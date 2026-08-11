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

function validSnapshot(sessionId, status = 'recording', journalSeq = 1) {
  return {
    schema_version: 1,
    journal_seq: journalSeq,
    session_id: sessionId,
    script_name: 'capture-fault-tray.csv',
    status,
    device_name: 'Test USB Interface',
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
    updated_at: '2026-08-11T00:00:01Z',
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

async function persistSession(sessionDir, snapshot) {
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
    this.pendingStop = null;
    this.stopCalls = 0;
    this.resumeCalls = 0;
    this.recoveryResumeFailures = 0;
    globalThis.captureFaultTrayEngine = this;
  }

  get running() { return this.runningValue; }

  async start() { this.runningValue = true; }

  async stop() {
    this.stopCalls += 1;
    this.runningValue = false;
    this.active = false;
    this.emit('stopped', { safe: true, code: 0, signal: null });
  }

  async forceStop() { throw new Error('capture fault tray test must never force stop'); }

  async request(command, payload) {
    if (command === 'get_state_optional') {
      return this.active
        ? {
          active: true,
          session_dir: this.sessionDir,
          snapshot: this.snapshot,
          active_attempt: null,
        }
        : { active: false };
    }
    if (command === 'start_session') {
      this.active = true;
      this.sessionDir = payload.session_dir;
      this.snapshot = validSnapshot(payload.session_id);
      await persistSession(this.sessionDir, this.snapshot);
      return { session_dir: this.sessionDir, snapshot: this.snapshot };
    }
    if (command === 'resume_session') {
      this.resumeCalls += 1;
      if (this.recoveryResumeFailures > 0) {
        this.recoveryResumeFailures -= 1;
        throw new FakeRequestError('mock first recovery resume failure');
      }
      this.active = true;
      this.snapshot = validSnapshot(this.snapshot.session_id, 'recording', this.snapshot.journal_seq + 1);
      return {
        active: true,
        session_dir: this.sessionDir,
        snapshot: this.snapshot,
        active_attempt: null,
      };
    }
    if (command === 'stop_session') {
      if (this.pendingStop) throw new Error('duplicate stop_session');
      return await new Promise((resolve) => {
        this.pendingStop = () => {
          this.active = false;
          this.snapshot = validSnapshot(this.snapshot.session_id, 'faulted', 2);
          resolve({ session_dir: this.sessionDir, snapshot: this.snapshot });
        };
      });
    }
    return {};
  }

  emitCaptureFault() {
    this.emit('event', {
      protocol_version: 1,
      event: 'meter',
      payload: {
        faulted: true,
        fault_kind: 'device_unavailable',
        fault_reason: '测试声卡已断开',
      },
    });
  }

  crashForRecovery(failedResumeAttempts = 1) {
    this.runningValue = false;
    this.active = false;
    this.recoveryResumeFailures = failedResumeAttempts;
    this.emit('offline', 'mock unexpected helper exit after capture fault');
  }

  completeStop() {
    assert.ok(this.pendingStop, 'stop_session must be pending');
    const complete = this.pendingStop;
    this.pendingStop = null;
    complete();
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
    this.hidden = false;
    FakeBrowserWindow.instances.push(this);
  }

  isDestroyed() { return this.destroyed; }
  isFocused() { return !this.hidden; }
  removeMenu() {}
  async loadFile() {}
  async loadURL() {}
  show() { this.hidden = false; }
  focus() { this.hidden = false; this.emit('focus'); }
  isMinimized() { return false; }
  restore() {}
  hide() { this.hidden = true; }
  setTitle() {}
  setProgressBar() {}
  flashFrame() {}
  close() {
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    if (!prevented) this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

class FakeTray extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.destroyed = false;
    this.tooltip = '';
    this.menu = null;
    FakeTray.instances.push(this);
  }

  setToolTip(value) { this.tooltip = value; }
  setContextMenu(value) { this.menu = value; }
  destroy() { this.destroyed = true; }
}

async function waitFor(predicate, label, attempts = 1_200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function activeTray() {
  return FakeTray.instances.findLast((tray) => !tray.destroyed) ?? null;
}

async function main() {
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-capture-fault-tray-'));
  const root = await fs.realpath(lexicalRoot);
  process.env.DATABAKER_DEFAULT_OUTPUT = root;
  const handlers = new Map();
  const appEvents = new Map();
  const messageBoxes = [];
  const messageBoxResponses = [];
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
      showMessageBox: async (...args) => {
        const options = args.length === 2 ? args[1] : args[0];
        messageBoxes.push(options);
        return { response: messageBoxResponses.shift() ?? 0 };
      },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (name, listener) => handlers.set(name, listener),
      on: () => undefined,
    },
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: () => undefined }) },
    screen: {
      getPrimaryDisplay: () => ({ id: 1, workArea: { width: 1440, height: 900, x: 0, y: 0 } }),
      getAllDisplays: () => [],
    },
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
        && FakeBrowserWindow.instances.length > 0
        && globalThis.captureFaultTrayEngine?.running,
      'main process startup',
    );
    const engine = globalThis.captureFaultTrayEngine;
    const window = FakeBrowserWindow.instances[0];
    const event = { sender: window.webContents };
    const firstSessionDir = path.join(root, 'faulted-session');
    await handlers.get('engine:request')(event, 'start_session', {
      session_id: 'faulted-session',
      session_dir: firstSessionDir,
    });

    engine.emitCaptureFault();
    assert.equal(activeTray(), null, 'a visible-window fault should be latched without creating a Tray');

    messageBoxResponses.push(1);
    window.close();
    await waitFor(() => window.hidden && activeTray(), 'faulted background Tray');

    const closePrompt = messageBoxes.at(-1);
    assert.match(closePrompt.title, /停止写入/);
    assert.match(closePrompt.message, /母轨已停止写入/);
    assert.match(closePrompt.detail, /不会恢复录音/);
    assert.match(closePrompt.buttons[1], /不会继续录音/);

    let tray = activeTray();
    assert.match(tray.tooltip, /所选声卡已断开或不可用/);
    assert.match(tray.tooltip, /已停止写入/);
    assert.doesNotMatch(tray.tooltip, /后台录音正在进行/);
    assert.match(tray.menu[0].label, /已停止写入/);

    appEvents.get('window-all-closed')();
    tray = activeTray();
    assert.match(tray.menu[0].label, /已停止写入/);
    assert.doesNotMatch(tray.menu[0].label, /后台录音正在进行/);

    const stopPromise = handlers.get('engine:request')(event, 'stop_session', {});
    await waitFor(() => engine.pendingStop, 'pending stop_session');
    appEvents.get('window-all-closed')();
    tray = activeTray();
    assert.match(tray.menu[0].label, /所选声卡已断开或不可用/);
    assert.match(tray.menu[0].label, /正在安全停止/);
    assert.doesNotMatch(tray.menu[0].label, /后台录音正在进行/);

    engine.completeStop();
    await stopPromise;
    tray.emit('click');
    await waitFor(() => activeTray() === null && !window.hidden, 'foreground panel after confirmed stop');

    const secondSessionDir = path.join(root, 'healthy-session');
    await handlers.get('engine:request')(event, 'start_session', {
      session_id: 'healthy-session',
      session_dir: secondSessionDir,
    });
    messageBoxResponses.push(1);
    window.close();
    await waitFor(() => window.hidden && activeTray(), 'healthy next-session Tray');
    tray = activeTray();
    assert.match(tray.menu[0].label, /后台录音正在进行/);
    assert.doesNotMatch(tray.menu[0].label, /所选声卡已断开或不可用/);

    engine.emitCaptureFault();
    engine.crashForRecovery(1);
    appEvents.get('window-all-closed')();
    tray = activeTray();
    assert.match(tray.menu[0].label, /所选声卡已断开或不可用/);
    assert.match(tray.menu[0].label, /采集中断.*恢复引擎/);
    assert.doesNotMatch(tray.menu[0].label, /后台录音正在进行/);

    await waitFor(() => engine.stopCalls >= 1, 'safe helper stop between recovery retries');
    appEvents.get('window-all-closed')();
    tray = activeTray();
    assert.match(tray.menu[0].label, /所选声卡已断开或不可用/,
      'a safe helper stop between retries must not clear the capture fault latch');
    assert.match(tray.menu[0].label, /采集中断.*恢复引擎/);
    assert.doesNotMatch(tray.menu[0].label, /后台录音正在进行/);

    await waitFor(
      () => window.webContents.messages.some(({ channel, args }) => (
        channel === 'engine:event' && args[0]?.event === 'engine_recovered'
      )),
      'successful second recovery attempt',
      1_000,
    );
    await waitFor(() => activeTray() === null && !window.hidden, 'foreground panel after recovery');

    const recoveredStop = handlers.get('engine:request')(event, 'stop_session', {});
    await waitFor(() => engine.pendingStop, 'stop recovered session');
    engine.completeStop();
    await recoveredStop;
    const thirdSessionDir = path.join(root, 'healthy-recovery-session');
    await handlers.get('engine:request')(event, 'start_session', {
      session_id: 'healthy-recovery-session',
      session_dir: thirdSessionDir,
    });
    messageBoxResponses.push(1);
    window.close();
    await waitFor(() => window.hidden && activeTray(), 'healthy recovery background Tray');
    engine.crashForRecovery(0);
    appEvents.get('window-all-closed')();
    tray = activeTray();
    assert.match(tray.menu[0].label, /采集中断.*恢复录音引擎/);
    assert.doesNotMatch(tray.menu[0].label, /后台录音正在进行/,
      'recovering ownership without a meter fault must not be advertised as capture');
    assert.doesNotMatch(tray.menu[0].label, /所选声卡已断开或不可用/);
    await waitFor(
      () => window.webContents.messages.filter(({ channel, args }) => (
        channel === 'engine:event' && args[0]?.event === 'engine_recovered'
      )).length >= 2,
      'healthy automatic recovery',
    );

    console.log('main process capture fault Tray latch test passed');
  } finally {
    delete globalThis.captureFaultTrayEngine;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
