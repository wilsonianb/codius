/**
 * @fileOverview
 * @name hosts-utils.js
 * @author Travis Crist
 */

const fetch = require('node-fetch')
const logger = require('riverpig')('codius-cli:host-utils')
const config = require('../config.js')
const BigNumber = require('bignumber.js')
const sampleSize = require('lodash.samplesize')
const { getCurrencyDetails, getPrice } = require('../common/price.js')
const { URL } = require('url')
const { fetchPromise } = require('../common/utils.js')
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

async function fetchHostPrice (payAccept, host, duration, manifestJson) {
  let url = `${host}/pods`
  if (payAccept === 'interledger-stream') {
    url += `?duration=${duration}`
  }
  const fetchFunction = fetch(url, {
    headers: {
      'Accept': `application/codius-v${config.version.codius.min}+json`,
      'Content-Type': 'application/json',
      'Pay-Accept': payAccept
    },
    method: 'POST',
    body: JSON.stringify(manifestJson),
    timeout: 10000 // 10s
  })
  return fetchPromise(fetchFunction, host)
}

function checkHeaderAsset (method, response) {
  if (!response.headers.get(`${method}-asset-code`) || !response.headers.get(`${method}-asset-scale`)) {
    return false
  } else {
    return true
  }
}

async function getHostPrice (method, response) {
  const unscaledQuote = new BigNumber(response.headers.get(`${method}-price`)).dividedBy(Math.pow(10, response.headers.get(`${method}-asset-scale`)))
  let hostPrice
  if (method === 'interledger-stream') {
    hostPrice = await getPrice(unscaledQuote, response.headers.get(`${method}-asset-code`))
  } else if (method === 'interledger-pull') {
    // call to SPSP exchange enpoint
  }

  return hostPrice
}

async function checkHostsPrices (fetchHostPromises, maxPrice, maxInterval) {
  logger.debug(`Fetching host prices from ${fetchHostPromises.length} host(s)`)
  const responses = await Promise.all(fetchHostPromises)
  const currency = await getCurrencyDetails()
  const results = await responses.reduce(async (acc, curr) => {
    const method = curr.headers.get('Pay').split(' ')[0]
    if (checkHeaderAsset(method, curr)) {
      const errorMessage = {
        message: 'Quote is missing asset code and scale.',
        host: curr.host
      }
      acc.failed.push(errorMessage)
      return acc
    }
    const hostPrice = await getHostPrice(method, curr)
    curr.hostPrice = hostPrice
    if (method === 'interledger-stream') {
      if (!hostPrice.lte(maxPrice)) {
        const errorMessage = {
          message: 'Quoted price exceeded specified max price, please increase your max price.',
          host: curr.host,
          quotedPrice: `${hostPrice.toString()} ${currency}`,
          maxPrice: `${maxPrice.toString()} ${currency}`
        }
        acc.failed.push(errorMessage)
      } else {
        acc.success.push(curr)
      }
      return acc
    } else if (method === 'interledger-pull') {
      const hostInterval = moment.duration(curr.headers.get('interledger-pull-interval'))
      if (maxInterval < hostInterval) {
        if (maxPrice.gte(hostPrice)) {
          acc.success.push(curr)
        } else {
          const errorMessage = {
            message: "Host's minimum interval exceeds your maximum interval and your maximum price does not cover the host's price. Please increase your max interval and/or your max price.",
            host: curr.host,
            quotedInterval: hostInterval.toString(),
            maxInterval: maxInterval.toString()
          }
          acc.failed.push(errorMessage)
        }
      } else {
        const maxPriceAdj = maxPrice / maxInterval * hostInterval
        if (maxPriceAdj.gte(hostPrice)) {
          acc.success.push(curr)
        } else {
          const errorMessage = {
            message: "Host's minimum price exceeds your maximum price. Please increase your max price.",
            host: curr.host,
            quotedPrice: `${hostPrice.toString()} ${currency}`,
            maxPrice: `${maxPriceAdj.toString()} ${currency}`
          }
          acc.failed.push(errorMessage)
        }
      }
      return acc
    }
  }, { success: [], failed: [] })
  return results
}

async function gatherMatchingValidHosts ({ duration, hostCount = 1 }, hostList, maxPrice, manifestJson) {
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
    const fetchPromises = candidateHosts.map((host) => fetchHostPrice(host, duration, manifestJson))
    const priceCheckResults = await checkHostsPrices(fetchPromises, maxPrice)
    if (priceCheckResults.success.length > 0) {
      validHosts = [...new Set([...validHosts, ...priceCheckResults.success])]
    }

    if (priceCheckResults.failed.length > 0) {
      invalidHosts = [...new Set([...invalidHosts, ...priceCheckResults.failed])]
    }
  }
  if (validHosts.length < hostCount) {
    const error = {
      message: `Unable to find ${hostCount} hosts with provided max price. Found ${validHosts.length} matching host(s)`,
      invalidHosts: invalidHosts.map((obj) => obj.host)
    }
    throw new Error(JSON.stringify(error))
  }
  logger.debug(`Validated Price successfully against ${validHosts.length}`)
  const uploadHosts = validHosts.slice(0, hostCount)
  logger.debug(`Using ${uploadHosts.length} for upload`)
  return uploadHosts
}

async function checkPricesOnHosts (payAccept, hosts, duration, maxInterval, maxPrice, manifestJson) {
  const fetchPromises = hosts.map((host) => fetchHostPrice(payAccept, host, duration, manifestJson))
  const priceCheckResults = await checkHostsPrices(fetchPromises, maxPrice, maxInterval)
  if (priceCheckResults.failed.length !== 0) {
    throw new Error(JSON.stringify(priceCheckResults.failed, null, 2))
  }
  return priceCheckResults.success
}

async function getValidHosts (pull, options, hostOpts) {
  let uploadHosts = []
  let payAccept
  if (pull) {
    payAccept = 'interledger-pull'
  } else {
    payAccept = 'interledger-stream'
  }
  const maxInterval = moment.duration(options.maxInterval)
  if (options.host || (hostOpts.codiusHostsExists && !options.hostCount)) {
    uploadHosts = await checkPricesOnHosts(payAccept, hostOpts.hostList, options.duration, maxInterval, hostOpts.maxPrice, hostOpts.manifestJson)
  } else {
    uploadHosts = await gatherMatchingValidHosts(payAccept, options, hostOpts.hostList, hostOpts.maxPrice, hostOpts.manifestJson)
  }
  const hosts = uploadHosts.map((item) => item.host)
  if (!pull) {
    return { validHosts: hosts }
  } else {
    const pullDetails = uploadHosts.reduce((obj, item) => {
      obj[item.host] = {
        price: item.hostPrice,
        interval: item.headers.get('interledger-pull-interval')
      }
      return obj
    }, {})
    return { validHostList: hosts, pullDetails: pullDetails }
  }
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

module.exports = {
  cleanHostListUrls,
  getValidHosts,
  checkPricesOnHosts,
  getHostsStatus,
  getHostList
}
