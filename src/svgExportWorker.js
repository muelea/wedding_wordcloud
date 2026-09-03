'use strict';

const { parentPort } = require('node:worker_threads');
const { layoutForExport } = require('./exportSvg');

parentPort.on('message', ({ id, words, theme }) => {
  try {
    const svg = layoutForExport(words, theme);
    parentPort.postMessage({ id, svg });
  } catch {
    parentPort.postMessage({ id, error: 'export_failed' });
  }
});
