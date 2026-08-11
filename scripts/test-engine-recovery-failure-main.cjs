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

function validSnapshot(sessionId) {
  return {
    schema_version: 1,
    journal_seq: 1,
    session_id: sessionId,
    script_name: 'recovery-test.csv',
    status: 'recording',
    device_name: 'test input',
    device_id: 'test-device',
    input_sample_format: 'i32',
    audio_format: {
      sample_rate: 48_000,
      bit_depth: 24,
      encoding: 'pcm',
      channels: 1,
      input_channels: 1,
      input_channel: 1,
    },
    master_audio: 'audio/segments',
    storage_layout_version: 1,
    segment_frames: 48_000 * 300,
    captured_samples: 48_000,
    committed_samples: 48_000,
    overflow_samples: 0,
    started_at: '2026-08-11T00:00:00Z',
    updated_at: '2026-08-11T00:00:01Z',
    noise_check: null,
    silence_duration_ms: 1_000,
    silence_threshold_dbfs: -45,
    items: [{
      id: '1', text: 'hello', label: '', status: 'pending', attempts: [], selected_attempt_id: null,
    }],
  };
}

class FakeEngineClient extends EventEmitter {
  constructor() {
    super();
    this.runningValue = false;
    this.failRecovery = false;
    this.recoveryStartCalls = 0;
    this.stopCalls = 0;
    globalThis.recoveryFailureEngine = this;
  }

  get running() { return this.runningValue; }

  async start() {
    if (this.failRecovery) {
      this.recoveryStartCalls += 1;
      this.runningValue = false;
      throw new Error(`mock device unavailable ${this.recoveryStartCalls}`);
    }
    this.runningValue = true;
  }

  async stop() {
    this.stopCalls += 1;
    this.runningValue = false;
    this.emit('stopped', { safe: true, code: 0, signal: null });
  }

  async forceStop() {
    throw new Error('automatic recovery must never force-stop the sidecar');
  }

  async request(command, payload) {
    if (command === 'get_state_optional') return { active: false };
    if (command === 'start_session') {
      const snapshot = validSnapshot(payload.session_id);
      await fs.mkdir(path.join(payload.session_dir, 'metadata'), { recursive: true });
      await fs.writeFile(
        path.join(payload.session_dir, 'session.json'),
        `${JSON.stringify({ schema_version: 1, session_id: payload.session_id })}\n`,
      );
      await fs.writeFile(
        path.join(payload.session_dir, 'metadata', 'items.snapshot.json'),
        `${JSON.stringify(snapshot)}\n`,
      );
      return { session_dir: payload.session_dir, snapshot };
    }
    if (command === 'resume_session') throw new Error('resume request should not run when start failed');
    return {};
  }

  crash() {
    this.failRecovery = true;
    this.runningValue = false;
    this.emit('offline', 'mock unexpected engine exit');
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

async function waitFor(predicate, label, attempts = 2_000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-recovery-failure-'));
  const root = await fs.realpath(lexicalRoot);
  process.env.DATABAKER_DEFAULT_OUTPUT = root;
  const handlers = new Map();
  const electronStub = {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: () => undefined,
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
      () => handlers.has('engine:request') && FakeBrowserWindow.instances.length > 0,
      'main process startup',
    );
    const window = FakeBrowserWindow.instances[0];
    const sessionId = 'terminal-recovery-failure';
    const sessionDir = path.join(root, sessionId);
    await handlers.get('engine:request')(
      { sender: window.webContents },
      'start_session',
      { session_id: sessionId, session_dir: sessionDir },
    );

    const engine = globalThis.recoveryFailureEngine;
    engine.crash();
    await waitFor(
      () => window.webContents.messages.some(({ channel, args }) => (
        channel === 'engine:event' && args[0]?.event === 'engine_recovery_failed'
      )),
      'structured terminal recovery event',
    );

    const failureMessages = window.webContents.messages.filter(({ channel, args }) => (
      channel === 'engine:event' && args[0]?.event === 'engine_recovery_failed'
    ));
    assert.equal(engine.recoveryStartCalls, 3, 'automatic recovery must stop after three attempts');
    assert.equal(failureMessages.length, 1, 'the terminal failure event must be emitted exactly once');
    assert.deepEqual(failureMessages[0].args[0].payload, {
      session_dir: await fs.realpath(sessionDir),
      error: 'mock device unavailable 3',
    });
    assert.equal(
      window.webContents.messages.some(({ channel, args }) => (
        channel === 'engine:event' && args[0]?.event === 'engine_recovered'
      )),
      false,
      'a failed recovery must never publish a recovered state',
    );
    console.log('main process terminal engine recovery event test passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
