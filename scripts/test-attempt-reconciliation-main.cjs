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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function item(id) {
  return {
    id,
    text: `sentence ${id}`,
    label: '',
    status: 'pending',
    attempts: [],
    selected_attempt_id: null,
  };
}

function snapshot(sessionId, journalSeq = 1) {
  return {
    schema_version: 1,
    journal_seq: journalSeq,
    session_id: sessionId,
    script_name: 'attempts.csv',
    status: 'recording',
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
    captured_samples: 96_000,
    committed_samples: 96_000,
    overflow_samples: 0,
    started_at: '2026-08-12T00:00:00Z',
    updated_at: '2026-08-12T00:00:01Z',
    noise_check: null,
    silence_duration_ms: 1_000,
    silence_threshold_dbfs: -45,
    items: [item('1'), item('2')],
  };
}

function activeAttempt(itemId, attemptId) {
  return {
    item_id: itemId,
    attempt_id: attemptId,
    start_sample: 48_000,
    recording_started_sample: 48_000,
    head_silence_armed_sample: 48_000,
    head_silence_passed_sample: 72_000,
    head_silence_progress_samples: 48_000,
    required_head_silence_samples: 48_000,
    head_silence_phase: 'speech_started',
    content_started_sample: 76_000,
  };
}

function completedAttempt(attempt) {
  return {
    attempt_id: attempt.attempt_id,
    start_sample: 48_000,
    recording_started_sample: attempt.recording_started_sample,
    head_silence_armed_sample: attempt.head_silence_armed_sample,
    head_silence_passed_sample: attempt.head_silence_passed_sample,
    required_head_silence_samples: attempt.required_head_silence_samples,
    content_started_sample: attempt.content_started_sample,
    end_sample: 96_000,
    forced_without_tail_silence: false,
    tail_silence_samples: 48_000,
    required_tail_silence_samples: 48_000,
    status: 'recorded',
    created_at: '2026-08-12T00:00:02Z',
  };
}

async function persistSessionTree(sessionDir, value) {
  for (const name of ['audio', 'metadata', 'script', 'preview', 'export']) {
    await fs.mkdir(path.join(sessionDir, name), { recursive: true });
  }
  await fs.writeFile(
    path.join(sessionDir, 'session.json'),
    `${JSON.stringify({ schema_version: 1, session_id: value.session_id })}\n`,
  );
  await fs.writeFile(
    path.join(sessionDir, 'metadata', 'items.snapshot.json'),
    `${JSON.stringify(value)}\n`,
  );
}

class FakeEngineClient extends EventEmitter {
  constructor() {
    super();
    this.runningValue = false;
    this.active = false;
    this.sessionDir = '';
    this.snapshot = null;
    this.activeAttempt = null;
    this.nextAttemptOutcome = '';
    this.attemptCalls = [];
    globalThis.attemptReconciliationEngine = this;
  }

  get running() { return this.runningValue; }

  async start() { this.runningValue = true; }

  async stop() {
    this.runningValue = false;
    this.active = false;
    this.emit('stopped', { safe: true, code: 0, signal: null });
  }

  async forceStop() { throw new Error('forceStop must not be used'); }

  requestInputAudition(command, payload = {}) {
    return this.request(command, payload, 20_000);
  }

  optionalState() {
    if (!this.active) return { active: false };
    return {
      active: true,
      session_dir: this.sessionDir,
      snapshot: clone(this.snapshot),
      active_attempt: clone(this.activeAttempt),
    };
  }

  incrementJournal() {
    this.snapshot.journal_seq += 1;
    this.snapshot.updated_at = `2026-08-12T00:00:${String(this.snapshot.journal_seq).padStart(2, '0')}Z`;
  }

