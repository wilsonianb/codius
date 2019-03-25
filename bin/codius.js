#!/usr/bin/env node

/* eslint-disable no-unused-expressions */
const yargs = require('yargs')

yargs.commandDir('../src/cmds')
  .help()
  .command('*', '', {}, argv => {
    console.error('Unknown Command, use --help for command options.')
    process.exit(1)
  })
  .conflicts('host', 'host-count')
  .implies('max-monthly-rate', 'units')
  .implies('units', 'max-monthly-rate')
  .implies('units', 'max-price')
  .conflicts('max-monthly-rate', 'max-price')
  .implies('codius-file', 'codius-vars-file')
  .implies('codius-vars-file', 'codius-file')
  .implies('tail', 'debug')
  .implies('max-price', 'units')
  .implies('pull-server-url', 'pull-server-secret')
  .implies('pull-server-secret', 'pull-server-url')
  .implies('max-interval', 'max-price')
  .implies('max-price', 'max-interval')
  .conflicts('max-interval', 'duration')
  .argv
