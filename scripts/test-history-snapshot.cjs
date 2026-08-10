const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request !== 'electron') return originalLoad.call(this, request, parent, isMain);
  const neverReady = new Promise(() => undefined);
  return {
    app: {
      requestSingleInstanceLock: () => true,
      on: () => undefined,
      whenReady: () => neverReady,
      quit: () => undefined,
    },
    BrowserWindow: class {},
    dialog: {},
    ipcMain: {},
    Menu: {},
    nativeImage: {},
    screen: {},
    shell: {},
    Tray: class {},
  };
};

const { hasCompleteExport, loadHistorySnapshot } = require('../dist-electron/main.js');
Module._load = originalLoad;

function snapshot(sessionId, journalSeq, status = 'recording') {
  return {
    schema_version: 1,
    journal_seq: journalSeq,
    session_id: sessionId,
    script_name: 'test.csv',
    status,
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
    captured_samples: 0,
    committed_samples: 0,
    overflow_samples: 0,
    started_at: '2026-08-11T00:00:00Z',
    updated_at: '2026-08-11T00:00:00Z',
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

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`);
}

async function main() {
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'databaker-history-'));
  const root = await fs.realpath(lexicalRoot);
  try {
    const sessionDir = path.join(root, 'session-a');
    const metadataDir = path.join(sessionDir, 'metadata');
    await fs.mkdir(metadataDir, { recursive: true });
    await writeJson(path.join(sessionDir, 'session.json'), {
      schema_version: 1,
      session_id: 'session-a',
    });
    await fs.writeFile(path.join(metadataDir, 'items.snapshot.json'), '{broken');
    await writeJson(path.join(metadataDir, 'items.snapshot.tmp'), snapshot('session-a', 2));
    await writeJson(path.join(metadataDir, 'items.snapshot.prev'), snapshot('session-a', 3));
    const foreign = snapshot('other-session', 99);
    const latest = snapshot('session-a', 4);
    await fs.writeFile(path.join(metadataDir, 'events.jsonl'), [
      JSON.stringify({ event: 'foreign', journal_seq: 99, snapshot: foreign }),
      '{broken middle line',
      JSON.stringify({ event: 'latest', journal_seq: 4, snapshot: latest }),
      '',
    ].join('\n'));

    const recovered = await loadHistorySnapshot(sessionDir, metadataDir);
    assert.equal(recovered?.snapshot.session_id, 'session-a');
    assert.equal(recovered?.snapshot.journal_seq, 4);

    const exportDir = path.join(sessionDir, 'export');
    await fs.mkdir(exportDir);
    await writeJson(path.join(exportDir, 'metadata.json'), { schema_version: 1 });
    assert.equal(await hasCompleteExport(exportDir), true, 'legacy export remains compatible');
    await writeJson(path.join(exportDir, 'status.json'), {
      schema_version: 1,
      status: 'in_progress',
      export_id: 'export-a',
    });
    assert.equal(await hasCompleteExport(exportDir), false, 'partial export stays hidden');
    await fs.writeFile(path.join(exportDir, 'full-track.wav'), 'audio');
    await fs.writeFile(path.join(exportDir, 'metadata.csv'), 'id,text\n');
    await fs.mkdir(path.join(exportDir, 'sentences'));
    await writeJson(path.join(exportDir, 'status.json'), {
      schema_version: 1,
      status: 'complete',
      export_id: 'export-a',
    });
    assert.equal(await hasCompleteExport(exportDir), true, 'committed export is visible');
    await fs.writeFile(path.join(exportDir, 'status.json'), '{broken');
    assert.equal(await hasCompleteExport(exportDir), false, 'corrupt marker cannot publish export');

    await fs.writeFile(path.join(metadataDir, 'audio-fault.tmp'), '{incomplete');
    const faulted = await loadHistorySnapshot(sessionDir, metadataDir);
    assert.equal(faulted?.snapshot.status, 'faulted');
    assert.equal(faulted?.snapshot.audio_fault_marker, true);

    const symlinkSessionDir = path.join(root, 'session-b');
    const symlinkMetadataDir = path.join(symlinkSessionDir, 'metadata');
    await fs.mkdir(symlinkMetadataDir, { recursive: true });
    await writeJson(path.join(symlinkSessionDir, 'session.json'), {
      schema_version: 1,
      session_id: 'session-b',
    });
    const outside = path.join(root, 'outside.json');
    await writeJson(outside, snapshot('session-b', 100));
    await fs.symlink(outside, path.join(symlinkMetadataDir, 'items.snapshot.tmp'));
    await writeJson(path.join(symlinkMetadataDir, 'items.snapshot.prev'), snapshot('session-b', 5));
    const symlinkRecovered = await loadHistorySnapshot(symlinkSessionDir, symlinkMetadataDir);
    assert.equal(symlinkRecovered?.snapshot.journal_seq, 5);

    const layoutSessionDir = path.join(root, 'session-c');
    const layoutMetadataDir = path.join(layoutSessionDir, 'metadata');
    await fs.mkdir(layoutMetadataDir, { recursive: true });
    await writeJson(path.join(layoutSessionDir, 'session.json'), {
      schema_version: 1,
      session_id: 'session-c',
    });
    const unknownLayout = snapshot('session-c', 8);
    unknownLayout.storage_layout_version = 2;
    const zeroLengthLayout = snapshot('session-c', 7);
    zeroLengthLayout.segment_frames = 0;
    const legacyLayout = snapshot('session-c', 6);
    delete legacyLayout.storage_layout_version;
    delete legacyLayout.segment_frames;
    await writeJson(path.join(layoutMetadataDir, 'items.snapshot.json'), unknownLayout);
    await writeJson(path.join(layoutMetadataDir, 'items.snapshot.tmp'), zeroLengthLayout);
    await writeJson(path.join(layoutMetadataDir, 'items.snapshot.prev'), legacyLayout);
    const layoutRecovered = await loadHistorySnapshot(layoutSessionDir, layoutMetadataDir);
    assert.equal(layoutRecovered?.snapshot.journal_seq, 6);
    assert.equal(layoutRecovered?.snapshot.segment_frames, undefined);

    console.log('history snapshot recovery smoke passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
