const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'recording-workflow.ts');
  const inputQualityModulePath = path.join(__dirname, '..', 'src', 'input-quality.ts');
  const captureConfigurationModulePath = path.join(__dirname, '..', 'src', 'capture-configuration.ts');
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
    selectionIndexAfterStoppedRetake,
    sessionNoiseGate,
    shouldAutoRunSessionNoiseCheck,
    shouldShowSessionNoiseCheckDialog,
    captureEntryOverlay,
    shouldAutoStartAfterAccept,
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
    classifyInputDevice,
    inputDeviceNeedsWarning,
    preferredInputDevice,
    productionSampleRates,
    captureFormatsSupportBitDepth,
    captureSampleFormatFromBitDepth,
    captureSampleFormatLabel,
    captureSampleFormatsForConfiguration,
    captureShareModeLabel,
    configurationsForShareMode,
    deliveryBitDepthForCaptureFormat,
    inputSampleFormatRepresentationBits,
    minimumInputRepresentationBits,
    normalizeCaptureSampleFormat,
    normalizeCaptureShareMode,
    preferredCaptureSampleFormat,
  } = await import(pathToFileURL(captureConfigurationModulePath).href);

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
  assert.equal(deliveryBitDepthForCaptureFormat('i24'), 24);
  assert.equal(deliveryBitDepthForCaptureFormat('i32'), 32);
  assert.equal(preferredCaptureSampleFormat(['f32', 'i16']), 'f32');
  assert.equal(preferredCaptureSampleFormat(['i16', 'i24']), 'i24');
  assert.equal(classifyInputDevice({ name: 'Analogue 1 + 2 (2- Focusrite USB Audio)' }), 'production');
  assert.equal(classifyInputDevice({ name: '麦克风阵列 (Senary Audio)' }), 'rejected');
  assert.equal(classifyInputDevice({ name: 'Headset (Bluetooth)' }), 'rejected');
  assert.equal(classifyInputDevice({ name: 'Microphone Array (Realtek)' }), 'rejected');
  assert.equal(classifyInputDevice({ name: 'Internal Microphone' }), 'discouraged');
  assert.equal(inputDeviceNeedsWarning('production'), false);
  assert.equal(inputDeviceNeedsWarning('discouraged'), true);
  assert.equal(inputDeviceNeedsWarning('rejected'), true);
  const picked = preferredInputDevice([
    { id: 'senary', name: '麦克风阵列 (Senary Audio)', is_default: true },
    { id: 'focusrite', name: 'Analogue 1 + 2 (Focusrite USB Audio)' },
  ], 'senary');
  assert.equal(picked?.id, 'focusrite', 'must not auto-select a rejected laptop array even if it is the Windows default');
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

  console.log('recording workflow policy tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
