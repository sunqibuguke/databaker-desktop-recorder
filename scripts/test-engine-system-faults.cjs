const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');

const workspace = path.resolve(__dirname, '..');
const executableName = process.platform === 'win32' ? 'recorder-engine.exe' : 'recorder-engine';
const systemTestEngine = path.resolve(
  process.env.DATABAKER_SYSTEM_TEST_ENGINE
    ?? path.join(workspace, 'engine', 'target', 'system-test', 'debug', executableName),
);
const releaseEngine = path.resolve(
  process.env.DATABAKER_RELEASE_ENGINE
    ?? path.join(workspace, 'engine', 'target', 'release', executableName),
);

function parseProfile(argv) {
  let profile = 'quick';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') {
      profile = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (profile !== 'quick') throw new Error(`unsupported system-test profile: ${profile}`);
  return profile;
}

class EngineClient {
  constructor(executable, label) {
    this.executable = executable;
    this.label = label;
    this.sequence = 0;
    this.pending = new Map();
    this.stderr = '';
    this.exited = false;
    this.child = spawn(executable, [], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} engine_ready timed out\n${this.stderr}`));
      }, 15_000);
      this.resolveReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.rejectReady = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.failPending(new Error(`${label} emitted invalid JSON: ${error.message}`));
        return;
      }
      if (message.event === 'engine_ready') {
        assert.equal(message.protocol_version, 1, `${label} protocol version`);
        this.resolveReady();
        return;
      }
      const pending = this.pending.get(message.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.request_id);
        pending.resolve(message);
      }
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exited = true;
        const result = { code, signal };
        this.exitResult = result;
        const error = new Error(
          `${label} exited: code=${code}, signal=${signal}${this.stderr ? `\n${this.stderr}` : ''}`,
        );
        this.rejectReady(error);
        this.failPending(error);
        resolve(result);
      });
    });
    this.child.once('error', (error) => {
      this.rejectReady(error);
      this.failPending(error);
    });
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(command, payload = {}, timeoutMs = 20_000) {
    await this.ready;
    assert.equal(this.exited, false, `${this.label} already exited`);
    const requestId = `${this.label}-${++this.sequence}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${this.label} command ${command} timed out\n${this.stderr}`));
      }, timeoutMs);
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

  async requestOk(command, payload = {}, timeoutMs = 20_000) {
    const response = await this.request(command, payload, timeoutMs);
    assert.equal(response.ok, true, `${this.label} ${command}: ${response.error?.message}`);
    return response.result;
  }

  async close() {
    if (this.exited) return this.exitResult;
    await this.requestOk('shutdown');
    this.child.stdin.end();
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`${this.label} clean exit timed out\n${this.stderr}`)),
        15_000,
      );
    });
    const result = await Promise.race([this.exitPromise, timeout]).finally(() => {
      clearTimeout(timeoutId);
    });
    assert.equal(result.code, 0, `${this.label} clean exit\n${this.stderr}`);
    return result;
  }
}

async function hardKill(client) {
  assert.equal(client.exited, false, 'system-test engine exited before forced termination');
  if (process.platform === 'win32') {
    const result = spawnSync(
      'taskkill.exe',
      ['/PID', String(client.child.pid), '/T', '/F'],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(
      result.status,
      0,
      `taskkill failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  } else {
    assert.equal(client.child.kill('SIGKILL'), true, 'SIGKILL was not delivered');
  }
  const result = await client.exitPromise;
  assert.ok(
    result.signal !== null || result.code !== 0,
    `system-test engine exited cooperatively: ${JSON.stringify(result)}`,
  );
  return result;
}

async function waitForAutomaticCheckpoint(client, minimumFrames, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await client.requestOk('get_state_optional');
    if (Number(lastState.snapshot?.committed_samples ?? 0) >= minimumFrames) return lastState;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `automatic audio checkpoint did not reach ${minimumFrames} frames; last state: `
      + JSON.stringify(lastState),
  );
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashRecoveryTree(sessionDir) {
  const roots = [
    path.join(sessionDir, 'audio'),
    path.join(sessionDir, 'metadata'),
    path.join(sessionDir, 'session.json'),
  ];
  const entries = [];
  const visit = (entry) => {
    const metadata = fs.lstatSync(entry);
    assert.equal(metadata.isSymbolicLink(), false, `unexpected symlink in recovery tree: ${entry}`);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(entry).sort()) visit(path.join(entry, name));
    } else if (metadata.isFile()) {
      const relative = path.relative(sessionDir, entry);
      // Acquiring the inter-process lease intentionally refreshes its owner
      // diagnostics even when sealing is otherwise a metadata/audio no-op.
      if (relative !== path.join('metadata', 'session.lock')) {
        entries.push([relative, sha256(entry)]);
      }
    }
  };
  for (const entry of roots) visit(entry);
  return entries;
}

