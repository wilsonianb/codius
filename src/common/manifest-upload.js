/**
 * @fileOverview
 * @name manifest-upload.js
 * @author Travis Crist
 */

const logger = require('riverpig')('codius-cli:manifest-upload')
const config = require('../config.js')
const moment = require('moment')
const { getCurrencyDetails } = require('../common/price.js')
const jsome = require('jsome')
const { checkStatus, fetchPromise } = require('../common/utils.js')
const chalk = require('chalk')
const FETCH_TIMEOUT = 70000 // 1m10s

function getParsedResponses (responses, status) {
  const parsedResponses = responses.reduce((acc, curr) => {
    const res = curr.response || curr
    if (checkStatus(curr)) {
      const successObj = {
        url: res.url,
        manifestHash: res.manifestHash,
        host: curr.host,
        expiry: res.expiry,
        expirationDate: moment(res.expiry).format('MM-DD-YYYY HH:mm:ss ZZ'),
        expires: moment().to(moment(res.expiry)),
        pricePaid: curr.price,
        units: getCurrencyDetails(curr)
      }
      acc.success = [...acc.success, successObj]
    } else {
      const failedObj = {
        host: curr.host,
        error: curr.error,
        response: curr.text || undefined,
        statusCode: curr.status || undefined,
        statusText: curr.message || undefined
      }
      acc.failed = [...acc.failed, failedObj]
    }
    return acc
  }, { success: [], failed: [] })

  if (parsedResponses.success.length > 0) {
    parsedResponses.success.map((obj) => {
      status.succeed(`Upload to ${obj.host} Successful`)
      jsome(obj)
    })
  }

  if (parsedResponses.failed.length > 0) {
    parsedResponses.failed.map((obj) => {
      status.fail(`Upload to ${obj.host} Failed`)
      jsome(obj)
    })
  }

  console.info(config.lineBreak)
  if (parsedResponses.success.length > 0) {
    status.succeed(`${parsedResponses.success.length} Successful Uploads`)
  }

  if (parsedResponses.failed.length > 0) {
    status.fail(`${parsedResponses.failed.length} Failed Uploads`)
  }

  if (parsedResponses.success.length > 0) {
    status.stopAndPersist({ symbol: `${chalk.blue('o')}`, text: `Manifest Hash: ${chalk.blue(parsedResponses.success[0].manifestHash)}` })
  }

  return parsedResponses
}

function getUploadRequest (manifestJson) {
  return {
    headers: {
      Accept: `application/codius-v${config.version.codius.min}+json`,
      'Content-Type': 'application/json'
    },
    method: 'POST',
    body: JSON.stringify(manifestJson),
    timeout: FETCH_TIMEOUT
  }
}

function getExtendRequest () {
  return {
    headers: {
      Accept: `application/codius-v${config.version.codius.min}+json`
    },
    method: 'PUT',
    timeout: FETCH_TIMEOUT
  }
}

async function fetch (host, paidRequest, payToken) {
  const fetchFunction = payToken ? paidRequest.fetch(host, payToken) : paidRequest.fetch(host)
  return fetchPromise(fetchFunction, host, FETCH_TIMEOUT)
}

async function uploadManifestToHosts (status, hosts, paidRequest, pullPointers, duration) {
  logger.debug(`Upload to Hosts: ${JSON.stringify(hosts)} Duration: ${duration}`)
  const uploadPromises = hosts.map((host) => {
    return fetch(host, paidRequest, pullPointers[host])
  })
  const responses = await Promise.all(uploadPromises)
  return getParsedResponses(responses, status)
}

async function extendManifestByHash (status, hosts, paidRequest, duration, manifestHash) {
  logger.debug(`Extending manifest hash ${manifestHash} on Hosts: ${JSON.stringify(hosts)} Duration: ${duration}`)
  const extendPromises = hosts.map((host) => {
    return fetch(host.host, paidRequest, host.pullPointer)
  })
  const responses = await Promise.all(extendPromises)
  return getParsedResponses(responses, status)
}

module.exports = {
  getUploadRequest,
  getExtendRequest,
  uploadManifestToHosts,
  extendManifestByHash
}
