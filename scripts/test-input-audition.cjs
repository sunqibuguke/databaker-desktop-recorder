'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const {
    InputAuditionDecisionCache,
    InputAuditionCacheInvalidationTracker,
    captureFingerprintFromInputAuditionResult,
    inputAuditionCheckIdFromResult,
    inputAuditionConfigurationFromEngineResult,
    inputAuditionDecidedAtFromResult,
    inputAuditionStatusFromResult,
    invalidatesInputAuditionCache,
    logicalInputAuditionKey,
  } = require('../dist-electron/input-audition-cache.js');
  const helperPath = path.join(__dirname, '..', 'src', 'input-audition.ts');
  const {
    createCurrentInputAuditionDecision,
    inputAuditionDurationSeconds,
    inputAuditionProgress,
    logicalInputAuditionConfigurationKey,
    shouldPromptInputAudition,
  } = await import(pathToFileURL(helperPath).href);

  const base = {
    backend: 'WASAPI',
    deviceName: '  Focusrite   USB Audio  ',
    deviceId: 'endpoint:{usb-port-a}',
    sampleRate: 48_000,
    outputBitDepth: 16,
    inputSampleFormat: 'I24',
    inputChannels: 2,
    inputChannel: 1,
    shareMode: 'exclusive',
    requestedBufferFrames: 512,
    actualBufferFrames: 512,
  };
  const movedUsbPort = {
    ...base,
    deviceName: 'Ｆｏｃｕｓｒｉｔｅ USB Audio',
    deviceId: 'endpoint:{usb-port-b}',
  };
  assert.equal(
    logicalInputAuditionKey(base),
    logicalInputAuditionKey(movedUsbPort),
    'WASAPI raw endpoint/USB location must not be part of the logical cache key',
  );
  assert.equal(
    logicalInputAuditionConfigurationKey(base),
    logicalInputAuditionKey(base),
    'renderer and main process must derive the same logical key',
  );
  const usbPortTwo = { ...base, deviceName: 'Microphone (2- USB Audio Device)' };
  const usbPortThree = { ...base, deviceName: 'Microphone (3- USB Audio Device)' };
  const usbUnnumbered = { ...base, deviceName: 'Microphone (USB Audio Device)' };
  assert.equal(logicalInputAuditionKey(usbPortTwo), logicalInputAuditionKey(usbPortThree));
  assert.equal(logicalInputAuditionKey(usbPortTwo), logicalInputAuditionKey(usbUnnumbered));
  assert.equal(
    logicalInputAuditionConfigurationKey(usbPortTwo),
    logicalInputAuditionKey(usbPortThree),
    'renderer and main must both ignore only the Windows numeric instance prefix',
  );
  assert.notEqual(
    logicalInputAuditionKey({ ...base, deviceName: 'RODE NT1 (2nd Generation)' }),
    logicalInputAuditionKey({ ...base, deviceName: 'RODE NT1 (3rd Generation)' }),
    'digits that are part of the real product name must remain significant',
  );
  assert.notEqual(
    logicalInputAuditionKey({ ...base, deviceName: 'USB Audio Device' }),
    logicalInputAuditionKey({ ...base, deviceName: 'RODE NT-USB' }),
    'different device product names must never collapse to one logical key',
  );

  const asioA = { ...base, backend: 'asio', driverName: 'Focusrite USB ASIO', deviceName: 'Input 1' };
  const asioB = { ...asioA, deviceId: 'different-endpoint', deviceName: 'Focusrite Input 1' };
  assert.equal(logicalInputAuditionKey(asioA), logicalInputAuditionKey(asioB),
    'ASIO must prefer the stable driver/display name over endpoint ids or per-port labels');

  for (const [field, value] of [
    ['deviceName', 'Another Interface'],
    ['sampleRate', 96_000],
    ['outputBitDepth', 24],
    ['inputSampleFormat', 'f32'],
    ['inputChannels', 4],
    ['inputChannel', 2],
    ['shareMode', 'shared'],
    ['requestedBufferFrames', 1_024],
    ['actualBufferFrames', 1_024],
  ]) {
    assert.notEqual(
      logicalInputAuditionKey(base),
      logicalInputAuditionKey({ ...base, [field]: value }),
      `${field} changes must invalidate the decision`,
    );
  }

  const cache = new InputAuditionDecisionCache(() => Date.parse('2026-09-01T03:00:00.000Z'));
  assert.equal(cache.get(base), null);
  assert.deepEqual(cache.remember(
    base,
    'confirmed',
    'capture-sha-256',
    'input-audition-1',
    '2026-09-01T03:00:00.000Z',
  ), {
    status: 'confirmed',
    decidedAt: '2026-09-01T03:00:00.000Z',
    captureFingerprint: 'capture-sha-256',
    sourceCheckId: 'input-audition-1',
  });
  assert.equal(cache.get(movedUsbPort).status, 'confirmed');
  assert.equal(cache.get({ ...base, sampleRate: 96_000 }), null);
  assert.equal(cache.remember(base, 'skipped', 'skip-fingerprint', 'input-audition-2').status, 'skipped');
  assert.equal(cache.get(base).status, 'skipped', 'confirmed and skipped remain distinct decisions');
  assert.throws(() => cache.remember(base, 'ready', null, 'invalid-status'), /决定无效/);
  assert.throws(() => cache.get({ ...base, inputChannel: 3 }), /录制声道无效/);
  assert.equal(cache.delete(base), true);
  assert.equal(cache.get(base), null);
  cache.remember(base, 'confirmed', 'capture-sha-256', 'input-audition-3');
  cache.clear();
  assert.equal(cache.size, 0);

  const engineResult = {
    input_audition: {
      status: 'confirmed',
      check_id: 'input-audition-engine',
      confirmed_at: '2026-09-01T03:05:00.000Z',
      capture_fingerprint: 'engine-sha',
    },
    snapshot: {
      capture_backend: 'asio',
      device_name: 'Focusrite USB ASIO',
      device_id: 'raw-endpoint',
      input_sample_format: 'i24',
      capture_share_mode: 'exclusive',
      requested_capture_buffer_frames: 512,
      capture_buffer_frames: 512,
      audio_format: {
        sample_rate: 48_000,
        bit_depth: 24,
        input_channels: 2,
        input_channel: 1,
      },
    },
  };
  assert.equal(inputAuditionStatusFromResult(engineResult), 'confirmed');
  assert.equal(inputAuditionCheckIdFromResult(engineResult), 'input-audition-engine');
  assert.equal(inputAuditionDecidedAtFromResult(engineResult), '2026-09-01T03:05:00.000Z');
  assert.equal(captureFingerprintFromInputAuditionResult(engineResult), 'engine-sha');
  assert.deepEqual(inputAuditionConfigurationFromEngineResult(engineResult), {
    backend: 'asio',
    deviceName: 'focusrite usb asio',
    deviceId: 'raw-endpoint',
    driverName: undefined,
    sampleRate: 48_000,
    outputBitDepth: 24,
    inputSampleFormat: 'i24',
    inputChannels: 2,
    inputChannel: 1,
    shareMode: 'exclusive',
    requestedBufferFrames: 512,
    actualBufferFrames: 512,
  });

  assert.equal(invalidatesInputAuditionCache({ event: 'input_discontinuity', payload: {} }), true);
  assert.equal(invalidatesInputAuditionCache({ event: 'meter', payload: { faulted: true } }), true);
  assert.equal(invalidatesInputAuditionCache({ event: 'meter', payload: { input_discontinuity_count: 1 } }), true);
  assert.equal(invalidatesInputAuditionCache({ event: 'meter', payload: { faulted: false, input_discontinuity_count: 0 } }), false);
  assert.equal(invalidatesInputAuditionCache({ event: 'noise_check_completed', payload: {} }), false,
    'the independent three-second room check must not mutate audition decisions');

  const invalidation = new InputAuditionCacheInvalidationTracker();
  const scope = { generation: 7, sessionDir: '/recordings/session-a' };
  assert.equal(invalidation.observe({
    event: 'meter',
    payload: { input_discontinuity_count: 1, overflow_samples: 0, faulted: false },
  }, scope), false, 'the first meter packet establishes the active-session baseline');
  assert.equal(invalidation.observe({
    event: 'meter',
    payload: { input_discontinuity_count: 2, overflow_samples: 0, faulted: false },
  }, scope), true, 'a newly observed discontinuity invalidates once');
  assert.equal(invalidation.observe({
    event: 'meter',
    payload: { input_discontinuity_count: 2, overflow_samples: 0, faulted: false },
  }, scope), false, 'the same cumulative discontinuity must not erase a later confirmation');
  assert.equal(invalidation.observe({ event: 'input_discontinuity', payload: {} }, scope), true);
  assert.equal(invalidation.observe({
    event: 'meter',
    payload: { input_discontinuity_count: 3, overflow_samples: 0, faulted: false },
  }, scope), false, 'the meter echo of a discrete fault event is consumed as a baseline');
  assert.equal(invalidation.observe({
    event: 'meter',
    payload: { input_discontinuity_count: 8, overflow_samples: 20, faulted: true },
  }, { generation: 8, sessionDir: '/recordings/session-b' }), false,
  'a resumed/new session establishes its own baseline even when counters are historical');
  assert.equal(invalidation.observe({
    event: 'meter',
    payload: { input_discontinuity_count: 8, overflow_samples: 21, faulted: true },
  }, { generation: 8, sessionDir: '/recordings/session-b' }), true,
  'a new overflow increase invalidates despite an already-faulted historical baseline');
  invalidation.reset();
  assert.equal(invalidation.observe({
    event: 'meter', payload: { input_discontinuity_count: 0, overflow_samples: 0, faulted: false },
  }, scope), false);
  assert.equal(invalidation.observe({
    event: 'meter', payload: { input_discontinuity_count: 0, overflow_samples: 0, faulted: true },
  }, scope), true, 'a healthy-to-faulted transition invalidates once');

  assert.equal(shouldPromptInputAudition(null), true);
  assert.equal(shouldPromptInputAudition(
    createCurrentInputAuditionDecision('confirmed', null, 'confirmed-check', 0),
  ), false);
  assert.equal(shouldPromptInputAudition(
    createCurrentInputAuditionDecision('skipped', null, 'skipped-check', 0),
  ), false);
  assert.equal(inputAuditionDurationSeconds({ required_samples: 480_000 }, 48_000), 10);
  assert.equal(inputAuditionProgress({ required_samples: 480_000, captured_samples: 240_000 }, 9, 48_000), .9,
    'the visible countdown must continue when the snapshot carries a stale captured-sample value');
  assert.equal(inputAuditionProgress({ required_samples: 480_000 }, 5, 48_000), .5);

  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.ts'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.ts'), 'utf8');
  for (const command of [
    'begin_input_audition',
    'finish_input_audition',
    'confirm_input_audition',
    'skip_input_audition',
    'cancel_input_audition',
  ]) {
    assert.match(mainSource, new RegExp(`'${command}'`));
    assert.match(preloadSource, new RegExp(command));
  }
  assert.match(preloadSource, /finishInputAudition:\s*\(checkId: string\)/);
  assert.match(preloadSource, /confirmInputAudition:\s*\(checkId: string\)/);
  assert.match(preloadSource, /cancelInputAudition:\s*\(checkId: string\)/);
  assert.match(preloadSource, /skipInputAudition:\s*\(checkId\?: string\)/);
  assert.match(mainSource, /INPUT_AUDITION_CHECK_ID_COMMANDS/);
  assert.match(mainSource, /adopt_cached_input_audition/,
    'trusted main must adopt launch-cache decisions into the current engine runtime');
  const cacheDecisionHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('input-audition:decision'"),
    mainSource.indexOf("ipcMain.handle('input-audition:clear-decision'"),
  );
  assert.ok(
    cacheDecisionHandler.indexOf("engine.request('get_state'")
      < cacheDecisionHandler.indexOf('inputAuditionDecisionCache.get(currentConfiguration)'),
    'cache adoption must derive its lookup key from authoritative engine state',
  );
  const clearDecisionHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('input-audition:clear-decision'"),
    mainSource.indexOf('for (const command of INPUT_AUDITION_COMMANDS)'),
  );
  assert.match(clearDecisionHandler, /invalidate_input_audition_decision/,
    'manual recheck must retire the Rust runtime arm as well as the UI/main decision');
  const rendererCommandAllowList = mainSource.slice(
    mainSource.indexOf('const allowedCommands'),
    mainSource.indexOf('const INPUT_AUDITION_COMMANDS'),
  );
  assert.doesNotMatch(rendererCommandAllowList, /adopt_cached_input_audition/,
    'the renderer generic engine channel must not expose cache adoption');
  assert.match(mainSource, /enginePayload = \{ check_id: checkId \}/,
    'main must strip arbitrary renderer payload and forward the checked operation id only');
  const stoppedListener = mainSource.slice(
    mainSource.indexOf("engine.on('stopped'"),
    mainSource.indexOf("engine.on('log'", mainSource.indexOf("engine.on('stopped'")),
  );
  assert.ok(
    stoppedListener.indexOf('inputAuditionDecisionCache.clear()')
      < stoppedListener.indexOf('if (!outcome.safe)'),
    'every engine replacement, including a safe stop, must clear launch-scoped audition reuse',
  );
  assert.ok(
    stoppedListener.indexOf('inputAuditionCacheInvalidationTracker.reset()')
      < stoppedListener.indexOf('if (!outcome.safe)'),
    'every engine replacement must reset the meter invalidation baseline',
  );
  const dialogSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'InputAuditionDialog.tsx'), 'utf8');
  const recorderSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'Recorder.tsx'), 'utf8');
  assert.match(dialogSource, /skipInputAudition\(skipCheckId\)/,
    'ready/warning explicit skip must carry the current check id');
  assert.doesNotMatch(
    dialogSource.slice(dialogSource.indexOf("phase === 'warning'")),
    /inputAudition\.confirm[^\n]+phase === 'warning'/,
    'warning UI must not advertise sound-normal confirmation',
  );
  assert.doesNotMatch(dialogSource, /if \(phase === 'checking-cache'\) return null/,
    'cache lookup must keep a real modal mounted so workspace shortcuts cannot leak through');
  assert.match(dialogSource, /\['recording', 'ready', 'warning'\]\.includes\(audition\.status\)/,
    'only non-final audition states may retain an operation check id in the dialog');
  assert.match(dialogSource, /if \(beginPendingRef\.current\)[\s\S]*?cancelAfterBeginRef\.current = true/,
    'cancelling while begin IPC is pending must queue cancellation for the returned check id');
  assert.ok(
    dialogSource.indexOf('beginPendingRef.current = true')
      < dialogSource.indexOf('await window.recorder.beginInputAudition()'),
    'the begin-pending guard must be armed before invoking the engine',
  );
  assert.match(dialogSource, /listenedToEnd[\s\S]*?\[data-dialog-default\]:not\(\[disabled\]\)/,
    'completed playback must move default focus to the enabled confirmation action');
  assert.match(dialogSource, /force \|\| unresolvedAtOpen[\s\S]*?getInputAuditionDecision/,
    'an unresolved engine audition must bypass cache adoption');
  const forcedOpen = recorderSource.slice(
    recorderSource.indexOf('function openInputAudition'),
    recorderSource.indexOf('function resolveInputAudition'),
  );
  assert.match(forcedOpen, /setInputAuditionDecision\(null\)/,
    'manual recheck must immediately retire the renderer decision');
  assert.match(forcedOpen, /clearInputAuditionDecision/,
    'manual recheck must retire the matching trusted-main cache entry');

  const discontinuityGate = recorderSource.slice(
    recorderSource.indexOf('if (discontinuityCount > baseline.count)'),
    recorderSource.indexOf('inputAuditionDiscontinuityBaselineRef.current =',
      recorderSource.indexOf('if (discontinuityCount > baseline.count)')),
  );
  assert.match(discontinuityGate, /setInputAuditionOpen\(false\)/,
    'a new discontinuity must close an already-ready audition dialog');
  assert.match(discontinuityGate, /setInputAuditionForce\(true\)/,
    'a new discontinuity must force a fresh audition instead of reusing the stale result');
  const skipItemGate = recorderSource.slice(
    recorderSource.indexOf('async function skipItem()'),
    recorderSource.indexOf("window.recorder.request('skip_item'"),
  );
  assert.match(skipItemGate, /inputAuditionOpen/);
  assert.match(skipItemGate, /!inputAuditionDecision/,
    'sentence skip mutation must remain blocked until the audition gate is resolved');
  assert.match(recorderSource, /modalOpen: inputAuditionOpen[\s\S]*?document\.querySelector/,
    'workspace shortcuts must be blocked even before the audition modal DOM has committed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
