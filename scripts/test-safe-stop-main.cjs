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
  for (const name of ['immediate-unsafe', 'late-unsafe', 'slow-safe', 'live-unsafe-retry']) {
    const result = spawnSync(process.execPath, [__filename, name], { encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
  }
  console.log('main process unsafe-stop tests passed');
  process.exit(0);
}
if (scenario === 'slow-safe') {
  Object.defineProperty(process, 'platform', { value: 'win32' });
}

class FakeRequestError extends Error {}
class FakeRequestTimeoutError extends Error {}
class FakeSafeStopTimeoutError extends Error {}
class FakeUnsafeStopError extends Error {
  constructor(outcome) {
    super('mock safe stop was not confirmed');
    this.outcome = outcome;
  }
}

let releaseSlowStop;
const slowStopGate = new Promise((resolve) => { releaseSlowStop = resolve; });

function validSnapshot(sessionId, status = 'recording', journalSeq = 1) {
  return {
    schema_version: 1,
    journal_seq: journalSeq,
    session_id: sessionId,
    script_name: 'unsafe-stop.csv',
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
      id: '1', text: 'hello', label: '', status: 'pending', attempts: [], selected_attempt_id: null,
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
    globalThis.safeStopEngine = this;
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
    if (scenario === 'slow-safe') {
      await slowStopGate;
      const outcome = { safe: true, code: 0, signal: null };
      this.runningValue = false;
      this.emit('stopped', outcome);
      return;
    }
    if (scenario === 'late-unsafe') {
      throw new FakeSafeStopTimeoutError('mock safe stop timeout');
    }
    if (scenario === 'live-unsafe-retry' && this.stopCalls > 1) {
      const outcome = { safe: true, code: 0, signal: null };
      this.runningValue = false;
      this.emit('stopped', outcome);
      return;
    }
    const outcome = { safe: false, code: 0, signal: null };
    this.runningValue = false;
    this.emit('stopped', outcome);
    throw new FakeUnsafeStopError(outcome);
  }

  async forceStop() {
    throw new Error('forceStop must not run without explicit confirmation');
  }

  async request(command, payload) {
    this.commands.push({ command, payload });
    if (command === 'resume_session') {
      return {
        session_dir: payload.session_dir,
        snapshot: validSnapshot(path.basename(payload.session_dir)),
      };
    }
    if (command === 'seal_interrupted_session') {
      const snapshot = validSnapshot(path.basename(payload.session_dir), 'stopped', 2);
      await fs.writeFile(
        path.join(payload.session_dir, 'metadata', 'items.snapshot.json'),
        `${JSON.stringify(snapshot)}\n`,
      );
      return {
        session_dir: payload.session_dir,
        snapshot,
        durable_frames: 48000,
        recovered_attempts: 0,
        fault_preserved: false,
        no_op: false,
        warnings: [],
      };
    }
    return { active: false };
  }

  emitLateUnsafeExit() {
    const outcome = { safe: false, code: 0, signal: null };
    this.runningValue = false;
    this.emit('stopped', outcome);
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
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), `databaker-safe-stop-${scenario}-`));
  const root = await fs.realpath(lexicalRoot);
  const sessionId = 'unsafe-live-session';
  const sessionDir = path.join(root, sessionId);
  if (scenario === 'live-unsafe-retry') {
    await fs.mkdir(path.join(sessionDir, 'metadata'), { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'session.json'),
      `${JSON.stringify({ schema_version: 1, session_id: sessionId })}\n`,
    );
    await fs.writeFile(
      path.join(sessionDir, 'metadata', 'items.snapshot.json'),
      `${JSON.stringify(validSnapshot(sessionId))}\n`,
    );
  }
  process.env.DATABAKER_DEFAULT_OUTPUT = root;
  const appEvents = new Map();
  const handlers = new Map();
  const dialogCalls = [];
  let quitCalls = 0;
  let internallyPreventedQuitCalls = 0;
  let internallyPreventedWindowCloseCalls = 0;
  let internallyPreventedSessionEndCalls = 0;
  const electronStub = {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: (name, listener) => appEvents.set(name, listener),
      quit: () => {
        quitCalls += 1;
        let prevented = false;
        appEvents.get('before-quit')?.({ preventDefault: () => { prevented = true; } });
        if (prevented) internallyPreventedQuitCalls += 1;
        const window = FakeBrowserWindow.instances[0];
        if (window) {
          let closePrevented = false;
          window.emit('close', { preventDefault: () => { closePrevented = true; } });
          if (closePrevented) internallyPreventedWindowCloseCalls += 1;
          if (process.platform === 'win32') {
            let sessionEndPrevented = false;
            window.emit('query-session-end', {
              preventDefault: () => { sessionEndPrevented = true; },
            });
            if (sessionEndPrevented) internallyPreventedSessionEndCalls += 1;
          }
        }
      },
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
      () => globalThis.safeStopEngine?.startCalls === 1 && FakeBrowserWindow.instances.length > 0,
      'main process startup',
    );
    const engine = globalThis.safeStopEngine;
    if (scenario === 'live-unsafe-retry') {
      const window = FakeBrowserWindow.instances[0];
      const event = { sender: window.webContents };
      const rows = (await handlers.get('recordings:list')({}, root)).recordings;
      assert.equal(rows.length, 1);
      await handlers.get('engine:request')(event, 'resume_session', { session_dir: sessionDir });
    }
    let prevented = false;
    appEvents.get('before-quit')({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, 'the first quit request must be held for safe stop');

    if (scenario === 'slow-safe') {
      await waitFor(() => engine.stopCalls === 1, 'pending safe stop');
      let secondQuitPrevented = false;
      appEvents.get('before-quit')({ preventDefault: () => { secondQuitPrevented = true; } });
      assert.equal(
        secondQuitPrevented,
        true,
        'a second Cmd+Q must stay intercepted while safe stop is pending',
      );
      assert.equal(engine.stopCalls, 1, 'the second quit reuses the in-flight safe-stop promise');
      assert.equal(quitCalls, 0, 'no quit is released before the engine confirms shutdown');

      const window = FakeBrowserWindow.instances[0];
      let repeatedClosePrevented = false;
      window.emit('close', { preventDefault: () => { repeatedClosePrevented = true; } });
      assert.equal(
        repeatedClosePrevented,
        true,
        'window close must remain intercepted while the safe-stop promise is pending',
      );
      let repeatedSessionEndPrevented = false;
      window.emit('query-session-end', {
        preventDefault: () => { repeatedSessionEndPrevented = true; },
      });
      assert.equal(
        repeatedSessionEndPrevented,
        true,
        'a repeated Windows query-session-end must remain intercepted while stopping',
      );
      assert.equal(engine.stopCalls, 1, 'all repeated exit surfaces reuse one safe-stop operation');
      assert.equal(dialogCalls.length, 0, 'repeated exit surfaces do not open duplicate dialogs');
      releaseSlowStop();
      await waitFor(() => quitCalls === 1, 'single internally released quit');
      assert.equal(engine.stopCalls, 1);
      assert.equal(dialogCalls.length, 0);
      assert.equal(
        internallyPreventedQuitCalls,
        0,
        'the internal release gate allows the confirmed app.quit call',
      );
      assert.equal(internallyPreventedWindowCloseCalls, 0);
      assert.equal(internallyPreventedSessionEndCalls, 0);
      return;
    }

    await waitFor(() => dialogCalls.length === 1, 'first safe-stop dialog');
    assert.equal(quitCalls, 0, 'the app must remain open until the operator acknowledges the result');

    if (scenario === 'immediate-unsafe') {
      let secondQuitPrevented = false;
      appEvents.get('before-quit')({ preventDefault: () => { secondQuitPrevented = true; } });
      assert.equal(secondQuitPrevented, true);
      assert.equal(dialogCalls.length, 1, 'a second quit request must not bypass or duplicate the acknowledgement gate');
      assert.equal(quitCalls, 0);
    }

    if (scenario === 'late-unsafe') {
      assert.equal(dialogCalls[0].options.title, '音频仍在封存');
      dialogCalls[0].resolve({ response: 0 });
      await waitFor(() => engine.stopCalls === 1, 'safe-stop timeout completion');
      engine.emitLateUnsafeExit();
      await waitFor(() => dialogCalls.length === 2, 'unconfirmed late-exit dialog');
      assert.equal(quitCalls, 0, 'a late unconfirmed exit must never complete the pending quit');
      assert.equal(dialogCalls[1].options.title, '安全封存未确认');
      dialogCalls[1].resolve({ response: 0 });
    } else {
      assert.equal(dialogCalls[0].options.title, '安全封存未确认');
      dialogCalls[0].resolve({ response: 0 });
    }

    const expectedRestartCalls = scenario === 'live-unsafe-retry' ? 3 : 2;
    await waitFor(
      () => engine.startCalls === expectedRestartCalls,
      'engine restart after operator acknowledgement',
    );
    assert.equal(quitCalls, 0, 'keeping the app open must not invoke app.quit');
    assert.equal(engine.running, true, 'the idle engine is restarted only after acknowledgement');

    if (scenario === 'live-unsafe-retry') {
      await new Promise((resolve) => setTimeout(resolve, 20));
      let retryPrevented = false;
      appEvents.get('before-quit')({ preventDefault: () => { retryPrevented = true; } });
      assert.equal(retryPrevented, true);
      await waitFor(() => quitCalls === 1, 'offline seal before retry quit');
      assert.equal(
        engine.commands.some(({ command }) => command === 'seal_interrupted_session'),
        true,
        'retry quit must seal the live session whose shutdown was unconfirmed',
      );
      assert.equal(engine.stopCalls, 2, 'retry closes the helper only after offline seal confirmation');
      assert.equal(dialogCalls.length, 1, 'the retry must not silently bypass through an idle helper');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

runScenario().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
