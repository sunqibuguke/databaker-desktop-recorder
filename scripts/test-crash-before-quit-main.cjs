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
  for (const name of [
    'success',
    'seal-failure',
    'persisted-mismatch',
    'identity-unknown',
    'unsafe-helper-stop',
  ]) {
    const result = spawnSync(process.execPath, [__filename, name], { encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
  }
  console.log('main process crash-before-quit seal tests passed');
  process.exit(0);
}

class FakeRequestError extends Error {}
class FakeRequestTimeoutError extends Error {}
class FakeSafeStopTimeoutError extends Error {}
class FakeUnsafeStopError extends Error {
  constructor(outcome) {
    super('mock helper shutdown was not safely confirmed');
    this.outcome = outcome;
  }
}

function validSnapshot(sessionId, status = 'recording', journalSeq = 1) {
  return {
    schema_version: 1,
    journal_seq: journalSeq,
    session_id: sessionId,
    script_name: 'crash-before-quit.csv',
    status,
    device_name: 'test input',
    device_id: 'test-device',
    input_sample_format: 'i32',
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
      status: 'pending',
      attempts: [],
      selected_attempt_id: null,
    }],
  };
}

class FakeEngineClient extends EventEmitter {
  constructor() {
    super();
    this.runningValue = false;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.commands = [];
    this.timeline = [];
    globalThis.crashBeforeQuitEngine = this;
  }

  get running() {
    return this.runningValue;
  }

  async start() {
    this.startCalls += 1;
    this.timeline.push('engine-start');
    this.runningValue = true;
  }

  async stop() {
    this.stopCalls += 1;
    this.timeline.push('engine-safe-stop');
    this.runningValue = false;
    if (scenario === 'unsafe-helper-stop') {
      const outcome = { safe: false, code: 7, signal: null };
      this.emit('stopped', outcome);
      throw new FakeUnsafeStopError(outcome);
    }
    this.emit('stopped', { safe: true, code: 0, signal: null });
  }

  async forceStop() {
    throw new Error('crash-before-quit must never force-stop the sidecar');
  }

  async request(command, payload) {
    this.commands.push({ command, payload });
    this.timeline.push(command);
    if (command === 'get_state_optional') return { active: false };
    if (command === 'resume_session') {
      return {
        session_dir: payload.session_dir,
        snapshot: validSnapshot(path.basename(payload.session_dir)),
      };
    }
    if (command === 'seal_interrupted_session') {
      if (scenario === 'seal-failure') {
        throw new FakeRequestError('mock offline seal failed');
      }
      const snapshot = validSnapshot(path.basename(payload.session_dir), 'stopped', 2);
      if (scenario !== 'persisted-mismatch') {
        await fs.writeFile(
          path.join(payload.session_dir, 'metadata', 'items.snapshot.json'),
          `${JSON.stringify(snapshot)}\n`,
        );
      }
      return {
        session_dir: payload.session_dir,
        snapshot,
        durable_frames: 48000,
        recovered_attempts: 1,
        fault_preserved: false,
        no_op: false,
        warnings: [],
      };
    }
    return {};
  }

