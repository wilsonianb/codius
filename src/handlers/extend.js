/**
 * @fileOverview
 * @name extend.js
 * @author Travis Crist
 */

const { hashManifest } = require('codius-manifest')
const { getCurrencyDetails, unitsPerHost } = require('../common/price.js')
const { checkPricesOnHosts, getHostsStatus } = require('../common/host-utils.js')
const { StreamRequest, PullRequest, OneTimePullRequest } = require('../common/paid-request.js')
const { getUploadRequest, uploadManifestToHosts } = require('../common/manifest-upload.js')
const { getCodiusState } = require('../common/codius-state.js')
const ora = require('ora')
const statusIndicator = ora({ text: '', color: 'blue', spinner: 'point' })
const codiusState = require('../common/codius-state.js')
const inquirer = require('inquirer')
const jsome = require('jsome')
const logger = require('riverpig')('codius-cli:uploadHandler')
const chalk = require('chalk')

function getOptions ({ maxMonthlyRate, duration, units }, codiusStateOptions) {
  return {
    maxMonthlyRate: maxMonthlyRate || codiusStateOptions.maxMonthlyRate,
    duration: duration || codiusStateOptions.duration,
    units: units || codiusStateOptions.units
  }
}

async function extend (options) {
  try {
    const { codiusStateFilePath, codiusStateJson } = await getCodiusState(statusIndicator, options)
    statusIndicator.start('Getting Codius State Details')
    const manifestJson = codiusStateJson.generatedManifest
    const hostList = codiusStateJson.hostList
    const statusDetails = getHostsStatus(codiusStateJson)
    const stateOptions = getOptions(options, codiusStateJson.options)
    statusIndicator.succeed()
    const manifestHash = hashManifest(manifestJson.manifest)

    if (!options.assumeYes) {
      console.info('Extending Manifest:')
      jsome(manifestJson)
      console.info('Manifest Hash:')
      console.info(chalk.blue(`${manifestHash}`))
      console.info('on the following host(s):')
      jsome(hostList)
      console.info('with the current status:')
      jsome(statusDetails)
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
        throw new Error('Extend aborted by user')
      }
    }

    statusIndicator.start('Calculating Max Price')
    const maxPrice = await unitsPerHost(stateOptions)
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
    const request = getUploadRequest(manifestJson)

    const paidRequest = pull
      ? new OneTimePullRequest(`/pods?duration=${options.duration}`, request, sourceMaxPrice, options.pullServerUrl, options.pullServerSecret)
      : new StreamRequest(`/pods?duration=${options.duration}`, request, sourceMaxPrice)

    await checkPricesOnHosts(hostList, paidRequest)
    statusIndicator.succeed()

    statusIndicator.start(`Uploading to ${hostList.length} host(s)`)
    const uploadHostsResponse = await uploadManifestToHosts(statusIndicator,
      hostList, paidRequest, stateOptions.duration)

    statusIndicator.start('Updating Codius State File')
    const saveStateOptions = {
      codiusStateFile: codiusStateFilePath,
      maxMonthlyRate: stateOptions.maxMonthlyRate,
      units: stateOptions.units,
      duration: stateOptions.duration
    }
    await codiusState.saveCodiusState(saveStateOptions, manifestJson, uploadHostsResponse, codiusStateJson)
    statusIndicator.succeed(`Codius State File: ${codiusStateFilePath} updated`)

    process.exit(0)
  } catch (err) {
    statusIndicator.fail()
    logger.error(err.message)
    logger.debug(err)
    process.exit(1)
  }
}

module.exports = {
  extend
}
