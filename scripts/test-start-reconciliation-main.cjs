'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

class FakeRequestError extends Error {}
class FakeRequestTimeoutError extends Error {}
class FakeSafeStopTimeoutError extends Error {}
class FakeUnsafeStopError extends Error {}

function validSnapshot(sessionId, status, journalSeq) {
  return {
    schema_version: 1,
    journal_seq: journalSeq,
    session_id: sessionId,
    script_name: 'activation-stopping.csv',
    status,
    device_name: 'test input',
    device_id: 'test-device',
    input_sample_format: 'i32',
    audio_format: {
      sample_rate: 48_000,
      bit_depth: 24,
      encoding: 'pcm',
      channels: 1,
      input_channels: 2,
      input_channel: 1,
    },
    master_audio: 'audio/segments',
    storage_layout_version: 1,
    segment_frames: 48_000 * 300,
    captured_samples: 48_000,
    committed_samples: 48_000,
    overflow_samples: 0,
    started_at: '2026-08-11T00:00:00Z',
    updated_at: `2026-08-11T00:00:0${journalSeq}Z`,
    noise_check: null,
    silence_duration_ms: 1_000,
    silence_threshold_dbfs: -45,
    items: [{
      id: '1',
      text: 'hello',
      label: '',
      status: 'pending',
      attempts: [],
      selected_attempt_id: null,
    }],
  };
}