  crash() {
    this.timeline.push('engine-crash');
    this.runningValue = false;
    this.emit('offline', 'mock unexpected engine exit');
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

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function runScenario() {
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), `databaker-crash-quit-${scenario}-`));
  const root = await fs.realpath(lexicalRoot);
  const sessionId = 'interrupted-session';
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
      quit: () => {
        quitCalls += 1;
        globalThis.crashBeforeQuitEngine?.timeline.push('app-quit');
      },
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
      'main process startup',
    );
    const engine = globalThis.crashBeforeQuitEngine;
    const window = FakeBrowserWindow.instances[0];
    const event = { sender: window.webContents };
    const list = handlers.get('recordings:list');
    const request = handlers.get('engine:request');
    assert.equal((await list({}, root)).length, 1, 'history scan captures the trusted session identity');
    await request(event, 'resume_session', { session_dir: sessionDir });

    if (scenario === 'identity-unknown') {
      await fs.unlink(path.join(sessionDir, 'session.json'));
    }
    engine.crash();
    let prevented = false;
    appEvents.get('before-quit')({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, 'quit must be intercepted after the unexpected exit');

    if (scenario === 'success') {
      await waitFor(() => quitCalls === 1, 'offline seal and safe quit');
      const sealIndex = engine.timeline.indexOf('seal_interrupted_session');
      const stopIndex = engine.timeline.indexOf('engine-safe-stop');
      const quitIndex = engine.timeline.indexOf('app-quit');
      assert.ok(sealIndex >= 0, 'quit must run the production offline-seal command');
      assert.ok(stopIndex > sealIndex, 'the helper sidecar stops only after seal confirmation');
      assert.ok(quitIndex > stopIndex, 'app.quit is released only after seal confirmation and safe sidecar stop');
      assert.equal(engine.stopCalls, 1);
      assert.equal(dialogCalls.length, 0, 'confirmed seal needs no warning gate');
      assert.equal(quitCalls, 1);
    } else if (scenario === 'unsafe-helper-stop') {
      await waitFor(() => dialogCalls.length === 1, 'unsafe helper-stop acknowledgement gate');
      assert.equal(dialogCalls[0].options.title, '安全封存未确认');
      assert.equal(
        engine.commands.some(({ command }) => command === 'seal_interrupted_session'),
        true,
        'the interrupted task was sealed before the helper shutdown failed',
      );
      assert.equal(engine.stopCalls, 1);
      assert.equal(quitCalls, 0, 'unsafe helper shutdown cannot release app.quit');
      dialogCalls[0].resolve({ response: 0 });
      await waitFor(() => engine.running, 'idle helper restart after acknowledgement');
      assert.equal(quitCalls, 0, 'keeping the app open after unsafe helper shutdown remains non-destructive');
      let repeatedQuitPrevented = false;
      appEvents.get('before-quit')({
        preventDefault: () => { repeatedQuitPrevented = true; },
      });
      assert.equal(repeatedQuitPrevented, true);
      await waitFor(
        () => engine.commands.filter(({ command }) => command === 'seal_interrupted_session').length === 2,
        'retained crash-seal obligation on the next quit',
      );
      await waitFor(() => dialogCalls.length === 2, 'second unsafe helper-stop gate');
      assert.equal(
        quitCalls,
        0,
        'keeping the app must not turn a later clean helper restart into permission to quit',
      );
      assert.equal(dialogCalls[1].options.title, '安全封存未确认');
      dialogCalls[1].resolve({ response: 0 });
    } else {
      await waitFor(() => dialogCalls.length === 1, 'unconfirmed crash-seal gate');
      assert.equal(dialogCalls[0].options.title, '中断任务封存未确认');
      assert.equal(quitCalls, 0, 'unknown or failed seal must never autoquit');
      if (scenario !== 'identity-unknown') {
        assert.equal(
          engine.commands.some(({ command }) => command === 'seal_interrupted_session'),
          true,
          'the production seal was attempted before its failure or persistence mismatch was gated',
        );
      } else {
        assert.equal(
          engine.commands.some(({ command }) => command === 'seal_interrupted_session'),
          false,
          'identity failure is rejected before the engine can mutate the task',
        );
      }
      dialogCalls[0].resolve({ response: 0 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(quitCalls, 0, 'acknowledging the warning keeps the application open');
      assert.equal(engine.stopCalls, 0, 'the no-child state is never accepted as a safe stop');

      let retryPrevented = false;
      appEvents.get('before-quit')({ preventDefault: () => { retryPrevented = true; } });
      assert.equal(retryPrevented, true);
      await waitFor(() => dialogCalls.length === 2, 'repeated quit remains behind the seal gate');
      assert.equal(quitCalls, 0, 'a repeated quit cannot bypass the retained crash-seal obligation');
      dialogCalls[1].resolve({ response: 0 });
      await new Promise((resolve) => setTimeout(resolve, 20));

      if (scenario === 'seal-failure') {
        const resumed = await request(event, 'resume_session', { session_dir: sessionDir });
        assert.equal(
          resumed.session_dir,
          sessionDir,
          'the exact interrupted task remains manually resumable after automatic/offline seal failure',
        );
        let resumedQuitPrevented = false;
        appEvents.get('before-quit')({ preventDefault: () => { resumedQuitPrevented = true; } });
        assert.equal(resumedQuitPrevented, true);
        await waitFor(() => quitCalls === 1, 'safe quit after confirmed manual resume');
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

runScenario().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
