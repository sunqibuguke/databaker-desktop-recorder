'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABAKER_TEST_EXPORT_TIMEOUT_MS = '1000';

class FakeRequestError extends Error {}
class FakeRequestTimeoutError extends Error {}
class FakeSafeStopTimeoutError extends Error {}
class FakeUnsafeStopError extends Error {}

let releaseExport;
let announceExportStarted;
const exportGate = new Promise((resolve) => { releaseExport = resolve; });
const exportStarted = new Promise((resolve) => { announceExportStarted = resolve; });

class FakeEngineClient extends EventEmitter {
  constructor() {
    super();
    this.runningValue = false;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.forceStopCalls = 0;
    this.commands = [];
    globalThis.exportLifecycleEngine = this;
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
    this.runningValue = false;
    this.emit('stopped', { safe: true, code: 0, signal: null });
  }

  async forceStop() {
    this.forceStopCalls += 1;
    throw new Error('export lifecycle must never force-stop the engine');
  }

  async request(command, payload, timeout) {
    this.commands.push({ command, payload, timeout });
    if (command === 'get_state_optional') return { active: false };
    if (command === 'export_session') {
      announceExportStarted();
      await exportGate;
      const exportDir = path.join(payload.session_dir, 'export');
      await fs.mkdir(path.join(exportDir, 'sentences'), { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(exportDir, 'full-track.wav'), 'mock wav'),
        fs.writeFile(path.join(exportDir, 'metadata.json'), '{}\n'),
        fs.writeFile(path.join(exportDir, 'metadata.csv'), 'id,text\n'),
        fs.writeFile(path.join(exportDir, 'status.json'), `${JSON.stringify({
          schema_version: 2,
          status: 'complete',
          export_id: 'export-after-timeout',
          session_id: path.basename(payload.session_dir),
          source: {
            journal_seq: 1,
            committed_samples: 48000,
            selected_attempts: [{ id: '1', attempt_id: null }],
          },
          exported_count: 1,
          skipped_count: 0,
        })}\n`),
      ]);
      // Model the old renderer deadline expiring just before the synchronous
      // Rust command's response is observed. Main must queue a state probe and
      // reconcile the schema-2 bundle, not report the completed export as lost.
      throw new FakeRequestTimeoutError('mock export response timeout');
    }
    return {};
  }
}

class FakeWebContents extends EventEmitter {
  isDestroyed() { return false; }
  send() {}
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

function validSnapshot(sessionId) {
  return {
    schema_version: 1,
    journal_seq: 1,
    session_id: sessionId,
    script_name: 'test.csv',
    status: 'stopped',
    device_name: 'test input',
    audio_format: {
      sample_rate: 48000,
      bit_depth: 24,
      encoding: 'pcm',
      channels: 1,
      input_channels: 2,
      input_channel: 1,
    },
    master_audio: 'audio/segments',
    storage_layout_version: 1,
    segment_frames: 48000 * 300,
    captured_samples: 48000,
    committed_samples: 48000,
    overflow_samples: 0,
    started_at: '2026-08-11T00:00:00Z',
    updated_at: '2026-08-11T00:00:01Z',
    noise_check: null,
    silence_duration_ms: 1000,
    silence_threshold_dbfs: -45,
    items: [{
      id: '1',
      text: 'hello',
      label: '',
      status: 'accepted',
      attempts: [],
      selected_attempt_id: null,
    }],
  };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-export-lifecycle-'));
  const root = await fs.realpath(lexicalRoot);
  const sessionId = 'completed-session';
  const sessionDir = path.join(root, sessionId);
  await fs.mkdir(path.join(sessionDir, 'metadata'), { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ schema_version: 1, session_id: sessionId })}\n`,
  );
  await fs.writeFile(
    path.join(sessionDir, 'metadata', 'items.snapshot.json'),
    `${JSON.stringify(validSnapshot(sessionId))}\n`,
  );
  process.env.DATABAKER_DEFAULT_OUTPUT = root;

  const handlers = new Map();
  const appEvents = new Map();
  const dialogCalls = [];
  let quitCalls = 0;
  const electronStub = {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: (name, listener) => appEvents.set(name, listener),
      quit: () => { quitCalls += 1; },
      getPath: () => root,
      getAppPath: () => process.cwd(),
      setBadgeCount: () => undefined,
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showMessageBox: (...args) => new Promise((resolve) => {
        dialogCalls.push({ options: args.at(-1), resolve });
      }),
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
      'main IPC registration',
    );
    const engine = globalThis.exportLifecycleEngine;
    const window = FakeBrowserWindow.instances[0];
    const event = { sender: window.webContents };
    const list = handlers.get('recordings:list');
    const request = handlers.get('engine:request');
    assert.equal((await list({}, root)).length, 1);

    let exportSettled = false;
    const exportPromise = request(event, 'export_session', { session_dir: sessionDir })
      .finally(() => { exportSettled = true; });
    await exportStarted;
    const exportCall = engine.commands.find(({ command }) => command === 'export_session');
    assert.equal(exportCall.timeout, 1000, 'the test-only long export deadline must reach EngineClient');

    // This is a compressed stand-in for crossing the former 120-second UI
    // boundary. The request must remain owned by the exporting intent.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(exportSettled, false, 'a long export must remain pending instead of timing out early');
    await assert.rejects(
      request(event, 'export_session', { session_dir: sessionDir }),
      /正在导出/,
    );
    await assert.rejects(
      request(event, 'start_session', { session_dir: path.join(root, 'new-session') }),
      /正在导出/,
    );
    await assert.rejects(
      request(event, 'resume_session', { session_dir: sessionDir }),
      /正在导出/,
    );
    await assert.rejects(
      request(event, 'seal_interrupted_session', {
        session_dir: sessionDir,
        session_id: sessionId,
      }),
      /正在导出/,
    );
    await assert.rejects(
      request(event, 'get_state_optional', {}),
      /正在导出/,
    );
    assert.equal(
      engine.commands.filter(({ command }) => command === 'export_session').length,
      1,
      'duplicate export must be rejected before reaching the engine',
    );

    let quitPrevented = false;
    appEvents.get('before-quit')({ preventDefault: () => { quitPrevented = true; } });
    assert.equal(quitPrevented, true);
    await waitFor(() => dialogCalls.length === 1, 'export-aware quit prompt');
    assert.equal(dialogCalls[0].options.title, '录音交付正在导出');
    dialogCalls[0].resolve({ response: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(engine.stopCalls, 0, 'quit must not send shutdown while export is writing');
    assert.equal(quitCalls, 0, 'app must remain open while export is writing');

    releaseExport();
    const result = await exportPromise;
    assert.equal(result.exported_count, 1);
    assert.equal(result.reconciled_after_timeout, true);
    assert.equal(result.export_confirmed_complete, true);
    await waitFor(() => engine.stopCalls === 1 && quitCalls === 1, 'safe quit after export');
    assert.equal(engine.forceStopCalls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('main process export lifecycle tests passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
