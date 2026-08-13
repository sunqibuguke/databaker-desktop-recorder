'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABAKER_LICENSE_DISABLED = '1';

class FakeRequestError extends Error {}
class FakeRequestTimeoutError extends Error {}
class FakeSafeStopTimeoutError extends Error {}
class FakeUnsafeStopError extends Error {}

let releaseWaveform;
let announceWaveformStarted;
const waveformGate = new Promise((resolve) => { releaseWaveform = resolve; });
const waveformStarted = new Promise((resolve) => { announceWaveformStarted = resolve; });

class FakeEngineClient extends EventEmitter {
  constructor() {
    super();
    this.runningValue = false;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.commands = [];
    this.activeCommands = [];
    globalThis.inspectPreviewEngine = this;
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
    this.runningValue = false;
    this.emit('stopped', { safe: false, code: null, signal: 'SIGTERM' });
  }

  async request(command, payload) {
    this.commands.push({ command, payload });
    this.activeCommands.push(command);
    try {
      if (command === 'get_state_optional') return { active: false };
      if (command === 'preview_session_waveform') {
        announceWaveformStarted();
        await waveformGate;
        return { bins: [[0, 0.1]], sample_rate: 48000, start_sample: 0, end_sample: 48000 };
      }
      if (command === 'render_session_attempt') {
        return { file_path: path.join(payload.session_dir, 'preview', '1-a1.wav') };
      }
      if (command === 'inspect_session') {
        return { session_dir: payload.session_dir, snapshot: validSnapshot(path.basename(payload.session_dir)), faulted: false };
      }
      return {};
    } finally {
      this.activeCommands = this.activeCommands.filter((name) => name !== command);
    }
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

class FakeTray extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.menu = null;
  }
  setToolTip() {}
  setContextMenu(value) { this.menu = value; }
  destroy() { this.destroyed = true; }
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
      status: 'review',
      attempts: [{
        attempt_id: '1-a1',
        start_sample: 0,
        end_sample: 48000,
        status: 'usable',
        created_at: '2026-08-11T00:00:01Z',
      }],
      selected_attempt_id: '1-a1',
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
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-inspect-preview-'));
  const root = await fs.realpath(lexicalRoot);
  const sessionId = 'inspect-preview-session';
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
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
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
      () => handlers.has('engine:request') && FakeBrowserWindow.instances.length > 0,
      'main IPC registration',
    );
    const engine = globalThis.inspectPreviewEngine;
    const window = FakeBrowserWindow.instances[0];
    const event = { sender: window.webContents };
    const list = handlers.get('recordings:list');
    const request = handlers.get('engine:request');
    const listed = await list(event, root);
    assert.equal(listed.recordings.some((row) => row.session_id === sessionId), true);

    const previewPayload = {
      session_dir: sessionDir,
      item_id: '1',
      attempt_id: '1-a1',
    };
    let renderSettled = false;
    const waveformPromise = request(event, 'preview_session_waveform', previewPayload);
    await waveformStarted;
    const renderPromise = request(event, 'render_session_attempt', previewPayload)
      .finally(() => { renderSettled = true; });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(renderSettled, false, 'inspect render must wait for the in-flight waveform instead of failing');
    assert.deepEqual(engine.activeCommands, ['preview_session_waveform']);
    await assert.rejects(
      request(event, 'start_session', { session_dir: path.join(root, 'new-session') }),
      /正在读取录制任务/,
      'live capture must still be blocked while an inspect command owns the engine',
    );

    releaseWaveform();
    const [waveform, rendered] = await Promise.all([waveformPromise, renderPromise]);
    assert.equal(Array.isArray(waveform.bins), true);
    assert.match(rendered.file_path, /1-a1\.wav$/);
    assert.deepEqual(
      engine.commands.filter(({ command }) => (
        command === 'preview_session_waveform' || command === 'render_session_attempt'
      )).map(({ command }) => command),
      ['preview_session_waveform', 'render_session_attempt'],
      'inspect waveform and render must reach the engine one after another',
    );

    const inspected = await request(event, 'inspect_session', { session_dir: sessionDir });
    assert.equal(inspected.snapshot.session_id, sessionId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('inspect preview IPC tests passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
