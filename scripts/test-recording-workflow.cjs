const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'recording-workflow.ts');
  const inputQualityModulePath = path.join(__dirname, '..', 'src', 'input-quality.ts');
  const captureConfigurationModulePath = path.join(__dirname, '..', 'src', 'capture-configuration.ts');
  const captureActivationModulePath = path.join(__dirname, '..', 'src', 'capture-activation.ts');
  const {
    areAllItemsHandled,
    captureExitAction,
    captureExitDialog,
    inspectorFooterModel,
    shouldStayInTaskAfterStop,
    continuationAfterAccept,
    executeSafePause,
    findNextActionableItemIndex,
    findNextRerecordIndex,
    idlePrimaryAction,
    isLabelBoundary,
    isCurrentSessionNoiseCheckOperation,
    isFinalReview,
    itemHasPendingRetakeDecision,
    itemHasRetainedPreviousWarning,
    itemRequiresRerecord,
    labelTransition,
    noiseCheckShortcutAction,
    noiseLevelPercent,
    noiseWindowState,
    normalizeScriptLabel,
    nextPhysicalItemIndex,
    resolveRunningItemIndex,
    retakeSequenceActionReady,
    selectionIndexAfterStoppedRetake,
    sessionNoiseGate,
    shouldAutoRunSessionNoiseCheck,
    shouldShowSessionNoiseCheckDialog,
    captureEntryOverlay,
    shouldAutoStartAfterAccept,
    shouldContinueRetakeSequence,
    viewShortcutAction,
    workflowShortcutAction,
    workflowShortcutTargetAllowed,
    workspacePosture,
  } = await import(pathToFileURL(modulePath).href);
  const {
    DIGITAL_SILENCE_WARNING,
    inputQualityWarning,
    shouldHandleLiveMeter,
  } = await import(pathToFileURL(inputQualityModulePath).href);
  const {
    DEFAULT_DELIVERY_BIT_DEPTH,
    classifyInputDevice,
    inputDeviceNeedsWarning,
    preferredInputDevice,
    productionSampleRates,
    captureFormatsSupportBitDepth,
    captureConfigurationSupported,
    captureSampleFormatFromBitDepth,
    captureSampleFormatLabel,
    captureSampleFormatsForConfiguration,
    captureShareModeLabel,
    captureShareModeForDevice,
    captureShareModeForSelection,
    configurationsForShareMode,
    inputSampleFormatRepresentationBits,
    minimumInputRepresentationBits,
    normalizeCaptureSampleFormat,
    normalizeCaptureShareMode,
    preferredCaptureSampleFormat,
  } = await import(pathToFileURL(captureConfigurationModulePath).href);
  const { captureActivationTarget } = await import(pathToFileURL(captureActivationModulePath).href);

  const item = (status) => ({ status });

  assert.equal(normalizeScriptLabel('  正常音量  '), '正常音量');
  assert.equal(normalizeScriptLabel(null), '');
  assert.deepEqual(
    labelTransition('  正常音量 ', '高音量  '),
    { changed: true, fromLabel: '正常音量', toLabel: '高音量' },
    '标签转换为 UI 提供 trim 后的前后文案',
  );
  assert.deepEqual(
    labelTransition(' 正常音量', '正常音量 '),
    { changed: false, fromLabel: '正常音量', toLabel: '正常音量' },
  );
  assert.equal(labelTransition('', '高音量').changed, true, '空标签到非空标签也是边界');
  assert.equal(labelTransition(undefined, '   ').changed, false);
  const labelledItems = [
    { label: '正常音量' },
    { label: ' 正常音量 ' },
    { label: '高音量' },
    { label: '' },
  ];
  assert.equal(isLabelBoundary(labelledItems, 0), false, '第一句没有前一句，不是边界');
  assert.equal(isLabelBoundary(labelledItems, 1), false);
  assert.equal(isLabelBoundary(labelledItems, 2), true);
  assert.equal(isLabelBoundary(labelledItems, 3), true);
  assert.equal(isLabelBoundary(labelledItems, 4), false);

  assert.equal(sessionNoiseGate(null, false), 'pending');
  assert.equal(sessionNoiseGate(null, true), 'checking');
  assert.equal(sessionNoiseGate({ passed: false }, false), 'failed');
  assert.equal(sessionNoiseGate({ passed: true }, false), 'ready');
  assert.equal(
    shouldAutoRunSessionNoiseCheck(null, true),
    true,
    'a newly created or resumed activation must run one ambient-noise check',
  );
  assert.equal(
    shouldAutoRunSessionNoiseCheck(null, false),
    false,
    'a renderer reconnect must not duplicate an in-flight or already requested check',
  );
  assert.equal(
    shouldAutoRunSessionNoiseCheck({ passed: false }, true),
    false,
    'a failed completed check waits for an explicit retry instead of auto-looping',
  );
  assert.equal(
    shouldAutoRunSessionNoiseCheck({ passed: true }, true),
    false,
    'a persisted pass keeps every later sentence and retake open',
  );
  assert.equal(sessionNoiseGate(null, false, false), 'ready');
  assert.equal(sessionNoiseGate({ passed: false }, true, false), 'ready');
  assert.equal(
    shouldAutoRunSessionNoiseCheck(null, true, false),
    false,
    'a disabled room-noise rule must not auto-run the gate',
  );
  const firstNoiseOperation = { activation: 1, request: 1, sessionDir: '/recordings/session-a' };
  const retryNoiseOperation = { activation: 1, request: 2, sessionDir: '/recordings/session-a' };
  const recoveredNoiseOperation = { activation: 2, request: 3, sessionDir: '/recordings/session-a' };
  assert.equal(
    isCurrentSessionNoiseCheckOperation(firstNoiseOperation, firstNoiseOperation, 1, '/recordings/session-a'),
    true,
    'the active request may settle its own activation',
  );
  assert.equal(
    isCurrentSessionNoiseCheckOperation(retryNoiseOperation, firstNoiseOperation, 1, '/recordings/session-a'),
    false,
    'an older promise must not settle a newer request in the same activation',
  );
  assert.equal(
    isCurrentSessionNoiseCheckOperation(recoveredNoiseOperation, firstNoiseOperation, 2, '/recordings/session-a'),
    false,
    'an older promise must not settle a recovered activation that reuses the same directory',
  );
  assert.equal(
    isCurrentSessionNoiseCheckOperation(firstNoiseOperation, firstNoiseOperation, 1, '/recordings/session-b'),
    false,
    'a request must not settle after the active session directory changes',
  );
  assert.equal(
    shouldShowSessionNoiseCheckDialog(true, false),
    true,
    'a blocked ambient-noise gate must keep the modal until the room passes',
  );
  assert.equal(
    shouldShowSessionNoiseCheckDialog(true, false, true),
    false,
    'the leave-confirm dialog must replace the noise modal so the operator can exit',
  );
  assert.equal(shouldShowSessionNoiseCheckDialog(true, true), false);
  assert.equal(shouldShowSessionNoiseCheckDialog(false, false), false);
  assert.equal(
    captureEntryOverlay({
      deviceWarningOpen: true,
      noiseCheckBlocksAttempt: true,
      hasCaptureFault: false,
    }),
    'device-warning',
    'a non-production sound-card warning must appear before the room-noise check',
  );
  assert.equal(
    captureEntryOverlay({
      deviceWarningOpen: false,
      noiseCheckBlocksAttempt: true,
      hasCaptureFault: false,
    }),
    'noise-check',
    'after the operator acknowledges the device warning, the room-noise check can open',
  );
  assert.equal(
    captureEntryOverlay({
      deviceWarningOpen: true,
      noiseCheckBlocksAttempt: true,
      hasCaptureFault: false,
      otherOverlayOpen: true,
    }),
    'none',
    'leave-confirm must replace both entry overlays so the operator can exit',
  );
  assert.equal(
    captureEntryOverlay({
      deviceWarningOpen: true,
      noiseCheckBlocksAttempt: true,
      hasCaptureFault: true,
    }),
    'none',
  );
  assert.equal(noiseCheckShortcutAction('Escape', 'Escape', false), 'leave');
  assert.equal(noiseCheckShortcutAction('Escape', 'Escape', true), 'leave');
  assert.equal(noiseCheckShortcutAction(' ', 'Space', false), 'retry');
  assert.equal(
    noiseCheckShortcutAction(' ', 'Space', true),
    'none',
    'space must not restart an in-flight room check',
  );

  assert.equal(noiseWindowState([], 0, -42).state, 'sampling');
  assert.equal(noiseWindowState([-50, -50, -50, -50, -50], 0, -42).state, 'passed');
  assert.equal(noiseWindowState([-50, -30, -50, -50, -50], 0, -42).state, 'failed');
  assert.equal(noiseWindowState([-42, -50, -50, -50, -50], 0, -42).state, 'failed');
  assert.equal(noiseWindowState(Array(10).fill(-55).concat([-30, -55, -55, -55, -55]), 2, -42).state, 'failed');
  assert.equal(noiseLevelPercent(-72), 0);
  assert.equal(noiseLevelPercent(-6), 100);

  assert.equal(
    inputQualityWarning(true, false, true),
    DIGITAL_SILENCE_WARNING,
    'a live exact-digital-silence run must produce the explicit operator warning',
  );
  assert.equal(
    inputQualityWarning(true, true, true),
    '',
    'a capture fault must take visual priority over the non-terminal input-quality warning',
  );
  assert.equal(
    inputQualityWarning(false, false, true),
    '',
    'a stopped task must not retain a late input-quality warning',
  );
  assert.equal(shouldHandleLiveMeter('running'), true);
  assert.equal(shouldHandleLiveMeter('home'), false);
  assert.equal(shouldHandleLiveMeter('setup'), false);

  assert.equal(minimumInputRepresentationBits(16), 16);
  assert.equal(minimumInputRepresentationBits(24), 24);
  assert.equal(minimumInputRepresentationBits(32), 24);
  assert.equal(inputSampleFormatRepresentationBits('F32'), 24);
  assert.equal(normalizeCaptureShareMode(undefined), 'exclusive');
  assert.equal(normalizeCaptureShareMode('shared'), 'shared');
  assert.equal(captureShareModeLabel('exclusive'), '独占');
  assert.equal(captureShareModeLabel('shared'), '系统混音');
  const dualModeDevice = {
    configurations: [
      { min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 2, sample_format: 'i24', share_mode: 'exclusive' },
      { min_sample_rate: 44_100, max_sample_rate: 48_000, channels: 2, sample_format: 'f32', share_mode: 'shared' },
    ],
  };
  assert.deepEqual(
    configurationsForShareMode(dualModeDevice, 'exclusive').map((configuration) => configuration.sample_format),
    ['i24'],
  );
  assert.deepEqual(
    configurationsForShareMode(dualModeDevice, 'shared').map((configuration) => configuration.min_sample_rate),
    [44_100],
  );
  assert.equal(configurationsForShareMode({ configurations: [{ min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 1, sample_format: 'f32' }] }, 'exclusive').length, 0);
  assert.equal(configurationsForShareMode({ configurations: [{ min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 1, sample_format: 'f32' }] }, 'shared').length, 1);
  const asioOnlyDevice = {
    id: 'asio:focusrite',
    name: 'Focusrite USB ASIO',
    backend: 'asio',
    is_default: false,
    sample_rates: [48_000],
    input_channels: [2],
    recommended_buffer_frames: 512,
    configurations: [
      { min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 2, sample_format: 'i24', share_mode: 'exclusive' },
    ],
  };
  assert.equal(captureShareModeForDevice(asioOnlyDevice, 'shared', true), 'exclusive',
    'ASIO must never retain the WASAPI shared-mode state');
  assert.equal(captureConfigurationSupported(asioOnlyDevice, 'exclusive', 48_000, 1, 'i24'), true);
  assert.equal(captureConfigurationSupported(asioOnlyDevice, 'shared', 48_000, 1, 'i24'), false,
    'ASIO-only configurations fail closed if a stale shared mode reaches validation');
  assert.equal(captureConfigurationSupported(asioOnlyDevice, 'exclusive', 48_000, 1, 'i16'), false,
    'explicit recovery settings must still match a driver-advertised input format');
  const sharedOnlyDevice = {
    id: 'wasapi:shared-only',
    name: 'Shared-only WASAPI input',
    backend: 'wasapi',
    is_default: false,
    exclusive_available: false,
    sample_rates: [48_000],
    input_channels: [1],
    configurations: [
      { min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 1, sample_format: 'i16', share_mode: 'shared' },
    ],
  };
  assert.equal(captureShareModeForDevice(sharedOnlyDevice, 'exclusive', true), 'shared',
    'a shared-only WASAPI device must not retain a stale exclusive-mode state');
  assert.equal(captureConfigurationSupported(sharedOnlyDevice, 'shared', 48_000, 1, 'i16'), true);
  assert.equal(captureConfigurationSupported(sharedOnlyDevice, 'exclusive', 48_000, 1, 'i16'), false);
  const dualModeWasapiDevice = {
    ...sharedOnlyDevice,
    id: 'wasapi:dual-mode',
    exclusive_available: true,
    configurations: [
      { min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 1, sample_format: 'i24', share_mode: 'exclusive' },
      { min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 1, sample_format: 'f32', share_mode: 'shared' },
    ],
  };
  const sharedPreset = {
    deviceId: dualModeWasapiDevice.id,
    captureShareMode: 'shared',
  };
  assert.equal(captureShareModeForSelection(dualModeWasapiDevice, sharedPreset, true), 'shared',
    'selecting a shared-mode preset for another WASAPI device must preserve its mode');
  assert.equal(captureShareModeForSelection({ ...dualModeWasapiDevice }, sharedPreset, true), 'shared',
    'refreshing the device inventory must not overwrite a matching shared-mode preset');
  assert.equal(captureShareModeForSelection(dualModeWasapiDevice, null, true), 'exclusive',
    'without a matching preset a dual-mode production device defaults to exclusive');
  assert.equal(captureShareModeForSelection(
    dualModeWasapiDevice,
    { deviceId: 'wasapi:some-other-device', captureShareMode: 'shared' },
    true,
  ), 'exclusive', 'a preset for another device must not control the current device');
  assert.equal(captureShareModeForSelection(
    sharedOnlyDevice,
    { deviceId: sharedOnlyDevice.id, captureShareMode: 'exclusive' },
    true,
  ), 'shared', 'a shared-only endpoint must normalize an unavailable exclusive preset to shared');
  assert.equal(captureShareModeForSelection(
    asioOnlyDevice,
    { deviceId: asioOnlyDevice.id, captureShareMode: 'shared' },
    true,
  ), 'exclusive', 'ASIO must normalize even a legacy shared-mode preset to exclusive');
  const inspectedSnapshot = {
    device_id: 'wasapi:shared-only',
    device_name: 'Shared-only WASAPI input',
    status: 'stopped',
    overflow_samples: 0,
  };
  const readonlyActivation = captureActivationTarget({
    session_dir: '/recordings/readonly-task',
    snapshot: inspectedSnapshot,
    faulted: false,
    data_health: 'readonly',
  }, [sharedOnlyDevice]);
  assert.equal(readonlyActivation.blocked, true,
    'an authoritative readonly inspection must remain blocked even if its snapshot status still says stopped');
  assert.equal(readonlyActivation.device, sharedOnlyDevice);
  assert.equal(captureActivationTarget({
    session_dir: '/recordings/marker-fault',
    snapshot: inspectedSnapshot,
    faulted: true,
    data_health: 'normal',
  }, [sharedOnlyDevice]).blocked, true,
  'an out-of-band audio fault marker returned by inspection must block immediate activation');
  assert.equal(captureActivationTarget({
    session_dir: '/recordings/moved-device',
    snapshot: { ...inspectedSnapshot, device_id: 'wasapi:old-endpoint' },
    faulted: false,
    data_health: 'normal',
  }, [sharedOnlyDevice]).device, null,
  'an explicit missing endpoint id must not fall back to a same-named stale device');
  assert.equal(captureFormatsSupportBitDepth(['I16'], 16), true);
  assert.equal(
    captureFormatsSupportBitDepth(['I16'], 24),
    false,
    'an I16-only input must not be presented as valid for 24-bit delivery',
  );
  assert.equal(
    captureFormatsSupportBitDepth(['I16'], 32),
    false,
    'an I16-only input must not enable 32-bit delivery',
  );
  assert.equal(captureFormatsSupportBitDepth(['I16', 'I24'], 24), true);
  assert.equal(captureFormatsSupportBitDepth(['F32'], 32), true);
  assert.equal(normalizeCaptureSampleFormat('I24'), 'i24');
  assert.equal(normalizeCaptureSampleFormat('pcm24'), null);
  assert.equal(captureSampleFormatFromBitDepth(16), 'i16');
  assert.equal(captureSampleFormatFromBitDepth(32), 'f32');
  assert.equal(DEFAULT_DELIVERY_BIT_DEPTH, 16,
    'new tasks keep PCM16 delivery independently from the selected driver input format');
  assert.equal(preferredCaptureSampleFormat(['f32', 'i16']), 'f32');
  assert.equal(preferredCaptureSampleFormat(['i16', 'i24']), 'i24');
  assert.equal(classifyInputDevice({ name: 'Analogue 1 + 2 (2- Focusrite USB Audio)' }), 'production');
  assert.equal(classifyInputDevice({ name: '麦克风阵列 (Senary Audio)' }), 'rejected');
  assert.equal(classifyInputDevice({ name: 'Headset (Bluetooth)' }), 'rejected');
  assert.equal(classifyInputDevice({ name: 'Microphone Array (Realtek)' }), 'rejected');
  assert.equal(classifyInputDevice({ name: 'Internal Microphone' }), 'discouraged');
  assert.equal(classifyInputDevice({ name: 'Generic Low Latency ASIO Driver' }), 'discouraged');
  assert.equal(inputDeviceNeedsWarning('production'), false);
  assert.equal(inputDeviceNeedsWarning('discouraged'), true);
  assert.equal(inputDeviceNeedsWarning('rejected'), true);
  const picked = preferredInputDevice([
    { id: 'senary', name: '麦克风阵列 (Senary Audio)', is_default: true },
    { id: 'focusrite', name: 'Analogue 1 + 2 (Focusrite USB Audio)' },
  ], 'senary');
  assert.equal(picked?.id, 'focusrite', 'must not auto-select a rejected laptop array even if it is the Windows default');
  const asioPicked = preferredInputDevice([
    { id: 'wasapi:focusrite', name: 'Analogue 1 + 2 (Focusrite USB Audio)', is_default: true },
    { id: 'asio:generic', name: 'Generic Low Latency ASIO', production_recommended: true, production_priority: 100 },
    { id: 'asio:focusrite', name: 'Focusrite USB ASIO', production_recommended: true, production_priority: 200 },
  ], 'wasapi:focusrite');
  assert.equal(asioPicked?.id, 'asio:focusrite', 'ASIO must win over the Focusrite WDM default endpoint');
  const genericAsioNotPreferred = preferredInputDevice([
    { id: 'wasapi:usb', name: 'Analogue Input (USB Audio Device)' },
    { id: 'asio:generic', name: 'Generic Low Latency ASIO Driver', production_recommended: true, production_priority: 100 },
  ]);
  assert.equal(genericAsioNotPreferred?.id, 'wasapi:usb',
    'a generic ASIO wrapper must not override a production USB input merely because it self-reports recommended');
  assert.deepEqual(productionSampleRates([16_000, 44_100, 48_000]), [44_100, 48_000]);
  assert.deepEqual(
    captureSampleFormatsForConfiguration(dualModeDevice.configurations, 48_000, 1),
    ['i24', 'f32'],
  );
  assert.deepEqual(
    captureSampleFormatsForConfiguration(
      dualModeDevice.configurations.filter((configuration) => configuration.share_mode === 'exclusive'),
      48_000,
      1,
    ),
    ['i24'],
  );
  assert.match(captureSampleFormatLabel('i32'), /32/);

  const threeComplete = [item('accepted'), item('skipped'), item('accepted')];
  assert.equal(captureExitAction(threeComplete, false), 'complete');
  assert.equal(captureExitAction([item('accepted'), item('pending')], false), 'pause');
  assert.equal(captureExitAction(threeComplete, true), 'fault');
  assert.equal(
    captureExitDialog(true, false, 'complete'),
    'pause',
    'a live retake in an otherwise complete task must remain safely pausable',
  );
  assert.equal(captureExitDialog(false, false, 'complete'), 'finish');
  assert.equal(captureExitDialog(true, true, 'fault'), 'finish');
  assert.deepEqual(
    inspectorFooterModel(false, false),
    { showEnterCapture: true, showPauseCapture: false, leaveKind: 'view' },
    'view mode must offer enter-capture and leave-view, not pause',
  );
  assert.deepEqual(
    inspectorFooterModel(true, false),
    { showEnterCapture: false, showPauseCapture: true, leaveKind: 'task' },
    'live capture must split pause-in-place from leaving the task',
  );
  assert.deepEqual(
    inspectorFooterModel(true, true),
    { showEnterCapture: false, showPauseCapture: false, leaveKind: 'fault' },
    'a capture fault must not offer a healthy pause; only the fault-aware finish/leave path remains',
  );
  assert.deepEqual(
    inspectorFooterModel(false, true),
    { showEnterCapture: true, showPauseCapture: false, leaveKind: 'view' },
    'a stale fault flag in view mode must not hide enter-capture or invent a pause button',
  );
  assert.equal(
    shouldStayInTaskAfterStop('inspect', 'finish', false),
    true,
    'a healthy finish-capture must stay in view instead of bouncing to the list',
  );
  assert.equal(
    shouldStayInTaskAfterStop('inspect', 'finish', true),
    false,
    'a finish-capture whose seal is faulted or only reconciled must return to the list for repair',
  );
  assert.equal(
    shouldStayInTaskAfterStop('home', 'finish', false),
    false,
    'an explicit leave destination must still return home after a healthy seal',
  );
  assert.equal(
    shouldStayInTaskAfterStop('inspect', 'pause', true),
    true,
    'pause-in-place keeps its own stay policy even when the stopped snapshot is faulted',
  );
  assert.equal(
    shouldStayInTaskAfterStop('inspect', 'fault', true),
    true,
    'fault stays are decided by the destination, not by this finish-only override',
  );
  assert.equal(areAllItemsHandled(threeComplete), true, 'three handled rows must enter the terminal state');
  assert.equal(idlePrimaryAction(threeComplete, 2), 'finish', 'the last handled row must offer finish, not another take');
  assert.equal(
    idlePrimaryAction(threeComplete, -1),
    'finish',
    'a completed task may clear the row selection without losing its finish action',
  );
  assert.equal(
    workflowShortcutAction('Space', ' ', idlePrimaryAction(threeComplete, -1), false),
    'finish',
    'Space must still finish after the terminal row selection is cleared',
  );
  assert.equal(
    workflowShortcutAction('Space', ' ', idlePrimaryAction(threeComplete, 2), true),
    'finish',
    'Space in the terminal state must open the existing finish confirmation',
  );
  assert.equal(
    workflowShortcutAction('KeyR', 'r', idlePrimaryAction(threeComplete, 2), true),
    'retake',
    'R must remain an explicit way to reopen a handled row from the terminal state',
  );

  const pendingReview = [item('accepted'), item('review'), item('accepted')];
  assert.equal(
    findNextActionableItemIndex(pendingReview, 0),
    1,
    'navigation must not skip a review row',
  );
  assert.equal(isFinalReview(pendingReview, 1), true, 'the final review must say it completes the task');
  assert.equal(
    isFinalReview([item('review'), item('interrupted')], 0),
    false,
    'an unknown or interrupted row must not be silently counted as handled',
  );
  assert.deepEqual(
    continuationAfterAccept([item('accepted'), item('pending'), item('accepted')], 0),
    { kind: 'start', nextIndex: 1 },
    'accepting a sentence names the next pending sentence as the start candidate',
  );
  assert.equal(
    shouldAutoStartAfterAccept(
      { kind: 'start', nextIndex: 1 },
      { autoStartNext: true, pauseOnLabelChange: false, labelChanged: true },
    ),
    true,
    'label changes keep the ordinary two-click rhythm while pause is off',
  );
  assert.equal(
    shouldAutoStartAfterAccept(
      { kind: 'start', nextIndex: 1 },
      { autoStartNext: true, pauseOnLabelChange: true, labelChanged: true },
    ),
    false,
    'the optional label-boundary rule pauses before the changed label',
  );
  assert.equal(
    shouldAutoStartAfterAccept(
      { kind: 'start', nextIndex: 1 },
      { autoStartNext: true, pauseOnLabelChange: true, labelChanged: false },
    ),
    true,
    'the label-boundary rule must not interrupt an unchanged label',
  );
  assert.equal(
    shouldAutoStartAfterAccept(
      { kind: 'start', nextIndex: 1 },
      { autoStartNext: false, pauseOnLabelChange: false, labelChanged: false },
    ),
    false,
    'the global auto-start rule must be able to keep confirm from arming the next take',
  );
  assert.equal(
    shouldAutoStartAfterAccept(
      { kind: 'review', nextIndex: 1 },
      { autoStartNext: true, pauseOnLabelChange: false, labelChanged: false },
    ),
    false,
  );
  for (const continuation of [{ kind: 'finish' }, { kind: 'blocked' }]) {
    assert.equal(
      shouldAutoStartAfterAccept(
        continuation,
        { autoStartNext: true, pauseOnLabelChange: false, labelChanged: false },
      ),
      false,
      `${continuation.kind} must never arm another recording`,
    );
  }
  assert.deepEqual(
    continuationAfterAccept([item('accepted'), item('review'), item('pending')], 0),
    { kind: 'review', nextIndex: 1 },
    'an existing review must be shown instead of being silently re-recorded',
  );
  assert.deepEqual(
    continuationAfterAccept(threeComplete, 2),
    { kind: 'finish' },
    'the final accepted sentence must enter the existing finish state',
  );
  assert.deepEqual(
    continuationAfterAccept([item('accepted'), item('interrupted')], 0),
    { kind: 'blocked' },
    'an unexpected item state must not be skipped or started',
  );

  const acceptedBeforePending = [item('accepted'), item('pending'), item('skipped')];
  assert.equal(
    idlePrimaryAction(acceptedBeforePending, 0),
    'retake-only',
    'an accepted row must never make the ordinary primary button start a new take',
  );
  assert.equal(
    workflowShortcutAction('Space', ' ', 'retake-only', true),
    'none',
    'Space must not re-record an accepted or skipped row',
  );
  assert.equal(
    workflowShortcutAction('KeyR', 'r', 'retake-only', true),
    'retake',
    'R remains an explicit retake action',
  );
  assert.equal(
    retakeSequenceActionReady(true, item('accepted'), false),
    true,
    'an accepted physical next sentence offers Space as the next retake action',
  );
  assert.equal(
    retakeSequenceActionReady(true, item('accepted'), true),
    false,
    'an unresolved retake decision must stay on its use-or-discard action',
  );
  assert.equal(
    retakeSequenceActionReady(true, item('pending'), false),
    false,
    'ordinary pending work must keep its first-take action',
  );
  assert.equal(
    shouldContinueRetakeSequence(true, 0, 1, item('accepted')),
    true,
    'a retake chain continues only onto a distinct handled physical next sentence',
  );
  assert.equal(
    shouldContinueRetakeSequence(true, 1, 1, item('accepted')),
    false,
    'the last sentence ends the retake chain instead of wrapping',
  );
  assert.equal(
    shouldContinueRetakeSequence(true, 0, 1, item('pending')),
    false,
    'a pending physical next sentence returns to the ordinary first-take workflow',
  );

  assert.equal(workspacePosture('running', false), 'view');
  assert.equal(workspacePosture('running', true), 'record');
  assert.equal(workspacePosture('home', false), 'home');
  assert.equal(viewShortcutAction('Space', ' '), 'preview');
  assert.equal(viewShortcutAction('KeyP', 'p'), 'preview');
  assert.equal(viewShortcutAction('KeyR', 'r'), 'enter-capture');
  assert.equal(viewShortcutAction('KeyS', 's'), 'none');
  assert.equal(workflowShortcutTargetAllowed({
    modalOpen: false, formControl: false, button: false, professionalItem: false,
  }), true, 'workspace shortcuts remain available when focus is on the workspace surface');
  assert.equal(workflowShortcutTargetAllowed({
    modalOpen: false, formControl: false, button: true, professionalItem: true,
  }), true, 'a focused sentence row must keep R/P/S/Space available');
  assert.equal(workflowShortcutTargetAllowed({
    modalOpen: false, formControl: false, button: true, professionalItem: false,
  }), false, 'ordinary buttons keep their native keyboard action');
  assert.equal(workflowShortcutTargetAllowed({
    modalOpen: false, formControl: true, button: false, professionalItem: false,
  }), false, 'form controls must never leak keys into recording shortcuts');
  assert.equal(workflowShortcutTargetAllowed({
    modalOpen: true, formControl: false, button: true, professionalItem: true,
  }), false, 'a modal blocks shortcuts even if the prior focused node was a sentence row');
  assert.equal(
    resolveRunningItemIndex(
      [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'accepted' }, { id: 'c', status: 'accepted' }],
      null,
      'c',
    ),
    2,
    'entering capture from view must keep the sentence the operator was inspecting',
  );
  assert.equal(
    resolveRunningItemIndex(
      [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'pending' }],
      null,
      null,
    ),
    1,
    'arming from the list without a kept sentence still lands on the first pending row',
  );
  assert.equal(
    resolveRunningItemIndex(
      [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'accepted' }],
      'b',
      'a',
    ),
    1,
    'a live attempt wins over a kept inspect sentence',
  );

  const wrappedReview = [item('review'), item('accepted'), item('accepted')];
  assert.equal(
    findNextActionableItemIndex(wrappedReview, 2),
    0,
    'navigation must wrap to an earlier review row',
  );

  const acceptedAttempt = (attemptId) => ({ attempt_id: attemptId, status: 'accepted' });
  const rerecordAttempt = (attemptId) => ({ attempt_id: attemptId, status: 'needs_rerecord' });
  const unresolvedRerecord = {
    status: 'review',
    attempts: [rerecordAttempt('a1')],
    selected_attempt_id: null,
  };
  const retainedPrevious = {
    status: 'accepted',
    attempts: [acceptedAttempt('old'), rerecordAttempt('new')],
    selected_attempt_id: 'old',
  };
  assert.equal(
    itemHasPendingRetakeDecision({
      status: 'review',
      attempts: [{ attempt_id: 'first', status: 'recorded' }],
      selected_attempt_id: null,
    }),
    false,
    '首录的单一候选不是重录决策',
  );
  assert.equal(
    itemHasPendingRetakeDecision({
      status: 'review',
      attempts: [
        { attempt_id: 'first', status: 'recorded' },
        { attempt_id: 'retake', status: 'recorded' },
      ],
      selected_attempt_id: null,
    }),
    true,
    '无旧 selected 的再次录制也必须从 attempt 历史恢复为重录决策',
  );
  assert.equal(
    itemHasPendingRetakeDecision({
      status: 'review',
      attempts: [
        { attempt_id: 'bad', status: 'needs_rerecord' },
        { attempt_id: 'retake', status: 'recorded' },
      ],
      selected_attempt_id: null,
    }),
    true,
    '异常尝试后的干净重录在重启后仍走物理下一句',
  );
  assert.equal(
    selectionIndexAfterStoppedRetake(
      [retainedPrevious, { status: 'pending', attempts: [], selected_attempt_id: null }],
      0,
      true,
      1,
    ),
    1,
    '暂停一条异常重录时不得用旧 keepItemId 覆盖已选定的物理下一句',
  );
  assert.equal(
    selectionIndexAfterStoppedRetake(
      [unresolvedRerecord, { status: 'pending', attempts: [], selected_attempt_id: null }],
      0,
      true,
      1,
    ),
    0,
    '无旧合格版本的异常尝试在暂停后仍停在本句待重录',
  );
  assert.equal(
    selectionIndexAfterStoppedRetake(
      [retainedPrevious, { status: 'pending', attempts: [], selected_attempt_id: null }],
      0,
      true,
      2,
    ),
    0,
    '旧“沿用旧版”警告不得把本次无语音取消误当成新异常尝试',
  );
  assert.equal(
    itemRequiresRerecord(unresolvedRerecord),
    true,
    '最新尝试需重录且没有可用选中版本时才进入问题队列',
  );
  assert.equal(
    idlePrimaryAction([unresolvedRerecord], 0),
    'start',
    '定位到无合格版本的问题句后，Space 必须直接开始重录而不是尝试确认异常版本',
  );
  assert.equal(itemHasRetainedPreviousWarning(unresolvedRerecord), false);
  assert.equal(itemRequiresRerecord(retainedPrevious), false);
  assert.equal(
    itemHasRetainedPreviousWarning(retainedPrevious),
    true,
    '最新重录异常但旧合格版本仍被选中时只显示沿用警告',
  );
  assert.equal(
    itemRequiresRerecord({
      status: 'review',
      attempts: [rerecordAttempt('a1'), { attempt_id: 'a2', status: 'recorded' }],
      selected_attempt_id: null,
    }),
    false,
    '只检查最新尝试，不应让较早的 needs_rerecord 污染新版本',
  );
  assert.equal(
    itemRequiresRerecord({
      status: 'accepted',
      attempts: [acceptedAttempt('old'), rerecordAttempt('new')],
      selected_attempt_id: 'missing',
    }),
    true,
    '指向不存在尝试的 selected id 不是可用旧版本',
  );
  assert.equal(
    itemRequiresRerecord({
      status: 'accepted',
      attempts: [{ attempt_id: 'old', status: 'rejected_by_operator' }, rerecordAttempt('new')],
      selected_attempt_id: 'old',
    }),
    true,
    '被拒绝的 selected 尝试不得被当作合格回退版本',
  );
  assert.equal(itemRequiresRerecord({ status: 'pending', attempts: [], selected_attempt_id: null }), false);

  const rerecordQueue = [
    unresolvedRerecord,
    { status: 'accepted', attempts: [acceptedAttempt('b1')], selected_attempt_id: 'b1' },
    { ...unresolvedRerecord, attempts: [rerecordAttempt('c1')] },
    retainedPrevious,
  ];
  assert.equal(findNextRerecordIndex(rerecordQueue, -1), 0, '无当前句时从第一条问题句开始');
  assert.equal(findNextRerecordIndex(rerecordQueue, 0), 2, '向后定位下一条问题句');
  assert.equal(findNextRerecordIndex(rerecordQueue, 2), 0, '到末尾后显式回绕');
  assert.equal(findNextRerecordIndex([retainedPrevious], 0), -1, '沿用旧版本的警告不进入需重录队列');
  assert.equal(findNextRerecordIndex([], 0), -1);
  assert.equal(nextPhysicalItemIndex(29, 50), 30, '重录第 30 句后只定位到物理第 31 句');
  assert.equal(nextPhysicalItemIndex(49, 50), 49, '末句重录决策后停留在末句');
  assert.equal(nextPhysicalItemIndex(-1, 50), 0);
  assert.equal(nextPhysicalItemIndex(0, 0), -1);

  const successfulPauseCalls = [];
  const stoppedState = { snapshot: { status: 'stopped' } };
  assert.equal(
    await executeSafePause({
      hasActiveAttempt: true,
      closeActiveAttempt: async () => { successfulPauseCalls.push('attempt'); return true; },
      stopSession: async () => { successfulPauseCalls.push('session'); return stoppedState; },
      closePrompter: async () => { successfulPauseCalls.push('prompter'); },
    }),
    stoppedState,
    'safe pause must return the durable stop result',
  );
  assert.deepEqual(
    successfulPauseCalls,
    ['attempt', 'session', 'prompter'],
    'an active sentence must close before the continuous session is sealed',
  );

  const failedAttemptCalls = [];
  assert.equal(
    await executeSafePause({
      hasActiveAttempt: true,
      closeActiveAttempt: async () => { failedAttemptCalls.push('attempt'); return false; },
      stopSession: async () => { failedAttemptCalls.push('session'); return null; },
      closePrompter: async () => { failedAttemptCalls.push('prompter'); },
    }),
    null,
    'a healthy session that still rejects stop must keep the UI in place',
  );
  assert.deepEqual(
    failedAttemptCalls,
    ['attempt', 'session'],
    'safe pause must try the authoritative session seal after a sentence-close failure',
  );

  const faultFallbackCalls = [];
  assert.equal(
    await executeSafePause({
      hasActiveAttempt: true,
      closeActiveAttempt: async () => { faultFallbackCalls.push('attempt'); return false; },
      stopSession: async () => { faultFallbackCalls.push('session'); return stoppedState; },
      closePrompter: async () => { faultFallbackCalls.push('prompter'); },
    }),
    stoppedState,
    'a fault seal may safely stop the session even when the take cannot mutate',
  );
  assert.deepEqual(faultFallbackCalls, ['attempt', 'session', 'prompter']);

  const failedStopCalls = [];
  assert.equal(
    await executeSafePause({
      hasActiveAttempt: false,
      closeActiveAttempt: async () => { failedStopCalls.push('attempt'); return true; },
      stopSession: async () => { failedStopCalls.push('session'); return null; },
      closePrompter: async () => { failedStopCalls.push('prompter'); },
    }),
    null,
    'a failed session seal must not report a successful pause',
  );
  assert.deepEqual(failedStopCalls, ['session'], 'the UI must stay put and keep the prompter when stop_session fails');

  const recorderSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'Recorder.tsx'), 'utf8');
  const newRecordingSource = recorderSource.slice(
    recorderSource.indexOf('function beginNewRecording()'),
    recorderSource.indexOf('function returnToRecordings()'),
  );
  assert.doesNotMatch(newRecordingSource, /setCaptureShareMode\('shared'\)/,
    'new recording must not overwrite an ASIO-only device with WASAPI shared mode');
  assert.match(newRecordingSource, /captureShareModeForDevice/);
  const startSessionSource = recorderSource.slice(
    recorderSource.indexOf('async function startSession('),
    recorderSource.indexOf('function presentActivationFailure('),
  );
  assert.match(startSessionSource, /captureConfigurationSupported/,
    'explicit recovery settings must pass the same device capability validation as setup');
  assert.doesNotMatch(startSessionSource, /settingsAlreadyChosen/,
    'supplying recovery settings must never bypass capture configuration validation');
  assert.match(startSessionSource, /captureActivationTarget\([\s\S]*?result,[\s\S]*?devices/,
    'recreate-and-activate must carry the newly created authoritative snapshot across the render boundary');
  const activationFailureSource = recorderSource.slice(
    recorderSource.indexOf('function presentActivationFailure('),
    recorderSource.indexOf('function clearActivationFailure('),
  );
  assert.match(activationFailureSource, /const activationSnapshot = target\?\.snapshot \?\? snapshot/,
    'activation recovery must prefer the explicitly activated snapshot over ambient React state');
  assert.match(activationFailureSource, /const activationDevice = target \? target\.device : selectedDevice/,
    'activation recovery must preserve an explicit missing device instead of falling back to a stale selection');
  assert.match(activationFailureSource, /presentActivationFailure\(caught, target\)/,
    'activation failures must be presented with the same target used by activate_session');
  assert.match(activationFailureSource, /const targetWorkspaceFaulted = target \? target\.blocked : workspaceFaulted/,
    'inspect-and-activate must preserve authoritative readonly/faulted health instead of checking snapshot status alone');
  const inspectionSource = recorderSource.slice(
    recorderSource.indexOf('function enterInspectionWorkspace('),
    recorderSource.indexOf('function stageScriptPreview('),
  );
  assert.match(inspectionSource, /scriptPreviewFromSnapshotItems\(nextSnapshot\.items\)/,
    'history inspection must rebuild preview and script items from its authoritative snapshot');
  assert.match(inspectionSource, /setScriptPreview\(authoritativeScriptPreview\)/,
    'history inspection must not retain a preview imported for an earlier task');
  const recreateSource = recorderSource.slice(
    recorderSource.indexOf('async function recreateFromActivationFailure('),
    recorderSource.indexOf('async function refreshState('),
  );
  assert.match(recreateSource, /items: sourceItems/,
    'history recovery must pass the failed task items explicitly instead of ambient setup state');
  const historicalActivationSource = recorderSource.slice(
    recorderSource.indexOf('async function openHistoricalRecording('),
    recorderSource.indexOf('async function exportRecordingArtifact('),
  );
  assert.match(historicalActivationSource, /captureActivationTarget\([\s\S]*?inspected,[\s\S]*?devices/,
    'inspect-and-activate must carry the inspected snapshot rather than relying on an old render closure');

  console.log('recording workflow policy tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
