'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scenario = process.argv[2];
if (!scenario) {
  for (const name of ['success', 'damaged-identity', 'active', 'swap', 'timeout']) {
    const result = spawnSync(process.execPath, [__filename, name], { encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
  }
  console.log('offline seal IPC safety tests passed');
  process.exit(0);
}

class FakeRequestError extends Error {
  constructor(message, code = 'ENGINE_REQUEST_FAILED', command = '', requestId = '') {
    super(message);
    this.code = code;
    this.command = command;
    this.requestId = requestId;
  }
}

class FakeTimeoutError extends Error {
  constructor(command) {
    super(`录音引擎响应超时：${command}`);
    this.command = command;
  }
}

class FakeSafeStopTimeoutError extends Error {}
class FakeUnsafeStopError extends Error {}

let stopGateResolve;
let stopStartedResolve;
const stopGate = new Promise((resolve) => { stopGateResolve = resolve; });
const stopStarted = new Promise((resolve) => { stopStartedResolve = resolve; });
let sealGateResolve;
let sealStartedResolve;
const sealGate = new Promise((resolve) => { sealGateResolve = resolve; });
const sealStarted = new Promise((resolve) => { sealStartedResolve = resolve; });
let replaceSessionBeforeRequest = async () => undefined;

class FakeEngineClient extends EventEmitter {
  constructor() {
    super();
    this.runningValue = false;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.commands = [];
    this.getStateCalls = 0;
    this.mode = scenario;
    globalThis.fakeOfflineSealEngine = this;
  }

  get running() {
    return this.runningValue;
  }

  async start() {
    this.startCalls += 1;
    this.runningValue = true;
    if (this.mode === 'swap' && this.startCalls === 2) await replaceSessionBeforeRequest();
  }

  async stop() {
    this.stopCalls += 1;
    stopStartedResolve();
    if (this.mode === 'timeout') await stopGate;
    this.runningValue = false;
    this.emit('stopped', { safe: true, code: 0, signal: null });
  }

  async forceStop() {
    this.runningValue = false;
    this.emit('stopped', { safe: false, code: null, signal: 'SIGTERM' });
  }

  async request(command, payload) {
    this.commands.push({ command, payload });
    if (command === 'get_state_optional') {
      this.getStateCalls += 1;
      if (this.mode === 'active') {
        return {
          active: true,
          session_dir: globalThis.offlineSealSessionDir,
          snapshot: validSnapshot(path.basename(globalThis.offlineSealSessionDir)),
        };
      }
      if (this.mode === 'timeout' && this.getStateCalls > 1) {
        throw new FakeTimeoutError(command);
      }
      return { active: false };
    }
    if (command === 'seal_interrupted_session') {
      assert.equal(
        payload.expected_session_id,
        path.basename(payload.session_dir),
        'offline sealing must bind the exact persisted session identity',
      );
      if (this.mode === 'timeout') throw new FakeTimeoutError(command);
      if (this.mode === 'success' && scenario === 'success') {
        sealStartedResolve();
        await sealGate;
      }
      const snapshot = {
        ...validSnapshot(path.basename(payload.session_dir)),
        journal_seq: 2,
        status: 'stopped',
      };
      await fs.writeFile(
        path.join(payload.session_dir, 'metadata', 'items.snapshot.json'),
        `${JSON.stringify(snapshot)}\n`,
      );
      return {
        session_dir: payload.session_dir,
        snapshot,
        durable_frames: 48000,
        no_op: false,
      };
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

class FakeTray extends EventEmitter {
  static instances = [];
  constructor() {
    super();
    this.destroyed = false;
    this.menu = null;
    FakeTray.instances.push(this);
  }
  setToolTip() {}
  setContextMenu(value) { this.menu = value; }
  destroy() { this.destroyed = true; }
}

function activeTray() {
  return FakeTray.instances.findLast((tray) => !tray.destroyed) ?? null;
}

function validSnapshot(sessionId) {
  return {
    schema_version: 1,
    journal_seq: 1,
    session_id: sessionId,
    script_name: 'test.csv',
    status: 'recording',
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
      id: '1', text: 'hello', label: '', status: 'pending', attempts: [], selected_attempt_id: null,
    }],
  };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function runScenario() {
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), `databaker-seal-ipc-${scenario}-`));
  const root = await fs.realpath(lexicalRoot);
  const sessionId = 'interrupted-session';
  const sessionDir = path.join(root, sessionId);
  globalThis.offlineSealSessionDir = sessionDir;
  await fs.mkdir(path.join(sessionDir, 'metadata'), { recursive: true });
  await fs.writeFile(path.join(sessionDir, 'session.json'), `${JSON.stringify({ schema_version: 1, session_id: sessionId })}\n`);
  await fs.writeFile(path.join(sessionDir, 'metadata', 'items.snapshot.json'), `${JSON.stringify(validSnapshot(sessionId))}\n`);
  if (scenario === 'damaged-identity') {
    await fs.writeFile(path.join(sessionDir, 'session.json'), '{broken');
  }
  process.env.DATABAKER_DEFAULT_OUTPUT = root;

  replaceSessionBeforeRequest = async () => {
    await fs.rename(sessionDir, `${sessionDir}-old`);
    await fs.mkdir(path.join(sessionDir, 'metadata'), { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'session.json'), `${JSON.stringify({ schema_version: 1, session_id: sessionId })}\n`);
    await fs.writeFile(
      path.join(sessionDir, 'metadata', 'items.snapshot.json'),
      `${JSON.stringify(validSnapshot(sessionId))}\n`,
    );
  };

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
        EngineRequestTimeoutError: FakeTimeoutError,
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
    await waitFor(() => handlers.has('engine:request') && FakeBrowserWindow.instances.length > 0, 'main IPC registration');
    const engine = globalThis.fakeOfflineSealEngine;
    const browserWindow = FakeBrowserWindow.instances[0];
    const event = { sender: browserWindow.webContents };
    const list = handlers.get('recordings:list');
    const request = handlers.get('engine:request');
    const rows = await list({}, root);
    assert.equal(rows.length, 1);

    const invokeSeal = () => request(event, 'seal_interrupted_session', {
      session_dir: sessionDir,
      session_id: sessionId,
    });

    if (scenario === 'success') {
      const resultPromise = invokeSeal();
      await sealStarted;
      appEvents.get('window-all-closed')();
      const tray = activeTray();
      assert.match(tray.menu[0].label, /修复并封存/);
      assert.doesNotMatch(tray.menu[0].label, /后台录音正在进行/,
        'offline sealing must never be advertised as capture');
      sealGateResolve();
      const result = await resultPromise;
      assert.equal(result.durable_frames, 48000);
      assert.equal(engine.commands.filter(({ command }) => command === 'seal_interrupted_session').length, 1);
      tray.emit('click');
    } else if (scenario === 'damaged-identity') {
      const result = await invokeSeal();
      assert.equal(result.durable_frames, 48000);
      assert.equal(
        engine.commands.filter(({ command }) => command === 'seal_interrupted_session').length,
        1,
        'consistent snapshots must authorize offline sealing when session.json alone is damaged',
      );
    } else if (scenario === 'active') {
      await assert.rejects(invokeSeal(), /正在处理另一个任务/);
      assert.equal(engine.commands.some(({ command }) => command === 'seal_interrupted_session'), false);
      await assert.rejects(invokeSeal(), /当前已有录音任务进行中/);
    } else if (scenario === 'swap') {
      await assert.rejects(invokeSeal(), /操作前被替换/);
      assert.equal(engine.commands.some(({ command }) => command === 'seal_interrupted_session'), false);
      await assert.rejects(invokeSeal(), /只能修复已授权/);
    } else if (scenario === 'timeout') {
      const first = invokeSeal();
      await stopStarted;
      await assert.rejects(invokeSeal(), /正在安全停止/);
      stopGateResolve();
      await assert.rejects(first, /seal_interrupted_session/);
      engine.mode = 'success';
      const retry = await invokeSeal();
      assert.equal(retry.durable_frames, 48000);
      assert.equal(engine.stopCalls, 1);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

runScenario().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
