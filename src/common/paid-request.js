/**
 * @fileOverview
 * @name paid-request.js
 * @author Brandon Wilson
 */

const BigNumber = require('bignumber.js')
const ilpFetch = require('ilp-fetch')
const plugin = require('ilp-plugin')()
const IlpPrice = require('ilp-price')
const ildcp = require('ilp-protocol-ildcp')
const jwt = require('jsonwebtoken')
const moment = require('moment')
const nodeFetch = require('node-fetch')
const os = require('os')
const { getCurrencyDetails } = require('./price.js')

class PaidRequest {
  constructor ({path, request, method, maxPrice}) {
    this.path = path
    this._request = request
    this.method = method
    this.maxPrice = maxPrice
  }

  set request (request) {
    this._request = request
  }

  getResponsePrice (resp) {
    const hostMethod = resp.headers.get('Pay').split(' ')[0]
    if (hostMethod !== this.method) {
      throw new Error(`Host does not support ${this.method} payment method.`)
    }

    const hostPrice = {
      amount: resp.headers.get(`${this.method}-price`),
      assetCode: resp.headers.get(`${this.method}-asset-code`),
      assetScale: resp.headers.get(`${this.method}-asset-scale`)
    }

    if (!hostPrice.amount) {
      throw new Error('Quote is missing price.')
    }
    if (!hostPrice.assetCode || !hostPrice.assetScale) {
      throw new Error('Quote is missing asset code and scale.')
    }
    hostPrice.assetScale = Number(hostPrice.assetScale)
    return hostPrice
  }

  fetchPrice (host) {
    const url = `${host}${this.path}`
    return nodeFetch(url, {
      ...this._request,
      headers: {
        ...this._request.headers,
        'Pay-Accept': this.method
      }
    })
  }
}

class StreamRequest extends PaidRequest {
  constructor ({path, request, maxPrice}) {
    super({
      path,
      request,
      method: 'interledger-stream',
      maxPrice
    })
  }

  static async convertToSourceAsset ({ amount, assetCode, assetScale = 0 }) {
    const price = new IlpPrice()
    try {
      let timer
      const timeoutPromise = new Promise((resolve, reject) => {
        timer = setTimeout(resolve, 2000)
      })

      const unscaledAmount = new BigNumber(amount).dividedBy(Math.pow(10, assetScale))
      const priceFetchPromise = price.fetch(assetCode, unscaledAmount)
      const priceResp = await Promise.race([timeoutPromise, priceFetchPromise])
      clearTimeout(timer)
      if (!priceResp) {
        if (os.platform() === 'win32') {
          throw new Error('unable to make ILP Connection, run Codius CLI in debug via command:\n\'set DEBUG=* & codius <commands>\'\nto verify you are connected.')
        } else {
          throw new Error('unable to make ILP Connection, run Codius CLI in debug via command:\n\'DEBUG=* codius <commands>\'\nto verify you are connected.')
        }
      }
      await plugin.connect()
      const assetDetails = await ildcp.fetch(plugin.sendData.bind(plugin))
      return {
        amount: priceResp,
        assetCode: assetDetails.assetCode,
        assetScale: assetDetails.assetScale
      }
    } catch (err) {
      throw new Error(`ilp-price lookup failed: ${err.message}`)
    }
  }

  async getHostPrice (resp) {
    const hostQuote = super.getResponsePrice(resp)
    return StreamRequest.convertToSourceAsset(hostQuote)
  }

  async checkHostPrice (resp) {
    const {amount: hostPrice, assetCode, assetScale} = await this.getHostPrice(resp)
    if (this.maxPrice < hostPrice) {
      const currency = getCurrencyDetails({
        assetCode: assetCode,
        assetScale: assetScale
      })
      throw new Error({
        message: 'Quoted price exceeded specified max price, please increase your max price.',
        quotedPrice: `${hostPrice.toString()} ${currency}`,
        maxPrice: `${this.maxPrice.toString()} ${currency}`
      })
    }
    return true
  }

  fetchPrice (host) {
    return super.fetchPrice(host)
  }

  fetch (host) {
    const url = `${host}${this.path}`
    return ilpFetch(url, {
      ...this._request,
      headers: {
        ...this._request.headers,
        'Pay-Accept': this.method
      },
      maxPrice: this.maxPrice.toString()
    })
  }
}

class PullRequest extends PaidRequest {
  constructor ({path, request, maxPrice, pullServerUrl, pullServerSecret}) {
    super({
      path,
      request,
      method: 'interledger-pull',
      maxPrice
    })
    this.pullServerUrl = pullServerUrl
    this.pullServerSecret = pullServerSecret
  }

