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
    this.malformedOptionalState = false;
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

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-start-reconciliation-'));
  const root = await fs.realpath(lexicalRoot);
  process.env.DATABAKER_DEFAULT_OUTPUT = root;
  const handlers = new Map();
  const appEvents = new Map();
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
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (name, listener) => handlers.set(name, listener),
      on: () => undefined,
    },
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: () => undefined }) },
    screen: { getPrimaryDisplay: () => ({ id: 1, workArea: {} }), getAllDisplays: () => [] },
    shell: { openPath: async () => '' },
    Tray: class extends EventEmitter {
      setToolTip() {}
      setContextMenu() {}
      destroy() {}
    },
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

    const pendingRows = await handlers.get('recordings:list')({}, root);
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

    const finishedRows = await handlers.get('recordings:list')({}, root);
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
    delete globalThis.startReconciliationEngine;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
