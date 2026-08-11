'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  defaultOutputRoot,
  engineExitWasClean,
  evaluateInventory,
  faultMarkerPresent,
  inputSampleFormatBits,
  inspectSession,
  inspectWav,
  matchingConfigurations,
  overallFromChecks,
  parseArgs,
  summarizeProgress,
  timestampForPath,
  validateDiskFullTarget,
} = require('./windows-audio-acceptance.cjs');

function makeWav(sampleRate, bitDepth, frames, declaredFrames = frames) {
  const isFloat = bitDepth === 32;
  const sampleBytes = bitDepth / 8;
  const headerLength = isFloat ? 56 : 44;
  const dataBytes = frames * sampleBytes;
  const declaredBytes = declaredFrames * sampleBytes;
  const buffer = Buffer.alloc(headerLength + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(headerLength - 8 + declaredBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(isFloat ? 3 : 1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * sampleBytes, 28);
  buffer.writeUInt16LE(sampleBytes, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  let dataMarker = 36;
  if (isFloat) {
    buffer.write('fact', 36, 'ascii');
    buffer.writeUInt32LE(4, 40);
    buffer.writeUInt32LE(declaredFrames, 44);
    dataMarker = 48;
  }
  buffer.write('data', dataMarker, 'ascii');
  buffer.writeUInt32LE(declaredBytes, dataMarker + 4);
  return buffer;
}

function makeRf64(sampleRate, bitDepth, frames) {
  const isFloat = bitDepth === 32;
  const sampleBytes = bitDepth / 8;
  const headerLength = (isFloat ? 56 : 44) + 36;
  const dataBytes = frames * sampleBytes;
  const paddingBytes = dataBytes % 2;
  const buffer = Buffer.alloc(headerLength + dataBytes + paddingBytes);
  buffer.write('RF64', 0, 'ascii');
  buffer.writeUInt32LE(0xffffffff, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('ds64', 12, 'ascii');
  buffer.writeUInt32LE(28, 16);
  buffer.writeBigUInt64LE(BigInt(buffer.length - 8), 20);
  buffer.writeBigUInt64LE(BigInt(dataBytes), 28);
  buffer.writeBigUInt64LE(BigInt(frames), 36);
  buffer.writeUInt32LE(0, 44);
  buffer.write('fmt ', 48, 'ascii');
  buffer.writeUInt32LE(16, 52);
  buffer.writeUInt16LE(isFloat ? 3 : 1, 56);
  buffer.writeUInt16LE(1, 58);
  buffer.writeUInt32LE(sampleRate, 60);
  buffer.writeUInt32LE(sampleRate * sampleBytes, 64);
  buffer.writeUInt16LE(sampleBytes, 68);
  buffer.writeUInt16LE(bitDepth, 70);
  let dataMarker = 72;
  if (isFloat) {
    buffer.write('fact', 72, 'ascii');
    buffer.writeUInt32LE(4, 76);
    buffer.writeUInt32LE(0xffffffff, 80);
    dataMarker = 84;
  }
  buffer.write('data', dataMarker, 'ascii');
  buffer.writeUInt32LE(0xffffffff, dataMarker + 4);
  return buffer;
}

function testArgs() {
  assert.equal(
    defaultOutputRoot('win32', { LOCALAPPDATA: 'C:\\Users\\qa\\AppData\\Local' }, 'D:\\source'),
    'C:\\Users\\qa\\AppData\\Local\\DataBaker\\acceptance-results',
  );
  assert.equal(
    defaultOutputRoot('win32', { USERPROFILE: 'C:\\Users\\qa' }, 'D:\\source'),
    'C:\\Users\\qa\\AppData\\Local\\DataBaker\\acceptance-results',
  );
  const short = parseArgs(['--mode', 'short', '--bit-depth', '24', '--device-index', '2']);
  assert.equal(short.sampleRate, 48_000);
  assert.equal(short.bitDepth, 24);
  assert.equal(short.minimumInputFormatBits, 24);
  assert.equal(short.deviceIndex, 2);
  assert.equal(short.pollSeconds, 1);
  assert.equal(short.export, true);

  const sixteenBit = parseArgs(['--mode', 'short', '--bit-depth', '16']);
  assert.equal(sixteenBit.minimumInputFormatBits, 16);
  const explicitMinimum = parseArgs([
    '--mode',
    'short',
    '--bit-depth',
    '32',
    '--minimum-input-format-bits',
    '32',
  ]);
  assert.equal(explicitMinimum.minimumInputFormatBits, 32);
  assert.throws(
    () => parseArgs(['--mode', 'short', '--minimum-input-format-bits', '20']),
    /minimum-input-format-bits/,
  );

  const soak = parseArgs(['--mode', 'soak', '--hours', '8', '--no-export']);
  assert.equal(soak.pollSeconds, 5);
  assert.equal(soak.export, false);
  assert.throws(() => parseArgs(['--mode', 'soak', '--hours', '1']), /2–8/);
  assert.throws(() => parseArgs(['--mode', 'short', '--bit-depth', '20']), /16、24/);
  assert.throws(() => parseArgs(['--mode', 'disk-full']), /confirm-dedicated-volume/);
  assert.throws(
    () =>
      parseArgs([
        '--mode',
        'disk-full',
        '--output',
        path.join(os.tmpdir(), 'dedicated-audio-qa-volume'),
        '--confirm-dedicated-volume',
      ]),
    /confirm-not-system-drive/,
  );
  const disk = parseArgs([
    '--mode',
    'disk-full',
    '--output',
    path.join(os.tmpdir(), 'dedicated-audio-qa-volume'),
    '--confirm-dedicated-volume',
    '--confirm-not-system-drive',
  ]);
  assert.equal(disk.confirmDedicatedVolume, true);
  assert.equal(disk.confirmNotSystemDrive, true);
  assert.throws(() => validateDiskFullTarget('C:\\qa', 'win32', 'C:'), /系统盘/);
  assert.doesNotThrow(() => validateDiskFullTarget('Q:\\qa', 'win32', 'C:'));
  assert.throws(() => validateDiskFullTarget('relative\\qa', 'win32', 'C:'), /独立根/);
}

function testInputSampleFormatBits() {
  assert.equal(inputSampleFormatBits('i16'), 16);
  assert.equal(inputSampleFormatBits('I24'), 24);
  assert.equal(inputSampleFormatBits('f32'), 32);
  assert.equal(inputSampleFormatBits('u8'), 8);
  assert.equal(inputSampleFormatBits('unknown'), null);
  assert.equal(inputSampleFormatBits(null), null);
}

function testConfigurations() {
  const device = {
    configurations: [
      { min_sample_rate: 44_100, max_sample_rate: 48_000, channels: 2, sample_format: 'f32' },
      { min_sample_rate: 96_000, max_sample_rate: 192_000, channels: 8, sample_format: 'i32' },
    ],
  };
  assert.equal(matchingConfigurations(device, 48_000, 2).length, 1);
  assert.equal(matchingConfigurations(device, 48_000, 3).length, 0);
  assert.equal(matchingConfigurations(device, 96_000, 8).length, 1);
}

function testProgressSummary() {
  const rows = [
    {
      elapsed_seconds: 1,
      captured_samples: 48_000,
      committed_samples: 47_000,
      segment_total_bytes: 96_044,
      peak: 0.25,
      rms: 0.1,
      storage_status: 'healthy',
    },
    {
      elapsed_seconds: 2,
      captured_samples: 96_000,
      committed_samples: 95_000,
      segment_total_bytes: 192_044,
      peak: 0.5,
      rms: 0.2,
      storage_status: 'healthy',
    },
    {
      elapsed_seconds: 3,
      captured_samples: 144_000,
      committed_samples: 143_000,
      segment_total_bytes: 288_044,
      peak: 0.1,
      rms: 0.05,
      storage_status: 'healthy',
    },
  ];
  const summary = summarizeProgress(rows, 48_000, 1);
  assert.equal(summary.captured_monotonic, true);
  assert.equal(summary.committed_monotonic, true);
  assert.equal(summary.file_bytes_monotonic, true);
  assert.equal(summary.observed_capture_rate, 48_000);
  assert.equal(summary.maximum_peak, 0.5);
  assert(summary.maximum_peak_dbfs < -6 && summary.maximum_peak_dbfs > -7);

  const broken = summarizeProgress(
    [...rows, { ...rows[2], elapsed_seconds: 4, captured_samples: 100, committed_samples: 100, segment_total_bytes: 10 }],
    48_000,
    1,
  );
  assert.equal(broken.captured_monotonic, false);
  assert.equal(broken.committed_monotonic, false);
  assert.equal(broken.file_bytes_monotonic, false);
}

function testInventoryChecks() {
  const good = evaluateInventory({
    devices: [
      { id: 'wasapi:one', configurations: [{ min_sample_rate: 48_000 }] },
      { id: 'wasapi:two', configurations: [{ min_sample_rate: 48_000 }] },
    ],
  });
  assert.equal(overallFromChecks(good), 'PASS');
  const duplicate = evaluateInventory({
    devices: [
      { id: 'wasapi:same', configurations: [{}] },
      { id: 'wasapi:same', configurations: [{}] },
    ],
  });
  assert.equal(overallFromChecks(duplicate), 'FAIL');
}

function testEngineExitChecks() {
  assert.equal(engineExitWasClean({ exit: { code: 0, signal: null } }), true);
  assert.equal(engineExitWasClean({ exit: { code: 1, signal: null } }), false);
  assert.equal(engineExitWasClean({ exit: { code: null, signal: 'SIGTERM' } }), false);
  assert.equal(engineExitWasClean({ exit: { code: null, signal: null, timeout: true } }), false);
  assert.equal(
    engineExitWasClean({
      exit: { code: 0, signal: null },
      shutdown_error: '安全收尾超时',
    }),
    false,
  );
  assert.equal(engineExitWasClean({ exit: null }), false);
}

function testWavInspection() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'databaker-audio-acceptance-test-'));
  try {
    for (const bitDepth of [16, 24, 32]) {
      const wavPath = path.join(root, `${bitDepth}.wav`);
      fs.writeFileSync(wavPath, makeWav(48_000, bitDepth, 480));
      const wav = inspectWav(wavPath);
      assert.equal(wav.sample_rate, 48_000);
      assert.equal(wav.bits_per_sample, bitDepth);
      assert.equal(wav.channels, 1);
      assert.equal(wav.physical_complete_frames, 480);
      assert.equal(wav.trailing_bytes, 0);
      assert.equal(wav.exact_header, true);
      assert.equal(wav.encoding, bitDepth === 32 ? 'float' : 'pcm');

      const rf64Path = path.join(root, `${bitDepth}-rf64.wav`);
      fs.writeFileSync(rf64Path, makeRf64(48_000, bitDepth, 481));
      const rf64 = inspectWav(rf64Path);
      assert.equal(rf64.container, 'rf64');
      assert.equal(rf64.riff_size_32, 0xffffffff);
      assert.equal(rf64.data_size_32, 0xffffffff);
      assert.equal(rf64.ds64.sample_count, 481);
      assert.equal(rf64.declared_frames, 481);
      assert.equal(rf64.physical_complete_frames, 481);
      assert.equal(rf64.word_padding_bytes, (481 * (bitDepth / 8)) % 2);
      assert.equal(rf64.exact_header, true);
    }

    const stalePath = path.join(root, 'stale-header.wav');
    fs.writeFileSync(stalePath, makeWav(48_000, 24, 481, 480));
    const stale = inspectWav(stalePath);
    assert.equal(stale.exact_header, false);
    assert.equal(stale.declared_frames, 480);
    assert.equal(stale.physical_complete_frames, 481);

    const session = path.join(root, 'session');
    fs.mkdirSync(path.join(session, 'audio', 'segments'), { recursive: true });
    fs.mkdirSync(path.join(session, 'metadata'), { recursive: true });
    fs.writeFileSync(path.join(session, 'audio', 'segments', 'master-000001.wav'), makeWav(48_000, 24, 480));
    fs.writeFileSync(
      path.join(session, 'metadata', 'items.snapshot.json'),
      JSON.stringify({ schema_version: 1, session_id: 'qa', committed_samples: 480 }),
    );
    const inspected = inspectSession(session);
    assert.equal(inspected.total_physical_frames, 480);
    assert.equal(inspected.segments.length, 1);
    assert.equal(inspected.segment_errors.length, 0);
    assert.equal(inspected.fault_marker_exists, false);
    assert.equal(faultMarkerPresent(inspected), false);

    fs.writeFileSync(path.join(session, 'metadata', 'audio-fault.json'), '{truncated');
    const malformedFault = inspectSession(session);
    assert.equal(malformedFault.fault_marker, null);
    assert.equal(malformedFault.fault_marker_exists, true);
    assert.equal(malformedFault.fault_marker_parse_error, true);
    assert.equal(
      faultMarkerPresent(malformedFault),
      true,
      'a malformed final marker must remain fail-closed for QA gating',
    );
    if (process.platform !== 'win32') {
      fs.unlinkSync(path.join(session, 'metadata', 'audio-fault.json'));
      fs.symlinkSync(
        path.join(root, 'missing-fault-target'),
        path.join(session, 'metadata', 'audio-fault.json'),
      );
      const brokenLinkFault = inspectSession(session);
      assert.equal(brokenLinkFault.fault_marker_exists, true);
      assert.equal(
        faultMarkerPresent(brokenLinkFault),
        true,
        'a broken marker symlink must remain fail-closed for QA gating',
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testTimestamp() {
  assert.equal(timestampForPath(new Date('2026-08-11T01:02:03.456Z')), '20260811T010203Z');
}

function testShortProtocolIntegration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'databaker-acceptance-integration-'));
  try {
    const tool = path.join(__dirname, 'windows-audio-acceptance.cjs');
    const mockEngine = path.join(__dirname, 'fixtures', 'mock-acceptance-engine.cjs');
    const result = spawnSync(
      process.execPath,
      [
        tool,
        '--mode',
        'short',
        '--engine',
        mockEngine,
        '--output',
        root,
        '--device-index',
        '1',
        '--sample-rate',
        '48000',
        '--bit-depth',
        '24',
        '--channel',
        '1',
        '--seconds',
        '5',
        '--poll-seconds',
        '0.25',
        '--skip-noise-check',
        '--yes',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const runNames = fs.readdirSync(root);
    assert.equal(runNames.length, 1);
    const reportPath = path.join(root, runNames[0], 'acceptance-report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.overall, 'PASS');
    assert.equal(report.start.snapshot.device_id, 'mock:usb-interface');
    assert.equal(report.start.snapshot.input_sample_format, 'f32');
    assert.equal(report.inspection.segments[0].bits_per_sample, 24);
    assert.equal(report.inspection.full_track.exact_header, true);
    assert.equal(
      report.checks.find((check) => check.id === 'engine-clean-exit')?.status,
      'PASS',
    );
    assert.equal(report.progress_rows, undefined);
    assert(report.progress_samples_recorded >= 10);
    assert(fs.statSync(path.join(root, runNames[0], 'telemetry.jsonl')).size > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testAbnormalEngineShutdownIntegration(mode, expectedStatus, expectedOverall) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `databaker-acceptance-${mode}-`));
  try {
    const tool = path.join(__dirname, 'windows-audio-acceptance.cjs');
    const mockEngine = path.join(__dirname, 'fixtures', 'mock-acceptance-engine.cjs');
    const result = spawnSync(
      process.execPath,
      [tool, '--mode', 'inventory', '--engine', mockEngine, '--output', root, '--yes'],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABAKER_ACCEPTANCE_TEST_SHUTDOWN_REQUEST_TIMEOUT_MS: '50',
          DATABAKER_ACCEPTANCE_TEST_SHUTDOWN_EXIT_TIMEOUT_MS: '50',
          DATABAKER_ACCEPTANCE_MOCK_SHUTDOWN: mode,
          DATABAKER_ACCEPTANCE_MOCK_EXIT_AFTER_MS: '750',
        },
      },
    );
    assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.status, expectedStatus, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const runNames = fs.readdirSync(root);
    assert.equal(runNames.length, 1);
    const report = JSON.parse(
      fs.readFileSync(path.join(root, runNames[0], 'acceptance-report.json'), 'utf8'),
    );
    assert.equal(report.overall, expectedOverall);
    assert.equal(
      report.checks.find((check) => check.id === 'engine-clean-exit')?.status,
      'FAIL',
    );
    if (mode === 'hang') {
      assert.equal(report.engine.exit.timeout, true);
      assert.equal(report.engine.exit.detached, true);
      assert.equal(typeof report.engine.exit.pid, 'number');
      assert.match(report.engine.shutdown_error, /shutdown 超时/);
    } else {
      assert.equal(report.engine.exit.code, 7);
      assert.equal(report.engine.exit.signal, null);
    }
  } finally {
    if (mode === 'hang') {
      // The tool intentionally detaches rather than killing a timed-out
      // recorder. Let the mock's bounded self-exit release its inherited log
      // handle before Windows removes the temporary acceptance directory.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

testArgs();
testInputSampleFormatBits();
testConfigurations();
testProgressSummary();
testInventoryChecks();
testEngineExitChecks();
testWavInspection();
testTimestamp();
testShortProtocolIntegration();
testAbnormalEngineShutdownIntegration('nonzero', 1, 'FAIL');
testAbnormalEngineShutdownIntegration('hang', 2, 'INCOMPLETE');
process.stdout.write('windows audio acceptance tool tests passed\n');
