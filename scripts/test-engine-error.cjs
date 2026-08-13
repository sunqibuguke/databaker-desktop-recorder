'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'engine-error.ts');
  const { userFacingEngineError, classifyEngineError } = await import(pathToFileURL(modulePath).href);

  const wrappedExclusive = "Error invoking remote method 'engine:request': EngineRequestError: activation stage build_input_stream failed; capture resources were stopped and joined within the safety deadline; session_activation_failed was durably committed as stopped and may be resumed: 独占开流失败。请确认声卡未被其他程序占用，并检查采样率/位深/通道；可改为「系统混音」，不会自动降级: 无法以独占模式创建采集端点 (0x8889000F)";

  assert.equal(
    userFacingEngineError(wrappedExclusive),
    '独占开流失败。请确认声卡未被其他程序占用，并检查采样率/位深/通道；可改为「系统混音」，不会自动降级: 无法以独占模式创建采集端点 (0x8889000F)',
  );
  assert.deepEqual(classifyEngineError(wrappedExclusive), {
    kind: 'exclusive_open',
    message: userFacingEngineError(wrappedExclusive),
    canEditCaptureSettings: true,
  });

  const busy = new Error('无法以独占模式创建采集端点: 声卡正被其他程序独占使用，请关闭后重试 (0x8889000A)');
  assert.equal(classifyEngineError(busy).kind, 'exclusive_busy');
  assert.equal(classifyEngineError(busy).canEditCaptureSettings, true);

  const format = '独占模式：所选设备在 48000 Hz、输入通道 1 不支持采集格式 i16。当前提供：i24 (24 位整数表示)。不会自动改选其他格式。';
  assert.equal(classifyEngineError(format).kind, 'exclusive_format');

  const policy = '系统策略不允许该设备使用独占模式 (0x8889000E)';
  assert.equal(classifyEngineError(policy).kind, 'exclusive_policy');

  const empty = '该输入设备未枚举到独占格式，无法以独占模式开流。请关闭占用该声卡的其他程序，或将采集模式改为「系统混音」。不会自动降级。';
  assert.equal(classifyEngineError(empty).kind, 'exclusive_empty');

  const generic = new Error('Error invoking remote method \'engine:request\': EngineRequestError: disk is full');
  assert.equal(userFacingEngineError(generic), 'disk is full');
  assert.equal(classifyEngineError(generic).kind, 'generic');
  assert.equal(classifyEngineError(generic).canEditCaptureSettings, false);

  const activationOnly = 'activation stage start_capture_watchdog failed; capture resources were stopped and joined within the safety deadline; session_activation_failed was durably committed as stopped and may be resumed: start capture heartbeat watchdog';
  assert.equal(userFacingEngineError(activationOnly), 'start capture heartbeat watchdog');
  assert.equal(classifyEngineError(activationOnly).kind, 'activation');
  assert.equal(classifyEngineError(activationOnly).canEditCaptureSettings, true);
}

main().then(() => {
  console.log('engine error sanitizer tests passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
