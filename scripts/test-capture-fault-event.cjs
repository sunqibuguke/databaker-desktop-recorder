const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'electron', 'capture-fault.ts');
  const { captureFaultNoticeFromEngineEvent } = await import(pathToFileURL(modulePath).href);

  assert.equal(captureFaultNoticeFromEngineEvent(null), null);
  assert.equal(captureFaultNoticeFromEngineEvent({ event: 'meter', payload: {} }), null);
  assert.equal(captureFaultNoticeFromEngineEvent({ event: 'other', payload: { faulted: true } }), null);
  assert.deepEqual(
    captureFaultNoticeFromEngineEvent({
      event: 'meter',
      payload: {
        faulted: true,
        fault_kind: 'device_unavailable',
        fault_reason: '端点已断开',
      },
    }),
    { kind: 'device_unavailable', title: '所选声卡已断开或不可用', reason: '端点已断开' },
  );
  assert.deepEqual(
    captureFaultNoticeFromEngineEvent({ event: 'meter', payload: { faulted: true } }),
    { kind: 'unknown', title: '音频采集已触发数据保护', reason: '' },
  );

  console.log('capture fault event tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
