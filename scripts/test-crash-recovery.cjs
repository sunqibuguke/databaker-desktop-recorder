const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');

const workspace = path.resolve(__dirname, '..');
const executable = process.argv[2] && process.argv[2] !== '--fixture-writer'
  ? path.resolve(process.argv[2])
  : path.join(
      workspace,
      'engine',
      'target',
      'debug',
      process.platform === 'win32' ? 'recorder-engine.exe' : 'recorder-engine',
    );
const sampleRate = 48_000;
const bitDepth = 24;
const frameBytes = 3;
const wavHeaderBytes = 44;

function writeDurable(filePath, contents) {
  const descriptor = fs.openSync(filePath, 'w');
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function makeSnapshot(sessionId, sequence, committedSamples) {
  return {
    schema_version: 1,
    journal_seq: sequence,
    session_id: sessionId,
    script_name: 'crash-recovery.csv',
    status: 'recording',
    device_name: 'crash fixture',
    device_id: 'null:crash-fixture',
    input_sample_format: 'f32',
    audio_format: {
      sample_rate: sampleRate,
      bit_depth: bitDepth,
      encoding: 'pcm',
      channels: 1,
      input_channels: 1,
      input_channel: 1,
    },
    master_audio: 'audio/segments',
    storage_layout_version: 1,
    segment_frames: sampleRate,
    captured_samples: committedSamples,
    committed_samples: committedSamples,
    overflow_samples: 0,
    started_at: '2026-08-11T00:00:00Z',
    updated_at: '2026-08-11T00:00:01Z',
    noise_check: null,
    silence_duration_ms: 1_000,
    silence_threshold_dbfs: -42,
    items: [{
      id: '001',
      text: '崩溃恢复测试',
      label: '中性',
      status: 'pending',
      attempts: [],
      selected_attempt_id: null,
    }],
  };
}

function makeEvent(kind, snapshot, payload = {}) {
  return {
    journal_seq: snapshot.journal_seq,
    event: kind,
    at: '2026-08-11T00:00:01Z',
    payload,
    captured_samples: snapshot.captured_samples,
    committed_samples: snapshot.committed_samples,
    snapshot,
  };
}

function makePcm24Wav(headerFrames, physicalFrames, incompleteTailBytes) {
  const physicalDataBytes = physicalFrames * frameBytes + incompleteTailBytes;
  const headerDataBytes = headerFrames * frameBytes;
  const output = Buffer.alloc(wavHeaderBytes + physicalDataBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + headerDataBytes, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * frameBytes, 28);
  output.writeUInt16LE(frameBytes, 32);
  output.writeUInt16LE(bitDepth, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(headerDataBytes, 40);
  for (let index = 0; index < physicalDataBytes; index += 1) {
    output[wavHeaderBytes + index] = (index * 17 + 29) & 0xff;
  }
  return output;
}

function prepareSession(root, options) {
  for (const directory of ['audio/segments', 'metadata', 'script', 'preview', 'export']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const finalSnapshot = path.join(root, 'metadata', 'items.snapshot.json');
  const latest = makeSnapshot(options.sessionId, options.latestSequence, options.headerFrames);
  const first = makeSnapshot(options.sessionId, 1, options.headerFrames);
  writeDurable(
    path.join(root, 'session.json'),
    `${JSON.stringify({
      schema_version: 1,
      journal_seq: options.latestSequence,
      session_id: options.sessionId,
      status: 'recording',
    })}\n`,
  );

  if (options.multigeneration) {
    writeDurable(finalSnapshot, '{"truncated_final_snapshot":');
    writeDurable(path.join(root, 'metadata', 'items.snapshot.prev'), `${JSON.stringify(first)}\n`);
    writeDurable(path.join(root, 'metadata', 'items.snapshot.tmp'), `${JSON.stringify(latest)}\n`);
  } else {
    writeDurable(finalSnapshot, `${JSON.stringify(latest)}\n`);
  }

  const journal = [JSON.stringify(makeEvent('session_started', first))];
  if (options.openAttempt) {
    const started = makeSnapshot(options.sessionId, 2, options.headerFrames);
    journal.push(JSON.stringify(makeEvent('attempt_started', started, {
      item_id: '001',
      attempt_id: '001-crashed',
      start_sample: 100,
      recording_started_sample: 110,
    })));
  }
  if (options.truncatedJournalTail) {
    journal.push('{"journal_seq":999,"event":"attempt_stopped","snapshot":');
    writeDurable(path.join(root, 'metadata', 'events.jsonl'), `${journal.join('\n')}`);
  } else {
    writeDurable(path.join(root, 'metadata', 'events.jsonl'), `${journal.join('\n')}\n`);
  }

  const wavPath = path.join(root, 'audio', 'segments', 'master-000001.wav');
  writeDurable(
    wavPath,
    makePcm24Wav(options.headerFrames, options.physicalFrames, options.incompleteTailBytes),
  );
  return fs.openSync(wavPath, 'r+');
}

function runFixtureWriter(root) {
  const killedSession = path.join(root, 'killed-recording');
  const aheadSession = path.join(root, 'header-ahead');
  const descriptors = [
    prepareSession(killedSession, {
      sessionId: 'killed-recording',
      latestSequence: 3,
      headerFrames: 96,
      physicalFrames: 333,
      incompleteTailBytes: 1,
      multigeneration: true,
      openAttempt: true,
      truncatedJournalTail: true,
    }),
    prepareSession(aheadSession, {
      sessionId: 'header-ahead',
      latestSequence: 1,
      headerFrames: 420,
      physicalFrames: 211,
      incompleteTailBytes: 0,
      multigeneration: false,
      openAttempt: false,
      truncatedJournalTail: false,
    }),
  ];
  writeDurable(
    path.join(root, 'fixture-ready.json'),
    `${JSON.stringify({ killedSession, aheadSession, pid: process.pid })}\n`,
  );
  // Keep the recording handles alive. The parent uses SIGKILL/TerminateProcess,
  // so neither a Rust destructor nor a cooperative shutdown can repair them.
  setInterval(() => descriptors.length, 60_000);
}

class EngineClient {
  constructor() {
    this.child = spawn(executable, [], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.stderr = '';
    this.pending = new Map();
    this.sequence = 0;
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('engine_ready timed out')), 10_000);
      this.readyResolve = () => { clearTimeout(timer); resolve(); };
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.failAll(new Error(`engine emitted invalid JSON: ${error.message}`));
        return;
      }
      if (message.event === 'engine_ready') {
        this.readyResolve();
        return;
      }
      const pending = this.pending.get(message.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.request_id);
        pending.resolve(message);
      }
    });
    this.child.once('error', (error) => this.failAll(error));
    this.child.once('exit', (code, signal) => {
      this.exit = { code, signal };
      this.failAll(new Error(`engine exited early: code=${code}, signal=${signal}`));
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(command, payload = {}) {
    await this.ready;
    const requestId = `crash-e2e-${++this.sequence}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`engine command ${command} timed out`));
      }, 15_000);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({
      protocol_version: 1,
      request_id: requestId,
      command,
      payload,
    })}\n`);
    return response;
  }

  async close() {
    if (this.exit) return;
    const response = await this.request('shutdown');
    assert.equal(response.ok, true, response.error?.message);
    this.child.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill();
        reject(new Error(`engine shutdown timed out\n${this.stderr}`));
      }, 10_000);
      this.child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`engine shutdown failed with ${code}\n${this.stderr}`));
      });
    });
  }
}

