'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Ajv2020 = require('ajv/dist/2020').default;

const {
  IMPLEMENTED_ACCEPTANCE_MODES,
  KNOWN_ACCEPTANCE_MODES,
  parseArgs,
  runQualification,
  validatePlan,
} = require('./windows-audio-qualification.cjs');

const ENGINE_HASH = '1'.repeat(64);
const TOOL_HASH = '2'.repeat(64);
const DEVICE_ID = 'wasapi:{fixture-usb-interface}';
const HOSTNAME = 'qa-windows-host';
const WINDOWS_RELEASE = '10.0.26100';

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildRequiredRuns() {
  const runs = [{ id: 'inventory', mode: 'inventory' }];
  for (const sampleRate of [44_100, 48_000, 96_000]) {
    for (const bitDepth of [16, 24, 32]) {
      runs.push({
        id: `short-${sampleRate}-${bitDepth}-ch1`,
        mode: 'short',
        sample_rate: sampleRate,
        bit_depth: bitDepth,
        channel: 1,
        min_seconds: 30,
        export: true,
      });
    }
  }
  runs.push(
    { id: 'soak-44100-24-ch1-2h', mode: 'soak', sample_rate: 44_100, bit_depth: 24, channel: 1, min_hours: 2, export: false },
    { id: 'soak-primary-48000-24-ch1-8h', mode: 'soak', sample_rate: 48_000, bit_depth: 24, channel: 1, min_hours: 8, export: false },
    { id: 'soak-96000-24-ch1-2h', mode: 'soak', sample_rate: 96_000, bit_depth: 24, channel: 1, min_hours: 2, export: false },
    {
      id: 'soak-rf64-96000-32-ch1-4h',
      mode: 'soak',
      sample_rate: 96_000,
      bit_depth: 32,
      channel: 1,
      min_hours: 4,
      export: true,
      expected_full_track_container: 'rf64',
    },
    { id: 'unplug-48000-24-ch1', mode: 'unplug', sample_rate: 48_000, bit_depth: 24, channel: 1 },
    { id: 'default-switch-48000-24-ch1', mode: 'default-switch', sample_rate: 48_000, bit_depth: 24, channel: 1 },
    { id: 'replug-48000-24-ch1', mode: 'replug', sample_rate: 48_000, bit_depth: 24, channel: 1 },
    { id: 'disk-full-48000-24-ch1', mode: 'disk-full', sample_rate: 48_000, bit_depth: 24, channel: 1 },
    {
      id: 'abrupt-enospc-48000-24-ch1',
      mode: 'abrupt-enospc',
      sample_rate: 48_000,
      bit_depth: 24,
      channel: 1,
      production_eligible: true,
    },
    {
      id: 'power-cut-recover-48000-24-ch1',
      mode: 'recover',
      sample_rate: 48_000,
      bit_depth: 24,
      channel: 1,
      production_eligible: true,
      phase1_evidence_run_id: 'power-cut-phase1-48000-24-ch1',
    },
    { id: 'power-cut-inspect', mode: 'inspect', bound_to: 'power-cut-recover-48000-24-ch1' },
  );
  return runs;
}

function makeSnapshot(requirement, sessionId) {
  return {
    schema_version: 1,
    journal_seq: 2,
    session_id: sessionId,
    status: 'stopped',
    device_id: DEVICE_ID,
    device_name: 'Fixture USB Interface',
    input_sample_format: 'f32',
    audio_format: {
      sample_rate: requirement.sample_rate ?? 48_000,
      bit_depth: requirement.bit_depth ?? 24,
      encoding: requirement.bit_depth === 32 ? 'float' : 'pcm',
      channels: 1,
      input_channels: 2,
      input_channel: requirement.channel ?? 1,
    },
    captured_samples: 1,
    committed_samples: 1,
    overflow_samples: 0,
    items: [],
  };
}

