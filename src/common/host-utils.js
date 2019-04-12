/**
 * @fileOverview
 * @name hosts-utils.js
 * @author Travis Crist
 */

const logger = require('riverpig')('codius-cli:host-utils')
const sampleSize = require('lodash.samplesize')
const { URL } = require('url')
const { checkStatus, fetchPromise } = require('../common/utils.js')
const moment = require('moment')
const BATCH_SIZE = 30

function cleanHostListUrls (hosts) {
  let hostList
  // Singular host options are a string so we have to make them into an array
  if (typeof hosts === 'string') {
    hostList = [hosts]
  } else {
    hostList = hosts
  }

  return hostList.map(host => {
    if (!host.startsWith('http://') && !host.startsWith('https://')) {
      host = `https://${host}`
    }
    try {
      const url = new URL(host)
      return url.origin
    } catch (err) {
      throw new Error(err)
    }
  })
}

async function fetchHostPrice (host, paidRequest) {
  const fetchFunction = paidRequest.fetchPrice(host)
  return fetchPromise(fetchFunction, host)
}

async function checkHostsPrices (fetchHostPromises, paidRequest) {
  logger.debug(`Fetching host prices from ${fetchHostPromises.length} host(s)`)
  const responses = await Promise.all(fetchHostPromises)
  const results = await responses.reduce(async (acc, curr) => {
    try {
      if (await paidRequest.checkHostPrice(curr)) {
        acc.success.push(curr)
      }
    } catch (e) {
      if (typeof e.message === 'string') {
        acc.failed.push({
          message: e.message,
          host: curr.host
        })
      } else {
        acc.failed.push({
          ...e.message,
          host: curr.host
        })
      }
    }
    return acc
  }, { success: [], failed: [] })
  return results
}

async function gatherMatchingValidHosts ({ hostCount = 1 }, hostList, paidRequest) {
  let validHosts = []
  const maxAttempts = hostList.length
  let attemptCount = 0
  let invalidHosts = []

  while (validHosts.length < hostCount && attemptCount < maxAttempts) {
    logger.debug(`Valid Hosts Found: ${validHosts.length}, attemptCount: ${attemptCount} need: ${hostCount} host(s) maxAttempts: ${maxAttempts}`)
    const candidateHosts = sampleSize(hostList, hostCount < BATCH_SIZE ? hostCount : BATCH_SIZE).filter((host) => !invalidHosts.includes(host))
    logger.debug(`Candidate Hosts: ${candidateHosts}`)
    logger.debug(`InvalidHosts: ${invalidHosts}`)
    attemptCount += candidateHosts.length
    const fetchPromises = candidateHosts.map((host) => fetchHostPrice(host, paidRequest))
    const priceCheckResults = await checkHostsPrices(fetchPromises, paidRequest)
    if (priceCheckResults.success.length > 0) {
      validHosts = [...new Set([...validHosts, ...priceCheckResults.success.map((obj) => obj.host)])]
    }

    if (priceCheckResults.failed.length > 0) {
      invalidHosts = [...new Set([...invalidHosts, ...priceCheckResults.failed.map((obj) => obj.host)])]
    }
  }
  if (validHosts.length < hostCount) {
    const error = {
      message: `Unable to find ${hostCount} hosts with provided max price. Found ${validHosts.length} matching host(s)`,
      invalidHosts: invalidHosts
    }
    throw new Error(JSON.stringify(error))
  }
  logger.debug(`Validated Price successfully against ${validHosts.length}`)
  const uploadHosts = validHosts.slice(0, hostCount)
  logger.debug(`Using ${uploadHosts.length} for upload`)
  return uploadHosts
}

async function checkPricesOnHosts (hosts, paidRequest) {
  const fetchPromises = hosts.map((host) => fetchHostPrice(host, paidRequest))
  const priceCheckResults = await checkHostsPrices(fetchPromises, paidRequest)
  if (priceCheckResults.failed.length !== 0) {
    throw new Error(JSON.stringify(priceCheckResults.failed, null, 2))
  }
  return hosts
}

async function getValidHosts (options, hostOpts) {
  let uploadHosts = []
  if (options.host || (hostOpts.codiusHostsExists && !options.hostCount)) {
    await checkPricesOnHosts(hostOpts.hostList, hostOpts.paidRequest)
    uploadHosts = hostOpts.hostList
  } else {
    uploadHosts = await gatherMatchingValidHosts(options, hostOpts.hostList, hostOpts.paidRequest)
  }

  return uploadHosts
}

function getHostsStatus (codiusStateJson) {
  const hostList = codiusStateJson.hostList
  const hostDetails = codiusStateJson.status ? codiusStateJson.status.hostDetails : null
  return hostList.map(host => {
    if (hostDetails && hostDetails[host]) {
      const hostInfo = hostDetails[host]
      return {
        host,
        expirationDate: hostInfo.expirationDate,
        'expires/expired': moment().to(moment(hostInfo.expirationDate, 'MM-DD-YYYY HH:mm:ss Z')),
        totalPricePaid: `${hostInfo.price.totalPaid} ${hostInfo.price.units}`
      }
    } else {
      return {
        host,
        message: 'No Existing Host Details for this host.'
      }
    }
  })
}

function getHostList ({ host, manifestHash }) {
  let hostsArr = []
  if (!host) {
    const potentialHost = manifestHash.split('.')
    potentialHost.shift()
    if (potentialHost.length <= 0) {
      throw new Error(`The end of ${manifestHash} is not a valid url. Please use the format <manifesth-hash.hostName> to specify the specific pod to extend or the --host parameter.`)
    }
    console.log(potentialHost)
    hostsArr = [`https://${potentialHost.join('.')}`]
  } else {
    hostsArr = host
  }

  return cleanHostListUrls(hostsArr)
}

// TODO: Use pull details from hosts?
function createPullPointers (hosts, paidRequest) {
  return hosts.reduce((acc, host) => {
    acc[host] = paidRequest.createPullPointer(host)
    return acc
  }, {})
}

module.exports = {
  cleanHostListUrls,
  getValidHosts,
  checkPricesOnHosts,
  createPullPointers,
  getHostsStatus,
  getHostList
}
