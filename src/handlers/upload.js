/**
 * @fileOverview Handler to upload codius pod to network
 * @name upload.js<handlers>
 * @author Travis Crist
 */

const { hashManifest } = require('codius-manifest')
const { getCurrencyDetails, unitsPerHost } = require('../common/price.js')
const { createPullPointers, getValidHosts, cleanHostListUrls } = require('../common/host-utils.js')
const { StreamRequest, PullRequest, OneTimePullRequest, RecurringPullRequest } = require('../common/paid-request.js')
const { discoverHosts } = require('../common/discovery.js')
const { getUploadRequest, uploadManifestToHosts } = require('../common/manifest-upload.js')
const { attachToLogs } = require('../common/pod-control.js')
const ora = require('ora')
const { generateManifest } = require('codius-manifest')
const statusIndicator = ora({ text: '', color: 'blue', spinner: 'point' })
const codiusState = require('../common/codius-state.js')
const fse = require('fs-extra')
const inquirer = require('inquirer')
const config = require('../config.js')
const { checkDebugFlag } = require('../common/utils.js')
const jsome = require('jsome')
const logger = require('riverpig')('codius-cli:uploadhandler')
const chalk = require('chalk')

function checkOptions ({ addHostEnv }) {
  // If the host number is set but the add host env is not specified warn the user
  if (!addHostEnv) {
    statusIndicator.warn('Hosts will NOT be added to the HOSTS env in the generated manifest.')
  }
}

async function addHostsToManifest (status, { addHostEnv }, manifestJson, hosts) {
  if (addHostEnv) {
    status.start('Adding hosts to HOSTS env in generated manifest')
    const containers = manifestJson.manifest.containers
    for (const container of containers) {
      if (container.environment && container.environment.HOSTS) {
        throw new Error('HOSTS env variable already exists in a container. Option --add-hosts-env cannot be used if the HOSTS env already exists in any container.')
      }
      container.environment = container.environment || {}
      container.environment.HOSTS = JSON.stringify(hosts)
    }
    status.succeed()
  }
}

function getUploadOptions ({
  forever,
  maxInterval = config.interval,
  maxMonthlyRate = config.price.amount,
  duration = config.duration,
  units = config.price.units
}) {
  return {
    maxInterval: forever ? maxInterval : undefined,
    maxMonthlyRate: maxMonthlyRate,
    duration: forever ? 'forever' : duration,
    units: units
  }
}

async function upload (options) {
  checkOptions(options)

  try {
    await codiusState.validateOptions(statusIndicator, options)
    statusIndicator.start('Generating Codius Manifest')
    const generatedManifestObj = await generateManifest(options.codiusVarsFile, options.codiusFile)
    checkDebugFlag(generatedManifestObj.manifest)
    const uploadOptions = getUploadOptions(options)
    if (options.debug) {
      generatedManifestObj.manifest.debug = true
    }

    let hostList
    const codiusHostsExists = await fse.pathExists(options.codiusHostsFile)
    // Skip discover if --host option is used.
    if (!options.host) {
      if (codiusHostsExists) {
        logger.debug('Codius Hosts File exists, or was provided as a parameter, using it for host list.')
        hostList = (await fse.readJson(options.codiusHostsFile)).hosts
      } else {
        statusIndicator.start('Discovering Hosts')
        const discoverCount = options.hostCount > 50 ? options.hostCount : 50
        hostList = await discoverHosts(discoverCount)
        statusIndicator.succeed(`Discovered ${hostList.length} Hosts`)
      }
    } else {
      hostList = options.host
    }
    const cleanHostList = cleanHostListUrls(hostList)
    statusIndicator.start('Calculating Max Price')
    const maxPrice = unitsPerHost(uploadOptions)
    const pull = options.pullServerUrl && options.pullServerSecret
    const recurring = pull && options.forever
    const sourceMaxPrice = pull
      ? await PullRequest.convertToSourceAsset(options.pullServerUrl, {
        amount: maxPrice,
        assetCode: uploadOptions.units
      })
      : await StreamRequest.convertToSourceAsset({
        amount: maxPrice,
        assetCode: uploadOptions.units
      })
    statusIndicator.succeed()
    const currencyDetails = getCurrencyDetails(sourceMaxPrice)
    statusIndicator.start(`Checking Host(s) Price vs Max Price ${sourceMaxPrice.amount} ${currencyDetails}`)
    const request = getUploadRequest(generatedManifestObj) // can't add manifest to body yet since we may add hosts list :/

    const validHostOptions = {
      hostList: cleanHostList,
      codiusHostsExists
    }

    if (pull) {
      if (recurring) {
        validHostOptions['paidRequest'] = new RecurringPullRequest('/pods', request, sourceMaxPrice, options.maxInterval, options.pullServerUrl, options.pullServerSecret)
      } else {
        validHostOptions['paidRequest'] = new OneTimePullRequest(`/pods?duration=${uploadOptions.duration}`, request, sourceMaxPrice, options.pullServerUrl, options.pullServerSecret)
      }
    } else {
      validHostOptions['paidRequest'] = new StreamRequest(`/pods?duration=${uploadOptions.duration}`, request, sourceMaxPrice)
    }

    const validHostList = await getValidHosts(options, validHostOptions)
    statusIndicator.succeed()
    addHostsToManifest(statusIndicator, options, generatedManifestObj, validHostList)
    validHostOptions.paidRequest.request = getUploadRequest(generatedManifestObj)
    const manifestHash = hashManifest(generatedManifestObj.manifest)

    if (!options.assumeYes) {
      console.info(config.lineBreak)
      console.info('Generated Manifest:')
      jsome(generatedManifestObj)
      console.info('Manifest Hash:')
      console.info(chalk.blue(`${manifestHash}`))
      console.info('will be uploaded to host(s):')
      jsome(validHostList)
      console.info('with options:')
      jsome(getUploadOptions(uploadOptions))
      statusIndicator.warn(`All information in the ${chalk.red('manifest')} property will be made ${chalk.red('public')}!`)
      if (options.debug) {
        statusIndicator.warn(`Debug logging for this pod will be enabled. Logs will be made ${chalk.red('public')}!`)
      }
      const userResp = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueToUpload',
          message: `Do you want to proceed with the pod upload?`,
          default: false
        }
      ])
      if (!userResp.continueToUpload) {
        statusIndicator.start('User declined to upload pod')
        throw new Error('Upload aborted by user')
      }
    }

    let pullPointers = {}
    if (pull) {
      statusIndicator.start(`Creating pull payment pointers for ${validHostList.length} host(s)`)
      pullPointers = await createPullPointers(validHostList, validHostOptions.paidRequest)
    }

    statusIndicator.start(`Uploading to ${validHostList.length} host(s)`)

    const uploadHostsResponse = await uploadManifestToHosts(statusIndicator,
      validHostList, validHostOptions.paidRequest, pullPointers, uploadOptions.duration)

    if (uploadHostsResponse.success.length > 0) {
      statusIndicator.start('Updating Codius State File')
      await codiusState.saveCodiusState(options, generatedManifestObj, uploadHostsResponse)
      statusIndicator.succeed(`Codius State File: ${options.codiusStateFile} Updated`)
    }

    if (uploadHostsResponse.success.length > 0 && options.debug && options.tail) {
      const logStream = await attachToLogs(validHostList, manifestHash)
      logStream.on('data', data => {
        logger.info(data.toString())
      })
    } else {
      process.exit(0)
    }
  } catch (err) {
    statusIndicator.fail()
    logger.error(err.message)
    logger.debug(err)
    process.exit(1)
  }
}

module.exports = {
  upload
}