async function waitForFile(filePath, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    if (child.exitCode !== null) throw new Error(`fixture writer exited with ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('fixture writer did not become ready');
}

function assertRepairedPcm24(wavPath, expectedFrames, expectedAudio) {
  const bytes = fs.readFileSync(wavPath);
  assert.equal(bytes.length, wavHeaderBytes + expectedFrames * frameBytes);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(4), 36 + expectedFrames * frameBytes);
  assert.equal(bytes.toString('ascii', 36, 40), 'data');
  assert.equal(bytes.readUInt32LE(40), expectedFrames * frameBytes);
  assert.deepEqual(bytes.subarray(wavHeaderBytes), expectedAudio);
}

function listWavSegments(directory) {
  return fs.readdirSync(directory).filter((name) => /^master-\d{6}\.wav$/.test(name)).sort();
}

function assertPcm24SegmentDescriptor(wavPath) {
  const descriptorPath = `${wavPath}.descriptor.json`;
  const metadata = fs.lstatSync(descriptorPath);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')), {
    schema_version: 1,
    kind: 'databaker.segmented-wav-header',
    segment_index: 1,
    segment_file: path.basename(wavPath),
    sample_rate: sampleRate,
    channels: 1,
    bit_depth: bitDepth,
    encoding: 'pcm',
    header_len: wavHeaderBytes,
    max_frames_per_segment: sampleRate,
  });
}

async function recover(sessionDir) {
  const engine = new EngineClient();
  try {
    const response = await engine.request('seal_interrupted_session', {
      session_dir: sessionDir,
      expected_session_id: path.basename(sessionDir),
    });
    assert.equal(response.ok, true, response.error?.message);
    return response.result;
  } finally {
    await engine.close();
  }
}

async function main() {
  assert.ok(fs.existsSync(executable), `engine executable not found: ${executable}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'databaker-crash-recovery-'));
  let fixture;
  try {
    fixture = spawn(process.execPath, [__filename, '--fixture-writer', root], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let fixtureStderr = '';
    fixture.stderr.setEncoding('utf8');
    fixture.stderr.on('data', (chunk) => { fixtureStderr += chunk; });
    await waitForFile(path.join(root, 'fixture-ready.json'), fixture);
    const fixtureInfo = JSON.parse(fs.readFileSync(path.join(root, 'fixture-ready.json'), 'utf8'));
    const killedWav = path.join(
      fixtureInfo.killedSession,
      'audio',
      'segments',
      'master-000001.wav',
    );
    const aheadWav = path.join(
      fixtureInfo.aheadSession,
      'audio',
      'segments',
      'master-000001.wav',
    );
    const killedBefore = fs.readFileSync(killedWav);
    const aheadBefore = fs.readFileSync(aheadWav);
    const killedSnapshotPaths = [
      path.join(fixtureInfo.killedSession, 'metadata', 'items.snapshot.json'),
      path.join(fixtureInfo.killedSession, 'metadata', 'items.snapshot.tmp'),
      path.join(fixtureInfo.killedSession, 'metadata', 'items.snapshot.prev'),
    ];
    const killedSnapshotsBefore = killedSnapshotPaths.map(
      (candidate) => fs.readFileSync(candidate),
    );
    const killedSegmentsBefore = fs.readdirSync(path.dirname(killedWav)).sort();
    const aheadSnapshotPath = path.join(
      fixtureInfo.aheadSession,
      'metadata',
      'items.snapshot.json',
    );
    const aheadSnapshotBefore = fs.readFileSync(aheadSnapshotPath);
    const aheadSegmentsBefore = fs.readdirSync(path.dirname(aheadWav)).sort();
    const killedFrames = Math.floor((killedBefore.length - wavHeaderBytes) / frameBytes);
    const aheadFrames = Math.floor((aheadBefore.length - wavHeaderBytes) / frameBytes);
    assert.equal(killedFrames, 333);
    assert.equal(aheadFrames, 211);
    assert.equal(killedBefore.readUInt32LE(40), 96 * frameBytes);
    assert.equal(aheadBefore.readUInt32LE(40), 420 * frameBytes);
    assert.match(killedSnapshotsBefore[0].toString('utf8'), /truncated_final_snapshot/);
    assert.equal(JSON.parse(killedSnapshotsBefore[1].toString('utf8')).journal_seq, 3);
    assert.equal(JSON.parse(killedSnapshotsBefore[2].toString('utf8')).journal_seq, 1);

    fixture.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    const fixtureExit = await new Promise((resolve) => {
      fixture.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.ok(
      fixtureExit.signal !== null || fixtureExit.code !== 0,
      `fixture writer exited cooperatively\n${fixtureStderr}`,
    );

    const killedResult = await recover(fixtureInfo.killedSession);
    assert.equal(killedResult.no_op, false);
    assert.equal(killedResult.durable_frames, killedFrames);
    assert.equal(killedResult.recovered_attempts, 1);
    assert.equal(killedResult.fault_preserved, false);
    assert.equal(killedResult.snapshot.status, 'stopped');
    assert.equal(killedResult.snapshot.captured_samples, killedFrames);
    assert.equal(killedResult.snapshot.committed_samples, killedFrames);
    assert.equal(killedResult.snapshot.journal_seq, 4);
    const interrupted = killedResult.snapshot.items[0].attempts[0];
    assert.equal(interrupted.attempt_id, '001-crashed');
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.start_sample, 100);
    assert.equal(interrupted.end_sample, killedFrames);
    assert.ok(killedResult.warnings.some((warning) => warning.includes('最后一行不完整')));
    assert.ok(killedResult.warnings.some((warning) => warning.includes('最终快照')));
    assert.ok(killedResult.warnings.some((warning) => warning.includes('上次退出时未完成')));
    assertRepairedPcm24(
      killedWav,
      killedFrames,
      killedBefore.subarray(wavHeaderBytes, wavHeaderBytes + killedFrames * frameBytes),
    );
    assert.deepEqual(
      listWavSegments(path.dirname(killedWav)),
      killedSegmentsBefore.filter((name) => /^master-\d{6}\.wav$/.test(name)),
    );
    assertPcm24SegmentDescriptor(killedWav);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(killedSnapshotPaths[0], 'utf8')),
      killedResult.snapshot,
    );
    const killedJournalPath = path.join(
      fixtureInfo.killedSession,
      'metadata',
      'events.jsonl',
    );
    const repairedJournal = fs.readFileSync(killedJournalPath, 'utf8');
    assert.ok(repairedJournal.endsWith('\n'));
    const repairedJournalLines = repairedJournal.trimEnd().split('\n');
    assert.equal(repairedJournalLines.length, 1);
    const sealEvent = JSON.parse(repairedJournalLines[0]);
    assert.equal(sealEvent.event, 'session_interrupted_sealed');
    assert.equal(sealEvent.journal_seq, 4);
    assert.deepEqual(sealEvent.snapshot, killedResult.snapshot);

    const killedAfterFirstSeal = {
      wav: fs.readFileSync(killedWav),
      journal: fs.readFileSync(killedJournalPath),
      snapshot: fs.readFileSync(killedSnapshotPaths[0]),
      segments: fs.readdirSync(path.dirname(killedWav)).sort(),
    };
    const secondKilledResult = await recover(fixtureInfo.killedSession);
    assert.equal(secondKilledResult.no_op, true);
    assert.equal(secondKilledResult.durable_frames, killedFrames);
    assert.equal(secondKilledResult.recovered_attempts, 0);
    assert.equal(secondKilledResult.snapshot.status, 'stopped');
    assert.equal(secondKilledResult.snapshot.journal_seq, 4);
    assert.deepEqual(fs.readFileSync(killedWav), killedAfterFirstSeal.wav);
    assert.deepEqual(fs.readFileSync(killedJournalPath), killedAfterFirstSeal.journal);
    assert.deepEqual(fs.readFileSync(killedSnapshotPaths[0]), killedAfterFirstSeal.snapshot);
    assert.deepEqual(
      fs.readdirSync(path.dirname(killedWav)).sort(),
      killedAfterFirstSeal.segments,
    );

    const aheadResult = await recover(fixtureInfo.aheadSession);
    assert.equal(aheadResult.no_op, false);
    assert.equal(aheadResult.durable_frames, aheadFrames);
    assert.equal(aheadResult.recovered_attempts, 0);
    assert.equal(aheadResult.fault_preserved, false);
    assert.equal(aheadResult.snapshot.status, 'stopped');
    assert.equal(aheadResult.snapshot.captured_samples, aheadFrames);
    assert.equal(aheadResult.snapshot.committed_samples, aheadFrames);
    assert.equal(aheadResult.snapshot.journal_seq, 2);
    assertRepairedPcm24(
      aheadWav,
      aheadFrames,
      aheadBefore.subarray(wavHeaderBytes, wavHeaderBytes + aheadFrames * frameBytes),
    );
    assert.deepEqual(
      listWavSegments(path.dirname(aheadWav)),
      aheadSegmentsBefore.filter((name) => /^master-\d{6}\.wav$/.test(name)),
    );
    assertPcm24SegmentDescriptor(aheadWav);
    assert.notDeepEqual(fs.readFileSync(aheadSnapshotPath), aheadSnapshotBefore);
    assert.deepEqual(JSON.parse(fs.readFileSync(aheadSnapshotPath, 'utf8')), aheadResult.snapshot);

    const markerPath = path.join(fixtureInfo.killedSession, 'metadata', 'audio-fault.json');
    const temporaryMarkerPath = path.join(fixtureInfo.killedSession, 'metadata', 'audio-fault.tmp');
    for (const candidate of [markerPath, temporaryMarkerPath]) {
      writeDurable(candidate, '{"reason":"injected crash fault"}\n');
      const engine = new EngineClient();
      try {
        for (const command of ['resume_session', 'export_session']) {
          const response = await engine.request(command, {
            session_dir: fixtureInfo.killedSession,
            ...(command === 'resume_session'
              ? { expected_session_id: 'killed-recording' }
              : {}),
          });
          assert.equal(response.ok, false, `${command} unexpectedly succeeded`);
          assert.match(response.error.message, /不可忽略的音频采集故障/);
        }
      } finally {
        await engine.close();
      }
      fs.unlinkSync(candidate);
    }

    process.stdout.write(
      `crash recovery black-box passed: killed=${killedFrames} frames, header-ahead=${aheadFrames} frames\n`,
    );
  } finally {
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      fixture.kill();
      await new Promise((resolve) => fixture.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[2] === '--fixture-writer') {
  try {
    runFixtureWriter(path.resolve(process.argv[3]));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
} else {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
