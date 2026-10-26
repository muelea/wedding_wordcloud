'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const { testEnvironment } = require('./local-postgres');

Object.assign(process.env, testEnvironment(process.env, process.env.TEST_DATABASE_URL?.trim()));

// Application/operator modules may load dotenv on import. Inside test workers
// the workstation file is never read, even with override:true or extra keys
// that have not yet been added to .env.example. Fixture files remain usable.
const workstationEnv = path.resolve(__dirname, '../../.env');
const originalConfig = dotenv.config;
dotenv.config = function config(options = {}) {
  const paths = [options.path || path.resolve(process.cwd(), '.env')].flat();
  if (paths.some(file => path.resolve(file) === workstationEnv)) return { parsed: {} };
  return originalConfig.call(this, options);
};
