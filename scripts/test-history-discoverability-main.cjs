'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

class FakeEngineClient extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.commands = [];
    globalThis.discoverabilityEngine = this;
  }
  async start() { this.running = true; }
  async stop() { this.running = false; }
  async request(command, payload) {
    this.commands.push({ command, payload });
    if (command === 'get_state_optional') return { active: false };
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

function snapshot(sessionId) {
  return {
    schema_version: 1,
    journal_seq: 1,
    session_id: sessionId,
    script_name: 'test.tsv',
    status: 'stopped',
    device_name: 'Studio Interface',
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
    started_at: '2026-08-12T00:00:00Z',
    updated_at: '2026-08-12T00:00:01Z',
    noise_check: null,
    silence_duration_ms: 1_000,
    silence_threshold_dbfs: -42,
    items: [{
      id: '001', text: 'hello', label: '', status: 'accepted', attempts: [], selected_attempt_id: null,
    }],
  };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`);
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-discoverability-'));
  const userData = path.join(root, 'user-data');
  const documents = path.join(root, 'documents');
  const recordingRoot = path.join(root, 'external-drive-recordings');
  await Promise.all([
    fs.mkdir(userData, { recursive: true }),
    fs.mkdir(documents, { recursive: true }),
    fs.mkdir(recordingRoot, { recursive: true }),
  ]);
  const recordingRootCanonical = await fs.realpath(recordingRoot);
  const recordingRootStat = await fs.lstat(recordingRootCanonical, { bigint: true });
  await writeJson(path.join(userData, 'output-root.json'), {
    schemaVersion: 2,
    outputRoot: recordingRoot,
    canonicalRoot: recordingRootCanonical,
    device: recordingRootStat.dev.toString(),
    inode: recordingRootStat.ino.toString(),
    birthtimeNs: recordingRootStat.birthtimeNs.toString(),
  });

  const validDir = path.join(recordingRoot, 'valid-session');
  await fs.mkdir(path.join(validDir, 'metadata'), { recursive: true });
  await writeJson(path.join(validDir, 'session.json'), { schema_version: 1, session_id: 'valid-session' });
  await writeJson(path.join(validDir, 'metadata', 'items.snapshot.json'), snapshot('valid-session'));

  const conflictDir = path.join(recordingRoot, 'conflicting-session');
  await fs.mkdir(path.join(conflictDir, 'metadata'), { recursive: true });
  await writeJson(path.join(conflictDir, 'session.json'), { schema_version: 1, session_id: 'conflicting-session' });
  await writeJson(
    path.join(conflictDir, 'metadata', 'items.snapshot.json'),
    snapshot('conflicting-session'),
  );
  await writeJson(
    path.join(conflictDir, 'metadata', 'items.snapshot.prev'),
    snapshot('foreign-session'),
  );

  const partialDir = path.join(recordingRoot, 'audio-only-session');
  await fs.mkdir(path.join(partialDir, 'audio'), { recursive: true });
  await fs.mkdir(path.join(recordingRoot, 'unrelated-folder'));
  const unrelatedDirectoryCount = 120;
  const unrelatedDirectories = await Promise.all(Array.from(
    { length: unrelatedDirectoryCount },
    async (_, index) => {
      const directory = path.join(recordingRoot, `unrelated-${String(index).padStart(3, '0')}`);
      await fs.mkdir(directory);
      return directory;
    },
  ));
  const bulkSessionCount = 205;
  await Promise.all(Array.from({ length: bulkSessionCount }, async (_, index) => {
    const sessionId = `bulk-${String(index).padStart(3, '0')}`;
    const sessionDir = path.join(recordingRoot, sessionId);
    await fs.mkdir(path.join(sessionDir, 'metadata'), { recursive: true });
    await Promise.all([
      writeJson(path.join(sessionDir, 'session.json'), { schema_version: 1, session_id: sessionId }),
      writeJson(path.join(sessionDir, 'metadata', 'items.snapshot.json'), snapshot(sessionId)),
    ]);
  }));
  const oldTimestamp = new Date('2020-01-01T00:00:00Z');
  const recentMetadataTimestamp = new Date(Date.now() + 60_000);
  const newerUnrelatedTimestamp = new Date(Date.now() + 120_000);
  await fs.utimes(validDir, oldTimestamp, oldTimestamp);
  await fs.utimes(path.join(validDir, 'metadata'), recentMetadataTimestamp, recentMetadataTimestamp);
  await Promise.all(unrelatedDirectories.map((directory) => (
    fs.utimes(directory, newerUnrelatedTimestamp, newerUnrelatedTimestamp)
  )));

  const handlers = new Map();
  const appEvents = new Map();
  const openedPaths = [];
  let outputSelection = null;
  const electronStub = {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: (name, listener) => appEvents.set(name, listener),
      quit: () => undefined,
      getPath: (name) => (name === 'userData' ? userData : documents),
      getAppPath: () => process.cwd(),
      setBadgeCount: () => undefined,
    },
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showOpenDialog: async () => outputSelection
        ? { canceled: false, filePaths: [outputSelection] }
        : { canceled: true, filePaths: [] },
      showMessageBox: async () => ({ response: 0 }),
    },
    ipcMain: {
      handle: (name, listener) => handlers.set(name, listener),
      on: () => undefined,
    },
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: () => undefined }) },
    screen: { getPrimaryDisplay: () => ({ id: 1, workArea: {} }), getAllDisplays: () => [] },
    shell: { openPath: async (target) => { openedPaths.push(target); return ''; } },
    Tray: class extends EventEmitter {},
  };

  const previousDefault = process.env.DATABAKER_DEFAULT_OUTPUT;
  delete process.env.DATABAKER_DEFAULT_OUTPUT;
  const originalLoad = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === './engine-client' && parent?.filename.endsWith(`${path.sep}dist-electron${path.sep}main.js`)) {
      return {
        EngineClient: FakeEngineClient,
        EngineRequestError: class extends Error {},
        EngineRequestTimeoutError: class extends Error {},
        EngineSafeStopTimeoutError: class extends Error {},
        EngineUnsafeStopError: class extends Error {},
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
      () => handlers.has('app:default-output') && FakeBrowserWindow.instances.length > 0,
      'main IPC registration',
    );
    const window = FakeBrowserWindow.instances[0];
    const event = { sender: window.webContents };
    const restored = await handlers.get('app:default-output')(event);
    assert.deepEqual(restored, { outputRoot: recordingRoot },
      'a restarted app must restore the last external recording root');
    const selected = restored.outputRoot;

    const listRecordings = handlers.get('recordings:list');
    let page = await listRecordings(event, selected, { offset: 0, limit: 100 });
    assert.equal(page.scanned_directories <= 100, true,
      'one history request must never parse more than its bounded page');
    assert.equal(page.recordings.some((row) => row.session_id === 'valid-session'), true,
      'unrelated newer directories must not consume the bounded page or hide a real task');
    const rows = [...page.recordings];
    while (page.next_offset !== null) {
      page = await listRecordings(event, selected, { offset: page.next_offset, limit: 100 });
      assert.equal(page.scanned_directories <= 100, true);
      rows.push(...page.recordings);
    }
    assert.equal(rows.length, bulkSessionCount + 3,
      'pagination must reach the 201st task, and damaged directories must remain visible');
    assert.equal(rows.some((row) => row.session_id === 'valid-session' && !row.history_issue), true);
    const conflict = rows.find((row) => row.session_id === 'conflicting-session');
    assert.match(conflict.history_issue, /身份不一致/);
    const partial = rows.find((row) => row.session_id === 'audio-only-session');
    assert.match(partial.history_issue, /元数据目录缺失/);
    assert.equal(rows.some((row) => row.session_id === 'unrelated-folder'), false,
      'ordinary folders in a broad selected root must not become fake tasks');

    await handlers.get('shell:open-path')(event, partialDir);
    assert.deepEqual(openedPaths, [partialDir],
      'an inspection-only damaged task must still allow opening its real directory');
    await assert.rejects(
      handlers.get('engine:request')(event, 'export_session', { session_dir: partialDir }),
      /无法确认录制任务身份/,
      'a visible damaged task must not become trusted for export',
    );
    assert.equal(globalThis.discoverabilityEngine.commands.some(({ command }) => command === 'export_session'), false);

    const nextRecordingRoot = path.join(root, 'second-external-drive');
    await fs.mkdir(nextRecordingRoot);
    outputSelection = nextRecordingRoot;
    assert.equal(await handlers.get('dialog:choose-output')(event), nextRecordingRoot);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(userData, 'output-root.json'), 'utf8')).outputRoot,
      nextRecordingRoot,
      'choosing a root must durably update the restart preference before the UI switches',
    );
    assert.deepEqual(
      await handlers.get('app:default-output')(event),
      { outputRoot: nextRecordingRoot },
    );

    // A failed same-path re-selection must not remove the previous in-memory
    // volume binding. Make the preference destination a directory so the
    // repository's final atomic rename fails after path/identity validation.
    const preferencePath = path.join(userData, 'output-root.json');
    await fs.rename(preferencePath, path.join(userData, 'output-root.saved.json'));
    await fs.mkdir(preferencePath);
    outputSelection = nextRecordingRoot;
    await assert.rejects(
      handlers.get('dialog:choose-output')(event),
      /EISDIR|directory|rename/i,
      'a preference-write failure must reject the re-selection',
    );
    await fs.rmdir(nextRecordingRoot);
    const missingTarget = path.join(nextRecordingRoot, 'must-not-be-created');
    await assert.rejects(
      handlers.get('engine:request')(event, 'start_session', {
        session_id: 'must-not-be-created',
        session_dir: missingTarget,
      }),
      /当前不可用.*重连外置盘/,
      'a failed re-selection must retain the old binding and refuse to recreate its missing root',
    );
    await assert.rejects(fs.lstat(nextRecordingRoot), { code: 'ENOENT' });
    assert.equal(
      globalThis.discoverabilityEngine.commands.some(({ command }) => command === 'start_session'),
      false,
      'a failed re-selection must not let start_session reach the engine',
    );

    await fs.mkdir(nextRecordingRoot);
    await assert.rejects(
      listRecordings(event, nextRecordingRoot, { offset: 0, limit: 100 }),
      /磁盘或目录身份已变化/,
      'a different directory or volume at the same path must never inherit recording authorization',
    );
    await fs.rmdir(nextRecordingRoot);
    await assert.rejects(
      listRecordings(event, nextRecordingRoot, { offset: 0, limit: 100 }),
      /当前不可用.*重连外置盘/,
      'a disconnected remembered volume must be reported, not rendered as an empty task list',
    );

    // Corrupting the sole saved pointer must not silently switch the operator
    // to an empty local directory and make the external tasks look lost.
    await fs.rm(preferencePath, { recursive: true, force: true });
    await fs.writeFile(preferencePath, '{broken', 'utf8');
    const damagedPreference = await handlers.get('app:default-output')(event);
    assert.equal(damagedPreference.outputRoot, '');
    assert.match(damagedPreference.warning, /损坏.*重新选择原保存目录/);
    assert.deepEqual(
      await handlers.get('app:default-output')(event),
      damagedPreference,
      'a renderer reload must not silently clear the re-selection requirement',
    );

    // Only an explicit selection clears the corruption warning and publishes
    // a newly identity-bound root.
    const localDefault = path.join(documents, 'DataBaker Recordings');
    await fs.mkdir(localDefault, { recursive: true });
    outputSelection = localDefault;
    assert.equal(await handlers.get('dialog:choose-output')(event), localDefault);
    assert.deepEqual(
      await handlers.get('app:default-output')(event),
      { outputRoot: localDefault },
    );
    assert.equal(
      JSON.parse(await fs.readFile(preferencePath, 'utf8')).outputRoot,
      localDefault,
    );

    // An administrator-provided removable output receives the same persisted
    // identity protection as a dialog selection.
    const missingEnvironmentRoot = path.join(root, 'missing-configured-output');
    process.env.DATABAKER_DEFAULT_OUTPUT = missingEnvironmentRoot;
    await assert.rejects(
      handlers.get('app:default-output')(event),
      /ENOENT|no such file|cannot find/i,
      'a missing administrator output must not be recreated on the system disk',
    );
    await assert.rejects(fs.lstat(missingEnvironmentRoot), { code: 'ENOENT' });

    const environmentRoot = path.join(root, 'configured-removable-output');
    await fs.mkdir(environmentRoot);
    process.env.DATABAKER_DEFAULT_OUTPUT = environmentRoot;
    assert.deepEqual(
      await handlers.get('app:default-output')(event),
      { outputRoot: environmentRoot },
    );
    await fs.rmdir(environmentRoot);
    await fs.mkdir(environmentRoot);
    await assert.rejects(
      listRecordings(event, environmentRoot, { offset: 0, limit: 100 }),
      /磁盘或目录身份已变化/,
      'a configured removable root must reject a same-path replacement after restart binding',
    );
  } finally {
    if (previousDefault === undefined) delete process.env.DATABAKER_DEFAULT_OUTPUT;
    else process.env.DATABAKER_DEFAULT_OUTPUT = previousDefault;
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('history discoverability and output-root restore tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
