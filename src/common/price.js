/**
 * @fileOverview Gets the units to run a host per month
 * @name price.js
 * @author Travis Crist
 */
const config = require('../config.js')
const logger = require('riverpig')('codius-cli:price')
const BigNumber = require('bignumber.js')
const moment = require('moment')
const monthsPerSecond = 0.0000003802571
const roundUpPriceConstant = 0.0008

function getCurrencyDetails ({ assetCode, assetScale = 0 }) {
  if (!assetCode) {
    return undefined
  }
  const prefixes = [ '', 'd', 'c', 'm', null, null, '\u00B5', null, null, 'n' ]
  const prefix = prefixes[assetScale]

  const currencyDetails = (prefix || '') + assetCode +
        ((prefix || !assetScale) ? '' : ('e-' + assetCode))

  return currencyDetails
}

function unitsPerHost ({
  forever,
  maxInterval = config.interval,
  maxMonthlyRate = config.price.amount,
  units = config.price.units,
  duration = config.duration
}) {
  const seconds = forever ? moment.duration(maxInterval).asSeconds() : duration
  const totalFee = new BigNumber(seconds).times(monthsPerSecond).times(maxMonthlyRate)
  logger.debug(`Total fee in ${units}: ${totalFee}`)
  // Increase the price by 8/100ths of a percent since the server rounds up so we are not off by a few drops
  const roundUpUnits = totalFee.multipliedBy(roundUpPriceConstant)//.integerValue(BigNumber.ROUND_CEIL)
  const amountOfUnits = totalFee.plus(roundUpUnits)
  logger.debug(`Total amount in ${units}: ${amountOfUnits}`)
  return amountOfUnits
}

module.exports = {
  getCurrencyDetails,
  unitsPerHost
}