  async request(command, payload, timeoutMs) {
    if (command === 'get_state_optional') return this.optionalState();

    if (command === 'start_session') {
      this.sessionDir = payload.session_dir;
      this.snapshot = snapshot(payload.session_id);
      this.activeAttempt = null;
      this.active = true;
      await persistSessionTree(this.sessionDir, this.snapshot);
      return { session_dir: this.sessionDir, snapshot: clone(this.snapshot) };
    }

    if (command === 'skip_input_audition') {
      const decidedAt = '2026-08-12T00:00:02Z';
      const captureFingerprint = 'trusted-current-audition-fingerprint';
      this.incrementJournal();
      this.snapshot.input_audition = {
        status: 'skipped',
        check_id: 'trusted-current-audition-skip',
        capture_fingerprint: captureFingerprint,
        start_sample: this.snapshot.committed_samples,
        end_sample: this.snapshot.committed_samples,
        required_samples: 480_000,
        captured_samples: 0,
        started_at: decidedAt,
        completed_at: decidedAt,
        skipped_at: decidedAt,
        warning_codes: [],
      };
      return {
        capture_fingerprint: captureFingerprint,
        input_audition: clone(this.snapshot.input_audition),
        snapshot: clone(this.snapshot),
      };
    }

    if (command === 'start_attempt') {
      this.attemptCalls.push({ command, payload: clone(payload), timeoutMs });
      const requestedItem = payload.item_id;
      if (this.nextAttemptOutcome === 'timeout-start-success') {
        this.incrementJournal();
        this.activeAttempt = activeAttempt(requestedItem, `${requestedItem}-a1`);
        throw new FakeRequestTimeoutError('mock lost start response');
      }
      if (this.nextAttemptOutcome === 'timeout-start-wrong-item') {
        this.incrementJournal();
        const wrongItem = requestedItem === '1' ? '2' : '1';
        this.activeAttempt = activeAttempt(wrongItem, `${wrongItem}-a1`);
        throw new FakeRequestTimeoutError('mock ambiguous start response');
      }
      if (this.nextAttemptOutcome === 'timeout-start-wrong-session') {
        this.incrementJournal();
        this.activeAttempt = activeAttempt(requestedItem, `${requestedItem}-a1`);
        this.sessionDir = `${this.sessionDir}-different`;
        throw new FakeRequestTimeoutError('mock different-session start response');
      }
      if (this.nextAttemptOutcome === 'timeout-start-without-journal') {
        this.activeAttempt = activeAttempt(requestedItem, `${requestedItem}-a1`);
        throw new FakeRequestTimeoutError('mock uncommitted start response');
      }
      throw new Error(`unexpected start outcome ${this.nextAttemptOutcome}`);
    }

    if (command === 'stop_attempt') {
      this.attemptCalls.push({ command, payload: clone(payload), timeoutMs });
      const active = this.activeAttempt;
      if (!active) throw new FakeRequestError('no attempt is recording');
      if (this.nextAttemptOutcome === 'timeout-stop-success') {
        this.incrementJournal();
        const target = this.snapshot.items.find((candidate) => candidate.id === active.item_id);
        const attempt = completedAttempt(active);
        target.status = 'review';
        target.attempts.push(attempt);
        this.activeAttempt = null;
        throw new FakeRequestTimeoutError('mock lost stop response');
      }
      if (this.nextAttemptOutcome === 'timeout-stop-discard') {
        this.incrementJournal();
        this.activeAttempt = null;
        throw new FakeRequestTimeoutError('mock lost discard response');
      }
      throw new Error(`unexpected stop outcome ${this.nextAttemptOutcome}`);
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
  setToolTip() {}
  setContextMenu() {}
  destroy() {}
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-attempt-reconciliation-')));
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
        && globalThis.attemptReconciliationEngine?.running,
      'main process startup',
    );
    const engine = globalThis.attemptReconciliationEngine;
    const event = { sender: FakeBrowserWindow.instances[0].webContents };
    const sessionId = 'attempt-reconciliation';
    const sessionDir = path.join(root, sessionId);
    await handlers.get('engine:request')(event, 'start_session', {
      session_id: sessionId,
      session_dir: sessionDir,
      items: [item('1'), item('2')],
    });
    await handlers.get('input-audition:skip_input_audition')(event, {});

    engine.nextAttemptOutcome = 'timeout-start-success';
    const started = await handlers.get('engine:request')(event, 'start_attempt', { item_id: '1' });
    assert.equal(started.attempt_id, '1-a1');
    assert.equal(started.reconciled_after_timeout, true);

    engine.nextAttemptOutcome = 'timeout-stop-success';
    const stopped = await handlers.get('engine:request')(event, 'stop_attempt', {
      item_id: '1',
      force: false,
    });
    assert.equal(stopped.item_id, '1');
    assert.equal(stopped.attempt.attempt_id, '1-a1');
    assert.equal(stopped.reconciled_after_timeout, true);
    assert.deepEqual(
      engine.attemptCalls.at(-1).payload,
      { force: false, discard_empty: true, enforce_silence: false },
      'item_id is reconciliation-only metadata and must not reach Rust stop_attempt',
    );
    assert.ok(
      engine.attemptCalls.every((call) => call.timeoutMs >= 60_000),
      'attempt IPC timeout must exceed Rust analysis plus writer-commit deadlines',
    );

    engine.nextAttemptOutcome = 'timeout-start-success';
    await handlers.get('engine:request')(event, 'start_attempt', { item_id: '2' });
    engine.nextAttemptOutcome = 'timeout-stop-discard';
    const discarded = await handlers.get('engine:request')(event, 'stop_attempt', {
      item_id: '2',
      force: true,
    });
    assert.equal(discarded.discarded, true);
    assert.equal(discarded.attempt, null);
    assert.equal(discarded.reconciled_after_timeout, true);
    assert.deepEqual(engine.attemptCalls.at(-1).payload, { force: true, discard_empty: true, enforce_silence: false });

    engine.nextAttemptOutcome = 'timeout-start-wrong-item';
    await assert.rejects(
      handlers.get('engine:request')(event, 'start_attempt', { item_id: '1' }),
      /状态对账失败|无法一致对账/,
      'a timed-out start must not synthesize success for another item',
    );
    engine.activeAttempt = null;

    engine.nextAttemptOutcome = 'timeout-start-wrong-session';
    await assert.rejects(
      handlers.get('engine:request')(event, 'start_attempt', { item_id: '1' }),
      /状态对账失败|同一个活动任务/,
      'a timed-out start must not synthesize success for another session',
    );
    engine.sessionDir = sessionDir;
    engine.activeAttempt = null;

    engine.nextAttemptOutcome = 'timeout-start-without-journal';
    await assert.rejects(
      handlers.get('engine:request')(event, 'start_attempt', { item_id: '1' }),
      /状态对账失败|日志序号/,
      'live memory without a new durable journal sequence must remain an error',
    );
    engine.activeAttempt = null;

    console.log('main process attempt timeout reconciliation test passed');
  } finally {
    delete globalThis.attemptReconciliationEngine;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
