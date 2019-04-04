/**
 * @fileOverview
 * @name extend-hash.js<handlers>
 * @author Travis Crist
 */

const { getCurrencyDetails, unitsPerHost } = require('../common/price.js')
const { checkPricesOnHosts, getHostList } = require('../common/host-utils.js')
const { getExtendRequest, extendManifestByHash } = require('../common/manifest-upload.js')
const { StreamRequest, PullRequest, OneTimePullRequest } = require('../common/paid-request.js')
const axios = require('axios')
const ora = require('ora')
const statusIndicator = ora({ text: '', color: 'blue', spinner: 'point' })
const config = require('../config.js')
const inquirer = require('inquirer')
const jsome = require('jsome')
const logger = require('riverpig')('codius-cli:extend-hash')
const { checkStatus, getManifestHash } = require('../common/utils.js')

async function getExistingManifest (hostList, manifestHash) {
  let responses = []
  try {
    for (const host of hostList) {
      logger.debug(`Getting existing manifest from ${manifestHash}.${host}`)
      const resp = await axios.get(`${host}/pods?manifestHash=${manifestHash}`, {
        headers: { Accept: `application/codius-v${config.version.codius.min}+json` }
      })
      if (checkStatus(resp)) {
        responses.push(resp.data)
      } else {
        throw new Error(`GET: ${host}/pods?manifestHash=${manifestHash} Failed. Status: ${resp.status}`)
      }
    }
  } catch (err) {
    throw new Error(`GET: ${err.config.url} ${err.message}`)
  }
  if (hostList.length !== responses.length) {
    throw new Error(`One of the hosts: ${hostList} does not have the associated manifest. Please check your host(s) and try again`)
  }
  return responses[0]
}

function getOptions ({
  maxMonthlyRate = config.price.amount,
  duration = config.duration,
  units = config.price.units
}) {
  return {
    maxMonthlyRate: maxMonthlyRate,
    duration: duration,
    units: units
  }
}

async function extendManifest (options) {
  try {
    statusIndicator.start('Checking Options')
    const hostList = getHostList(options)
    const manifestHash = getManifestHash(options)
    const stateOptions = getOptions(options)
    logger.debug(`host list: ${hostList}`)
    logger.debug(`manifest hash: ${manifestHash}`)
    logger.debug(`state options: ${JSON.stringify(stateOptions)}`)
    statusIndicator.succeed('Options Validated Successfully')

    statusIndicator.start('Fetching Exising Manifest')
    const manifestJson = {
      manifest: (await getExistingManifest(hostList, manifestHash)).manifest
    }
    statusIndicator.succeed()

    if (!options.assumeYes) {
      console.info('Extending Manifest:')
      jsome(manifestJson)
      console.info('on the following hosts:')
      jsome(hostList)
      console.info('with options:')
      jsome(stateOptions)
      const userResp = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueToExtend',
          message: `Do you want to proceed with extending the pod?`,
          default: false
        }
      ])
      if (!userResp.continueToExtend) {
        statusIndicator.start('User declined to extend pod')
        throw new Error('Extend manifest aborted by user')
      }
    }

    statusIndicator.start('Calculating Max Price')
    const maxPrice = unitsPerHost(stateOptions)
    const pull = options.pullServerUrl && options.pullServerSecret
    const sourceMaxPrice = pull
      ? await PullRequest.convertToSourceAsset(options.pullServerUrl, {
        amount: maxPrice,
        assetCode: stateOptions.units
      })
      : await StreamRequest.convertToSourceAsset({
        amount: maxPrice,
        assetCode: stateOptions.units
      })
    const currencyDetails = getCurrencyDetails(sourceMaxPrice)
    statusIndicator.start(`Checking Host(s) Price vs Max Price ${sourceMaxPrice.amount.toString()} ${currencyDetails}`)
    const request = getExtendRequest()
    const path = `/pods?manifestHash=${manifestHash}&duration=${options.duration}`
    const paidRequest = pull
      ? new OneTimePullRequest(path, request, sourceMaxPrice, options.pullServerUrl, options.pullServerSecret)
      : new StreamRequest(path, request, sourceMaxPrice)
    await checkPricesOnHosts(hostList, paidRequest)
    statusIndicator.succeed()

    statusIndicator.start(`Uploading to ${hostList.length} host(s)`)
    await extendManifestByHash(statusIndicator,
      hostList, paidRequest, stateOptions.duration, manifestHash)

    process.exit(0)
  } catch (err) {
    statusIndicator.fail()
    logger.error(err.message)
    logger.debug(err)
    process.exit(1)
  }
}

module.exports = {
  extendManifest
}
