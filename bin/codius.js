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
  .implies('codius-file', 'codius-vars-file')
  .implies('codius-vars-file', 'codius-file')
  .implies('tail', 'debug')
  .implies('forever', 'pull-server-url')
  .implies('forever', 'pull-server-secret')
  .implies('forever', 'max-interval')
  .implies('max-interval', 'forever')
  .conflicts('forever', 'duration')
  .implies('pull-server-url', 'pull-server-secret')
  .implies('pull-server-secret', 'pull-server-url')
  .conflicts('max-interval', 'duration')
  .argv