function inspectPcm24Wav(filePath, sampleRate) {
  const source = fs.readFileSync(filePath);
  assert.ok(source.length >= 44, `${filePath} is shorter than a PCM WAV header`);
  assert.equal(source.toString('ascii', 0, 4), 'RIFF');
  assert.equal(source.toString('ascii', 8, 12), 'WAVE');
  assert.equal(source.toString('ascii', 12, 16), 'fmt ');
  assert.equal(source.readUInt16LE(20), 1, `${filePath} is not integer PCM`);
  assert.equal(source.readUInt16LE(22), 1, `${filePath} is not mono`);
  assert.equal(source.readUInt32LE(24), sampleRate);
  assert.equal(source.readUInt16LE(32), 3);
  assert.equal(source.readUInt16LE(34), 24);
  assert.equal(source.toString('ascii', 36, 40), 'data');
  const dataBytes = source.readUInt32LE(40);
  assert.equal(dataBytes % 3, 0, `${filePath} contains an incomplete PCM frame`);
  assert.equal(source.length, 44 + dataBytes, `${filePath} header does not match EOF`);
  assert.equal(source.readUInt32LE(4), source.length - 8, `${filePath} RIFF size is stale`);
  return dataBytes / 3;
}

function verifyRecoveredSession(sessionDir, recovery, expected) {
  const { sampleRate, bitDepth, segmentFrames, checkpointFrames, capturedFrames } = expected;
  assert.equal(bitDepth, 24);
  assert.equal(recovery.no_op, false);
  assert.equal(recovery.fault_preserved, false);
  assert.equal(recovery.snapshot.status, 'stopped');
  assert.equal(recovery.snapshot.overflow_samples, 0);
  const durableFrames = Number(recovery.durable_frames);
  assert.ok(durableFrames >= checkpointFrames, 'recovery lost checkpointed audio');
  assert.ok(durableFrames <= capturedFrames, 'recovery invented frames beyond the accepted timeline');
  assert.ok(
    capturedFrames - durableFrames <= sampleRate * 30,
    'recovery exceeded the 30-second tail-loss budget',
  );
  assert.equal(recovery.snapshot.captured_samples, durableFrames);
  assert.equal(recovery.snapshot.committed_samples, durableFrames);
  assert.equal(recovery.snapshot.segment_frames, segmentFrames);

  const segmentsDir = path.join(sessionDir, 'audio', 'segments');
  const segmentNames = fs.readdirSync(segmentsDir)
    .filter((name) => /^master-\d{6}\.wav$/.test(name))
    .sort();
  assert.ok(segmentNames.length >= 2, 'quick profile did not exercise segmented rollover');
  let physicalFrames = 0;
  segmentNames.forEach((name, offset) => {
    const index = offset + 1;
    assert.equal(name, `master-${String(index).padStart(6, '0')}.wav`);
    const wavPath = path.join(segmentsDir, name);
    const frames = inspectPcm24Wav(wavPath, sampleRate);
    if (offset < segmentNames.length - 1) assert.equal(frames, segmentFrames);
    physicalFrames += frames;
    const descriptor = JSON.parse(fs.readFileSync(`${wavPath}.descriptor.json`, 'utf8'));
    assert.equal(descriptor.segment_index, index);
    assert.equal(descriptor.segment_file, name);
    assert.equal(descriptor.sample_rate, sampleRate);
    assert.equal(descriptor.bit_depth, bitDepth);
    assert.equal(descriptor.max_frames_per_segment, segmentFrames);
  });
  assert.equal(physicalFrames, durableFrames, 'segment frames do not match recovery watermark');

  const snapshot = JSON.parse(
    fs.readFileSync(path.join(sessionDir, 'metadata', 'items.snapshot.json'), 'utf8'),
  );
  const summary = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
  assert.equal(snapshot.status, 'stopped');
  assert.equal(snapshot.captured_samples, durableFrames);
  assert.equal(snapshot.committed_samples, durableFrames);
  assert.equal(summary.status, 'stopped');
  assert.equal(summary.journal_seq, snapshot.journal_seq);
  assert.equal(summary.session_id, snapshot.session_id);
  const journalSource = fs.readFileSync(
    path.join(sessionDir, 'metadata', 'events.jsonl'),
    'utf8',
  );
  assert.equal(journalSource.endsWith('\n'), true, 'recovered journal lacks a final newline');
  const journal = journalSource.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(
    journal.some((entry) => entry.event === 'system_test_checkpoint'),
    false,
    'forced-kill qualification must exercise the automatic writer checkpoint, not a test command',
  );
  const finalEvent = journal.at(-1);
  assert.equal(finalEvent.event, 'session_interrupted_sealed');
  assert.equal(finalEvent.journal_seq, snapshot.journal_seq);
  assert.deepEqual(finalEvent.snapshot, snapshot);
  assert.equal(fs.existsSync(path.join(sessionDir, 'metadata', 'audio-fault.json')), false);
  assert.equal(fs.existsSync(path.join(sessionDir, 'metadata', 'audio-fault.tmp')), false);
  return durableFrames;
}

