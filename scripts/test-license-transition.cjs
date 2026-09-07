'use strict';
const assert = require('node:assert/strict');
const { LicenseTransition } = require('../dist-electron/license-transition.js');
const { emptyLicenseStatus, disabledLicenseStatus } = require('../dist-electron/license.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function main() {
  let current = disabledLicenseStatus(); let idle = false; let stopCalls = 0; let resolveStop; let rejectStop;
  const events = [];
  const transition = new LicenseTransition(async () => current, () => {
    stopCalls++; return new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
  }, (status) => events.push(status), () => idle);
  assert.equal((await transition.refresh()).state, 'valid');
  current = emptyLicenseStatus('machine', 'expired');
  assert.equal((await transition.refresh()).captureStopPending, true);
  await transition.refresh();
  assert.equal(stopCalls, 1, 'duplicate refresh does not start another stop');
  assert.equal(events.at(-1).captureStopPending, true, 'must not unmount recorder before sealing');
  rejectStop(new Error('disk full')); await tick();
  assert.equal(events.at(-1).captureStopError, 'disk full');
  assert.equal(events.at(-1).captureStopPending, true);
  await transition.refresh(); assert.equal(stopCalls, 2, 'failed seals can be retried');
  idle = true; resolveStop(true); await tick();
  assert.equal(events.at(-1).captureStopPending, false);
  assert.equal((await transition.refresh()).captureStopPending, false, 'idle invalid refresh cannot re-enter pending');
  current = disabledLicenseStatus();
  assert.equal((await transition.refresh()).state, 'valid');
  assert.equal(transition.pending, false);
  console.log('license transition tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