  validatePriceResponse (resp) {
    super.validatePriceResponse(resp)
  }

  static async convertToSourceAsset (pullServerUrl, { amount, assetCode, assetScale = 0 }) {
    const resp = await nodeFetch(`${pullServerUrl}/exchange?amount=${amount}&assetCode=${assetCode}&assetScale=${assetScale}`, {
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'GET'
    })
    return resp.json()
  }

  async convertToSourceAsset ({ amount, assetCode, assetScale = 0 }) {
    return PullRequest.convertToSourceAsset(this.pullServerUrl, {amount, assetCode, assetScale})
  }

  createPullPointer (id, pullDetails) {
    const token = jwt.sign({
      ...pullDetails,
      amount: this.maxPrice.toString(),
      assetCode: this.assetCode,
      assetScale: this.assetScale
    }, this.pullServerSecret, {
      algorithm: 'HS256',
      jwtId: id
    })
    return `${this.pullServerUrl}/${token}`
  }

  async getHostPrice (resp) {
    const hostQuote = super.getResponsePrice(resp)
    return this.convertToSourceAsset(hostQuote)
  }

  fetchPrice (host) {
    return super.fetchPrice(host)
  }

  fetch (host, payToken) {
    const url = `${host}${this.path}`
    return nodeFetch(url, {
      ...this._request,
      headers: {
        ...this._request.headers,
        'Pay-Accept': this.method,
        'Pay-Token': payToken
      }
    })
  }
}

// Can this just be in PullRequest?
class OneTimePullRequest extends PullRequest {
  async checkHostPrice (resp) {
    const {amount: hostPrice, assetCode, assetScale} = await super.getHostPrice(resp)
    if (this.maxPrice < hostPrice) {
      const currency = getCurrencyDetails({
        assetCode: assetCode,
        assetScale: assetScale
      })
      throw new Error({
        message: 'Quoted price exceeded specified max price, please increase your max price.',
        quotedPrice: `${hostPrice.toString()} ${currency}`,
        maxPrice: `${this.maxPrice.toString()} ${currency}`
      })
    }
    return true
  }

  createPullPointer (id) {
    return super.createPullPointer(id, {
      cycles: 1
    })
  }

  fetchPrice (host) {
    return super.fetchPrice(host)
  }

  fetch (host, payToken) {
    return super.fetch(host, payToken)
  }
}

class RecurringPullRequest extends PullRequest {
  constructor ({path, request, maxPrice, maxInterval, pullServerUrl, pullServerSecret}) {
    super({path, request, maxPrice, pullServerUrl, pullServerSecret})
    this.maxInterval = moment.duration(maxInterval)
  }

  static getHostInterval (resp) {
    const hostInterval = resp.headers.get('interledger-pull-interval')
    if (!hostInterval) {
      throw new Error('Quote is missing pull interval.')
    }
    return moment.duration(hostInterval)
  }

  async checkHostPrice (resp) {
    const {amount: hostPrice, assetCode, assetScale} = await super.getHostPrice(resp)
    if (!resp.headers.get('interledger-pull-interval')) {
      throw new Error('Quote is missing pull interval.')
    }
    const hostInterval = RecurringPullRequest.getHostInterval(resp)
    if (this.maxInterval.asSeconds() < hostInterval.asSeconds()) {
      if (this.maxPrice < hostPrice) {
        return true
      } else {
        throw new Error({
          message: "Host's minimum interval exceeds your maximum interval and your maximum price does not cover the host's price. Please increase your max interval and/or your max price.",
          quotedInterval: hostInterval.humanize(),
          maxInterval: this.maxInterval.humanize()
        })
      }
    } else {
      const maxPriceAdj = this.maxPrice / this.maxInterval.asSeconds() * hostInterval.asSeconds() // big number?
      if (maxPriceAdj > hostPrice) {
        return true
      } else {
        const currency = getCurrencyDetails({
          assetCode: assetCode,
          assetScale: assetScale
        })
        throw new Error({
          message: "Host's minimum price exceeds your maximum price. Please increase your max price.",
          quotedPrice: `${hostPrice.toString()} ${currency}`,
          maxPrice: `${maxPriceAdj.toString()} ${currency}`
        })
      }
    }
  }

  createPullPointer (id) {
    return super.createPullPointer(id, {
      interval: this.maxInterval.toISOString()
    })
  }

  fetchPrice (host) {
    return super.fetchPrice(host)
  }

  fetch (host, payToken) {
    return super.fetch(host, payToken)
  }
}

module.exports = {
  StreamRequest,
  PullRequest,
  OneTimePullRequest,
  RecurringPullRequest
}