async function main() {
  const profile = parseProfile(process.argv.slice(2));
  assert.ok(fs.existsSync(systemTestEngine), `system-test engine not found: ${systemTestEngine}`);
  assert.ok(fs.existsSync(releaseEngine), `default release engine not found: ${releaseEngine}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'databaker-engine-system-faults-'));
  const sessionDir = path.join(root, 'forced-kill-session');
  // Exercise the production-default format. The synthetic source bypasses
  // hardware but the release recovery path reads the same 48 kHz / 24-bit
  // segmented WAV bytes used in a studio session.
  const sampleRate = 48_000;
  const bitDepth = 24;
  const segmentFrames = sampleRate;
  const checkpointFrames = sampleRate * 10;
  const tailFrames = sampleRate / 4;
  const capturedFrames = checkpointFrames + tailFrames;
  let passed = false;
  let captureClient = null;
  let recoveryClient = null;
  try {
    recoveryClient = new EngineClient(releaseEngine, 'release-negative');
    const forbidden = await recoveryClient.request('test_start_session', {});
    assert.equal(forbidden.ok, false, 'default release unexpectedly accepted a test command');
    assert.match(forbidden.error?.message ?? '', /unknown command test_start_session/);
    await recoveryClient.close();
    recoveryClient = null;

    captureClient = new EngineClient(systemTestEngine, 'system-capture');
    const started = await captureClient.requestOk('test_start_session', {
      session_dir: sessionDir,
      session_id: 'system-fault-quick',
      script_name: 'system fault quick profile',
      device_id: null,
      device_name: null,
      sample_rate: sampleRate,
      bit_depth: bitDepth,
      input_channel: 1,
      silence_duration_ms: 200,
      silence_threshold_dbfs: -42,
      segment_frames: segmentFrames,
      items: [{ id: '001', text: 'deterministic crash recovery', label: 'system-test' }],
    });
    assert.equal(started.snapshot.status, 'recording');
    assert.equal(started.snapshot.device_id, 'system-test:synthetic');
    assert.equal(started.snapshot.segment_frames, segmentFrames);

    const initial = await captureClient.requestOk('test_feed_pcm', {
      frames: checkpointFrames,
      seed: 0x5a17,
      block_frames: 256,
    });
    assert.equal(initial.captured_samples, checkpointFrames);
    const automaticallyCheckpointed = await waitForAutomaticCheckpoint(
      captureClient,
      checkpointFrames,
    );
    assert.equal(automaticallyCheckpointed.snapshot.captured_samples, checkpointFrames);
    assert.equal(automaticallyCheckpointed.snapshot.committed_samples, checkpointFrames);
    const tail = await captureClient.requestOk('test_feed_pcm', {
      frames: tailFrames,
      seed: 0xc0de,
      block_frames: 127,
    });
    assert.equal(tail.captured_samples, capturedFrames);
    const live = await captureClient.requestOk('get_state_optional');
    assert.equal(live.active, true);
    assert.equal(live.snapshot.status, 'recording');
    assert.equal(live.snapshot.captured_samples, capturedFrames);

    const killed = await hardKill(captureClient);
    captureClient = null;

    recoveryClient = new EngineClient(releaseEngine, 'release-recovery');
    const recovery = await recoveryClient.requestOk(
      'seal_interrupted_session',
      { session_dir: sessionDir, expected_session_id: 'system-fault-quick' },
      30_000,
    );
    const durableFrames = verifyRecoveredSession(sessionDir, recovery, {
      sampleRate,
      bitDepth,
      segmentFrames,
      checkpointFrames,
      capturedFrames,
    });
    const treeAfterRecovery = hashRecoveryTree(sessionDir);
    const second = await recoveryClient.requestOk(
      'seal_interrupted_session',
      { session_dir: sessionDir, expected_session_id: 'system-fault-quick' },
      30_000,
    );
    assert.equal(second.no_op, true);
    assert.equal(second.durable_frames, durableFrames);
    assert.deepEqual(second.snapshot, recovery.snapshot);
    assert.deepEqual(hashRecoveryTree(sessionDir), treeAfterRecovery);
    await recoveryClient.close();
    recoveryClient = null;

    passed = true;
    process.stdout.write(
      `engine system fault ${profile} passed: killed=${JSON.stringify(killed)}, `
      + `automatic_checkpoint=${checkpointFrames}, captured=${capturedFrames}, recovered=${durableFrames}\n`,
    );
  } finally {
    if (captureClient && !captureClient.exited) {
      try { await hardKill(captureClient); } catch {}
    }
    if (recoveryClient && !recoveryClient.exited) {
      try { await recoveryClient.close(); } catch {}
    }
    if (passed) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
      process.stderr.write(`system fault artifacts retained at ${root}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
