'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const {
    applyDevWebCaptureEnv,
    isDevWebCaptureEnabled,
  } = await import(pathToFileURL(path.join(__dirname, '..', 'electron', 'dev-web-capture.ts')).href);
  const {
    mixToMono,
    resampleMono,
    samplesForEngineFeed,
  } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'dev-web-capture.ts')).href);

  assert.equal(isDevWebCaptureEnabled('darwin', false, {}), true);
  assert.equal(isDevWebCaptureEnabled('darwin', false, { DATABAKER_DEV_WEB_CAPTURE: '1' }), true);
  assert.equal(isDevWebCaptureEnabled('darwin', false, { DATABAKER_DEV_WEB_CAPTURE: '0' }), false);
  assert.equal(isDevWebCaptureEnabled('darwin', true, {}), false);
  assert.equal(isDevWebCaptureEnabled('win32', false, { DATABAKER_DEV_WEB_CAPTURE: '1' }), false);

  const env = {};
  assert.equal(applyDevWebCaptureEnv('darwin', false, env), true);
  assert.equal(env.DATABAKER_DEV_WEB_CAPTURE, '1');
  const windowsEnv = { DATABAKER_DEV_WEB_CAPTURE: '1' };
  assert.equal(applyDevWebCaptureEnv('win32', false, windowsEnv), false);
  assert.equal(windowsEnv.DATABAKER_DEV_WEB_CAPTURE, '1');

  const left = new Float32Array([0.2, 0.4]);
  const right = new Float32Array([0.4, 0.8]);
  const mixed = mixToMono([left, right]);
  assert.equal(mixed.length, 2);
  assert.ok(Math.abs(mixed[0] - 0.3) < 1e-6);
  assert.ok(Math.abs(mixed[1] - 0.6) < 1e-6);
  const only = mixToMono([left]);
  assert.equal(only.length, 2);
  assert.ok(Math.abs(only[0] - 0.2) < 1e-6);
  assert.ok(Math.abs(only[1] - 0.4) < 1e-6);

  const sameRate = resampleMono(new Float32Array([0, 1, 0, -1]), 48_000, 48_000);
  assert.deepEqual(Array.from(sameRate), [0, 1, 0, -1]);

  const up = resampleMono(new Float32Array([0, 1]), 24_000, 48_000);
  assert.equal(up.length, 4);
  assert.ok(Math.abs(up[0]) < 1e-6);
  assert.ok(up[up.length - 1] > 0.9);

  const feed = samplesForEngineFeed([new Float32Array([0.5, -0.5, 0.25, -0.25])], 48_000, 48_000);
  assert.deepEqual(feed, [0.5, -0.5, 0.25, -0.25]);
  console.log('dev web capture helper tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
