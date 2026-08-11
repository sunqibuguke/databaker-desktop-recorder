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
  evaluateSealedSession,
  faultMarkerPresent,
  hostBootIdentity,
  inputSampleFormatBits,
  inspectSession,
  inspectWav,
  matchingConfigurations,
  MAX_NORMAL_COMMIT_LAG_SECONDS,
  MAX_POWER_CUT_TAIL_LOSS_SECONDS,
  overallFromChecks,
  parseArgs,
  sha256RegularFile,
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
  const systemDrive = String(process.env.SystemDrive ?? 'C:')
    .replace(/[\\/]+$/, '')
    .toUpperCase();
  const syntheticTestDrive = systemDrive === 'Q:' ? 'R:' : 'Q:';
  const dedicatedVolume = process.platform === 'win32'
    ? path.win32.join(`${syntheticTestDrive}\\`, 'dedicated-audio-qa-volume')
    : path.join(os.tmpdir(), 'dedicated-audio-qa-volume');
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
  assert.throws(() => parseArgs(['--mode', 'power-cut']), /session-dir/);
  assert.throws(() => parseArgs(['--mode', 'recover']), /session-dir/);
  assert.throws(() => parseArgs(['--mode', 'inspect']), /session-dir/);
  const productionPowerCut = parseArgs([
    '--mode',
    'power-cut',
    '--session-dir',
    path.join(os.tmpdir(), 'power-cut'),
  ]);
  assert.equal(productionPowerCut.mode, 'power-cut');
  assert.equal(productionPowerCut.triggerDelaySeconds, 3_600);
  assert.equal(productionPowerCut.seconds, 3_900);
  assert.equal(productionPowerCut.maxTailLossSeconds, 15);
  assert.equal(productionPowerCut.testOnlyPowerCut, false);
  assert.equal(MAX_NORMAL_COMMIT_LAG_SECONDS, 15);
  assert.equal(MAX_POWER_CUT_TAIL_LOSS_SECONDS, 30);
  assert.equal(
    parseArgs([
      '--mode', 'power-cut',
      '--session-dir', path.join(os.tmpdir(), 'power-cut-tail-30'),
      '--max-tail-loss-seconds', '30',
    ]).maxTailLossSeconds,
    30,
  );
  assert.throws(
    () => parseArgs([
      '--mode', 'power-cut',
      '--session-dir', path.join(os.tmpdir(), 'power-cut-tail-too-large'),
      '--max-tail-loss-seconds', '30.1',
    ]),
    /0.1–30/,
  );
  assert.throws(
    () => parseArgs([
      '--mode', 'power-cut',
      '--session-dir', path.join(os.tmpdir(), 'power-cut'),
      '--seconds', '5',
      '--trigger-delay-seconds', '2',
    ]),
    /test-only-power-cut/,
  );
  const testPowerCut = parseArgs([
    '--mode', 'power-cut',
    '--session-dir', path.join(os.tmpdir(), 'power-cut-test'),
    '--seconds', '5',
    '--trigger-delay-seconds', '2',
    '--test-only-power-cut',
  ]);
  assert.equal(testPowerCut.testOnlyPowerCut, true);
  assert.throws(
    () => parseArgs([
      '--mode', 'recover',
      '--session-dir', path.join(os.tmpdir(), 'power-cut'),
    ]),
    /phase1-report/,
  );
  assert.equal(
    parseArgs([
      '--mode', 'recover',
      '--session-dir', path.join(os.tmpdir(), 'power-cut'),
      '--phase1-report', path.join(os.tmpdir(), 'phase1.json'),
    ]).mode,
    'recover',
  );
  assert.throws(
    () =>
      parseArgs([
        '--mode',
        'disk-full',
        '--output',
        dedicatedVolume,
        '--confirm-dedicated-volume',
      ]),
    /confirm-not-system-drive/,
  );
  const disk = parseArgs([
    '--mode',
    'disk-full',
    '--output',
    dedicatedVolume,
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
  assert.equal(inputSampleFormatBits('f32'), 24);
  assert.equal(inputSampleFormatBits('f64'), 53);
  assert.equal(inputSampleFormatBits('f16'), null);
  assert.equal(inputSampleFormatBits('u8'), 8);
  assert.equal(inputSampleFormatBits('unknown'), null);
  assert.equal(inputSampleFormatBits(null), null);
}

function testBootOverrideIsolation() {
  const environment = {
    NODE_ENV: 'test',
    DATABAKER_ACCEPTANCE_TEST_BOOT_ID: 'forged-new-boot',
    DATABAKER_ACCEPTANCE_TEST_BOOTED_AT: '2026-08-11T00:01:00.000Z',
  };
  const production = hostBootIdentity(
    environment,
    Date.parse('2026-08-11T01:00:00.000Z'),
    3_600,
    'qa-host',
    false,
  );
  assert.equal(production.source, 'os-uptime');
  assert.notEqual(production.id, 'forged-new-boot');
  const explicitTestOnly = hostBootIdentity(
    environment,
    Date.parse('2026-08-11T01:00:00.000Z'),
    3_600,
    'qa-host',
    true,
  );
  assert.equal(explicitTestOnly.source, 'test-override');
  assert.equal(explicitTestOnly.id, 'forged-new-boot');
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
    fs.mkdirSync(path.join(session, 'script'), { recursive: true });
    fs.writeFileSync(path.join(session, 'audio', 'segments', 'master-000001.wav'), makeWav(48_000, 24, 480));
    const goodSnapshot = {
      schema_version: 1,
      journal_seq: 2,
      session_id: 'qa',
      status: 'stopped',
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
      segment_frames: 480,
      captured_samples: 480,
      committed_samples: 480,
      overflow_samples: 0,
    };
    fs.writeFileSync(
      path.join(session, 'metadata', 'items.snapshot.json'),
      JSON.stringify(goodSnapshot),
    );
    fs.writeFileSync(
      path.join(session, 'session.json'),
      JSON.stringify({ schema_version: 1, journal_seq: 2, session_id: 'qa', status: 'stopped' }),
    );
    const inspected = inspectSession(session);
    assert.equal(inspected.total_physical_frames, 480);
    assert.equal(inspected.segments.length, 1);
    assert.equal(inspected.segment_errors.length, 0);
    assert.equal(inspected.fault_marker_exists, false);
    assert.equal(faultMarkerPresent(inspected), false);
    assert.equal(overallFromChecks(evaluateSealedSession(inspected)), 'PASS');

    const byteRateBroken = makeWav(48_000, 24, 480);
    byteRateBroken.writeUInt32LE(0, 28);
    fs.writeFileSync(path.join(session, 'audio', 'segments', 'master-000001.wav'), byteRateBroken);
    const byteRateChecks = evaluateSealedSession(inspectSession(session));
    assert.equal(overallFromChecks(byteRateChecks), 'FAIL');
    assert.equal(
      byteRateChecks.find((check) => check.id === 'segment-format-consistent')?.status,
      'FAIL',
    );

    fs.writeFileSync(path.join(session, 'audio', 'segments', 'master-000001.wav'), makeWav(48_000, 24, 480));
    fs.writeFileSync(path.join(session, 'audio', 'segments', 'master-000003.wav'), makeWav(48_000, 24, 480));
    fs.writeFileSync(
      path.join(session, 'metadata', 'items.snapshot.json'),
      JSON.stringify({ ...goodSnapshot, captured_samples: 960, committed_samples: 960 }),
    );
    const gapChecks = evaluateSealedSession(inspectSession(session));
    assert.equal(overallFromChecks(gapChecks), 'FAIL');
    assert.equal(gapChecks.find((check) => check.id === 'segment-layout-valid')?.status, 'FAIL');
    fs.unlinkSync(path.join(session, 'audio', 'segments', 'master-000003.wav'));
    fs.writeFileSync(
      path.join(session, 'metadata', 'items.snapshot.json'),
      JSON.stringify(goodSnapshot),
    );

    if (process.platform !== 'win32') {
      const linkedSession = path.join(root, 'linked-session');
      fs.symlinkSync(session, linkedSession, 'dir');
      const linkedChecks = evaluateSealedSession(inspectSession(linkedSession));
      assert.equal(overallFromChecks(linkedChecks), 'FAIL');
      assert.equal(linkedChecks.find((check) => check.id === 'real-recording-tree')?.status, 'FAIL');
    }

    const redundantDescriptor = path.join(
      session,
      'audio',
      'segments',
      'master-000001.wav.descriptor.json',
    );
    fs.writeFileSync(redundantDescriptor, '{malformed');
    const redundantDescriptorChecks = evaluateSealedSession(inspectSession(session));
    assert.equal(overallFromChecks(redundantDescriptorChecks), 'PASS');
    assert.equal(
      redundantDescriptorChecks.find((check) => check.id === 'segment-descriptor-redundancy')?.status,
      'WARN',
    );
    fs.unlinkSync(redundantDescriptor);

    const orphanDescriptor = path.join(
      session,
      'audio',
      'segments',
      'master-000002.wav.descriptor.json',
    );
    fs.writeFileSync(orphanDescriptor, '{}');
    const orphanDescriptorChecks = evaluateSealedSession(inspectSession(session));
    assert.equal(overallFromChecks(orphanDescriptorChecks), 'FAIL');
    assert.equal(
      orphanDescriptorChecks.find((check) => check.id === 'segment-descriptors-valid')?.status,
      'FAIL',
    );
    fs.unlinkSync(orphanDescriptor);

    fs.writeFileSync(
      path.join(session, 'audio', 'segments', 'master-000001.wav'),
      makeWav(48_000, 24, 481, 480),
    );
    const staleSessionChecks = evaluateSealedSession(inspectSession(session));
    assert.equal(overallFromChecks(staleSessionChecks), 'FAIL');
    assert.equal(
      staleSessionChecks.find((check) => check.id === 'exact-segment-headers')?.status,
      'FAIL',
    );

    fs.writeFileSync(
      path.join(session, 'audio', 'segments', 'master-000001.wav'),
      Buffer.concat([makeWav(48_000, 24, 480), Buffer.from([0x7f])]),
    );
    const tornSessionChecks = evaluateSealedSession(inspectSession(session));
    assert.equal(overallFromChecks(tornSessionChecks), 'FAIL');
    assert.equal(
      tornSessionChecks.find((check) => check.id === 'no-trailing-frame-bytes')?.status,
      'FAIL',
    );

    fs.writeFileSync(path.join(session, 'audio', 'segments', 'master-000001.wav'), makeWav(48_000, 24, 480));
    fs.writeFileSync(
      path.join(session, 'metadata', 'items.snapshot.json'),
      JSON.stringify({ ...goodSnapshot, status: 'recording', captured_samples: 481 }),
    );
    const inconsistentChecks = evaluateSealedSession(inspectSession(session));
    assert.equal(overallFromChecks(inconsistentChecks), 'FAIL');
    assert.equal(inconsistentChecks.find((check) => check.id === 'stopped-status')?.status, 'FAIL');
    assert.equal(inconsistentChecks.find((check) => check.id === 'exact-sample-watermark')?.status, 'FAIL');

    fs.writeFileSync(
      path.join(session, 'metadata', 'items.snapshot.json'),
      JSON.stringify(goodSnapshot),
    );

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
    assert.equal(
      evaluateSealedSession(malformedFault).find((check) => check.id === 'no-fault-marker')?.status,
      'FAIL',
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
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, DATABAKER_ACCEPTANCE_MOCK_EXPORT_ACCEPTED_ITEM: '1' },
      },
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
    assert.equal(report.inspection.export_metadata.exported.length, 1);
    assert.equal(report.inspection.export_metadata.skipped.length, 0);
    assert.equal(report.inspection.export_csv.matches_metadata, true);
    assert.equal(report.inspection.export_sentence_wavs.length, 1);
    assert.equal(
      report.inspection.export_sentence_wavs[0].physical_complete_frames,
      report.inspection.export_metadata.exported[0].duration_samples,
    );
    assert.equal(
      report.checks.find((check) => check.id === 'delivery-manifest-coherent')?.status,
      'PASS',
    );
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

function testBadExportManifestRejected() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'databaker-acceptance-bad-manifest-'));
  try {
    const tool = path.join(__dirname, 'windows-audio-acceptance.cjs');
    const mockEngine = path.join(__dirname, 'fixtures', 'mock-acceptance-engine.cjs');
    const result = spawnSync(
      process.execPath,
      [
        tool,
        '--mode', 'short',
        '--engine', mockEngine,
        '--output', root,
        '--device-index', '1',
        '--seconds', '5',
        '--poll-seconds', '0.25',
        '--skip-noise-check',
        '--yes',
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          DATABAKER_ACCEPTANCE_MOCK_EXPORT_ACCEPTED_ITEM: '1',
          DATABAKER_ACCEPTANCE_MOCK_BAD_EXPORT_MANIFEST: '1',
        },
      },
    );
    assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const report = latestReport(root);
    assert.equal(report.overall, 'FAIL');
    assert.equal(
      report.checks.find((check) => check.id === 'delivery-manifest-coherent')?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeInterruptedSessionFixture(session, phase1Report) {
  fs.mkdirSync(path.join(session, 'audio', 'segments'), { recursive: true });
  fs.mkdirSync(path.join(session, 'metadata'), { recursive: true });
  fs.mkdirSync(path.join(session, 'script'), { recursive: true });
  fs.writeFileSync(
    path.join(session, 'audio', 'segments', 'master-000001.wav'),
    makeWav(48_000, 24, 96_001, 96_000),
  );
  const armedAt = '2026-08-11T00:00:00.000Z';
  const snapshot = {
    schema_version: 1,
    journal_seq: 1,
    session_id: 'power-cut-fixture',
    script_name: 'power cut fixture',
    status: 'recording',
    device_name: 'Mock USB Audio Interface',
    device_id: 'mock:usb-interface',
    input_sample_format: 'f32',
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
    captured_samples: 96_001,
    committed_samples: 96_000,
    overflow_samples: 0,
    started_at: '2026-08-10T23:59:58.000Z',
    updated_at: armedAt,
    noise_check: null,
    silence_duration_ms: 1_000,
    silence_threshold_dbfs: -40,
    items: [{
      id: 'QA-001',
      text: 'power cut fixture',
      label: 'power-cut',
      status: 'pending',
      attempts: [],
      selected_attempt_id: null,
    }],
  };
  fs.writeFileSync(
    path.join(session, 'metadata', 'items.snapshot.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(session, 'session.json'),
    `${JSON.stringify({
      schema_version: 1,
      journal_seq: 1,
      session_id: snapshot.session_id,
      status: 'recording',
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(session, 'script', 'normalized.json'),
    `${JSON.stringify(snapshot.items, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(session, 'audio', 'segments', 'master-000001.wav.descriptor.json'),
    `${JSON.stringify({
      schema_version: 1,
      kind: 'databaker.segmented-wav-header',
      segment_index: 1,
      segment_file: 'master-000001.wav',
      sample_rate: 48_000,
      channels: 1,
      bit_depth: 24,
      encoding: 'pcm',
      header_len: 44,
      max_frames_per_segment: 48_000 * 300,
    }, null, 2)}\n`,
  );
  const evidence = {
    schema_version: 1,
    kind: 'databaker.power-cut-phase-1',
    phase: 'armed',
    nonce: 'test-only-power-cut-nonce-0001',
    test_only: true,
    production_eligible: false,
    session_dir: path.resolve(session),
    session_id: snapshot.session_id,
    device_id: snapshot.device_id,
    device_name: snapshot.device_name,
    input_sample_format: snapshot.input_sample_format,
    audio_format: snapshot.audio_format,
    required_duration_seconds: 2,
    production_minimum_seconds: 3_600,
    wall_elapsed_seconds: 2.1,
    armed_at: armedAt,
    armed_captured_samples: 96_001,
    armed_committed_samples: 96_000,
    max_tail_loss_samples: 96_000,
    segment_total_bytes: 44 + 96_001 * 3,
    segment_count: 1,
    tool_version: 1,
    protocol_version: 1,
    binary_identity: {
      acceptance_tool_sha256: sha256RegularFile(
        path.join(__dirname, 'windows-audio-acceptance.cjs'),
      ),
      engine_sha256: sha256RegularFile(
        path.join(__dirname, 'fixtures', 'mock-acceptance-engine.cjs'),
      ),
      engine_ready: {
        engine_version: 'mock-1',
        protocol_version: 1,
        platform: process.platform,
        arch: process.arch,
      },
    },
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      architecture: process.arch,
      boot_id: 'phase1-old-boot',
      booted_at: '2026-08-10T22:00:00.000Z',
    },
  };
  fs.writeFileSync(
    path.join(session, 'metadata', 'power-cut.acceptance.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  fs.writeFileSync(
    phase1Report,
    `${JSON.stringify({
      schema_version: 1,
      tool_version: 1,
      mode: 'power-cut',
      completed_at: null,
      overall: 'INCOMPLETE',
      power_cut: { phase: 'armed', evidence },
      start: { snapshot: { session_id: snapshot.session_id } },
    }, null, 2)}\n`,
  );
  return { snapshot, evidence };
}

function latestReport(outputRoot) {
  const runNames = fs.readdirSync(outputRoot);
  assert.equal(runNames.length, 1);
  return JSON.parse(
    fs.readFileSync(path.join(outputRoot, runNames[0], 'acceptance-report.json'), 'utf8'),
  );
}

function testPowerCutArmingIntegration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'databaker-power-cut-arm-'));
  try {
    const tool = path.join(__dirname, 'windows-audio-acceptance.cjs');
    const mockEngine = path.join(__dirname, 'fixtures', 'mock-acceptance-engine.cjs');
    const output = path.join(root, 'reports');
    const session = path.join(root, 'interrupted-recording');
    const result = spawnSync(
      process.execPath,
      [
        tool,
        '--mode',
        'power-cut',
        '--engine',
        mockEngine,
        '--output',
        output,
        '--session-dir',
        session,
        '--device-index',
        '1',
        '--seconds',
        '5',
        '--trigger-delay-seconds',
        '2',
        '--test-only-power-cut',
        '--poll-seconds',
        '0.25',
        '--skip-noise-check',
        '--yes',
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(result.error, undefined, result.error?.stack);
    assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const report = latestReport(output);
    assert.equal(report.overall, 'INCOMPLETE');
    assert.equal(report.power_cut.phase, 'not-performed');
    assert.equal(report.power_cut.evidence.test_only, true);
    assert.equal(report.power_cut.evidence.production_eligible, false);
    assert.equal(report.production_eligible, false);
    assert.equal(
      fs.existsSync(path.join(session, 'metadata', 'power-cut.acceptance.json')),
      true,
    );
    assert.equal(report.stop.result.snapshot.status, 'stopped');
    assert.equal(report.checks.find((check) => check.id === 'power-cut-observed')?.status, 'FAIL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPowerCutRecoveryIntegration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'databaker-power-cut-recover-'));
  try {
    const tool = path.join(__dirname, 'windows-audio-acceptance.cjs');
    const mockEngine = path.join(__dirname, 'fixtures', 'mock-acceptance-engine.cjs');
    const session = path.join(root, 'interrupted-recording');
    const phase1Report = path.join(root, 'phase1-report.json');
    writeInterruptedSessionFixture(session, phase1Report);
    const recoveryEnvironment = {
      ...process.env,
      NODE_ENV: 'test',
      DATABAKER_ACCEPTANCE_TEST_BOOT_ID: 'phase2-new-boot',
      DATABAKER_ACCEPTANCE_TEST_BOOTED_AT: '2026-08-11T00:01:00.000Z',
    };

    const sessionEvidencePath = path.join(session, 'metadata', 'power-cut.acceptance.json');
    const originalSessionEvidence = JSON.parse(fs.readFileSync(sessionEvidencePath, 'utf8'));
    fs.writeFileSync(
      sessionEvidencePath,
      `${JSON.stringify({ ...originalSessionEvidence, armed_committed_samples: 95_999 }, null, 2)}\n`,
    );
    const tamperedOutput = path.join(root, 'tampered-evidence');
    const tampered = spawnSync(
      process.execPath,
      [
        tool,
        '--mode', 'recover',
        '--engine', mockEngine,
        '--session-dir', session,
        '--phase1-report', phase1Report,
        '--test-only-power-cut',
        '--output', tamperedOutput,
        '--yes',
      ],
      { encoding: 'utf8', timeout: 20_000, env: recoveryEnvironment },
    );
    assert.equal(tampered.status, 1, `stdout:\n${tampered.stdout}\nstderr:\n${tampered.stderr}`);
    const tamperedReport = latestReport(tamperedOutput);
    assert.equal(
      tamperedReport.checks.find((check) => check.id === 'session-evidence-bound')?.status,
      'FAIL',
    );
    assert.equal(tamperedReport.recovery, undefined, 'tampered evidence must fail before engine start');
    fs.writeFileSync(sessionEvidencePath, `${JSON.stringify(originalSessionEvidence, null, 2)}\n`);

    const sameSourceOutput = path.join(root, 'same-source-evidence');
    const sameSource = spawnSync(
      process.execPath,
      [
        tool,
        '--mode', 'recover',
        '--engine', mockEngine,
        '--session-dir', session,
        '--phase1-report', sessionEvidencePath,
        '--test-only-power-cut',
        '--output', sameSourceOutput,
        '--yes',
      ],
      { encoding: 'utf8', timeout: 20_000, env: recoveryEnvironment },
    );
    assert.equal(sameSource.status, 1, `stdout:\n${sameSource.stdout}\nstderr:\n${sameSource.stderr}`);
    assert.equal(
      latestReport(sameSourceOutput).checks.find((check) => check.id === 'session-evidence-bound')?.status,
      'FAIL',
    );

    const originalPhase1Report = JSON.parse(fs.readFileSync(phase1Report, 'utf8'));
    const wrongBinaryEvidence = {
      ...originalSessionEvidence,
      binary_identity: {
        ...originalSessionEvidence.binary_identity,
        engine_sha256: '0'.repeat(64),
      },
    };
    fs.writeFileSync(sessionEvidencePath, `${JSON.stringify(wrongBinaryEvidence, null, 2)}\n`);
    fs.writeFileSync(
      phase1Report,
      `${JSON.stringify({
        ...originalPhase1Report,
        power_cut: { ...originalPhase1Report.power_cut, evidence: wrongBinaryEvidence },
      }, null, 2)}\n`,
    );
    const wrongBinaryOutput = path.join(root, 'wrong-binary');
    const wrongBinary = spawnSync(
      process.execPath,
      [
        tool,
        '--mode', 'recover',
        '--engine', mockEngine,
        '--session-dir', session,
        '--phase1-report', phase1Report,
        '--test-only-power-cut',
        '--output', wrongBinaryOutput,
        '--yes',
      ],
      { encoding: 'utf8', timeout: 20_000, env: recoveryEnvironment },
    );
    assert.equal(wrongBinary.status, 1, `stdout:\n${wrongBinary.stdout}\nstderr:\n${wrongBinary.stderr}`);
    const wrongBinaryReport = latestReport(wrongBinaryOutput);
    assert.equal(
      wrongBinaryReport.checks.find((check) => check.id === 'phase1-binaries-match')?.status,
      'FAIL',
    );
    assert.equal(wrongBinaryReport.recovery, undefined, 'binary mismatch must fail before engine start');
    fs.writeFileSync(sessionEvidencePath, `${JSON.stringify(originalSessionEvidence, null, 2)}\n`);
    fs.writeFileSync(phase1Report, `${JSON.stringify(originalPhase1Report, null, 2)}\n`);

    const beforeOutput = path.join(root, 'before-inspect');
    const before = spawnSync(
      process.execPath,
      [tool, '--mode', 'inspect', '--session-dir', session, '--output', beforeOutput],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(before.status, 1, `stdout:\n${before.stdout}\nstderr:\n${before.stderr}`);
    const beforeReport = latestReport(beforeOutput);
    assert.equal(beforeReport.overall, 'FAIL');
    assert.equal(
      beforeReport.checks.find((check) => check.id === 'exact-segment-headers')?.status,
      'FAIL',
    );

    const recoveryOutput = path.join(root, 'recovery');
    const recovery = spawnSync(
      process.execPath,
      [
        tool,
        '--mode',
        'recover',
        '--engine',
        mockEngine,
        '--session-dir',
        session,
        '--phase1-report',
        phase1Report,
        '--test-only-power-cut',
        '--output',
        recoveryOutput,
        '--yes',
      ],
      { encoding: 'utf8', timeout: 20_000, env: recoveryEnvironment },
    );
    assert.equal(recovery.error, undefined, recovery.error?.stack);
    assert.equal(recovery.status, 0, `stdout:\n${recovery.stdout}\nstderr:\n${recovery.stderr}`);
    const recoveryReport = latestReport(recoveryOutput);
    assert.equal(recoveryReport.overall, 'TEST_ONLY_PASS');
    assert.equal(recoveryReport.production_eligible, false);
    assert.equal(recoveryReport.recovery.result.snapshot.status, 'stopped');
    assert.equal(recoveryReport.inspection.total_physical_frames, 96_001);
    assert.equal(recoveryReport.inspection.snapshot.committed_samples, 96_001);
    assert.equal(recoveryReport.inspection.segments[0].exact_header, true);
    assert.equal(
      recoveryReport.checks.find((check) => check.id === 'engine-clean-exit')?.status,
      'PASS',
    );

    const afterOutput = path.join(root, 'after-inspect');
    const after = spawnSync(
      process.execPath,
      [tool, '--mode', 'inspect', '--session-dir', session, '--output', afterOutput],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(after.status, 0, `stdout:\n${after.stdout}\nstderr:\n${after.stderr}`);
    assert.equal(latestReport(afterOutput).overall, 'PASS');

    const replayOutput = path.join(root, 'recovery-replay');
    const replay = spawnSync(
      process.execPath,
      [
        tool,
        '--mode', 'recover',
        '--engine', mockEngine,
        '--session-dir', session,
        '--phase1-report', phase1Report,
        '--test-only-power-cut',
        '--output', replayOutput,
        '--yes',
      ],
      { encoding: 'utf8', timeout: 20_000, env: recoveryEnvironment },
    );
    assert.equal(replay.status, 1, `stdout:\n${replay.stdout}\nstderr:\n${replay.stderr}`);
    const replayReport = latestReport(replayOutput);
    assert.equal(replayReport.overall, 'FAIL');
    assert.equal(
      replayReport.checks.find((check) => check.id === 'interrupted-preseal-status')?.status,
      'FAIL',
    );
    assert.equal(replayReport.recovery, undefined, 'normal stopped sessions must be rejected before seal');
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
testBootOverrideIsolation();
testConfigurations();
testProgressSummary();
testInventoryChecks();
testEngineExitChecks();
testWavInspection();
testTimestamp();
testShortProtocolIntegration();
testBadExportManifestRejected();
testPowerCutArmingIntegration();
testPowerCutRecoveryIntegration();
testAbnormalEngineShutdownIntegration('nonzero', 1, 'FAIL');
testAbnormalEngineShutdownIntegration('hang', 2, 'INCOMPLETE');
process.stdout.write('windows audio acceptance tool tests passed\n');