async function persistSnapshot(sessionDir, snapshot) {
  await fs.mkdir(path.join(sessionDir, 'metadata'), { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ schema_version: 1, session_id: snapshot.session_id })}\n`,
  );
  await fs.writeFile(
    path.join(sessionDir, 'metadata', 'items.snapshot.json'),
    `${JSON.stringify(snapshot)}\n`,
  );
}

class FakeEngineClient extends EventEmitter {
  constructor() {
    super();
    this.runningValue = false;
    this.active = false;
    this.sessionDir = '';
    this.snapshot = null;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.startSessionCalls = 0;
    this.unboundStartSessionCalls = 0;
    this.resumeSessionCalls = 0;
    this.resumeCrashOnNextDispatch = false;
    this.stopSessionCrash = false;
    this.malformedOptionalState = false;
    this.pendingStartResolve = null;
    globalThis.startReconciliationEngine = this;
  }

  get running() {
    return this.runningValue;
  }

  async start() {
    this.startCalls += 1;
    this.runningValue = true;
  }

  async stop() {
    this.stopCalls += 1;
    if (this.stopCalls === 1) {
      this.runningValue = true;
      throw new FakeSafeStopTimeoutError('mock safe-stop timeout');
    }

    this.snapshot = validSnapshot(this.snapshot.session_id, 'stopped', 2);
    await persistSnapshot(this.sessionDir, this.snapshot);
    this.active = false;
    this.malformedOptionalState = false;
    this.runningValue = false;
    this.emit('stopped', { safe: true, code: 0, signal: null });
  }

  async forceStop() {
    throw new Error('the reconciliation path must never force-stop the engine');
  }

  async request(command, payload) {
    if (command === 'get_state_optional') {
      if (!this.active) return { active: false };
      if (this.malformedOptionalState) {
        return { active: true, snapshot: this.snapshot, active_attempt: null };
      }
      return {
        active: true,
        session_dir: this.sessionDir,
        snapshot: this.snapshot,
        active_attempt: null,
      };
    }

    if (command === 'start_session') {
      if (payload.session_id === 'unbound-start-crash') {
        this.unboundStartSessionCalls += 1;
        this.sessionDir = payload.session_dir;
        this.snapshot = validSnapshot(payload.session_id, 'recording', 1);
        await persistSnapshot(this.sessionDir, this.snapshot);
        this.active = false;
        this.runningValue = false;
        this.emit('offline', 'mock helper exit before start binding exists');
        throw new FakeRequestError('mock unbound start lost its helper');
      }
      if (payload.session_id === 'pending-start-status') {
        this.sessionDir = payload.session_dir;
        this.snapshot = validSnapshot(payload.session_id, 'recording', 1);
        await persistSnapshot(this.sessionDir, this.snapshot);
        await new Promise((resolve) => { this.pendingStartResolve = resolve; });
        this.pendingStartResolve = null;
        this.active = true;
        return { session_dir: this.sessionDir, snapshot: this.snapshot };
      }
      this.startSessionCalls += 1;
      this.sessionDir = payload.session_dir;
      this.snapshot = validSnapshot(payload.session_id, 'stopping', 1);
      this.active = true;
      await persistSnapshot(this.sessionDir, this.snapshot);
      if (this.startSessionCalls === 2) {
        this.malformedOptionalState = true;
        throw new FakeRequestError('mock activation returned malformed optional state');
      }
      if (this.startSessionCalls !== 1) {
        throw new Error('an unexpected start_session reached the engine');
      }
      throw new FakeRequestError('mock activation failed after capture resources were created');
    }

    if (command === 'resume_session') {
      assert.equal(
        payload.expected_session_id,
        path.basename(payload.session_dir),
        'every foreground and automatic resume must bind the exact persisted session identity',
      );
      this.resumeSessionCalls += 1;
      this.sessionDir = payload.session_dir;
      this.snapshot = validSnapshot(payload.expected_session_id, 'recording', 1);
      if (this.resumeCrashOnNextDispatch) {
        this.resumeCrashOnNextDispatch = false;
        this.active = false;
        this.runningValue = false;
        this.emit('offline', 'mock helper exit after resume_session dispatch');
        throw new FakeRequestError('mock resume dispatch lost its helper');
      }
      this.active = true;
      return { session_dir: this.sessionDir, snapshot: this.snapshot };
    }

    if (command === 'stop_session') {
      if (this.stopSessionCrash) {
        this.stopSessionCrash = false;
        this.active = false;
        this.runningValue = false;
        this.emit('offline', 'mock helper exit while stopping');
        throw new FakeRequestError('mock stop lost its helper');
      }
      this.active = false;
      this.snapshot = { ...this.snapshot, status: 'stopped' };
      return { session_dir: this.sessionDir, snapshot: this.snapshot };
    }

    return {};
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
  }

  isDestroyed() { return false; }
  send(channel, ...args) { this.messages.push({ channel, args }); }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    FakeBrowserWindow.instances.push(this);
  }

  isDestroyed() { return this.destroyed; }
  removeMenu() {}
  async loadFile() {}
  async loadURL() {}
  show() {}
  focus() {}
  isMinimized() { return false; }
  restore() {}
  hide() {}
  setTitle() {}
  setProgressBar() {}
  close() { this.destroyed = true; this.emit('closed'); }
  destroy() { this.close(); }
}

class FakeTray extends EventEmitter {
  static instances = [];
  constructor() {
    super();
    this.destroyed = false;
    this.menu = null;
    this.tooltip = '';
    FakeTray.instances.push(this);
  }
  setToolTip(value) { this.tooltip = value; }
  setContextMenu(value) { this.menu = value; }
  destroy() { this.destroyed = true; }
}

function activeTray() {
  return FakeTray.instances.findLast((tray) => !tray.destroyed) ?? null;
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-start-reconciliation-'));
  const root = await fs.realpath(lexicalRoot);
  const unauthorizedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-resume-unauthorized-'));
  const originalRealpath = fs.realpath;
  process.env.DATABAKER_DEFAULT_OUTPUT = root;
  const handlers = new Map();
  const appEvents = new Map();
  let microphoneAccessStatus = 'granted';
  let microphonePromptResult = true;
  let microphonePromptCalls = 0;
  let microphonePromptHook = null;
  const electronStub = {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: (name, listener) => appEvents.set(name, listener),
      quit: () => undefined,
      getPath: () => root,
      getAppPath: () => process.cwd(),
      setBadgeCount: () => undefined,
    },
    systemPreferences: {
      getMediaAccessStatus: () => microphoneAccessStatus,
      askForMediaAccess: async () => {
        microphonePromptCalls += 1;
        if (microphonePromptHook) await microphonePromptHook();
        if (microphonePromptResult) microphoneAccessStatus = 'granted';
        return microphonePromptResult;
      },
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (name, listener) => handlers.set(name, listener),
      on: () => undefined,
    },
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: () => undefined }) },
    screen: { getPrimaryDisplay: () => ({ id: 1, workArea: {} }), getAllDisplays: () => [] },
    shell: { openPath: async () => '' },
    Tray: FakeTray,
  };

  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === './engine-client' && parent?.filename.endsWith(`${path.sep}dist-electron${path.sep}main.js`)) {
      return {
        EngineClient: FakeEngineClient,
        EngineRequestError: FakeRequestError,
        EngineRequestTimeoutError: FakeRequestTimeoutError,
        EngineSafeStopTimeoutError: FakeSafeStopTimeoutError,
        EngineUnsafeStopError: FakeUnsafeStopError,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require('../dist-electron/main.js');
  } finally {
    Module._load = originalLoad;
  }

  try {
    await waitFor(
      () => handlers.has('engine:request')
        && handlers.has('recordings:list')
        && FakeBrowserWindow.instances.length > 0
        && globalThis.startReconciliationEngine?.running,
      'main process startup',
    );
    const engine = globalThis.startReconciliationEngine;
    const window = FakeBrowserWindow.instances[0];
    const event = { sender: window.webContents };
    const sessionId = 'activation-stopping';
    const sessionDir = path.join(root, sessionId);
    const resumeSessionId = 'authorized-resume';
    const resumeSessionDir = path.join(root, resumeSessionId);
    const unauthorizedSessionDir = path.join(unauthorizedRoot, 'outside-task');
    await persistSnapshot(
      resumeSessionDir,
      validSnapshot(resumeSessionId, 'stopped', 1),
    );
    await persistSnapshot(
      unauthorizedSessionDir,
      validSnapshot('outside-task', 'stopped', 1),
    );
    assert.equal(
      (await handlers.get('recordings:list')({}, root)).recordings.some(
        (row) => row.session_dir === resumeSessionDir,
      ),
      true,
      'history scan must establish the authorized session identity before resume',
    );

    await assert.rejects(
      handlers.get('engine:request')(event, 'resume_session', {
        session_dir: unauthorizedSessionDir,
      }),
      /\u53ea\u80fd\u7ee7\u7eed\u5df2\u6388\u6743/,
      'an unauthorized raw path must be rejected before resume_session dispatch',
    );
    assert.equal(engine.resumeSessionCalls, 0);

    await fs.writeFile(path.join(resumeSessionDir, 'session.json'), '{broken');
    await handlers.get('engine:request')(event, 'resume_session', {
      session_dir: resumeSessionDir,
    });
    assert.equal(
      engine.resumeSessionCalls,
      1,
      'a damaged session.json must not block a resume backed by consistent snapshots',
    );
    await assert.rejects(
      handlers.get('engine:request')(event, 'stop_session', {
        expected_session_id: 'another-task',
        expected_session_dir: resumeSessionDir,
      }),
      /\u4e0e\u6240\u9009\u5217\u8868\u9879\u4e0d\u4e00\u81f4/,
      'a history action must not stop a different active task',
    );
    assert.equal(engine.active, true, 'identity mismatch must leave capture active');
    await handlers.get('engine:request')(event, 'stop_session', {
      expected_session_id: resumeSessionId,
      expected_session_dir: resumeSessionDir,
    });

    await fs.writeFile(
      path.join(resumeSessionDir, 'session.json'),
      `${JSON.stringify({ schema_version: 1, session_id: 'replaced-identity' })}\n`,
    );
    await assert.rejects(
      handlers.get('engine:request')(event, 'resume_session', {
        session_dir: resumeSessionDir,
      }),
      /\u8eab\u4efd.*\u4e0d\u4e00\u81f4/,
      'a replaced task identity must be rejected before resume_session dispatch',
    );
    assert.equal(engine.resumeSessionCalls, 1);
    await fs.writeFile(
      path.join(resumeSessionDir, 'session.json'),
      `${JSON.stringify({ schema_version: 1, session_id: resumeSessionId })}\n`,
    );

    await handlers.get('engine:request')(event, 'resume_session', {
      session_dir: resumeSessionDir,
    });
    assert.equal(engine.resumeSessionCalls, 2);
    engine.stopSessionCrash = true;
    await assert.rejects(
      handlers.get('engine:request')(event, 'stop_session', {}),
      /mock stop lost its helper/,
      'a stopping crash establishes a crash-seal obligation for the existing task',
    );
    await waitFor(() => engine.running, 'idle helper restart after stopping crash');

    let releaseRealpath;
    let enteredRealpath;
    const realpathGate = new Promise((resolve) => { releaseRealpath = resolve; });
    const realpathEntered = new Promise((resolve) => { enteredRealpath = resolve; });
    let blockNextResumeRealpath = true;
    fs.realpath = async (candidate, ...args) => {
      if (blockNextResumeRealpath
        && path.resolve(String(candidate)) === resumeSessionDir) {
        blockNextResumeRealpath = false;
        enteredRealpath();
        await realpathGate;
      }
      return originalRealpath(candidate, ...args);
    };
    const resumeBeforeDispatch = handlers.get('engine:request')(event, 'resume_session', {
      session_dir: resumeSessionDir,
    });
    await realpathEntered;
    engine.runningValue = false;
    engine.emit('offline', 'mock helper exit while resolveKnownSession is pending');
    releaseRealpath();
    await assert.rejects(
      resumeBeforeDispatch,
      /\u53d6\u4ee3/,
      'a helper exit during resolveKnownSession must cancel the pending resume',
    );
    fs.realpath = originalRealpath;
    await waitFor(() => engine.running, 'idle helper restart after resume preflight crash');
    assert.equal(
      engine.resumeSessionCalls,
      2,
      'pre-dispatch offline must not auto-resume the raw or unresolved path',
    );
    await assert.rejects(
      handlers.get('engine:request')(event, 'resume_session', {
        session_dir: unauthorizedSessionDir,
      }),
      /\u5c1a\u672a\u5b89\u5168\u6536\u5c3e/,
      'pre-dispatch cancellation must preserve the older crash-seal obligation',
    );

    await handlers.get('engine:request')(event, 'resume_session', {
      session_dir: resumeSessionDir,
    });
    await handlers.get('engine:request')(event, 'stop_session', {});

    const resumeCallsBeforeReplacementCrash = engine.resumeSessionCalls;
    engine.resumeCrashOnNextDispatch = true;
    await assert.rejects(
      handlers.get('engine:request')(event, 'resume_session', {
        session_dir: resumeSessionDir,
      }),
      /\u53d6\u4ee3|mock resume dispatch/,
      'the foreground request is superseded after its authorized dispatch crashes',
    );
    const displacedSessionDir = `${resumeSessionDir}.original`;
    await fs.rename(resumeSessionDir, displacedSessionDir);
    await persistSnapshot(
      resumeSessionDir,
      validSnapshot(resumeSessionId, 'stopped', 1),
    );
    await waitFor(
      () => window.webContents.messages.some(({ channel, args }) => (
        channel === 'engine:event'
          && args[0]?.event === 'engine_recovery_failed'
          && /\u66ff\u6362/.test(String(args[0]?.payload?.error))
      )),
      'terminal recovery failure after the bound directory is replaced',
    );
    assert.equal(
      engine.resumeSessionCalls,
      resumeCallsBeforeReplacementCrash + 1,
      'a replaced binding must be rejected before automatic resume_session dispatch',
    );
    await assert.rejects(
      handlers.get('engine:request')(event, 'resume_session', {
        session_dir: unauthorizedSessionDir,
      }),
      /\u5c1a\u672a\u5b89\u5168\u6536\u5c3e/,
      'binding rejection must retain the original crash-seal obligation',
    );
    await fs.rm(resumeSessionDir, { recursive: true, force: true });
    await fs.rename(displacedSessionDir, resumeSessionDir);
    await handlers.get('engine:request')(event, 'resume_session', {
      session_dir: resumeSessionDir,
    });
    await handlers.get('engine:request')(event, 'stop_session', {});

    const resumeCallsBeforeDispatchCrash = engine.resumeSessionCalls;
    engine.resumeCrashOnNextDispatch = true;
    await assert.rejects(
      handlers.get('engine:request')(event, 'resume_session', {
        session_dir: resumeSessionDir,
      }),
      /\u53d6\u4ee3|mock resume dispatch/,
      'the foreground request is superseded when the helper exits after dispatch',
    );
    await waitFor(
      () => engine.resumeSessionCalls === resumeCallsBeforeDispatchCrash + 2 && engine.active,
      'authorized resume recovery after dispatch crash',
    );
    assert.equal(
      engine.resumeSessionCalls,
      resumeCallsBeforeDispatchCrash + 2,
      'a dispatched authorized resume remains eligible for automatic crash recovery',
    );
    await handlers.get('engine:request')(event, 'stop_session', {});
    await fs.rm(resumeSessionDir, { recursive: true, force: true });

    const unboundStartSessionDir = path.join(root, 'unbound-start-crash');
    const resumeCallsBeforeUnboundStart = engine.resumeSessionCalls;
    await assert.rejects(
      handlers.get('engine:request')(event, 'start_session', {
        session_id: 'unbound-start-crash',
        session_dir: unboundStartSessionDir,
      }),
      /\u53d6\u4ee3|mock unbound start/,
      'a start dispatch crash is superseded before a trusted binding exists',
    );
    await waitFor(() => engine.running, 'idle helper after unbound start crash');
    assert.equal(engine.unboundStartSessionCalls, 1);
    assert.equal(
      engine.resumeSessionCalls,
      resumeCallsBeforeUnboundStart,
      'an unbound start crash must never manufacture an automatic resume',
    );
    await assert.rejects(
      handlers.get('engine:request')(event, 'resume_session', {
        session_dir: unauthorizedSessionDir,
      }),
      /\u5c1a\u672a\u5b89\u5168\u6536\u5c3e/,
      'the unbound start crash must retain its crash-seal obligation',
    );
    assert.equal(
      (await handlers.get('recordings:list')({}, root)).recordings.some(
        (row) => row.session_dir === unboundStartSessionDir,
      ),
      true,
      'history refresh may establish the crashed start identity for manual recovery',
    );
    await handlers.get('engine:request')(event, 'resume_session', {
      session_dir: unboundStartSessionDir,
    });
    await handlers.get('engine:request')(event, 'stop_session', {});
    await fs.rm(unboundStartSessionDir, { recursive: true, force: true });

    const resumeCallsBeforeNewStartPreflight = engine.resumeSessionCalls;
    if (process.platform === 'darwin') {
      microphoneAccessStatus = 'not-determined';
      microphonePromptResult = false;
      await assert.rejects(
        handlers.get('engine:request')(event, 'start_session', {
          session_id: 'permission-denied',
          session_dir: path.join(root, 'permission-denied'),
        }),
        /麦克风权限未开启/,
        'macOS microphone denial must block capture before start_session reaches the engine',
      );
      assert.equal(engine.startSessionCalls, 0);
      assert.equal(microphonePromptCalls, 1, 'undetermined permission must show the macOS prompt');
      microphoneAccessStatus = 'granted';
      microphonePromptResult = true;

      microphoneAccessStatus = 'not-determined';
      microphonePromptHook = async () => {
        microphonePromptHook = null;
        engine.runningValue = false;
        engine.emit('offline', 'mock helper exit while microphone permission is pending');
      };
      await assert.rejects(
        handlers.get('engine:request')(event, 'start_session', {
          session_id: 'preflight-helper-crash',
          session_dir: path.join(root, 'preflight-helper-crash'),
        }),
        /取代|退出|helper exit/i,
        'a helper exit before start_session dispatch must cancel only the proposed activation',
      );
      await waitFor(() => engine.running, 'idle helper restart after preflight crash');
      assert.equal(engine.startSessionCalls, 0,
        'permission-prompt crash must happen before start_session reaches the engine');
      assert.equal(engine.resumeSessionCalls, resumeCallsBeforeNewStartPreflight,
        'permission-prompt crash must not manufacture an automatic resume job');
      microphoneAccessStatus = 'granted';
    }

    const pendingStart = handlers.get('engine:request')(event, 'start_session', {
      session_id: 'pending-start-status',
      session_dir: path.join(root, 'pending-start-status'),
    });
    await waitFor(() => engine.pendingStartResolve, 'pending start_session dispatch');
    appEvents.get('window-all-closed')();
    let tray = activeTray();
    assert.match(tray.menu[0].label, /正在启动/);
    assert.match(tray.menu[0].label, /尚未确认写入/);
    assert.doesNotMatch(tray.menu[0].label, /后台录音正在进行/,
      'starting ownership must not be advertised as healthy capture');
    engine.pendingStartResolve();
    await pendingStart;
    tray.emit('click');
    await waitFor(() => activeTray() === null, 'starting-status Tray cleanup');
    await handlers.get('engine:request')(event, 'stop_session', {});
    await fs.rm(path.join(root, 'pending-start-status'), { recursive: true, force: true });

    await assert.rejects(
      handlers.get('engine:request')(event, 'start_session', {
        session_id: sessionId,
        session_dir: sessionDir,
      }),
      /未进入可录制状态|状态对账失败/,
      'active+stopping must never be reconciled as a successful recording start',
    );
    assert.equal(engine.stopCalls, 1, 'an uncertain activation must attempt a safe engine stop');
    assert.equal(engine.running, true, 'a safe-stop timeout must leave the engine process alive');
    tray = activeTray();
    assert.match(tray.menu[0].label, /安全停止.*封存母轨/);
    assert.doesNotMatch(tray.menu[0].label, /后台录音正在进行/,
      'stopping ownership must never be advertised as capture');

    const pendingRows = (await handlers.get('recordings:list')({}, root)).recordings;
    assert.equal(pendingRows.length, 1);
    assert.equal(pendingRows[0].session_dir, await fs.realpath(sessionDir));
    assert.equal(pendingRows[0].status, 'stopping');
    assert.equal(pendingRows[0].is_active, true, 'the pending cleanup must retain active ownership');

    await assert.rejects(
      handlers.get('engine:request')(event, 'start_session', {
        session_id: 'must-stay-blocked',
        session_dir: path.join(root, 'must-stay-blocked'),
      }),
      /正在安全停止/,
      'a second task must remain blocked while capture cleanup is pending',
    );
    assert.equal(engine.startSessionCalls, 1, 'the blocked second start must not reach the engine');

    const stopped = await handlers.get('engine:request')(event, 'stop_session', {});
    assert.equal(engine.stopCalls, 2, 'the operator retry must continue the pending safe stop');
    assert.equal(engine.running, true, 'the idle helper must restart after cleanup completes');
    assert.equal(stopped.session_dir, await fs.realpath(sessionDir));
    assert.equal(stopped.snapshot.status, 'stopped');

    const finishedRows = (await handlers.get('recordings:list')({}, root)).recordings;
    assert.equal(finishedRows.length, 1);
    assert.equal(finishedRows[0].status, 'stopped');
    assert.equal(finishedRows[0].is_active, false, 'successful retry must restore the idle intent');

    const malformedSessionDir = path.join(root, 'malformed-optional-state');
    await assert.rejects(
      handlers.get('engine:request')(event, 'start_session', {
        session_id: 'malformed-optional-state',
        session_dir: malformedSessionDir,
      }),
      /状态对账失败|无法确认的可选任务状态/,
      'active=true without a session directory must trigger fail-closed cleanup',
    );
    assert.equal(engine.startSessionCalls, 2);
    assert.equal(engine.stopCalls, 3, 'malformed reconciliation must safely stop the engine');
    assert.equal(engine.active, false);
    console.log('main process start reconciliation stopping-state test passed');
  } finally {
    fs.realpath = originalRealpath;
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    delete globalThis.startReconciliationEngine;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(unauthorizedRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