function makeHost(bootId = 'fixture-phase2-boot', bootedAt = '2026-08-11T23:00:00.000Z') {
  return {
    platform: 'win32',
    architecture: 'x64',
    hostname: HOSTNAME,
    release: WINDOWS_RELEASE,
    boot: { id: bootId, booted_at: bootedAt },
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'databaker-qualification-'));
  const installer = path.join(root, 'DataBaker-Recorder-fixture-Windows-x64.exe');
  fs.writeFileSync(installer, 'fixture installer bytes\n');
  const installerHash = sha256(installer);
  const requiredRuns = buildRequiredRuns();
  const plan = {
    schema_version: 1,
    profile: 'databaker-windows-v1',
    qualification_id: 'DB-WIN-FIXTURE-001',
    release: {
      app_version: '0.1.0-fixture',
      installer_path: path.basename(installer),
      installer_sha256: installerHash,
      engine_sha256: ENGINE_HASH,
      acceptance_tool_sha256: TOOL_HASH,
    },
    target: {
      hostname: HOSTNAME,
      platform: 'win32',
      architecture: 'x64',
      windows_release: WINDOWS_RELEASE,
      device_id: DEVICE_ID,
      device_name: 'Fixture USB Interface',
      driver_version: '1.2.3-fixture',
      usb_port: 'USB-ROOT-1/PORT-2',
      serial: 'FIXTURE-001',
      channels: [1],
      primary_format: { sample_rate: 48_000, bit_depth: 24, channel: 1 },
    },
    required_runs: requiredRuns,
  };
  const powerSession = path.join(root, 'power-cut-session');
  fs.mkdirSync(path.join(powerSession, 'metadata'), { recursive: true });
  fs.writeFileSync(path.join(powerSession, 'metadata', 'sealed-evidence.json'), '{}\n');
  const reportPaths = new Map();
  const recoverRequirement = requiredRuns.find((requirement) => requirement.mode === 'recover');
  const phase1RunDirectory = path.join(root, 'runs', recoverRequirement.phase1_evidence_run_id);
  fs.mkdirSync(phase1RunDirectory, { recursive: true });
  const phase1SessionId = 'power-cut-session-fixture';
  const phase1Snapshot = {
    ...makeSnapshot(recoverRequirement, phase1SessionId),
    status: 'recording',
  };
  const engineReady = {
    engine_version: 'fixture',
    protocol_version: 1,
    platform: 'windows',
    arch: 'x86_64',
  };
  const phase1Qualification = {
    qualification_id: plan.qualification_id,
    run_id: recoverRequirement.phase1_evidence_run_id,
    installer_sha256: installerHash,
  };
  const phase1Evidence = {
    schema_version: 1,
    kind: 'databaker.power-cut-phase-1',
    phase: 'armed',
    nonce: 'fixture-power-cut-nonce-00000001',
    test_only: false,
    production_eligible: true,
    session_dir: powerSession,
    session_id: phase1SessionId,
    device_id: DEVICE_ID,
    device_name: 'Fixture USB Interface',
    input_sample_format: 'f32',
    audio_format: phase1Snapshot.audio_format,
    required_duration_seconds: 3_600,
    production_minimum_seconds: 3_600,
    wall_elapsed_seconds: 3_600.5,
    armed_captured_samples: 172_804_800,
    armed_committed_samples: 172_800_000,
    max_tail_loss_samples: 720_000,
    segment_total_bytes: 518_400_044,
    segment_count: 2,
    tool_version: 1,
    protocol_version: 1,
    qualification: phase1Qualification,
    binary_identity: {
      acceptance_tool_sha256: TOOL_HASH,
      engine_sha256: ENGINE_HASH,
      engine_ready: engineReady,
    },
    host: {
      hostname: HOSTNAME,
      platform: 'win32',
      architecture: 'x64',
      boot_id: 'fixture-phase1-boot',
      booted_at: '2026-08-10T20:00:00.000Z',
    },
    armed_at: '2026-08-11T00:59:59.000Z',
  };
  const phase1Report = {
    schema_version: 1,
    tool_version: 1,
    acceptance_tool_sha256: TOOL_HASH,
    mode: 'power-cut',
    started_at: '2026-08-11T00:00:00.000Z',
    completed_at: null,
    overall: 'INCOMPLETE',
    production_eligible: true,
    host: makeHost('fixture-phase1-boot', '2026-08-10T20:00:00.000Z'),
    qualification: phase1Qualification,
    options: { sampleRate: 48_000, bitDepth: 24, channel: 1 },
    engine: { binary_sha256: ENGINE_HASH, ready: engineReady },
    selected_device: { id: DEVICE_ID, name: 'Fixture USB Interface' },
    start: { snapshot: phase1Snapshot },
    requested: { sample_rate: 48_000, wav_bit_depth: 24, input_channel: 1 },
    session_dir: powerSession,
    power_cut: {
      phase: 'armed',
      nonce: phase1Evidence.nonce,
      armed_at: phase1Evidence.armed_at,
      test_only: false,
      production_eligible: true,
      evidence: phase1Evidence,
    },
    checks: [],
  };
  const phase1ReportPath = path.join(phase1RunDirectory, 'acceptance-report.json');
  writeJson(phase1ReportPath, phase1Report);
  writeJson(path.join(phase1RunDirectory, 'power-cut-evidence.json'), phase1Evidence);
  writeJson(path.join(powerSession, 'metadata', 'power-cut.acceptance.json'), phase1Evidence);
  fs.writeFileSync(
    path.join(phase1RunDirectory, 'telemetry.jsonl'),
    `${JSON.stringify({
      at: phase1Evidence.armed_at,
      phase: 'power-cut-armed',
      captured_samples: phase1Evidence.armed_captured_samples,
      committed_samples: phase1Evidence.armed_committed_samples,
      segment_total_bytes: phase1Evidence.segment_total_bytes,
      segment_count: phase1Evidence.segment_count,
    })}\n`,
  );
  const startRequestId = 'acceptance-fixture-1';
  fs.writeFileSync(
    path.join(phase1RunDirectory, 'protocol.jsonl'),
    `${[
      {
        at: '2026-08-11T00:00:00.000Z',
        direction: 'engine',
        message: { event: 'engine_ready', payload: engineReady },
      },
      {
        at: '2026-08-11T00:00:01.000Z',
        direction: 'tool',
        message: {
          protocol_version: 1,
          request_id: startRequestId,
          command: 'start_session',
          payload: {
            session_dir: powerSession,
            session_id: phase1SessionId,
            device_id: DEVICE_ID,
            sample_rate: 48_000,
            bit_depth: 24,
            input_channel: 1,
          },
        },
      },
      {
        at: '2026-08-11T00:00:01.100Z',
        direction: 'engine',
        message: {
          protocol_version: 1,
          request_id: startRequestId,
          ok: true,
          result: { snapshot: phase1Snapshot },
        },
      },
    ].map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  fs.writeFileSync(path.join(phase1RunDirectory, 'engine-stderr.log'), '');
  reportPaths.set(recoverRequirement.phase1_evidence_run_id, phase1ReportPath);
  recoverRequirement.phase1_report = path.relative(root, phase1ReportPath);
  for (const requirement of requiredRuns) {
    const runDirectory = path.join(root, 'runs', requirement.id);
    fs.mkdirSync(runDirectory, { recursive: true });
    const sessionId = requirement.mode === 'recover' || requirement.mode === 'inspect'
      ? 'power-cut-session-fixture'
      : `session-${requirement.id}`;
    const snapshot = makeSnapshot(requirement, sessionId);
    const sessionDirectory = requirement.mode === 'recover' || requirement.mode === 'inspect'
      ? powerSession
      : path.join(runDirectory, 'recording');
    if (!['inventory', 'recover', 'inspect'].includes(requirement.mode)) {
      fs.mkdirSync(path.join(sessionDirectory, 'audio'), { recursive: true });
      fs.writeFileSync(path.join(sessionDirectory, 'audio', 'master-fixture.wav'), 'fixture-audio\n');
    }
    const report = {
      schema_version: 1,
      tool_version: 1,
      acceptance_tool_sha256: TOOL_HASH,
      mode: requirement.mode,
      started_at: '2026-08-11T00:00:00.000Z',
      completed_at: '2026-08-11T08:01:00.000Z',
      overall: 'PASS',
      host: makeHost(),
      qualification: {
        qualification_id: plan.qualification_id,
        run_id: requirement.id,
        installer_sha256: installerHash,
      },
      options: {
        sampleRate: requirement.sample_rate ?? 48_000,
        bitDepth: requirement.bit_depth ?? 24,
        channel: requirement.channel ?? 1,
        seconds: requirement.min_seconds ?? 30,
        hours: requirement.min_hours ?? 2,
        export: requirement.export ?? false,
      },
      engine: {
        binary_sha256: ENGINE_HASH,
        ready: { engine_version: 'fixture', protocol_version: 1, platform: 'windows', arch: 'x86_64' },
        exit: { code: 0, signal: null },
      },
      selected_device: { id: DEVICE_ID, name: 'Fixture USB Interface' },
      start: { snapshot },
      requested: {
        sample_rate: requirement.sample_rate ?? 48_000,
        wav_bit_depth: requirement.bit_depth ?? 24,
        input_channel: requirement.channel ?? 1,
      },
      progress_summary: {
        first: { elapsed_seconds: 0 },
        last: {
          elapsed_seconds: requirement.min_hours !== undefined
            ? requirement.min_hours * 3_600
            : requirement.min_seconds ?? 30,
        },
      },
      session_dir: sessionDirectory,
      inspection: {
        session_dir: sessionDirectory,
        snapshot,
        full_track: requirement.expected_full_track_container
          ? { container: requirement.expected_full_track_container, exact_header: true }
          : null,
      },
      checks: [{ id: 'fixture-pass', status: 'PASS' }],
    };
    if (requirement.mode === 'inventory') {
      report.inventory = {
        devices: [{
          id: DEVICE_ID,
          name: 'Fixture USB Interface',
          configurations: [
            { min_sample_rate: 44_100, max_sample_rate: 44_100, channels: 2, sample_format: 'f32' },
            { min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 2, sample_format: 'f32' },
            { min_sample_rate: 96_000, max_sample_rate: 96_000, channels: 2, sample_format: 'f32' },
          ],
        }],
      };
    }
    if (requirement.mode === 'recover') {
      report.production_eligible = true;
      report.options.phase1Report = phase1ReportPath;
      report.phase1 = {
        source_kind: 'report',
        source_path: phase1ReportPath,
        report: phase1Report,
        evidence: phase1Evidence,
        session_evidence: phase1Evidence,
      };
      report.recovery = { result: { snapshot } };
    }
    if (requirement.mode === 'abrupt-enospc') report.production_eligible = true;
    const companionNames = requirement.mode === 'inspect'
      ? []
      : requirement.mode === 'inventory' || requirement.mode === 'recover'
        ? ['protocol.jsonl', 'engine-stderr.log']
        : ['telemetry.jsonl', 'protocol.jsonl', 'engine-stderr.log'];
    for (const name of companionNames) {
      fs.writeFileSync(path.join(runDirectory, name), name === 'engine-stderr.log' ? '' : '{}\n');
    }
    const reportPath = path.join(runDirectory, 'acceptance-report.json');
    writeJson(reportPath, report);
    reportPaths.set(requirement.id, reportPath);
    requirement.report = path.relative(root, reportPath);
  }
  const planPath = path.join(root, 'qualification-plan.json');
  writeJson(planPath, plan);
  return { root, installer, plan, planPath, reportPaths, phase1ReportPath, phase1RunDirectory };
}

function mutateReport(fixture, runId, mutator) {
  const reportPath = fixture.reportPaths.get(runId);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  mutator(report, reportPath);
  writeJson(reportPath, report);
}

function mutatePhase1Report(fixture, mutator) {
  const report = JSON.parse(fs.readFileSync(fixture.phase1ReportPath, 'utf8'));
  mutator(report, fixture.phase1ReportPath);
  writeJson(fixture.phase1ReportPath, report);
}

function requirement(result, id) {
  return result.report.requirements.find((item) => item.id === id);
}

async function testQualifiedWithFutureModesInjected() {
  const fixture = createFixture();
  try {
    assert(validatePlan(fixture.plan).every((check) => check.status === 'PASS'));
    const output = path.join(fixture.root, 'qualified', 'qualification-report.json');
    const result = await runQualification({
      plan: fixture.planPath,
      reports: fixture.root,
      output,
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(
      result.report.overall,
      'QUALIFIED',
      JSON.stringify({
        plan: result.report.plan_checks.filter((check) => check.status !== 'PASS'),
        runs: result.report.requirements
          .filter((item) => item.status !== 'PASS')
          .map((item) => ({
            id: item.id,
            status: item.status,
            checks: item.checks.filter((check) => check.status !== 'PASS'),
          })),
        evidence: result.report.evidence,
      }, null, 2),
    );
    assert(result.report.requirements.every((item) => item.status === 'PASS'));
    assert.equal(fs.existsSync(output), true);
    assert.equal(fs.existsSync(result.manifestPath), true);
    const manifest = fs.readFileSync(result.manifestPath, 'utf8');
    assert.match(manifest, /qualification-report\.json/);
    assert.match(manifest, /acceptance-report\.json/);
    assert.match(manifest, /runs\/power-cut-phase1-48000-24-ch1\/telemetry\.jsonl/);
    assert.match(manifest, /runs\/power-cut-phase1-48000-24-ch1\/protocol\.jsonl/);
    assert.match(manifest, /runs\/power-cut-phase1-48000-24-ch1\/engine-stderr\.log/);
    assert.match(manifest, /runs\/power-cut-phase1-48000-24-ch1\/power-cut-evidence\.json/);
    assert(result.manifestEntries.length > fixture.plan.required_runs.length);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testRuntimeSchemaValidation() {
  const cases = [
    {
      name: 'additional property',
      mutate: (plan) => { plan.unexpected_runtime_bypass = true; },
    },
    {
      name: 'string numeric',
      mutate: (plan) => {
        plan.required_runs.find((run) => run.id === 'short-44100-16-ch1').sample_rate = '44100';
      },
    },
  ];
  for (const testCase of cases) {
    const fixture = createFixture();
    try {
      const plan = JSON.parse(fs.readFileSync(fixture.planPath, 'utf8'));
      testCase.mutate(plan);
      writeJson(fixture.planPath, plan);
      const output = path.join(fixture.root, 'invalid-schema', 'qualification-report.json');
      await assert.rejects(
        runQualification({
          plan: fixture.planPath,
          reports: fixture.root,
          output,
          implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
        }),
        /strict JSON Schema/,
        testCase.name,
      );
      assert.equal(fs.existsSync(output), false, testCase.name);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

async function testPhase1ArchiveFailClosed() {
  const missingReport = createFixture();
  try {
    fs.unlinkSync(missingReport.phase1ReportPath);
    const result = await runQualification({
      plan: missingReport.planPath,
      reports: missingReport.root,
      output: path.join(missingReport.root, 'missing-phase1-report', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    const recover = requirement(result, 'power-cut-recover-48000-24-ch1');
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(recover.checks.find((check) => check.id === 'phase1-original-report-selected')?.status, 'FAIL');
  } finally {
    fs.rmSync(missingReport.root, { recursive: true, force: true });
  }

  const duplicateReport = createFixture();
  try {
    const duplicatePath = path.join(duplicateReport.root, 'duplicate-phase1', 'acceptance-report.json');
    fs.mkdirSync(path.dirname(duplicatePath), { recursive: true });
    fs.copyFileSync(duplicateReport.phase1ReportPath, duplicatePath);
    const result = await runQualification({
      plan: duplicateReport.planPath,
      reports: duplicateReport.root,
      output: path.join(duplicateReport.root, 'duplicate-phase1-output', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    const recover = requirement(result, 'power-cut-recover-48000-24-ch1');
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(recover.checks.find((check) => check.id === 'phase1-original-report-selected')?.status, 'FAIL');
    assert.equal(
      result.report.plan_checks.find((check) => check.id === 'unique-qualification-run-bindings')?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(duplicateReport.root, { recursive: true, force: true });
  }

  for (const companion of ['telemetry.jsonl', 'protocol.jsonl', 'engine-stderr.log']) {
    const fixture = createFixture();
    try {
      fs.unlinkSync(path.join(fixture.phase1RunDirectory, companion));
      const result = await runQualification({
        plan: fixture.planPath,
        reports: fixture.root,
        output: path.join(fixture.root, `missing-${companion}`, 'qualification-report.json'),
        implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
      });
      assert.equal(result.report.overall, 'NOT_QUALIFIED');
      assert.equal(
        requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
          (check) => check.id === `phase1-evidence-${companion}`,
        )?.status,
        'FAIL',
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const independentMismatch = createFixture();
  try {
    const evidencePath = path.join(independentMismatch.phase1RunDirectory, 'power-cut-evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.nonce = 'different-independent-evidence';
    writeJson(evidencePath, evidence);
    const result = await runQualification({
      plan: independentMismatch.planPath,
      reports: independentMismatch.root,
      output: path.join(independentMismatch.root, 'independent-mismatch', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
        (check) => check.id === 'phase1-independent-evidence-equal',
      )?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(independentMismatch.root, { recursive: true, force: true });
  }

  const missingSessionEvidence = createFixture();
  try {
    fs.unlinkSync(path.join(
      missingSessionEvidence.root,
      'power-cut-session',
      'metadata',
      'power-cut.acceptance.json',
    ));
    const result = await runQualification({
      plan: missingSessionEvidence.planPath,
      reports: missingSessionEvidence.root,
      output: path.join(missingSessionEvidence.root, 'missing-session-evidence', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
        (check) => check.id === 'phase1-session-evidence-equal',
      )?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(missingSessionEvidence.root, { recursive: true, force: true });
  }

  const badTelemetry = createFixture();
  try {
    fs.writeFileSync(path.join(badTelemetry.phase1RunDirectory, 'telemetry.jsonl'), '{"phase":"recording"}\n');
    const result = await runQualification({
      plan: badTelemetry.planPath,
      reports: badTelemetry.root,
      output: path.join(badTelemetry.root, 'bad-armed-telemetry', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
        (check) => check.id === 'phase1-armed-telemetry-bound',
      )?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(badTelemetry.root, { recursive: true, force: true });
  }

  const badProtocol = createFixture();
  try {
    fs.writeFileSync(path.join(badProtocol.phase1RunDirectory, 'protocol.jsonl'), '{}\n');
    const result = await runQualification({
      plan: badProtocol.planPath,
      reports: badProtocol.root,
      output: path.join(badProtocol.root, 'bad-phase1-protocol', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
        (check) => check.id === 'phase1-protocol-lifecycle-bound',
      )?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(badProtocol.root, { recursive: true, force: true });
  }

  const shortProductionEvidence = createFixture();
  try {
    mutatePhase1Report(shortProductionEvidence, (report) => {
      report.power_cut.evidence.required_duration_seconds = 30;
      report.power_cut.evidence.wall_elapsed_seconds = 30;
      report.power_cut.evidence.armed_committed_samples = 1;
    });
    const result = await runQualification({
      plan: shortProductionEvidence.planPath,
      reports: shortProductionEvidence.root,
      output: path.join(shortProductionEvidence.root, 'short-production-evidence', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
        (check) => check.id === 'phase1-production-evidence',
      )?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(shortProductionEvidence.root, { recursive: true, force: true });
  }

  const identityCases = [
    {
      name: 'qualification',
      checkId: 'phase1-report-qualification-binding',
      mutate: (report) => { report.qualification.installer_sha256 = 'f'.repeat(64); },
    },
    {
      name: 'tool',
      checkId: 'phase1-binary-identity',
      mutate: (report) => { report.acceptance_tool_sha256 = 'f'.repeat(64); },
    },
    {
      name: 'engine',
      checkId: 'phase1-binary-identity',
      mutate: (report) => { report.engine.binary_sha256 = 'f'.repeat(64); },
    },
    {
      name: 'host',
      checkId: 'phase1-host-identity',
      mutate: (report) => { report.host.hostname = 'wrong-phase1-host'; },
    },
    {
      name: 'device',
      checkId: 'phase1-device-format-identity',
      mutate: (report) => { report.selected_device.id = 'wasapi:wrong-phase1'; },
    },
    {
      name: 'format',
      checkId: 'phase1-device-format-identity',
      mutate: (report) => { report.requested.sample_rate = 44_100; },
    },
  ];
  for (const testCase of identityCases) {
    const fixture = createFixture();
    try {
      mutatePhase1Report(fixture, testCase.mutate);
      const result = await runQualification({
        plan: fixture.planPath,
        reports: fixture.root,
        output: path.join(fixture.root, `phase1-${testCase.name}`, 'qualification-report.json'),
        implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
      });
      assert.equal(result.report.overall, 'NOT_QUALIFIED', testCase.name);
      assert.equal(
        requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
          (check) => check.id === testCase.checkId,
        )?.status,
        'FAIL',
        testCase.name,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const embeddedMismatch = createFixture();
  try {
    mutateReport(embeddedMismatch, 'power-cut-recover-48000-24-ch1', (report) => {
      report.phase1.evidence.audio_format.sample_rate = 44_100;
    });
    const result = await runQualification({
      plan: embeddedMismatch.planPath,
      reports: embeddedMismatch.root,
      output: path.join(embeddedMismatch.root, 'embedded-mismatch', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
        (check) => check.id === 'phase1-original-equals-phase2-embedded',
      )?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(embeddedMismatch.root, { recursive: true, force: true });
  }
}

async function testPhase1LogsAllowOnlyATornFinalAppend() {
  const tornFinal = createFixture();
  try {
    fs.appendFileSync(
      path.join(tornFinal.phase1RunDirectory, 'telemetry.jsonl'),
      '{"phase":"recording"',
    );
    fs.appendFileSync(
      path.join(tornFinal.phase1RunDirectory, 'protocol.jsonl'),
      '{"direction":"engine"',
    );
    const result = await runQualification({
      plan: tornFinal.planPath,
      reports: tornFinal.root,
      output: path.join(tornFinal.root, 'torn-final-line', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(
      result.report.overall,
      'QUALIFIED',
      'an abrupt power loss may tear only the append after already-synced armed evidence',
    );
  } finally {
    fs.rmSync(tornFinal.root, { recursive: true, force: true });
  }

  const corruptMiddle = createFixture();
  try {
    fs.appendFileSync(
      path.join(corruptMiddle.phase1RunDirectory, 'telemetry.jsonl'),
      '{"broken":\n{}\n',
    );
    const result = await runQualification({
      plan: corruptMiddle.planPath,
      reports: corruptMiddle.root,
      output: path.join(corruptMiddle.root, 'corrupt-middle-line', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
        (check) => check.id === 'phase1-armed-telemetry-bound',
      )?.status,
      'FAIL',
      'a non-final malformed NDJSON record must never be excused as a power-loss tail',
    );
  } finally {
    fs.rmSync(corruptMiddle.root, { recursive: true, force: true });
  }
}

async function testCurrentModesFailClosed() {
  const fixture = createFixture();
  try {
    const result = await runQualification({
      plan: fixture.planPath,
      reports: fixture.root,
      output: path.join(fixture.root, 'current', 'qualification-report.json'),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(requirement(result, 'default-switch-48000-24-ch1').status, 'NOT_IMPLEMENTED');
    assert.equal(requirement(result, 'replug-48000-24-ch1').status, 'NOT_IMPLEMENTED');
    assert.equal(requirement(result, 'abrupt-enospc-48000-24-ch1').status, 'NOT_IMPLEMENTED');
    assert.equal(fs.existsSync(result.manifestPath), false);
    assert.equal(IMPLEMENTED_ACCEPTANCE_MODES.has('default-switch'), false);
    assert.equal(IMPLEMENTED_ACCEPTANCE_MODES.has('replug'), false);
    assert.equal(IMPLEMENTED_ACCEPTANCE_MODES.has('abrupt-enospc'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testIdentityAndEvidenceFailures() {
  const cases = [
    {
      name: 'engine hash',
      runId: 'short-48000-24-ch1',
      mutate: (report) => { report.engine.binary_sha256 = 'f'.repeat(64); },
      checkId: 'engine-hash',
    },
    {
      name: 'host',
      runId: 'short-48000-24-ch1',
      mutate: (report) => { report.host.hostname = 'another-host'; },
      checkId: 'host-identity',
    },
    {
      name: 'device',
      runId: 'short-48000-24-ch1',
      mutate: (report) => { report.selected_device.id = 'wasapi:wrong'; report.start.snapshot.device_id = 'wasapi:wrong'; report.inspection.snapshot.device_id = 'wasapi:wrong'; },
      checkId: 'device-identity',
    },
    {
      name: 'option',
      runId: 'short-48000-24-ch1',
      mutate: (report) => { report.options.sampleRate = 44_100; },
      checkId: 'option-sample_rate',
    },
    {
      name: 'warning',
      runId: 'short-48000-24-ch1',
      mutate: (report) => { report.checks.push({ id: 'clipping', status: 'WARN' }); },
      checkId: 'all-acceptance-checks-pass',
    },
  ];
  for (const testCase of cases) {
    const fixture = createFixture();
    try {
      mutateReport(fixture, testCase.runId, testCase.mutate);
      const result = await runQualification({
        plan: fixture.planPath,
        reports: fixture.root,
        output: path.join(fixture.root, `failure-${testCase.name.replace(/\s+/g, '-')}`, 'qualification-report.json'),
        implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
      });
      assert.equal(result.report.overall, 'NOT_QUALIFIED', testCase.name);
      const failed = requirement(result, testCase.runId);
      assert.equal(failed.status, 'FAIL', testCase.name);
      assert.equal(failed.checks.find((check) => check.id === testCase.checkId)?.status, 'FAIL', testCase.name);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const missingEvidence = createFixture();
  try {
    fs.unlinkSync(path.join(path.dirname(missingEvidence.reportPaths.get('short-48000-24-ch1')), 'telemetry.jsonl'));
    const result = await runQualification({
      plan: missingEvidence.planPath,
      reports: missingEvidence.root,
      output: path.join(missingEvidence.root, 'missing-evidence', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'short-48000-24-ch1').checks.find((check) => check.id === 'evidence-telemetry.jsonl')?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(missingEvidence.root, { recursive: true, force: true });
  }

  const unboundPowerCut = createFixture();
  try {
    mutateReport(unboundPowerCut, 'power-cut-recover-48000-24-ch1', (report) => {
      report.phase1.evidence.qualification.run_id = 'another-power-cut';
    });
    const result = await runQualification({
      plan: unboundPowerCut.planPath,
      reports: unboundPowerCut.root,
      output: path.join(unboundPowerCut.root, 'unbound-power-cut', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'power-cut-recover-48000-24-ch1').checks.find(
        (check) => check.id === 'phase1-qualification-binding',
      )?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(unboundPowerCut.root, { recursive: true, force: true });
  }
}

async function testDuplicateBindingFailsEvenWithExplicitReport() {
  const fixture = createFixture();
  try {
    const runId = 'short-48000-24-ch1';
    const duplicate = path.join(fixture.root, 'runs', 'duplicate-binding', 'acceptance-report.json');
    fs.mkdirSync(path.dirname(duplicate), { recursive: true });
    fs.copyFileSync(fixture.reportPaths.get(runId), duplicate);
    const result = await runQualification({
      plan: fixture.planPath,
      reports: fixture.root,
      output: path.join(fixture.root, 'duplicate', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    const duplicateResult = requirement(result, runId);
    assert.equal(duplicateResult.status, 'FAIL');
    assert.match(duplicateResult.checks[0].details.error, /多份报告/);
    assert.equal(duplicateResult.checks[0].details.candidates.length, 2);
    assert.equal(
      result.report.plan_checks.find((check) => check.id === 'unique-qualification-run-bindings')?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }

  const orphanDuplicate = createFixture();
  try {
    const source = JSON.parse(fs.readFileSync(orphanDuplicate.reportPaths.get('short-48000-24-ch1'), 'utf8'));
    source.qualification.run_id = 'unplanned-phase1-binding';
    writeJson(path.join(orphanDuplicate.root, 'orphan-a', 'acceptance-report.json'), source);
    writeJson(path.join(orphanDuplicate.root, 'orphan-b', 'acceptance-report.json'), source);
    const result = await runQualification({
      plan: orphanDuplicate.planPath,
      reports: orphanDuplicate.root,
      output: path.join(orphanDuplicate.root, 'orphan-duplicate', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      result.report.plan_checks.find((check) => check.id === 'unique-qualification-run-bindings')?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(orphanDuplicate.root, { recursive: true, force: true });
  }

  const unreadableReport = createFixture();
  try {
    const corruptPath = path.join(unreadableReport.root, 'corrupt-run', 'acceptance-report.json');
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, '{"qualification":');
    const result = await runQualification({
      plan: unreadableReport.planPath,
      reports: unreadableReport.root,
      output: path.join(unreadableReport.root, 'corrupt-report-output', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      result.report.plan_checks.find((check) => check.id === 'all-acceptance-reports-readable')?.status,
      'FAIL',
    );
  } finally {
    fs.rmSync(unreadableReport.root, { recursive: true, force: true });
  }
}

async function testAggregateOutputDoesNotHashItself() {
  const fixture = createFixture();
  try {
    const outputDirectory = path.dirname(fixture.reportPaths.get('short-48000-24-ch1'));
    const output = path.join(outputDirectory, 'qualification-report.json');
    const manifestPath = path.join(outputDirectory, 'qualification-evidence.sha256');
    fs.writeFileSync(output, '{"stale":true}\n');
    fs.writeFileSync(manifestPath, `${'f'.repeat(64)} *qualification-report.json\n`);
    const result = await runQualification({
      plan: fixture.planPath,
      reports: fixture.root,
      output,
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'QUALIFIED');
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    assert.equal((manifest.match(/\*runs\/short-48000-24-ch1\/qualification-report\.json/g) ?? []).length, 1);
    assert.doesNotMatch(manifest, /qualification-evidence\.sha256/);
    assert.doesNotMatch(manifest, new RegExp(`${'f'.repeat(64)} \\*qualification-report\\.json`));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testCanonicalContainmentRejectsSymlinkAncestor() {
  if (process.platform === 'win32') return;
  const fixture = createFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'databaker-qualification-outside-'));
  try {
    const escapedSession = path.join(outside, 'recording');
    fs.mkdirSync(escapedSession, { recursive: true });
    const link = path.join(fixture.root, 'linked-evidence');
    fs.symlinkSync(outside, link, 'dir');
    mutateReport(fixture, 'short-48000-24-ch1', (report) => {
      report.session_dir = path.join(link, 'recording');
      report.inspection.session_dir = path.join(link, 'recording');
    });
    const result = await runQualification({
      plan: fixture.planPath,
      reports: fixture.root,
      output: path.join(fixture.root, 'symlink-evidence', 'qualification-report.json'),
      implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
    });
    assert.equal(result.report.overall, 'NOT_QUALIFIED');
    assert.equal(
      requirement(result, 'short-48000-24-ch1').checks.find(
        (check) => check.id === 'recording-evidence-contained',
      )?.status,
      'FAIL',
    );
    await assert.rejects(
      runQualification({
        plan: fixture.planPath,
        reports: fixture.root,
        output: path.join(link, 'qualification-report.json'),
        implementedModes: new Set(KNOWN_ACCEPTANCE_MODES),
      }),
      /链接|reports 归档根/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function testPlanAndArgs() {
  const parsed = parseArgs(['--plan', 'plan.json', '--reports', 'reports']);
  assert.equal(path.isAbsolute(parsed.plan), true);
  assert.equal(path.isAbsolute(parsed.reports), true);
  assert.throws(() => parseArgs(['--plan', 'plan.json']), /--reports/);

  const example = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'doc', 'Windows外置声卡资格计划.example.json'),
    'utf8',
  ));
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'doc', 'windows-audio-qualification-plan.schema.json'),
    'utf8',
  ));
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validateSchema(example), true, JSON.stringify(validateSchema.errors, null, 2));
  assert(validatePlan(example).every((check) => check.status === 'PASS'));
  const incomplete = structuredClone(example);
  incomplete.required_runs = incomplete.required_runs.filter((run) => run.id !== 'short-96000-32-ch1');
  assert.equal(
    validatePlan(incomplete).find((check) => check.id === 'matrix-short-96000-32-ch1')?.status,
    'FAIL',
  );
  const invalidRecover = structuredClone(example);
  delete invalidRecover.required_runs.find((run) => run.mode === 'recover').phase1_evidence_run_id;
  assert.equal(validateSchema(invalidRecover), false);
}

async function main() {
  testPlanAndArgs();
  await testRuntimeSchemaValidation();
  await testQualifiedWithFutureModesInjected();
  await testCurrentModesFailClosed();
  await testIdentityAndEvidenceFailures();
  await testDuplicateBindingFailsEvenWithExplicitReport();
  await testAggregateOutputDoesNotHashItself();
  await testCanonicalContainmentRejectsSymlinkAncestor();
  await testPhase1ArchiveFailClosed();
  await testPhase1LogsAllowOnlyATornFinalAppend();
  process.stdout.write('windows audio qualification aggregator tests passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
