'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const {
  evaluateSealedSession,
  faultMarkerPresent,
  inspectSession,
} = require('./windows-audio-acceptance.cjs');

function loadAjv2020() {
  const candidates = ['ajv/dist/2020'];
  if (process.resourcesPath) {
    candidates.push(path.join(
      process.resourcesPath,
      'app.asar',
      'node_modules',
      'ajv',
      'dist',
      '2020.js',
    ));
  }
  const errors = [];
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      return loaded.default ?? loaded;
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`无法加载 Ajv 2020，不得跳过资格计划校验:\n${errors.join('\n')}`);
}

const Ajv2020 = loadAjv2020();

const QUALIFICATION_PROFILE = 'databaker-windows-v1';
const REQUIRED_SAMPLE_RATES = Object.freeze([44_100, 48_000, 96_000]);
const REQUIRED_BIT_DEPTHS = Object.freeze([16, 24, 32]);
const IMPLEMENTED_ACCEPTANCE_MODES = new Set([
  'inventory',
  'short',
  'soak',
  'unplug',
  'replug',
  'disk-full',
  'power-cut',
  'recover',
  'inspect',
]);
const KNOWN_ACCEPTANCE_MODES = new Set([
  ...IMPLEMENTED_ACCEPTANCE_MODES,
  'default-switch',
  'abrupt-enospc',
]);
const ENGINE_MODES = new Set([
  'inventory',
  'short',
  'soak',
  'unplug',
  'disk-full',
  'power-cut',
  'recover',
  'default-switch',
  'replug',
  'abrupt-enospc',
]);
const CAPTURE_MODES = new Set([
  'short',
  'soak',
  'unplug',
  'disk-full',
  'power-cut',
  'default-switch',
  'replug',
  'abrupt-enospc',
]);
const NORMAL_CAPTURE_MODES = new Set(['short', 'soak', 'replug']);
const SEALED_NORMAL_CAPTURE_MODES = new Set(['short', 'soak', 'default-switch']);
const FAULT_CAPTURE_MODES = new Set(['unplug', 'disk-full', 'abrupt-enospc']);
const INPUT_AUDITION_SECONDS = 10;
const PRODUCTION_MAX_NOISE_THRESHOLD_DBFS = -40;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RIFF_MAX_DATA_BYTES = 0xffff_ffff - 128;

function usage() {
  return `DataBaker Windows 音频生产资格聚合器

用法:
  node scripts/windows-audio-qualification.cjs --plan <plan.json> --reports <root> [--output <report.json>]

参数:
  --plan <file>       资格计划 JSON
  --reports <root>    包含所有 acceptance run 和录音证据的归档根目录
  --output <file>     聚合结果，文件名必须为 qualification-report.json
  --help              显示帮助

退出码:
  0 = QUALIFIED
  1 = NOT_QUALIFIED
  2 = 参数或工具错误
`;
}

function parseArgs(argv) {
  const options = { plan: null, reports: null, output: null, help: false };
  const valueFor = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') options.help = true;
    else if (flag === '--plan') options.plan = valueFor(index++, flag);
    else if (flag === '--reports') options.reports = valueFor(index++, flag);
    else if (flag === '--output') options.output = valueFor(index++, flag);
    else throw new Error(`未知参数: ${flag}`);
  }
  if (options.help) return options;
  if (!options.plan) throw new Error('缺少 --plan <plan.json>');
  if (!options.reports) throw new Error('缺少 --reports <root>');
  options.plan = path.resolve(options.plan);
  options.reports = path.resolve(options.reports);
  options.output = path.resolve(options.output ?? path.join(options.reports, 'qualification-report.json'));
  return options;
}

function readJsonRegularFile(filePath, label) {
  const metadata = fs.lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} 必须是普通文件，不能是链接: ${filePath}`);
  }
  if (metadata.size <= 0 || metadata.size > 64 * 1024 * 1024) {
    throw new Error(`${label} 大小无效: ${filePath} (${metadata.size} bytes)`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} 无法解析: ${filePath}: ${error.message}`);
  }
}

function readNdjsonRegularFile(
  filePath,
  label,
  maximumBytes = 512 * 1024 * 1024,
  allowTornFinalLine = false,
) {
  const metadata = fs.lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} 必须是普通文件，不能是链接: ${filePath}`);
  }
  if (metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} 大小无效: ${filePath} (${metadata.size} bytes)`);
  }
  const contents = fs.readFileSync(filePath, 'utf8');
  const lines = contents.split(/\r?\n/);
  let lastContentIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== '') {
      lastContentIndex = index;
      break;
    }
  }
  const endsWithNewline = /\r?\n$/.test(contents);
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      // A real power loss may interrupt the append that follows the already
      // synced armed record. Accept only one unterminated final fragment; any
      // earlier corruption still invalidates the archive.
      if (allowTornFinalLine && !endsWithNewline && index === lastContentIndex) break;
      throw new Error(`${label} 第 ${index + 1} 行无法解析: ${error.message}`);
    }
  }
  return rows;
}

let cachedPlanSchemaValidator = null;

function qualificationSchemaPath() {
  const candidates = [
    path.join(__dirname, 'windows-audio-qualification-plan.schema.json'),
    path.resolve(__dirname, '..', 'doc', 'windows-audio-qualification-plan.schema.json'),
  ];
  for (const candidate of candidates) {
    try {
      const metadata = fs.lstatSync(candidate);
      if (metadata.isFile() && !metadata.isSymbolicLink()) return candidate;
    } catch {}
  }
  throw new Error(`找不到 Windows 音频资格计划 Schema: ${candidates.join(', ')}`);
}

function planSchemaValidator() {
  if (cachedPlanSchemaValidator) return cachedPlanSchemaValidator;
  const schemaPath = qualificationSchemaPath();
  const schema = readJsonRegularFile(schemaPath, '资格计划 Schema');
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });
  cachedPlanSchemaValidator = ajv.compile(schema);
  return cachedPlanSchemaValidator;
}

function validatePlanSchema(plan) {
  const validate = planSchemaValidator();
  if (validate(plan)) return;
  const details = (validate.errors ?? []).map((error) => ({
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
  throw new Error(`资格计划不符合 strict JSON Schema:\n${JSON.stringify(details, null, 2)}`);
}

function normalizeHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value) ? value.toLowerCase() : null;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPath(existingPath) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(existingPath)
    : fs.realpathSync(existingPath);
}

function isCanonicalWithin(root, target) {
  try {
    return isWithin(canonicalPath(root), canonicalPath(target));
  } catch {
    return false;
  }
}

function prepareContainedOutput(root, outputPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedOutput = path.resolve(outputPath);
  if (path.basename(resolvedOutput) !== 'qualification-report.json') {
    throw new Error('--output 文件名必须为 qualification-report.json');
  }
  if (!isWithin(resolvedRoot, resolvedOutput)) {
    throw new Error(`--output 必须位于 reports 归档根内: ${resolvedOutput}`);
  }
  const canonicalRoot = canonicalPath(resolvedRoot);
  const relativeParent = path.relative(resolvedRoot, path.dirname(resolvedOutput));
  let current = resolvedRoot;
  for (const component of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const metadata = fs.lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`聚合输出路径包含链接或非目录节点: ${current}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current);
    }
    if (!isWithin(canonicalRoot, canonicalPath(current))) {
      throw new Error(`聚合输出路径经链接逃出 reports 归档根: ${current}`);
    }
  }
  for (const candidate of [resolvedOutput, path.join(path.dirname(resolvedOutput), 'qualification-evidence.sha256')]) {
    try {
      const metadata = fs.lstatSync(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink() || !isCanonicalWithin(canonicalRoot, candidate)) {
        throw new Error(`聚合输出必须是 reports 归档根内的普通文件: ${candidate}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function writeFileAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx');
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    // Windows does not consistently replace an existing destination with
    // renameSync. The temporary file is already flushed, so copy is a safe
    // compatibility fallback for generated qualification outputs.
    fs.copyFileSync(temporary, filePath);
    fs.unlinkSync(temporary);
    if (!fs.existsSync(filePath)) throw error;
  }
}

function reportNumericValues(report, field) {
  const sources = {
    sample_rate: [
      report?.options?.sampleRate,
      report?.requested?.sample_rate,
      report?.start?.snapshot?.audio_format?.sample_rate,
      report?.inspection?.snapshot?.audio_format?.sample_rate,
      report?.phase1?.evidence?.audio_format?.sample_rate,
    ],
    bit_depth: [
      report?.options?.bitDepth,
      report?.requested?.wav_bit_depth,
      report?.start?.snapshot?.audio_format?.bit_depth,
      report?.inspection?.snapshot?.audio_format?.bit_depth,
      report?.phase1?.evidence?.audio_format?.bit_depth,
    ],
    channel: [
      report?.options?.channel,
      report?.requested?.input_channel,
      report?.start?.snapshot?.audio_format?.input_channel,
      report?.inspection?.snapshot?.audio_format?.input_channel,
      report?.phase1?.evidence?.audio_format?.input_channel,
    ],
  };
  return [...new Set((sources[field] ?? [])
    .map(Number)
    .filter((value) => Number.isFinite(value)))];
}

function reportDeviceIds(report) {
  return [...new Set([
    report?.selected_device?.id,
    report?.start?.snapshot?.device_id,
    report?.inspection?.snapshot?.device_id,
    report?.phase1?.evidence?.device_id,
  ].filter((value) => typeof value === 'string' && value.length > 0))];
}

function reportElapsedSeconds(report) {
  const values = [
    report?.progress_summary?.last?.elapsed_seconds,
    report?.progress_summary?.first && report?.progress_summary?.last
      ? Number(report.progress_summary.last.elapsed_seconds) - Number(report.progress_summary.first.elapsed_seconds)
      : null,
  ].map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  return values.length > 0 ? Math.max(...values) : null;
}

function requiredDataBytes(requirement) {
  const sampleRate = Number(requirement.sample_rate);
  const bitDepth = Number(requirement.bit_depth);
  const hours = Number(requirement.min_hours);
  if (!Number.isSafeInteger(sampleRate) || !REQUIRED_BIT_DEPTHS.includes(bitDepth) || !Number.isFinite(hours)) {
    return null;
  }
  return sampleRate * (bitDepth / 8) * hours * 3_600;
}

function validatePlan(plan) {
  const issues = [];
  const add = (id, passed, details) => issues.push({ id, status: passed ? 'PASS' : 'FAIL', details });
  add('plan-schema-version', plan?.schema_version === 1, { actual: plan?.schema_version, expected: 1 });
  add('qualification-profile', plan?.profile === QUALIFICATION_PROFILE, {
    actual: plan?.profile,
    expected: QUALIFICATION_PROFILE,
  });
  add('qualification-id', SAFE_ID_PATTERN.test(String(plan?.qualification_id ?? '')), plan?.qualification_id);
  add('release-app-version', typeof plan?.release?.app_version === 'string' && plan.release.app_version.trim() !== '', plan?.release?.app_version);
  for (const field of ['installer_sha256', 'engine_sha256', 'acceptance_tool_sha256']) {
    add(`release-${field}`, normalizeHash(plan?.release?.[field]) !== null, plan?.release?.[field]);
  }
  add('release-installer-path', typeof plan?.release?.installer_path === 'string' && plan.release.installer_path.trim() !== '', plan?.release?.installer_path);
  add('target-platform', plan?.target?.platform === 'win32', plan?.target?.platform);
  add('target-architecture', plan?.target?.architecture === 'x64', plan?.target?.architecture);
  for (const field of ['hostname', 'windows_release', 'device_id', 'device_name', 'driver_version', 'usb_port', 'serial']) {
    add(`target-${field}`, typeof plan?.target?.[field] === 'string' && plan.target[field].trim() !== '', plan?.target?.[field]);
  }
  add(
    'target-capture-backend',
    plan?.target?.capture_backend === 'asio' || plan?.target?.capture_backend === 'wasapi',
    plan?.target?.capture_backend,
  );
  add(
    'target-capture-buffer-frames',
    plan?.target?.capture_backend === 'asio'
      ? Number.isSafeInteger(plan?.target?.capture_buffer_frames) &&
        plan.target.capture_buffer_frames >= 16 && plan.target.capture_buffer_frames <= 16_384
      : plan?.target?.capture_buffer_frames === null,
    plan?.target?.capture_buffer_frames,
  );
  add(
    'target-noise-threshold-dbfs',
    Number.isFinite(plan?.target?.noise_threshold_dbfs) &&
      plan.target.noise_threshold_dbfs >= -96 &&
      plan.target.noise_threshold_dbfs <= PRODUCTION_MAX_NOISE_THRESHOLD_DBFS,
    {
      actual: plan?.target?.noise_threshold_dbfs,
      maximum: PRODUCTION_MAX_NOISE_THRESHOLD_DBFS,
    },
  );
  const channels = Array.isArray(plan?.target?.channels) ? plan.target.channels.map(Number) : [];
  add(
    'target-channels',
    channels.length > 0 && channels.every((value) => Number.isInteger(value) && value >= 1 && value <= 256) &&
      new Set(channels).size === channels.length,
    channels,
  );
  const primary = plan?.target?.primary_format;
  add(
    'target-primary-format',
    REQUIRED_SAMPLE_RATES.includes(Number(primary?.sample_rate)) &&
      REQUIRED_BIT_DEPTHS.includes(Number(primary?.bit_depth)) &&
      channels.includes(Number(primary?.channel)),
    primary,
  );

  const runs = Array.isArray(plan?.required_runs) ? plan.required_runs : [];
  add('required-runs-present', runs.length > 0, { count: runs.length });
  const ids = runs.map((run) => run?.id);
  add(
    'required-run-ids',
    ids.every((id) => SAFE_ID_PATTERN.test(String(id ?? ''))) && new Set(ids).size === ids.length,
    ids,
  );
  add(
    'required-run-modes-known',
    runs.every((run) => KNOWN_ACCEPTANCE_MODES.has(run?.mode)),
    runs.filter((run) => !KNOWN_ACCEPTANCE_MODES.has(run?.mode)).map((run) => ({ id: run?.id, mode: run?.mode })),
  );
  for (const run of runs) {
    if (run?.report !== undefined) {
      add(
        `run-${run.id}-report-relative`,
        typeof run.report === 'string' && run.report.trim() !== '' && !path.isAbsolute(run.report),
        run.report,
      );
    }
    if (run?.sample_rate !== undefined) {
      add(`run-${run.id}-sample-rate`, REQUIRED_SAMPLE_RATES.includes(Number(run.sample_rate)), run.sample_rate);
    }
    if (run?.bit_depth !== undefined) {
      add(`run-${run.id}-bit-depth`, REQUIRED_BIT_DEPTHS.includes(Number(run.bit_depth)), run.bit_depth);
    }
    if (run?.channel !== undefined) {
      add(`run-${run.id}-channel`, channels.includes(Number(run.channel)), run.channel);
    }
    if (run?.mode === 'recover') {
      add(
        `run-${run.id}-phase1-evidence-run-id`,
        SAFE_ID_PATTERN.test(String(run.phase1_evidence_run_id ?? '')) &&
          run.phase1_evidence_run_id !== run.id &&
          !ids.includes(run.phase1_evidence_run_id),
        {
          actual: run.phase1_evidence_run_id,
          rule: '必须是独立于 required_runs[].id 的安全 ID',
        },
      );
      add(
        `run-${run.id}-phase1-report-relative`,
        typeof run.phase1_report === 'string' && run.phase1_report.trim() !== '' &&
          !path.isAbsolute(run.phase1_report),
        run.phase1_report,
      );
    }
  }

  const hasRun = (predicate) => runs.some(predicate);
  for (const channel of channels) {
    for (const sampleRate of REQUIRED_SAMPLE_RATES) {
      for (const bitDepth of REQUIRED_BIT_DEPTHS) {
        add(
          `matrix-short-${sampleRate}-${bitDepth}-ch${channel}`,
          hasRun((run) => run.mode === 'short' && Number(run.sample_rate) === sampleRate &&
            Number(run.bit_depth) === bitDepth && Number(run.channel) === channel &&
            Number(run.min_seconds) >= 30 && run.export === true),
          { sample_rate: sampleRate, bit_depth: bitDepth, channel, minimum_seconds: 30, export: true },
        );
      }
    }
  }
  for (const sampleRate of REQUIRED_SAMPLE_RATES) {
    add(
      `matrix-soak-${sampleRate}`,
      hasRun((run) => run.mode === 'soak' && Number(run.sample_rate) === sampleRate &&
        Number(run.bit_depth) === 24 && Number(run.channel) === Number(primary?.channel) &&
        Number(run.min_hours) >= 2),
      { sample_rate: sampleRate, bit_depth: 24, channel: primary?.channel, minimum_hours: 2 },
    );
  }
  add(
    'matrix-primary-soak-8h',
    hasRun((run) => run.mode === 'soak' && Number(run.sample_rate) === Number(primary?.sample_rate) &&
      Number(run.bit_depth) === Number(primary?.bit_depth) && Number(run.channel) === Number(primary?.channel) &&
      Number(run.min_hours) >= 8),
    primary,
  );
  add(
    'matrix-rf64-export',
    hasRun((run) => run.mode === 'soak' && run.export === true &&
      run.expected_full_track_container === 'rf64' && Number(requiredDataBytes(run)) > RIFF_MAX_DATA_BYTES),
    { minimum_data_bytes: RIFF_MAX_DATA_BYTES + 1 },
  );
  for (const mode of ['inventory', 'unplug', 'default-switch', 'replug', 'disk-full', 'abrupt-enospc', 'recover', 'inspect']) {
    add(`required-mode-${mode}`, hasRun((run) => run.mode === mode), mode);
  }
  for (const mode of ['unplug', 'default-switch', 'replug', 'disk-full', 'abrupt-enospc', 'recover']) {
    add(
      `required-mode-${mode}-primary-format`,
      hasRun((run) => run.mode === mode &&
        Number(run.sample_rate) === Number(primary?.sample_rate) &&
        Number(run.bit_depth) === Number(primary?.bit_depth) &&
        Number(run.channel) === Number(primary?.channel)),
      { mode, ...primary },
    );
  }
  add(
    'production-recover-required',
    hasRun((run) => run.mode === 'recover' && run.production_eligible === true &&
      Number(run.sample_rate) === Number(primary?.sample_rate) &&
      Number(run.bit_depth) === Number(primary?.bit_depth) &&
      Number(run.channel) === Number(primary?.channel)),
    null,
  );
  add(
    'production-abrupt-enospc-required',
    hasRun((run) => run.mode === 'abrupt-enospc' && run.production_eligible === true &&
      Number(run.sample_rate) === Number(primary?.sample_rate) &&
      Number(run.bit_depth) === Number(primary?.bit_depth) &&
      Number(run.channel) === Number(primary?.channel)),
    null,
  );
  const runById = new Map(runs.map((run) => [run.id, run]));
  add(
    'inspect-bound-to-recover',
    runs.filter((run) => run.mode === 'inspect').every((run) => runById.get(run.bound_to)?.mode === 'recover'),
    runs.filter((run) => run.mode === 'inspect').map((run) => ({ id: run.id, bound_to: run.bound_to })),
  );
  return issues;
}

function findAcceptanceReports(root) {
  const results = [];
  const stack = [path.resolve(root)];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && entry.name === 'acceptance-report.json') {
        try {
          results.push({ path: candidate, report: readJsonRegularFile(candidate, '验收报告') });
        } catch (error) {
          results.push({ path: candidate, report: null, parse_error: error.message });
        }
      }
    }
  }
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

function reportParameterMatches(report, requirement) {
  if (report?.mode !== requirement.mode) return false;
  for (const field of ['sample_rate', 'bit_depth', 'channel']) {
    if (requirement[field] === undefined) continue;
    const values = reportNumericValues(report, field);
    if (values.length === 0 || !values.includes(Number(requirement[field]))) return false;
  }
  return true;
}

function selectReport(requirement, reportsRoot, discovered) {
  const bound = discovered.filter((entry) =>
    entry.report?.qualification?.qualification_id === requirement.qualification_id &&
    entry.report?.qualification?.run_id === requirement.id);
  if (bound.length > 1) {
    return { error: '同一 qualification_id/run_id 有多份报告，必须删除或隔离重复证据', candidates: bound };
  }
  if (requirement.report) {
    const reportPath = path.resolve(reportsRoot, requirement.report);
    if (!isWithin(reportsRoot, reportPath)) {
      return { error: '指定报告越出 reports 根目录', candidates: [] };
    }
    const found = discovered.find((entry) => path.resolve(entry.path) === reportPath);
    return found ? { selected: found, candidates: [found] } : { error: '指定报告不存在', candidates: [] };
  }
  if (bound.length === 1) return { selected: bound[0], candidates: bound };
  const near = discovered.filter((entry) => reportParameterMatches(entry.report, requirement));
  return { error: '缺少与 qualification_id/run_id 绑定的报告', candidates: near };
}

function expectedCompanions(mode) {
  if (mode === 'inspect') return [];
  if (mode === 'inventory' || mode === 'recover') return ['protocol.jsonl', 'engine-stderr.log'];
  return ['telemetry.jsonl', 'protocol.jsonl', 'engine-stderr.log'];
}

function selectPhase1Report(requirement, plan, reportsRoot, discovered) {
  const bound = discovered.filter((entry) =>
    entry.report?.qualification?.qualification_id === plan.qualification_id &&
    entry.report?.qualification?.run_id === requirement.phase1_evidence_run_id);
  if (bound.length !== 1) {
    return {
      error: bound.length === 0
        ? '缺少唯一的 phase-1 原始 acceptance-report.json'
        : '同一 phase1_evidence_run_id 存在多份原始报告',
      candidates: bound,
    };
  }
  const explicitPath = path.resolve(reportsRoot, String(requirement.phase1_report ?? ''));
  if (!isWithin(reportsRoot, explicitPath)) {
    return { error: 'phase1_report 越出 reports 归档根', candidates: bound };
  }
  const explicit = discovered.find((entry) => path.resolve(entry.path) === explicitPath);
  if (!explicit) return { error: 'phase1_report 指定的原始报告不存在', candidates: bound };
  if (path.resolve(explicit.path) !== path.resolve(bound[0].path)) {
    return { error: 'phase1_report 与 qualification_id/phase1_evidence_run_id 绑定不一致', candidates: bound };
  }
  return { selected: explicit, candidates: bound };
}

function audioFormatIdentity(format) {
  if (!format || typeof format !== 'object') return null;
  return {
    sample_rate: Number(format.sample_rate),
    bit_depth: Number(format.bit_depth),
    encoding: format.encoding,
    channels: Number(format.channels),
    input_channels: Number(format.input_channels),
    input_channel: Number(format.input_channel),
  };
}

function expectedPhase1Qualification(requirement, plan) {
  return {
    qualification_id: plan.qualification_id,
    run_id: requirement.phase1_evidence_run_id,
    installer_sha256: normalizeHash(plan.release.installer_sha256),
  };
}

function normalizedQualification(value) {
  return {
    qualification_id: value?.qualification_id,
    run_id: value?.run_id,
    installer_sha256: normalizeHash(value?.installer_sha256),
  };
}

function validatePhase1Archive(entry, phase2Report, requirement, plan, reportsRoot) {
  const checks = [];
  const evidenceRoots = [];
  const add = (id, passed, details) => checks.push({ id, status: passed ? 'PASS' : 'FAIL', details });
  const phase1Report = entry?.report;
  add('phase1-report-readable', Boolean(phase1Report) && !entry?.parse_error, entry?.parse_error ?? entry?.path);
  if (!phase1Report) return { checks, evidenceRoots, reportPath: entry?.path ?? null };

  const reportDirectory = path.dirname(entry.path);
  const reportDirectoryContained = isCanonicalWithin(reportsRoot, reportDirectory);
  add('phase1-report-directory-contained', reportDirectoryContained, reportDirectory);
  if (reportDirectoryContained) evidenceRoots.push(canonicalPath(reportDirectory));

  add(
    'phase1-original-armed-report',
    phase1Report.schema_version === 1 &&
      phase1Report.mode === 'power-cut' &&
      phase1Report.overall === 'INCOMPLETE' &&
      phase1Report.completed_at === null &&
      !phase1Report.tool_error &&
      phase1Report.aborted !== true &&
      phase1Report.production_eligible === true &&
      phase1Report.power_cut?.phase === 'armed' &&
      phase1Report.power_cut?.test_only === false &&
      phase1Report.power_cut?.production_eligible === true &&
      phase1Report.power_cut?.nonce === phase1Report.power_cut?.evidence?.nonce &&
      phase1Report.power_cut?.armed_at === phase1Report.power_cut?.evidence?.armed_at,
    {
      schema_version: phase1Report.schema_version,
      mode: phase1Report.mode,
      overall: phase1Report.overall,
      completed_at: phase1Report.completed_at,
      tool_error: phase1Report.tool_error,
      aborted: phase1Report.aborted,
      report_production_eligible: phase1Report.production_eligible,
      power_cut_phase: phase1Report.power_cut?.phase,
      test_only: phase1Report.power_cut?.test_only,
      production_eligible: phase1Report.power_cut?.production_eligible,
      nonce: phase1Report.power_cut?.nonce,
      armed_at: phase1Report.power_cut?.armed_at,
    },
  );

  const expectedQualification = expectedPhase1Qualification(requirement, plan);
  const originalEvidence = phase1Report.power_cut?.evidence;
  const embeddedEvidence = phase2Report?.phase1?.evidence;
  const phase1SampleRate = Number(originalEvidence?.audio_format?.sample_rate);
  const requiredDurationSeconds = Number(originalEvidence?.required_duration_seconds);
  const wallElapsedSeconds = Number(originalEvidence?.wall_elapsed_seconds);
  const armedCapturedSamples = Number(originalEvidence?.armed_captured_samples);
  const armedCommittedSamples = Number(originalEvidence?.armed_committed_samples);
  const maximumTailLossSamples = Number(originalEvidence?.max_tail_loss_samples);
  const requiredCommittedSamples = Math.ceil(phase1SampleRate * requiredDurationSeconds);
  add(
    'phase1-production-evidence',
    originalEvidence?.schema_version === 1 &&
      originalEvidence?.kind === 'databaker.power-cut-phase-1' &&
      originalEvidence?.phase === 'armed' &&
      typeof originalEvidence?.nonce === 'string' && originalEvidence.nonce.length >= 16 &&
      originalEvidence?.test_only === false &&
      originalEvidence?.production_eligible === true &&
      Number.isSafeInteger(phase1SampleRate) && phase1SampleRate === Number(requirement.sample_rate) &&
      Number.isFinite(requiredDurationSeconds) && requiredDurationSeconds >= 3_600 &&
      Number(originalEvidence?.production_minimum_seconds) === 3_600 &&
      Number.isFinite(wallElapsedSeconds) && wallElapsedSeconds >= requiredDurationSeconds &&
      Number.isSafeInteger(requiredCommittedSamples) &&
      Number.isSafeInteger(armedCommittedSamples) && armedCommittedSamples >= requiredCommittedSamples &&
      Number.isSafeInteger(armedCapturedSamples) && armedCapturedSamples >= armedCommittedSamples &&
      Number.isSafeInteger(originalEvidence?.overflow_samples) && originalEvidence.overflow_samples === 0 &&
      Number.isSafeInteger(originalEvidence?.input_discontinuity_count) &&
        originalEvidence.input_discontinuity_count === 0 &&
      Number.isSafeInteger(originalEvidence?.input_discontinuity_silence_samples) &&
        originalEvidence.input_discontinuity_silence_samples === 0 &&
      Number.isSafeInteger(maximumTailLossSamples) && maximumTailLossSamples >= 0 &&
      maximumTailLossSamples <= phase1SampleRate * 30 &&
      armedCapturedSamples - armedCommittedSamples <= maximumTailLossSamples &&
      Number(originalEvidence?.segment_count) > 0 &&
      Number(originalEvidence?.segment_total_bytes) > 0 &&
      Number(originalEvidence?.tool_version) === Number(phase1Report.tool_version) &&
      Number(originalEvidence?.protocol_version) === 1,
    {
      schema_version: originalEvidence?.schema_version,
      kind: originalEvidence?.kind,
      phase: originalEvidence?.phase,
      test_only: originalEvidence?.test_only,
      production_eligible: originalEvidence?.production_eligible,
      sample_rate: phase1SampleRate,
      required_duration_seconds: requiredDurationSeconds,
      production_minimum_seconds: originalEvidence?.production_minimum_seconds,
      wall_elapsed_seconds: wallElapsedSeconds,
      required_committed_samples: requiredCommittedSamples,
      armed_captured_samples: armedCapturedSamples,
      armed_committed_samples: armedCommittedSamples,
      overflow_samples: originalEvidence?.overflow_samples,
      input_discontinuity_count: originalEvidence?.input_discontinuity_count,
      input_discontinuity_silence_samples: originalEvidence?.input_discontinuity_silence_samples,
      max_tail_loss_samples: maximumTailLossSamples,
      segment_count: originalEvidence?.segment_count,
      segment_total_bytes: originalEvidence?.segment_total_bytes,
      tool_version: originalEvidence?.tool_version,
      protocol_version: originalEvidence?.protocol_version,
    },
  );
  add(
    'phase1-report-qualification-binding',
    isDeepStrictEqual(normalizedQualification(phase1Report.qualification), expectedQualification),
    { expected: expectedQualification, actual: phase1Report.qualification },
  );
  add(
    'phase1-evidence-qualification-binding',
    isDeepStrictEqual(normalizedQualification(originalEvidence?.qualification), expectedQualification) &&
      isDeepStrictEqual(normalizedQualification(embeddedEvidence?.qualification), expectedQualification),
    {
      expected: expectedQualification,
      original: originalEvidence?.qualification,
      embedded: embeddedEvidence?.qualification,
    },
  );

  add(
    'phase1-original-equals-phase2-embedded',
    Boolean(originalEvidence) && isDeepStrictEqual(originalEvidence, embeddedEvidence),
    {
      original_nonce: originalEvidence?.nonce,
      embedded_nonce: embeddedEvidence?.nonce,
      original_armed_at: originalEvidence?.armed_at,
      embedded_armed_at: embeddedEvidence?.armed_at,
    },
  );
  add(
    'phase2-consumed-original-phase1-report',
    phase2Report?.phase1?.source_kind === 'report' &&
      isDeepStrictEqual(phase2Report?.phase1?.report, phase1Report) &&
      isCanonicalWithin(reportsRoot, String(phase2Report?.phase1?.source_path ?? '')) &&
      canonicalPath(String(phase2Report?.phase1?.source_path ?? '')) === canonicalPath(entry.path) &&
      isCanonicalWithin(reportsRoot, String(phase2Report?.options?.phase1Report ?? '')) &&
      canonicalPath(String(phase2Report?.options?.phase1Report ?? '')) === canonicalPath(entry.path),
    {
      source_kind: phase2Report?.phase1?.source_kind,
      source_path: phase2Report?.phase1?.source_path,
      option_phase1_report: phase2Report?.options?.phase1Report,
      expected_path: entry.path,
    },
  );

  let independentEvidence = null;
  let independentEvidenceError = null;
  const independentEvidencePath = path.join(reportDirectory, 'power-cut-evidence.json');
  try {
    independentEvidence = readJsonRegularFile(independentEvidencePath, 'phase-1 独立证据');
  } catch (error) {
    independentEvidenceError = error.message;
  }
  add(
    'phase1-independent-evidence-equal',
    independentEvidenceError === null && isDeepStrictEqual(independentEvidence, originalEvidence),
    { path: independentEvidencePath, error: independentEvidenceError },
  );

  for (const companion of ['telemetry.jsonl', 'protocol.jsonl', 'engine-stderr.log']) {
    const candidate = path.join(reportDirectory, companion);
    let valid = false;
    try {
      const metadata = fs.lstatSync(candidate);
      valid = metadata.isFile() && !metadata.isSymbolicLink() &&
        (companion === 'engine-stderr.log' || metadata.size > 0);
    } catch {}
    add(`phase1-evidence-${companion}`, valid, candidate);
  }

  let sessionEvidence = null;
  let sessionEvidenceError = null;
  const sessionEvidencePath = path.join(
    String(originalEvidence?.session_dir ?? ''),
    'metadata',
    'power-cut.acceptance.json',
  );
  try {
    if (!isCanonicalWithin(reportsRoot, sessionEvidencePath)) {
      throw new Error('session phase-1 证据越出 reports 归档根');
    }
    sessionEvidence = readJsonRegularFile(sessionEvidencePath, '会话内 phase-1 证据');
  } catch (error) {
    sessionEvidenceError = error.message;
  }
  add(
    'phase1-session-evidence-equal',
    sessionEvidenceError === null &&
      isDeepStrictEqual(sessionEvidence, originalEvidence) &&
      isDeepStrictEqual(phase2Report?.phase1?.session_evidence, originalEvidence) &&
      !phase2Report?.phase1?.session_evidence_error,
    {
      path: sessionEvidencePath,
      error: sessionEvidenceError ?? phase2Report?.phase1?.session_evidence_error ?? null,
    },
  );

  let telemetryRows = [];
  let telemetryError = null;
  try {
    telemetryRows = readNdjsonRegularFile(
      path.join(reportDirectory, 'telemetry.jsonl'),
      'phase-1 telemetry',
      512 * 1024 * 1024,
      true,
    );
  } catch (error) {
    telemetryError = error.message;
  }
  const matchingArmedRows = telemetryRows.filter((row) =>
    row?.phase === 'power-cut-armed' &&
    row?.at === originalEvidence?.armed_at &&
    Number(row?.captured_samples) === armedCapturedSamples &&
    Number(row?.committed_samples) === armedCommittedSamples &&
    Number.isSafeInteger(row?.overflow_samples) && row.overflow_samples === 0 &&
    row.overflow_samples === originalEvidence?.overflow_samples &&
    Number.isSafeInteger(row?.input_discontinuity_count) && row.input_discontinuity_count === 0 &&
    row.input_discontinuity_count === originalEvidence?.input_discontinuity_count &&
    Number.isSafeInteger(row?.input_discontinuity_silence_samples) &&
    row.input_discontinuity_silence_samples === 0 &&
    row.input_discontinuity_silence_samples === originalEvidence?.input_discontinuity_silence_samples &&
    Number(row?.segment_total_bytes) === Number(originalEvidence?.segment_total_bytes) &&
    Number(row?.segment_count) === Number(originalEvidence?.segment_count));
  add(
    'phase1-armed-telemetry-bound',
    telemetryError === null && matchingArmedRows.length === 1,
    { error: telemetryError, matching_rows: matchingArmedRows.length },
  );

  let protocolRows = [];
  let protocolError = null;
  try {
    protocolRows = readNdjsonRegularFile(
      path.join(reportDirectory, 'protocol.jsonl'),
      'phase-1 protocol',
      512 * 1024 * 1024,
      true,
    );
  } catch (error) {
    protocolError = error.message;
  }
  const readyRows = protocolRows.filter((row) =>
    row?.direction === 'engine' && row?.message?.event === 'engine_ready' &&
    isDeepStrictEqual(row.message.payload ?? row.message, phase1Report.engine?.ready));
  const startRequests = protocolRows.filter((row) =>
    row?.direction === 'tool' && row?.message?.command === 'start_session');
  const matchingStartRequests = startRequests.filter((row) => {
    const payload = row.message?.payload;
    return payload?.session_dir === originalEvidence?.session_dir &&
      payload?.session_id === originalEvidence?.session_id &&
      payload?.device_id === plan.target.device_id &&
      Number(payload?.sample_rate) === Number(requirement.sample_rate) &&
      Number(payload?.bit_depth) === Number(requirement.bit_depth) &&
      Number(payload?.input_channel) === Number(requirement.channel) &&
      payload?.capture_buffer_frames === plan.target.capture_buffer_frames;
  });
  const matchingStartResponses = matchingStartRequests.filter((requestRow) =>
    protocolRows.some((row) =>
      row?.direction === 'engine' &&
      row?.message?.request_id === requestRow.message.request_id &&
      row?.message?.ok === true &&
      row?.message?.result?.snapshot?.session_id === originalEvidence?.session_id &&
      row?.message?.result?.snapshot?.device_id === plan.target.device_id &&
      row?.message?.result?.snapshot?.capture_backend === plan.target.capture_backend &&
      row?.message?.result?.snapshot?.requested_capture_buffer_frames === plan.target.capture_buffer_frames &&
      row?.message?.result?.snapshot?.capture_buffer_frames === plan.target.capture_buffer_frames &&
      row?.message?.result?.snapshot?.overflow_samples === 0 &&
      row?.message?.result?.snapshot?.input_discontinuity_count === 0 &&
      row?.message?.result?.snapshot?.input_discontinuity_silence_samples === 0 &&
      isDeepStrictEqual(
        audioFormatIdentity(row?.message?.result?.snapshot?.audio_format),
        audioFormatIdentity(originalEvidence?.audio_format),
      )));
  add(
    'phase1-protocol-lifecycle-bound',
    protocolError === null && readyRows.length >= 1 &&
      startRequests.length === 1 && matchingStartRequests.length === 1 && matchingStartResponses.length === 1,
    {
      error: protocolError,
      engine_ready_rows: readyRows.length,
      start_requests: startRequests.length,
      matching_start_requests: matchingStartRequests.length,
      matching_start_responses: matchingStartResponses.length,
    },
  );

  const expectedToolHash = normalizeHash(plan.release.acceptance_tool_sha256);
  const expectedEngineHash = normalizeHash(plan.release.engine_sha256);
  add(
    'phase1-binary-identity',
    normalizeHash(phase1Report.acceptance_tool_sha256) === expectedToolHash &&
      normalizeHash(phase1Report.engine?.binary_sha256) === expectedEngineHash &&
      normalizeHash(originalEvidence?.binary_identity?.acceptance_tool_sha256) === expectedToolHash &&
      normalizeHash(originalEvidence?.binary_identity?.engine_sha256) === expectedEngineHash &&
      normalizeHash(embeddedEvidence?.binary_identity?.acceptance_tool_sha256) === expectedToolHash &&
      normalizeHash(embeddedEvidence?.binary_identity?.engine_sha256) === expectedEngineHash &&
      isDeepStrictEqual(phase1Report.engine?.ready, originalEvidence?.binary_identity?.engine_ready),
    {
      expected_tool: expectedToolHash,
      expected_engine: expectedEngineHash,
      report_tool: phase1Report.acceptance_tool_sha256,
      report_engine: phase1Report.engine?.binary_sha256,
      evidence_binary_identity: originalEvidence?.binary_identity,
    },
  );

  const expectedReportHost = {
    hostname: plan.target.hostname,
    platform: plan.target.platform,
    architecture: plan.target.architecture,
    release: plan.target.windows_release,
  };
  const reportHost = {
    hostname: phase1Report.host?.hostname,
    platform: phase1Report.host?.platform,
    architecture: phase1Report.host?.architecture,
    release: phase1Report.host?.release,
  };
  const expectedEvidenceHost = {
    hostname: plan.target.hostname,
    platform: plan.target.platform,
    architecture: plan.target.architecture,
  };
  const evidenceHost = {
    hostname: originalEvidence?.host?.hostname,
    platform: originalEvidence?.host?.platform,
    architecture: originalEvidence?.host?.architecture,
  };
  const reportBoot = {
    id: phase1Report.host?.boot?.id,
    booted_at: phase1Report.host?.boot?.booted_at,
  };
  const evidenceBoot = {
    id: originalEvidence?.host?.boot_id,
    booted_at: originalEvidence?.host?.booted_at,
  };
  add(
    'phase1-host-identity',
    isDeepStrictEqual(reportHost, expectedReportHost) &&
      isDeepStrictEqual(evidenceHost, expectedEvidenceHost) &&
      typeof reportBoot.id === 'string' && reportBoot.id.length > 0 &&
      typeof reportBoot.booted_at === 'string' && reportBoot.booted_at.length > 0 &&
      isDeepStrictEqual(reportBoot, evidenceBoot),
    {
      expected_report: expectedReportHost,
      expected_evidence: expectedEvidenceHost,
      report: reportHost,
      evidence: evidenceHost,
      report_boot: reportBoot,
      evidence_boot: evidenceBoot,
    },
  );

  const snapshot = phase1Report.start?.snapshot;
  const selectedBackend = typeof phase1Report.selected_device?.backend === 'string'
    ? phase1Report.selected_device.backend.trim().toLowerCase()
    : '';
  const requestedBackend = typeof phase1Report.requested?.capture_backend === 'string'
    ? phase1Report.requested.capture_backend.trim().toLowerCase()
    : '';
  const actualBackend = typeof snapshot?.capture_backend === 'string'
    ? snapshot.capture_backend.trim().toLowerCase()
    : '';
  const expectedBackend = String(plan.target?.capture_backend ?? '').trim().toLowerCase();
  add(
    'phase1-production-noise-check',
    phase1Report.options?.skipNoiseCheck !== true &&
      Number(phase1Report.options?.noiseThresholdDbfs) === Number(plan.target?.noise_threshold_dbfs) &&
      Number(phase1Report.options?.noiseThresholdDbfs) <= PRODUCTION_MAX_NOISE_THRESHOLD_DBFS &&
      !phase1Report.noise_check_error &&
      phase1Report.noise_check?.passed === true &&
      Number(phase1Report.noise_check?.threshold_dbfs) === Number(plan.target?.noise_threshold_dbfs) &&
      isDeepStrictEqual(originalEvidence?.noise_check, phase1Report.noise_check),
    {
      skip_noise_check: phase1Report.options?.skipNoiseCheck,
      plan_threshold_dbfs: plan.target?.noise_threshold_dbfs,
      report_threshold_dbfs: phase1Report.options?.noiseThresholdDbfs,
      error: phase1Report.noise_check_error,
      report: phase1Report.noise_check,
      evidence: originalEvidence?.noise_check,
    },
  );
  add(
    'phase1-capture-backend-evidence',
    expectedBackend.length > 0 &&
      phase1Report.options?.expectedCaptureBackend === expectedBackend &&
      selectedBackend === expectedBackend && requestedBackend === expectedBackend && actualBackend === expectedBackend &&
      originalEvidence?.capture_backend === snapshot?.capture_backend,
    {
      plan_expected: plan.target?.capture_backend,
      cli_expected: phase1Report.options?.expectedCaptureBackend,
      selected: phase1Report.selected_device?.backend,
      requested: phase1Report.requested?.capture_backend,
      snapshot: snapshot?.capture_backend,
      evidence: originalEvidence?.capture_backend,
    },
  );
  const claimsAsio = expectedBackend === 'asio' || selectedBackend === 'asio' || requestedBackend === 'asio' || actualBackend === 'asio' ||
    String(snapshot?.device_id ?? '').toLowerCase().startsWith('asio:');
  if (claimsAsio) {
    const selectedBuffer = Number(phase1Report.selected_device?.recommended_buffer_frames);
    const requestedBuffer = Number(phase1Report.requested?.capture_buffer_frames);
    const expectedBuffer = Number(plan.target?.capture_buffer_frames);
    add(
      'phase1-asio-buffer-evidence',
      Number.isSafeInteger(expectedBuffer) && expectedBuffer > 0 &&
        phase1Report.options?.expectedCaptureBufferFrames === expectedBuffer &&
        Number.isSafeInteger(selectedBuffer) && selectedBuffer > 0 &&
        Number.isSafeInteger(requestedBuffer) && requestedBuffer > 0 &&
        selectedBuffer === expectedBuffer && requestedBuffer === expectedBuffer &&
        snapshot?.requested_capture_buffer_frames === expectedBuffer &&
        snapshot?.capture_buffer_frames === expectedBuffer &&
        originalEvidence?.requested_capture_buffer_frames === expectedBuffer &&
        originalEvidence?.capture_buffer_frames === expectedBuffer,
      {
        plan_expected: plan.target?.capture_buffer_frames,
        cli_expected: phase1Report.options?.expectedCaptureBufferFrames,
        selected: phase1Report.selected_device?.recommended_buffer_frames,
        requested: phase1Report.requested?.capture_buffer_frames,
        snapshot_requested: snapshot?.requested_capture_buffer_frames,
        snapshot_actual: snapshot?.capture_buffer_frames,
        evidence_requested: originalEvidence?.requested_capture_buffer_frames,
        evidence_actual: originalEvidence?.capture_buffer_frames,
      },
    );
  }
  add(
    'phase1-no-input-discontinuity-at-arm',
    Number.isSafeInteger(originalEvidence?.overflow_samples) &&
      originalEvidence.overflow_samples === 0 &&
      Number.isSafeInteger(snapshot?.overflow_samples) && snapshot.overflow_samples === 0 &&
      Number.isSafeInteger(originalEvidence?.input_discontinuity_count) &&
      originalEvidence.input_discontinuity_count === 0 &&
      Number.isSafeInteger(originalEvidence?.input_discontinuity_silence_samples) &&
      originalEvidence.input_discontinuity_silence_samples === 0 &&
      Number.isSafeInteger(snapshot?.input_discontinuity_count) && snapshot.input_discontinuity_count === 0 &&
      Number.isSafeInteger(snapshot?.input_discontinuity_silence_samples) &&
        snapshot.input_discontinuity_silence_samples === 0,
    {
      overflow_samples: originalEvidence?.overflow_samples,
      count: originalEvidence?.input_discontinuity_count,
      inserted_silence_samples: originalEvidence?.input_discontinuity_silence_samples,
      start_snapshot: {
        overflow_samples: snapshot?.overflow_samples,
        count: snapshot?.input_discontinuity_count,
        inserted_silence_samples: snapshot?.input_discontinuity_silence_samples,
      },
    },
  );
  const expectedFormat = {
    sample_rate: Number(requirement.sample_rate),
    bit_depth: Number(requirement.bit_depth),
    input_channel: Number(requirement.channel),
  };
  const reportFormat = audioFormatIdentity(snapshot?.audio_format);
  const evidenceFormat = audioFormatIdentity(originalEvidence?.audio_format);
  const requestedFormat = {
    sample_rate: Number(phase1Report.requested?.sample_rate),
    bit_depth: Number(phase1Report.requested?.wav_bit_depth),
    input_channel: Number(phase1Report.requested?.input_channel),
  };
  add(
    'phase1-device-format-identity',
    phase1Report.selected_device?.id === plan.target.device_id &&
      phase1Report.selected_device?.name === plan.target.device_name &&
      snapshot?.device_id === plan.target.device_id &&
      snapshot?.device_name === plan.target.device_name &&
      originalEvidence?.device_id === plan.target.device_id &&
      originalEvidence?.device_name === plan.target.device_name &&
      typeof snapshot?.input_sample_format === 'string' &&
      snapshot.input_sample_format.length > 0 &&
      snapshot.input_sample_format === originalEvidence?.input_sample_format &&
      reportFormat !== null && isDeepStrictEqual(reportFormat, evidenceFormat) &&
      requestedFormat.sample_rate === expectedFormat.sample_rate &&
      requestedFormat.bit_depth === expectedFormat.bit_depth &&
      requestedFormat.input_channel === expectedFormat.input_channel &&
      reportFormat.sample_rate === expectedFormat.sample_rate &&
      reportFormat.bit_depth === expectedFormat.bit_depth &&
      reportFormat.input_channel === expectedFormat.input_channel,
    {
      expected_device: { id: plan.target.device_id, name: plan.target.device_name },
      selected_device: phase1Report.selected_device,
      snapshot_device: { id: snapshot?.device_id, name: snapshot?.device_name },
      evidence_device: { id: originalEvidence?.device_id, name: originalEvidence?.device_name },
      expected_format: expectedFormat,
      requested_format: requestedFormat,
      report_format: reportFormat,
      evidence_format: evidenceFormat,
      report_input_sample_format: snapshot?.input_sample_format,
      evidence_input_sample_format: originalEvidence?.input_sample_format,
    },
  );

  const preRecoverySnapshot = phase2Report?.pre_recovery_inspection?.snapshot;
  const sealedSnapshot = phase2Report?.recovery?.result?.snapshot;
  const inspectedSealedSnapshot = phase2Report?.inspection?.snapshot;
  const recoverySnapshots = [
    { phase: 'phase1-start', snapshot },
    { phase: 'phase2-pre-recovery', snapshot: preRecoverySnapshot },
    { phase: 'phase2-seal-result', snapshot: sealedSnapshot },
    { phase: 'phase2-final-inspection', snapshot: inspectedSealedSnapshot },
  ];
  add(
    'phase1-recovery-input-health-binding',
    recoverySnapshots.every(({ snapshot: candidate }) =>
      Boolean(candidate) &&
      Number.isSafeInteger(candidate.overflow_samples) && candidate.overflow_samples === 0 &&
      Number.isSafeInteger(candidate.input_discontinuity_count) && candidate.input_discontinuity_count === 0 &&
      Number.isSafeInteger(candidate.input_discontinuity_silence_samples) &&
        candidate.input_discontinuity_silence_samples === 0 &&
      candidate.capture_backend === originalEvidence?.capture_backend &&
      candidate.requested_capture_buffer_frames === originalEvidence?.requested_capture_buffer_frames &&
      candidate.capture_buffer_frames === originalEvidence?.capture_buffer_frames) &&
      isDeepStrictEqual(preRecoverySnapshot?.noise_check, originalEvidence?.noise_check) &&
      isDeepStrictEqual(sealedSnapshot?.noise_check, originalEvidence?.noise_check) &&
      isDeepStrictEqual(inspectedSealedSnapshot?.noise_check, originalEvidence?.noise_check),
    {
      evidence: {
        overflow_samples: originalEvidence?.overflow_samples,
        input_discontinuity_count: originalEvidence?.input_discontinuity_count,
        input_discontinuity_silence_samples: originalEvidence?.input_discontinuity_silence_samples,
        capture_backend: originalEvidence?.capture_backend,
        requested_capture_buffer_frames: originalEvidence?.requested_capture_buffer_frames,
        capture_buffer_frames: originalEvidence?.capture_buffer_frames,
        noise_check: originalEvidence?.noise_check,
      },
      snapshots: recoverySnapshots,
    },
  );

  add(
    'phase1-session-identity',
    typeof originalEvidence?.session_id === 'string' && originalEvidence.session_id.length > 0 &&
      phase1Report.start?.snapshot?.session_id === originalEvidence.session_id &&
      phase1Report.session_dir === originalEvidence.session_dir &&
      phase2Report?.session_dir === originalEvidence.session_dir,
    {
      report_session_id: phase1Report.start?.snapshot?.session_id,
      evidence_session_id: originalEvidence?.session_id,
      report_session_dir: phase1Report.session_dir,
      phase2_session_dir: phase2Report?.session_dir,
      evidence_session_dir: originalEvidence?.session_dir,
    },
  );

  return { checks, evidenceRoots, reportPath: entry.path };
}

const COMMON_CAPTURE_CHECK_IDS = Object.freeze([
  'engine-ready',
  'engine-clean-exit',
  'device-id-match',
  'sample-rate-match',
  'wav-bit-depth-match',
  'input-channel-match',
  'capture-share-mode-match',
  'capture-backend-match',
  'input-format-recorded',
  'input-format-minimum',
  'captured-monotonic',
  'committed-monotonic',
  'file-growth-monotonic',
  'commit-lag',
  'segment-wav-readable',
  'segment-format-match',
  'physical-frame-watermark',
]);

const NORMAL_CAPTURE_CHECK_IDS = Object.freeze([
  'safe-stop',
  'stopped-status',
  'exact-sample-watermark',
  'no-overflow',
  'no-input-discontinuity',
  'ambient-noise-check',
  'input-audition-confirmed',
  'accepted-attempt-lifecycle',
  'no-capture-fault',
  'no-fault-marker',
  'exact-segment-headers',
  'continuous-file-growth',
  'capture-clock-rate',
  'signal-observed',
  'no-clipping',
  'storage-health',
]);

const FAULT_CAPTURE_CHECK_IDS = Object.freeze([
  'ambient-noise-check',
  'input-audition-confirmed',
  'fault-attempt-blocked',
  'healthy-prefix',
  'fault-detected',
  'fault-marker',
  'faulted-status',
  'normal-export-blocked',
  'captured-prefix-preserved',
  'timeline-stopped-after-fault',
]);

const SEALED_SESSION_CHECK_IDS = Object.freeze([
  'real-recording-tree',
  'metadata-readable',
  'snapshot-present',
  'segments-present',
  'no-segment-errors',
  'segment-layout-valid',
  'segment-descriptors-valid',
  'segment-descriptor-redundancy',
  'exact-segment-headers',
  'no-trailing-frame-bytes',
  'segment-format-consistent',
  'stopped-status',
  'no-overflow',
  'no-fault-marker',
  'exact-sample-watermark',
  'session-summary-consistent',
  'full-track-readable-if-present',
]);

function requiredAcceptanceCheckIds(requirement, plan = null) {
  const mode = requirement?.mode;
  const commonCaptureIds = String(plan?.target?.capture_backend ?? '').trim().toLowerCase() === 'asio'
    ? [...COMMON_CAPTURE_CHECK_IDS, 'capture-buffer-match']
    : [...COMMON_CAPTURE_CHECK_IDS];
  if (mode === 'inventory') {
    return ['devices-present', 'stable-device-ids', 'unique-device-ids', 'driver-configurations', 'engine-clean-exit'];
  }
  if (SEALED_NORMAL_CAPTURE_MODES.has(mode)) {
    const ids = [...commonCaptureIds, ...NORMAL_CAPTURE_CHECK_IDS, 'engine-no-panic'];
    if (requirement?.export === true) {
      ids.push('full-track-export', 'delivery-manifest-coherent', 'accepted-attempt-exported');
    }
    return ids;
  }
  if (FAULT_CAPTURE_MODES.has(mode)) {
    const ids = [...commonCaptureIds, ...FAULT_CAPTURE_CHECK_IDS, 'engine-no-panic'];
    if (mode === 'unplug') ids.push('fault-after-trigger', 'unplug-detection-latency', 'unplug-fault-kind');
    if (mode === 'disk-full' || mode === 'abrupt-enospc') ids.push('disk-critical-latency');
    return ids;
  }
  if (mode === 'replug') {
    const before = [...commonCaptureIds, ...FAULT_CAPTURE_CHECK_IDS]
      .map((id) => `replug-a-${id}`);
    const after = [...commonCaptureIds, ...NORMAL_CAPTURE_CHECK_IDS]
      .map((id) => `replug-b-${id}`);
    return [
      ...before,
      ...after,
      'replug-a-healthy-prefix-clock',
      'replug-a-healthy-prefix-signal',
      'replug-old-export-blocked',
      'replug-old-resume-blocked',
      'replug-target-disappeared',
      'replug-same-endpoint-stable',
      'replug-first-device-exact',
      'replug-distinct-session',
      'replug-second-device-exact',
      'replug-b-duration',
      'engine-no-panic',
    ];
  }
  if (mode === 'inspect') return SEALED_SESSION_CHECK_IDS;
  if (mode === 'recover') {
    return [
      'phase1-evidence-schema',
      'phase1-source-bound',
      'session-evidence-bound',
      'recording-tree-safe-before-seal',
      'interrupted-preseal-status',
      'phase1-session-identity',
      'phase1-input-health-at-arm',
      'phase1-production-noise-check',
      'power-cut-qualification-class',
      'phase1-minimum-duration',
      'phase1-tail-budget',
      'host-rebooted-after-arm',
      'phase1-binaries-match',
      'engine-ready',
      'offline-seal-complete',
      ...SEALED_SESSION_CHECK_IDS,
      'seal-watermark-consistent',
      'armed-committed-preserved',
      'power-cut-tail-loss-budget',
      'engine-clean-exit',
    ];
  }
  return [];
}

function inputAuditionEvidencePassed(evidence, sampleRate, persistedAudition) {
  const expectedSamples = Number(sampleRate) * INPUT_AUDITION_SECONDS;
  const begin = evidence?.begin;
  const started = begin?.input_audition;
  const finished = evidence?.finish?.input_audition;
  const confirmed = evidence?.confirm?.input_audition;
  const checkId = begin?.check_id;
  const startSample = started?.start_sample;
  return !evidence?.error &&
    Number.isSafeInteger(expectedSamples) && expectedSamples > 0 &&
    typeof checkId === 'string' && checkId.length > 0 &&
    Number.isSafeInteger(startSample) && startSample >= 0 &&
    begin?.required_samples === expectedSamples &&
    started?.check_id === checkId &&
    started?.status === 'recording' &&
    started?.required_samples === expectedSamples &&
    started?.captured_samples === 0 &&
    Array.isArray(started?.warning_codes) && started.warning_codes.length === 0 &&
    finished?.check_id === checkId &&
    finished?.status === 'ready' &&
    finished?.start_sample === startSample &&
    finished?.required_samples === expectedSamples &&
    finished?.captured_samples === expectedSamples &&
    finished?.end_sample === startSample + expectedSamples &&
    Array.isArray(finished?.warning_codes) && finished.warning_codes.length === 0 &&
    finished?.metrics?.duration_samples === expectedSamples &&
    Number(finished?.metrics?.duration_seconds) === INPUT_AUDITION_SECONDS &&
    finished?.metrics?.input_discontinuity_count === 0 &&
    finished?.metrics?.input_discontinuity_silence_samples === 0 &&
    finished?.metrics?.overflow_samples === 0 &&
    Array.isArray(finished?.metrics?.warning_codes) && finished.metrics.warning_codes.length === 0 &&
    confirmed?.check_id === checkId &&
    confirmed?.status === 'confirmed' &&
    confirmed?.start_sample === startSample &&
    confirmed?.required_samples === expectedSamples &&
    confirmed?.captured_samples === expectedSamples &&
    confirmed?.end_sample === startSample + expectedSamples &&
    Array.isArray(confirmed?.warning_codes) && confirmed.warning_codes.length === 0 &&
    isDeepStrictEqual(confirmed?.metrics, finished?.metrics) &&
    isDeepStrictEqual(confirmed, persistedAudition);
}

function auditionPrecedesAttempt(evidence, lifecycle, snapshot) {
  const auditionEnd = evidence?.confirm?.input_audition?.end_sample;
  const attemptStart = lifecycle?.start?.start_sample;
  return Number.isSafeInteger(auditionEnd) &&
    Number.isSafeInteger(attemptStart) &&
    Number.isSafeInteger(snapshot?.committed_samples) &&
    auditionEnd <= attemptStart && attemptStart < snapshot.committed_samples;
}

function segmentEvidenceProjection(segments) {
  if (!Array.isArray(segments)) return null;
  return segments.map((segment) => ({
    file_name: segment?.file_name,
    container: segment?.container,
    sample_rate: Number(segment?.sample_rate),
    bits_per_sample: Number(segment?.bits_per_sample),
    channels: Number(segment?.channels),
    encoding: segment?.encoding,
    physical_complete_frames: Number(segment?.physical_complete_frames),
    declared_frames: Number(segment?.declared_frames),
    trailing_bytes: Number(segment?.trailing_bytes),
    exact_header: segment?.exact_header,
  }));
}

function inputSampleFormatBits(format) {
  const normalized = String(format ?? '').trim().toLowerCase();
  if (/^[iu](8|16|24|32|64)$/.test(normalized)) return Number(normalized.slice(1));
  if (normalized === 'f32') return 24;
  if (normalized === 'f64') return 53;
  return null;
}

function actualSnapshotMatchesRequirement(snapshot, requirement, plan) {
  const bitDepth = Number(requirement?.bit_depth);
  const minimumInputBits = bitDepth === 16 ? 16 : 24;
  const expectedBackend = String(plan?.target?.capture_backend ?? '').trim().toLowerCase();
  const expectedBuffer = plan?.target?.capture_buffer_frames;
  return Boolean(snapshot) &&
    snapshot.device_id === plan?.target?.device_id &&
    snapshot.device_name === plan?.target?.device_name &&
    inputSampleFormatBits(snapshot.input_sample_format) >= minimumInputBits &&
    String(snapshot.capture_backend ?? '').trim().toLowerCase() === expectedBackend &&
    (
      expectedBackend === 'asio'
        ? Number.isSafeInteger(expectedBuffer) &&
          snapshot.requested_capture_buffer_frames === expectedBuffer &&
          snapshot.capture_buffer_frames === expectedBuffer
        : expectedBackend === 'wasapi' &&
          snapshot.requested_capture_buffer_frames == null &&
          snapshot.capture_buffer_frames == null
    ) &&
    Number(snapshot.audio_format?.sample_rate) === Number(requirement?.sample_rate) &&
    Number(snapshot.audio_format?.bit_depth) === bitDepth &&
    snapshot.audio_format?.encoding === (bitDepth === 32 ? 'float' : 'pcm') &&
    Number(snapshot.audio_format?.channels) === 1 &&
    Number(snapshot.audio_format?.input_channels) >= Number(requirement?.channel) &&
    Number(snapshot.audio_format?.input_channel) === Number(requirement?.channel);
}

function actualAttemptMatchesNormal(snapshot, lifecycle) {
  const itemId = lifecycle?.item_id;
  const attemptId = lifecycle?.start?.attempt_id;
  const item = Array.isArray(snapshot?.items)
    ? snapshot.items.find((candidate) => candidate?.id === itemId)
    : null;
  const attempt = Array.isArray(item?.attempts)
    ? item.attempts.find((candidate) => candidate?.attempt_id === attemptId)
    : null;
  return typeof itemId === 'string' && itemId.length > 0 &&
    typeof attemptId === 'string' && attemptId.length > 0 &&
    lifecycle?.stop?.attempt?.attempt_id === attemptId &&
    lifecycle?.stop?.attempt?.status === 'recorded' &&
    lifecycle?.stop?.observed_discontinuity === false &&
    lifecycle?.accept?.item_id === itemId &&
    lifecycle?.accept?.attempt_id === attemptId &&
    item?.status === 'accepted' &&
    item?.selected_attempt_id === attemptId &&
    attempt?.status === 'accepted';
}

function actualAttemptMatchesFault(snapshot, lifecycle) {
  const itemId = lifecycle?.item_id;
  const attemptId = lifecycle?.start?.attempt_id;
  const item = Array.isArray(snapshot?.items)
    ? snapshot.items.find((candidate) => candidate?.id === itemId)
    : null;
  const attempt = Array.isArray(item?.attempts)
    ? item.attempts.find((candidate) => candidate?.attempt_id === attemptId)
    : null;
  const stopped = lifecycle?.stop?.attempt;
  return typeof itemId === 'string' && itemId.length > 0 &&
    typeof attemptId === 'string' && attemptId.length > 0 &&
    stopped?.attempt_id === attemptId &&
    ['interrupted', 'needs_rerecord'].includes(stopped?.status) &&
    attempt?.attempt_id === attemptId &&
    attempt?.status === stopped.status &&
    typeof lifecycle?.accept_error === 'string' && lifecycle.accept_error.length > 0 &&
    lifecycle?.accept == null &&
    item?.selected_attempt_id == null &&
    !item?.attempts?.some((candidate) => candidate?.status === 'accepted');
}

function independentExportPassed(inspection, snapshot, lifecycle) {
  const metadata = inspection?.export_metadata;
  const status = inspection?.export_status;
  const exported = Array.isArray(metadata?.exported) ? metadata.exported : null;
  const skipped = Array.isArray(metadata?.skipped) ? metadata.skipped : null;
  const itemId = lifecycle?.item_id;
  const attemptId = lifecycle?.start?.attempt_id;
  const expectedSelections = Array.isArray(snapshot?.items)
    ? snapshot.items.map((item) => ({ id: item.id, attempt_id: item.selected_attempt_id }))
    : null;
  return inspection?.export_bundle_present === true &&
    Array.isArray(inspection?.export_bundle_errors) && inspection.export_bundle_errors.length === 0 &&
    inspection?.full_track?.exact_header === true &&
    Number(inspection.full_track.physical_complete_frames) === Number(snapshot?.committed_samples) &&
    Number(inspection.full_track.sample_rate) === Number(snapshot?.audio_format?.sample_rate) &&
    Number(inspection.full_track.bits_per_sample) === Number(snapshot?.audio_format?.bit_depth) &&
    Number(inspection.full_track.channels) === 1 &&
    status?.schema_version === 2 && status?.status === 'complete' &&
    status?.session_id === snapshot?.session_id &&
    metadata?.schema_version === 1 && metadata?.session_id === snapshot?.session_id &&
    metadata?.full_track === 'full-track.wav' &&
    isDeepStrictEqual(metadata?.audio_format, snapshot?.audio_format) &&
    isDeepStrictEqual(status?.source, metadata?.source) &&
    Number(metadata?.source?.journal_seq) === Number(snapshot?.journal_seq) &&
    Number(metadata?.source?.committed_samples) === Number(snapshot?.committed_samples) &&
    expectedSelections !== null &&
    isDeepStrictEqual(metadata?.source?.selected_attempts, expectedSelections) &&
    exported !== null && skipped !== null &&
    exported.length + skipped.length === expectedSelections.length &&
    Number(status?.exported_count) === exported.length &&
    Number(status?.skipped_count) === skipped.length &&
    inspection?.export_csv?.matches_metadata === true &&
    exported.some((row) => row?.id === itemId && row?.attempt_id === attemptId) &&
    !skipped.some((row) => row?.id === itemId) &&
    isDeepStrictEqual(
      inspection?.export_sentence_file_names,
      exported.map((row) => path.posix.basename(String(row?.file ?? ''))).sort(),
    ) &&
    inspection?.export_sentence_wavs?.length === exported.length &&
    inspection.export_sentence_wavs.every((wav, index) =>
      wav?.exact_header === true &&
      Number(wav?.sample_rate) === Number(snapshot?.audio_format?.sample_rate) &&
      Number(wav?.bits_per_sample) === Number(snapshot?.audio_format?.bit_depth) &&
      Number(wav?.channels) === 1 &&
      Number(wav?.physical_complete_frames) === Number(exported[index]?.duration_samples));
}

function validateIndependentCaptureArchive(evidence, requirement, plan, reportsRoot) {
  const checks = [];
  const add = (id, passed, details) => checks.push({ id, status: passed ? 'PASS' : 'FAIL', details });
  const sessionDirectory = path.resolve(String(evidence?.session_dir ?? evidence?.inspection?.session_dir ?? ''));
  let directorySafe = false;
  try {
    const metadata = fs.lstatSync(sessionDirectory);
    directorySafe = sessionDirectory !== path.resolve('.') &&
      isCanonicalWithin(reportsRoot, sessionDirectory) &&
      metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {}
  add('independent-session-directory', directorySafe, sessionDirectory);
  let inspection = null;
  let inspectionError = null;
  if (directorySafe) {
    try {
      inspection = inspectSession(sessionDirectory);
    } catch (error) {
      inspectionError = error.message;
    }
  }
  add('independent-session-inspected', inspectionError === null && inspection !== null, {
    session_dir: sessionDirectory,
    error: inspectionError,
  });
  if (!inspection) return { checks, inspection, sessionDirectory };

  const snapshot = inspection.snapshot;
  const reportedFinal = evidence?.stop?.result?.snapshot ?? evidence?.inspection?.snapshot;
  const reportInspection = evidence?.inspection;
  const basePassed = inspection.exists === true &&
    Array.isArray(inspection.tree_errors) && inspection.tree_errors.length === 0 &&
    Array.isArray(inspection.metadata_errors) && inspection.metadata_errors.length === 0 &&
    Array.isArray(inspection.segment_errors) && inspection.segment_errors.length === 0 &&
    Array.isArray(inspection.segment_layout_errors) && inspection.segment_layout_errors.length === 0 &&
    Array.isArray(inspection.descriptor_errors) && inspection.descriptor_errors.length === 0 &&
    Array.isArray(inspection.descriptor_issues) && inspection.descriptor_issues.length === 0 &&
    actualSnapshotMatchesRequirement(snapshot, requirement, plan) &&
    sessionSummaryMatchesSnapshot(inspection) &&
    Array.isArray(inspection.segments) && inspection.segments.length > 0 &&
    inspection.segments.every((segment) =>
      segment?.exact_header === true &&
      Number(segment?.trailing_bytes) === 0 &&
      Number(segment?.sample_rate) === Number(requirement.sample_rate) &&
      Number(segment?.bits_per_sample) === Number(requirement.bit_depth) &&
      Number(segment?.channels) === 1);
  add('independent-recording-tree', basePassed, {
    tree_errors: inspection.tree_errors,
    metadata_errors: inspection.metadata_errors,
    segment_errors: inspection.segment_errors,
    segment_layout_errors: inspection.segment_layout_errors,
    descriptor_errors: inspection.descriptor_errors,
    descriptor_issues: inspection.descriptor_issues,
    snapshot,
    segments: segmentEvidenceProjection(inspection.segments),
  });
  add(
    'independent-report-disk-binding',
    snapshotWatermarksMatch(snapshot, reportedFinal) &&
      snapshotWatermarksMatch(snapshot, reportInspection?.snapshot) &&
      Number(reportInspection?.total_physical_frames) === Number(inspection.total_physical_frames) &&
      isDeepStrictEqual(
        segmentEvidenceProjection(reportInspection?.segments),
        segmentEvidenceProjection(inspection.segments),
      ) &&
      isDeepStrictEqual(reportInspection?.export_status ?? null, inspection.export_status ?? null) &&
      isDeepStrictEqual(reportInspection?.export_metadata ?? null, inspection.export_metadata ?? null),
    {
      actual_snapshot: snapshot,
      reported_final: reportedFinal,
      reported_inspection_snapshot: reportInspection?.snapshot,
      actual_total_physical_frames: inspection.total_physical_frames,
      reported_total_physical_frames: reportInspection?.total_physical_frames,
    },
  );
  add(
    'independent-noise-binding',
    evidence?.noise_check?.passed === true &&
      Number(evidence.noise_check.threshold_dbfs) === Number(plan.target.noise_threshold_dbfs) &&
      isDeepStrictEqual(snapshot?.noise_check, evidence.noise_check),
    { expected: plan.target.noise_threshold_dbfs, report: evidence?.noise_check, disk: snapshot?.noise_check },
  );
  add(
    'independent-input-audition',
    inputAuditionEvidencePassed(
      evidence?.input_audition,
      requirement.sample_rate,
      snapshot?.input_audition,
    ) &&
      auditionPrecedesAttempt(evidence?.input_audition, evidence?.attempt, snapshot),
    evidence?.input_audition ?? null,
  );

  if (FAULT_CAPTURE_MODES.has(requirement.mode)) {
    add(
      'independent-fault-session',
      snapshot?.status === 'faulted' &&
        faultMarkerPresent(inspection) && inspection.fault_marker_parse_error !== true &&
        Number.isSafeInteger(snapshot?.overflow_samples) && snapshot.overflow_samples === 0 &&
        Number.isSafeInteger(snapshot?.input_discontinuity_count) && snapshot.input_discontinuity_count === 0 &&
        Number.isSafeInteger(snapshot?.input_discontinuity_silence_samples) &&
          snapshot.input_discontinuity_silence_samples === 0 &&
        Number.isSafeInteger(Number(inspection.total_physical_frames)) &&
        Number(inspection.total_physical_frames) > 0 &&
        Number(inspection.total_physical_frames) === Number(snapshot?.committed_samples) &&
        actualAttemptMatchesFault(snapshot, evidence?.attempt) &&
        evidence?.export?.expected_rejection === true &&
        inspection.export_bundle_present === false,
      {
        snapshot,
        fault_marker: inspection.fault_marker,
        attempt: evidence?.attempt,
        export: evidence?.export,
      },
    );
  } else {
    const sealedChecks = evaluateSealedSession(inspection);
    add(
      'independent-normal-session',
      sealedChecks.every((check) => check.status === 'PASS') &&
        Number.isSafeInteger(snapshot?.input_discontinuity_count) && snapshot.input_discontinuity_count === 0 &&
        Number.isSafeInteger(snapshot?.input_discontinuity_silence_samples) &&
          snapshot.input_discontinuity_silence_samples === 0 &&
        actualAttemptMatchesNormal(snapshot, evidence?.attempt),
      { failed_checks: sealedChecks.filter((check) => check.status !== 'PASS'), attempt: evidence?.attempt },
    );
    if (requirement.export === true) {
      add(
        'independent-export-bundle',
        independentExportPassed(inspection, snapshot, evidence?.attempt) &&
          (
            requirement.expected_full_track_container === undefined ||
            inspection.full_track?.container === requirement.expected_full_track_container
          ),
        {
          full_track: inspection.full_track,
          status: inspection.export_status,
          metadata: inspection.export_metadata,
          csv: inspection.export_csv,
          errors: inspection.export_bundle_errors,
        },
      );
    } else {
      add('independent-no-export-bundle', inspection.export_bundle_present === false, {
        export_bundle_present: inspection.export_bundle_present,
      });
    }
  }
  return { checks, inspection, sessionDirectory };
}

function validateIndependentSealedArchive(report, requirement, plan, reportsRoot) {
  const checks = [];
  const add = (id, passed, details) => checks.push({ id, status: passed ? 'PASS' : 'FAIL', details });
  const sessionDirectory = path.resolve(String(report?.session_dir ?? report?.inspection?.session_dir ?? ''));
  const reportedPaths = [report?.session_dir, report?.inspection?.session_dir];
  if (requirement.mode === 'recover') reportedPaths.push(report?.recovery?.result?.session_dir);
  let directorySafe = false;
  let canonicalDirectory = null;
  let canonicalReportedPaths = [];
  let directoryError = null;
  try {
    const metadata = fs.lstatSync(sessionDirectory);
    canonicalDirectory = canonicalPath(sessionDirectory);
    canonicalReportedPaths = reportedPaths.map((value) => canonicalPath(String(value ?? '')));
    directorySafe = sessionDirectory !== path.resolve('.') &&
      metadata.isDirectory() && !metadata.isSymbolicLink() &&
      isCanonicalWithin(reportsRoot, sessionDirectory) &&
      reportedPaths.every((value) => typeof value === 'string' && value.length > 0) &&
      canonicalReportedPaths.every((value) => value === canonicalDirectory);
  } catch (error) {
    directoryError = error.message;
  }
  add('independent-sealed-session-directory', directorySafe, {
    session_dir: sessionDirectory,
    reported_paths: reportedPaths,
    canonical_paths: canonicalReportedPaths,
    error: directoryError,
  });

  let inspection = null;
  let inspectionError = null;
  if (directorySafe) {
    try {
      inspection = inspectSession(sessionDirectory);
    } catch (error) {
      inspectionError = error.message;
    }
  }
  add('independent-sealed-session-inspected', inspectionError === null && inspection !== null, {
    session_dir: sessionDirectory,
    error: inspectionError,
  });
  if (!inspection) return { checks, inspection, sessionDirectory };

  const snapshot = inspection.snapshot;
  const effectiveRequirement = {
    ...requirement,
    sample_rate: requirement.sample_rate ?? plan.target?.primary_format?.sample_rate,
    bit_depth: requirement.bit_depth ?? plan.target?.primary_format?.bit_depth,
    channel: requirement.channel ?? plan.target?.primary_format?.channel,
  };
  const sealedChecks = evaluateSealedSession(inspection);
  const sealedFailures = sealedChecks.filter((check) => check.status !== 'PASS');
  const actualTreePassed = sealedFailures.length === 0 &&
    actualSnapshotMatchesRequirement(snapshot, effectiveRequirement, plan) &&
    Number.isSafeInteger(snapshot?.overflow_samples) && snapshot.overflow_samples === 0 &&
    Number.isSafeInteger(snapshot?.input_discontinuity_count) && snapshot.input_discontinuity_count === 0 &&
    Number.isSafeInteger(snapshot?.input_discontinuity_silence_samples) &&
      snapshot.input_discontinuity_silence_samples === 0;
  add('independent-sealed-recording-tree', actualTreePassed, {
    failed_checks: sealedFailures,
    snapshot,
    segments: segmentEvidenceProjection(inspection.segments),
  });

  const reportedInspection = report?.inspection;
  const reportedSnapshots = requirement.mode === 'recover'
    ? [report?.recovery?.result?.snapshot, reportedInspection?.snapshot]
    : [reportedInspection?.snapshot];
  const reportBindingPassed = reportedSnapshots.every((candidate) =>
    snapshotWatermarksMatch(snapshot, candidate)) &&
    Number(reportedInspection?.total_physical_frames) === Number(inspection.total_physical_frames) &&
    isDeepStrictEqual(
      segmentEvidenceProjection(reportedInspection?.segments),
      segmentEvidenceProjection(inspection.segments),
    ) &&
    isDeepStrictEqual(reportedInspection?.export_status ?? null, inspection.export_status ?? null) &&
    isDeepStrictEqual(reportedInspection?.export_metadata ?? null, inspection.export_metadata ?? null) &&
    (
      requirement.mode !== 'recover' ||
      Number(report?.recovery?.result?.durable_frames) === Number(inspection.total_physical_frames)
    );
  add('independent-sealed-report-disk-binding', reportBindingPassed, {
    actual_snapshot: snapshot,
    reported_snapshots: reportedSnapshots,
    actual_total_physical_frames: inspection.total_physical_frames,
    reported_total_physical_frames: reportedInspection?.total_physical_frames,
    recovery_durable_frames: report?.recovery?.result?.durable_frames,
  });
  add('independent-sealed-no-export-bundle', inspection.export_bundle_present === false, {
    export_bundle_present: inspection.export_bundle_present,
    export_bundle_errors: inspection.export_bundle_errors,
  });

  if (requirement.mode === 'recover') {
    const evidence = report?.phase1?.evidence;
    const preRecoverySnapshot = report?.pre_recovery_inspection?.snapshot;
    const physicalFrames = Number(inspection.total_physical_frames);
    const armedCommitted = Number(evidence?.armed_committed_samples);
    const armedCaptured = Number(evidence?.armed_captured_samples);
    const maximumTailLoss = Number(evidence?.max_tail_loss_samples);
    const tailLoss = Math.max(0, armedCaptured - physicalFrames);
    let evidenceDirectoryMatches = false;
    try {
      evidenceDirectoryMatches = canonicalPath(String(evidence?.session_dir ?? '')) === canonicalDirectory;
    } catch {}
    const recoveryBindingPassed = evidenceDirectoryMatches &&
      snapshot?.session_id === evidence?.session_id &&
      snapshot?.device_id === evidence?.device_id &&
      snapshot?.device_name === evidence?.device_name &&
      snapshot?.input_sample_format === evidence?.input_sample_format &&
      snapshot?.capture_share_mode === evidence?.capture_share_mode &&
      snapshot?.capture_backend === evidence?.capture_backend &&
      snapshot?.requested_capture_buffer_frames === evidence?.requested_capture_buffer_frames &&
      snapshot?.capture_buffer_frames === evidence?.capture_buffer_frames &&
      isDeepStrictEqual(audioFormatIdentity(snapshot?.audio_format), audioFormatIdentity(evidence?.audio_format)) &&
      Number.isSafeInteger(physicalFrames) &&
      Number.isSafeInteger(armedCommitted) && physicalFrames >= armedCommitted &&
      Number.isSafeInteger(armedCaptured) && armedCaptured >= armedCommitted &&
      Number.isSafeInteger(maximumTailLoss) && maximumTailLoss >= 0 &&
      tailLoss <= maximumTailLoss &&
      Number.isSafeInteger(Number(evidence?.segment_count)) &&
      inspection.segments.length >= Number(evidence.segment_count) &&
      Number.isSafeInteger(Number(evidence?.segment_total_bytes)) &&
      Number(inspection.total_file_bytes) >= Number(evidence.segment_total_bytes) &&
      Number.isSafeInteger(preRecoverySnapshot?.overflow_samples) && preRecoverySnapshot.overflow_samples === 0 &&
      Number.isSafeInteger(preRecoverySnapshot?.input_discontinuity_count) &&
        preRecoverySnapshot.input_discontinuity_count === 0 &&
      Number.isSafeInteger(preRecoverySnapshot?.input_discontinuity_silence_samples) &&
        preRecoverySnapshot.input_discontinuity_silence_samples === 0 &&
      preRecoverySnapshot?.session_id === evidence?.session_id &&
      actualSnapshotMatchesRequirement(preRecoverySnapshot, effectiveRequirement, plan);
    add('independent-recovery-phase1-binding', recoveryBindingPassed, {
      evidence_session_dir: evidence?.session_dir,
      actual_session_dir: sessionDirectory,
      evidence_session_id: evidence?.session_id,
      actual_session_id: snapshot?.session_id,
      armed_committed_samples: armedCommitted,
      armed_captured_samples: armedCaptured,
      recovered_physical_frames: physicalFrames,
      tail_loss_samples: tailLoss,
      maximum_tail_loss_samples: maximumTailLoss,
      armed_segment_count: evidence?.segment_count,
      recovered_segment_count: inspection.segments.length,
      armed_segment_total_bytes: evidence?.segment_total_bytes,
      recovered_segment_total_bytes: inspection.total_file_bytes,
      pre_recovery_snapshot: preRecoverySnapshot,
    });
  }
  return { checks, inspection, sessionDirectory };
}

function validateReport(entry, requirement, plan, reportsRoot) {
  const report = entry?.report;
  const checks = [];
  const evidenceRoots = [];
  const add = (id, passed, details) => checks.push({ id, status: passed ? 'PASS' : 'FAIL', details });
  add('report-readable', Boolean(report) && !entry?.parse_error, entry?.parse_error ?? entry?.path);
  if (!report) return { checks, evidenceRoots };
  add('report-schema', report.schema_version === 1, report.schema_version);
  add('report-mode', report.mode === requirement.mode, { expected: requirement.mode, actual: report.mode });
  add('report-complete-pass', report.overall === 'PASS' && Boolean(report.completed_at) && !report.tool_error && report.aborted !== true, {
    overall: report.overall,
    completed_at: report.completed_at,
    tool_error: report.tool_error,
    aborted: report.aborted,
  });
  add(
    'qualification-binding',
    report.qualification?.qualification_id === plan.qualification_id &&
      report.qualification?.run_id === requirement.id &&
      normalizeHash(report.qualification?.installer_sha256) === normalizeHash(plan.release.installer_sha256),
    { expected: { qualification_id: plan.qualification_id, run_id: requirement.id, installer_sha256: plan.release.installer_sha256 }, actual: report.qualification },
  );
  add(
    'acceptance-tool-hash',
    normalizeHash(report.acceptance_tool_sha256) === normalizeHash(plan.release.acceptance_tool_sha256),
    { expected: plan.release.acceptance_tool_sha256, actual: report.acceptance_tool_sha256 },
  );
  if (ENGINE_MODES.has(requirement.mode)) {
    add(
      'engine-hash',
      normalizeHash(report.engine?.binary_sha256) === normalizeHash(plan.release.engine_sha256),
      { expected: plan.release.engine_sha256, actual: report.engine?.binary_sha256 },
    );
  }
  if (CAPTURE_MODES.has(requirement.mode)) {
    const phases = requirement.mode === 'replug'
      ? [
          { name: 'before', evidence: report.replug?.before },
          { name: 'after', evidence: report.replug?.after },
        ]
      : [{ name: 'capture', evidence: report }];
    const noiseEvidence = phases.map(({ name, evidence }) => ({
      phase: name,
      result: evidence?.noise_check ?? null,
      error: evidence?.noise_check_error ?? null,
    }));
    add(
      'production-noise-check',
      report.options?.skipNoiseCheck !== true &&
        Number(report.options?.noiseThresholdDbfs) === Number(plan.target?.noise_threshold_dbfs) &&
        Number(report.options?.noiseThresholdDbfs) <= PRODUCTION_MAX_NOISE_THRESHOLD_DBFS &&
        noiseEvidence.every(({ result, error }) =>
          !error && result?.passed === true &&
          Number(result?.threshold_dbfs) === Number(plan.target?.noise_threshold_dbfs)),
      {
        skip_noise_check: report.options?.skipNoiseCheck,
        plan_threshold_dbfs: plan.target?.noise_threshold_dbfs,
        report_threshold_dbfs: report.options?.noiseThresholdDbfs,
        maximum_threshold_dbfs: PRODUCTION_MAX_NOISE_THRESHOLD_DBFS,
        phases: noiseEvidence,
      },
    );

    const selectedBackend = typeof report.selected_device?.backend === 'string'
      ? report.selected_device.backend.trim().toLowerCase()
      : '';
    const requestedBackend = typeof report.requested?.capture_backend === 'string'
      ? report.requested.capture_backend.trim().toLowerCase()
      : '';
    const expectedBackend = String(plan.target?.capture_backend ?? '').trim().toLowerCase();
    const phaseSnapshots = phases.flatMap(({ name, evidence }) => {
      const start = evidence?.start?.snapshot;
      const final = evidence?.stop?.result?.snapshot ?? evidence?.inspection?.snapshot;
      return [
        { phase: `${name}-start`, snapshot: start },
        { phase: `${name}-final`, snapshot: final },
      ];
    });
    const expectedShareMode = report.options?.shareMode;
    add(
      'capture-share-mode-evidence',
      (expectedShareMode === 'exclusive' || expectedShareMode === 'shared') &&
        report.requested?.capture_share_mode === expectedShareMode &&
        phaseSnapshots.every(({ snapshot }) => snapshot?.capture_share_mode === expectedShareMode),
      {
        option: expectedShareMode,
        requested: report.requested?.capture_share_mode,
        snapshots: phaseSnapshots.map(({ phase, snapshot }) => ({
          phase,
          capture_share_mode: snapshot?.capture_share_mode,
        })),
      },
    );
    const requiredInputBits = Number(requirement.bit_depth) === 16 ? 16 : 24;
    add(
      'input-sample-format-evidence',
      Number.isSafeInteger(report.options?.minimumInputFormatBits) &&
        report.options.minimumInputFormatBits >= requiredInputBits &&
        phaseSnapshots.every(({ snapshot }) =>
          inputSampleFormatBits(snapshot?.input_sample_format) >= report.options.minimumInputFormatBits),
      {
        required_minimum_bits: requiredInputBits,
        report_minimum_bits: report.options?.minimumInputFormatBits,
        snapshots: phaseSnapshots.map(({ phase, snapshot }) => ({
          phase,
          input_sample_format: snapshot?.input_sample_format,
          effective_bits: inputSampleFormatBits(snapshot?.input_sample_format),
        })),
      },
    );
    add(
      'capture-backend-evidence',
      expectedBackend.length > 0 &&
        report.options?.expectedCaptureBackend === expectedBackend &&
        selectedBackend === expectedBackend && requestedBackend === expectedBackend &&
        phaseSnapshots.length > 0 &&
        phaseSnapshots.every(({ snapshot }) =>
          typeof snapshot?.capture_backend === 'string' &&
          snapshot.capture_backend.trim().toLowerCase() === expectedBackend),
      {
        plan_expected: plan.target?.capture_backend,
        cli_expected: report.options?.expectedCaptureBackend,
        selected: report.selected_device?.backend,
        requested: report.requested?.capture_backend,
        snapshots: phaseSnapshots.map(({ phase, snapshot }) => ({
          phase,
          capture_backend: snapshot?.capture_backend,
        })),
      },
    );
    const claimsAsio = expectedBackend === 'asio' || selectedBackend === 'asio' || requestedBackend === 'asio' ||
      String(report.selected_device?.id ?? '').toLowerCase().startsWith('asio:') ||
      phaseSnapshots.some(({ snapshot }) =>
        String(snapshot?.device_id ?? '').toLowerCase().startsWith('asio:') ||
        String(snapshot?.capture_backend ?? '').toLowerCase() === 'asio');
    if (claimsAsio) {
      const selectedBuffer = Number(report.selected_device?.recommended_buffer_frames);
      const requestedBuffer = Number(report.requested?.capture_buffer_frames);
      const expectedBuffer = Number(plan.target?.capture_buffer_frames);
      add(
        'asio-buffer-evidence',
        Number.isSafeInteger(expectedBuffer) && expectedBuffer > 0 &&
          report.options?.expectedCaptureBufferFrames === expectedBuffer &&
          Number.isSafeInteger(selectedBuffer) && selectedBuffer > 0 &&
          Number.isSafeInteger(requestedBuffer) && requestedBuffer > 0 &&
          selectedBuffer === expectedBuffer && requestedBuffer === expectedBuffer &&
          phaseSnapshots.every(({ snapshot }) =>
            Number.isSafeInteger(snapshot?.requested_capture_buffer_frames) &&
            snapshot.requested_capture_buffer_frames === expectedBuffer &&
            Number.isSafeInteger(snapshot?.capture_buffer_frames) &&
            snapshot.capture_buffer_frames === expectedBuffer),
        {
          plan_expected: plan.target?.capture_buffer_frames,
          cli_expected: report.options?.expectedCaptureBufferFrames,
          selected: report.selected_device?.recommended_buffer_frames,
          requested: report.requested?.capture_buffer_frames,
          snapshots: phaseSnapshots.map(({ phase, snapshot }) => ({
            phase,
            requested_capture_buffer_frames: snapshot?.requested_capture_buffer_frames,
            capture_buffer_frames: snapshot?.capture_buffer_frames,
          })),
        },
      );
    }

    if (NORMAL_CAPTURE_MODES.has(requirement.mode)) {
      const normalEvidence = requirement.mode === 'replug' ? report.replug?.after : report;
      const finalSnapshot = normalEvidence?.stop?.result?.snapshot ?? normalEvidence?.inspection?.snapshot;
      const startSnapshot = normalEvidence?.start?.snapshot;
      add(
        'no-input-discontinuity',
        Number.isSafeInteger(startSnapshot?.input_discontinuity_count) &&
          startSnapshot.input_discontinuity_count === 0 &&
          Number.isSafeInteger(startSnapshot?.input_discontinuity_silence_samples) &&
          startSnapshot.input_discontinuity_silence_samples === 0 &&
          Number.isSafeInteger(finalSnapshot?.input_discontinuity_count) &&
          finalSnapshot.input_discontinuity_count === 0 &&
          Number.isSafeInteger(finalSnapshot?.input_discontinuity_silence_samples) &&
          finalSnapshot.input_discontinuity_silence_samples === 0,
        {
          start: {
            count: startSnapshot?.input_discontinuity_count,
            inserted_silence_samples: startSnapshot?.input_discontinuity_silence_samples,
          },
          final: {
            count: finalSnapshot?.input_discontinuity_count,
            inserted_silence_samples: finalSnapshot?.input_discontinuity_silence_samples,
          },
        },
      );
      const attempt = normalEvidence?.attempt;
      const itemId = attempt?.item_id;
      const attemptId = attempt?.start?.attempt_id;
      const item = Array.isArray(finalSnapshot?.items)
        ? finalSnapshot.items.find((candidate) => candidate?.id === itemId)
        : null;
      const selectedAttempt = Array.isArray(item?.attempts)
        ? item.attempts.find((candidate) => candidate?.attempt_id === attemptId)
        : null;
      const attemptPassed =
        typeof itemId === 'string' && itemId.length > 0 &&
        typeof attemptId === 'string' && attemptId.length > 0 &&
        attempt?.stop?.attempt?.attempt_id === attemptId &&
        attempt?.stop?.attempt?.status === 'recorded' &&
        attempt?.stop?.observed_discontinuity === false &&
        attempt?.accept?.item_id === itemId &&
        attempt?.accept?.attempt_id === attemptId &&
        item?.status === 'accepted' &&
        item?.selected_attempt_id === attemptId &&
        selectedAttempt?.status === 'accepted';
      add('accepted-attempt-lifecycle', attemptPassed, { attempt, item });
      add(
        'input-audition-confirmed',
        inputAuditionEvidencePassed(
          normalEvidence?.input_audition,
          requirement.sample_rate,
          finalSnapshot?.input_audition,
        ),
        normalEvidence?.input_audition,
      );
      if (requirement.export === true) {
        const exported = normalEvidence?.inspection?.export_metadata?.exported;
        const skipped = normalEvidence?.inspection?.export_metadata?.skipped;
        add(
          'accepted-attempt-exported',
          attemptPassed && Array.isArray(exported) && Array.isArray(skipped) &&
            exported.some((row) => row?.id === itemId && row?.attempt_id === attemptId) &&
            !skipped.some((row) => row?.id === itemId),
          { item_id: itemId, attempt_id: attemptId, exported, skipped },
        );
      }
    }
    if (FAULT_CAPTURE_MODES.has(requirement.mode)) {
      const finalSnapshot = report.stop?.result?.snapshot ?? report.inspection?.snapshot;
      add(
        'fault-input-audition-confirmed',
        inputAuditionEvidencePassed(
          report.input_audition,
          requirement.sample_rate,
          finalSnapshot?.input_audition,
        ),
        report.input_audition,
      );
      add(
        'fault-attempt-not-deliverable',
        actualAttemptMatchesFault(finalSnapshot, report.attempt),
        { attempt: report.attempt, item: finalSnapshot?.items },
      );
    }
  }
  add(
    'host-identity',
    report.host?.platform === plan.target.platform &&
      report.host?.architecture === plan.target.architecture &&
      report.host?.hostname === plan.target.hostname &&
      report.host?.release === plan.target.windows_release,
    { expected: plan.target, actual: report.host },
  );
  if (requirement.mode === 'inventory') {
    const matches = (report.inventory?.devices ?? []).filter((device) => device?.id === plan.target.device_id);
    add('inventory-target-device', matches.length === 1, { target: plan.target.device_id, matches });
    const configurations = matches[0]?.configurations ?? [];
    const missing = [];
    for (const sampleRate of REQUIRED_SAMPLE_RATES) {
      for (const channel of plan.target.channels) {
        if (!configurations.some((config) => Number(config.min_sample_rate) <= sampleRate &&
          Number(config.max_sample_rate) >= sampleRate && Number(config.channels) >= channel)) {
          missing.push({ sample_rate: sampleRate, channel });
        }
      }
    }
    add('inventory-required-configurations', missing.length === 0, { missing });
  } else {
    const ids = reportDeviceIds(report);
    add('device-identity', ids.length > 0 && ids.every((id) => id === plan.target.device_id), {
      expected: plan.target.device_id,
      actual: ids,
    });
  }
  for (const field of ['sample_rate', 'bit_depth', 'channel']) {
    if (requirement[field] === undefined) continue;
    const values = reportNumericValues(report, field);
    add(
      `option-${field}`,
      values.length > 0 && values.every((value) => value === Number(requirement[field])),
      { expected: Number(requirement[field]), actual: values },
    );
  }
  if (requirement.min_seconds !== undefined || requirement.min_hours !== undefined) {
    const minimum = requirement.min_hours !== undefined
      ? Number(requirement.min_hours) * 3_600
      : Number(requirement.min_seconds);
    const elapsed = reportElapsedSeconds(report);
    add('duration-reached', elapsed !== null && elapsed >= minimum, { minimum_seconds: minimum, actual_seconds: elapsed });
  }
  if (requirement.export !== undefined) {
    add('export-option', report.options?.export === requirement.export, {
      expected: requirement.export,
      actual: report.options?.export,
    });
  }
  if (requirement.expected_full_track_container !== undefined) {
    add(
      'full-track-container',
      report.inspection?.full_track?.container === requirement.expected_full_track_container &&
        report.inspection?.full_track?.exact_header === true,
      { expected: requirement.expected_full_track_container, actual: report.inspection?.full_track },
    );
  }
  if (requirement.production_eligible === true) {
    add('production-eligible', report.production_eligible === true, report.production_eligible);
  }
  if (requirement.mode === 'recover') {
    const phase1Qualification = report.phase1?.evidence?.qualification;
    add(
      'phase1-qualification-binding',
      phase1Qualification?.qualification_id === plan.qualification_id &&
        phase1Qualification?.run_id === requirement.phase1_evidence_run_id &&
        normalizeHash(phase1Qualification?.installer_sha256) === normalizeHash(plan.release.installer_sha256),
      {
        expected: {
          qualification_id: plan.qualification_id,
          run_id: requirement.phase1_evidence_run_id,
          installer_sha256: plan.release.installer_sha256,
        },
        actual: phase1Qualification,
      },
    );
  }
  const reportChecks = Array.isArray(report.checks) ? report.checks : [];
  const checkIds = reportChecks.map((check) => check?.id);
  const duplicateCheckIds = checkIds.filter((id, index) => typeof id !== 'string' || checkIds.indexOf(id) !== index);
  const requiredCheckIds = requiredAcceptanceCheckIds(requirement, plan);
  const missingCheckIds = requiredCheckIds.filter((id) => !checkIds.includes(id));
  add('unique-acceptance-check-ids', duplicateCheckIds.length === 0, { duplicates: duplicateCheckIds });
  add(
    'required-acceptance-check-ids',
    requiredCheckIds.length > 0 && missingCheckIds.length === 0,
    { required: requiredCheckIds, missing: missingCheckIds },
  );
  add(
    'all-acceptance-checks-pass',
    reportChecks.length > 0 && reportChecks.every((check) => check?.status === 'PASS'),
    reportChecks.filter((check) => check?.status !== 'PASS'),
  );

  const reportDirectory = path.dirname(entry.path);
  const reportDirectoryContained = isCanonicalWithin(reportsRoot, reportDirectory);
  add('report-directory-contained', reportDirectoryContained, reportDirectory);
  if (reportDirectoryContained) evidenceRoots.push(canonicalPath(reportDirectory));
  for (const companion of expectedCompanions(requirement.mode)) {
    const candidate = path.join(reportDirectory, companion);
    let valid = false;
    try {
      const metadata = fs.lstatSync(candidate);
      valid = metadata.isFile() && !metadata.isSymbolicLink() &&
        (companion === 'engine-stderr.log' || metadata.size > 0);
    } catch {}
    add(`evidence-${companion}`, valid, candidate);
  }
  if (CAPTURE_MODES.has(requirement.mode) || requirement.mode === 'recover' || requirement.mode === 'inspect') {
    const sessionDirectory = path.resolve(String(report.session_dir ?? report.inspection?.session_dir ?? ''));
    let valid = false;
    try {
      const metadata = fs.lstatSync(sessionDirectory);
      valid = sessionDirectory !== path.resolve('.') && isCanonicalWithin(reportsRoot, sessionDirectory) &&
        metadata.isDirectory() && !metadata.isSymbolicLink();
    } catch {}
    add('recording-evidence-contained', valid, sessionDirectory);
    if (valid) evidenceRoots.push(canonicalPath(sessionDirectory));
  }
  if (
    CAPTURE_MODES.has(requirement.mode) &&
    requirement.mode !== 'replug' &&
    requirement.mode !== 'power-cut'
  ) {
    const independent = validateIndependentCaptureArchive(report, requirement, plan, reportsRoot);
    checks.push(...independent.checks);
    if (independent.inspection) evidenceRoots.push(canonicalPath(independent.sessionDirectory));
  }
  if (requirement.mode === 'recover' || requirement.mode === 'inspect') {
    const independent = validateIndependentSealedArchive(report, requirement, plan, reportsRoot);
    checks.push(...independent.checks);
    if (independent.inspection) evidenceRoots.push(canonicalPath(independent.sessionDirectory));
  }
  return { checks, evidenceRoots };
}

function replugConfigurationMatches(device, requirement) {
  return Array.isArray(device?.configurations) && device.configurations.some((configuration) =>
    Number(configuration?.min_sample_rate) <= Number(requirement.sample_rate) &&
    Number(configuration?.max_sample_rate) >= Number(requirement.sample_rate) &&
    Number(configuration?.channels) >= Number(requirement.channel));
}

function replugSnapshotMatches(snapshot, sessionDirectory, requirement, plan) {
  const bitDepth = Number(requirement.bit_depth);
  const expectedBackend = String(plan.target?.capture_backend ?? '').trim().toLowerCase();
  return Boolean(snapshot) &&
    snapshot.device_id === plan.target.device_id &&
    snapshot.device_name === plan.target.device_name &&
    typeof snapshot.input_sample_format === 'string' && snapshot.input_sample_format.length > 0 &&
    String(snapshot.capture_backend ?? '').trim().toLowerCase() === expectedBackend &&
    (
      expectedBackend === 'asio'
        ? snapshot.requested_capture_buffer_frames === plan.target.capture_buffer_frames &&
          snapshot.capture_buffer_frames === plan.target.capture_buffer_frames
        : expectedBackend === 'wasapi' &&
          snapshot.requested_capture_buffer_frames == null && snapshot.capture_buffer_frames == null
    ) &&
    Number(snapshot.audio_format?.sample_rate) === Number(requirement.sample_rate) &&
    Number(snapshot.audio_format?.bit_depth) === bitDepth &&
    snapshot.audio_format?.encoding === (bitDepth === 32 ? 'float' : 'pcm') &&
    Number(snapshot.audio_format?.channels) === 1 &&
    Number(snapshot.audio_format?.input_channels) >= Number(requirement.channel) &&
    Number(snapshot.audio_format?.input_channel) === Number(requirement.channel) &&
    (sessionDirectory === null || typeof snapshot.session_id === 'string' && snapshot.session_id.length > 0);
}

function snapshotWatermarksMatch(actual, reported) {
  return Boolean(actual) && Boolean(reported) &&
    actual.session_id === reported.session_id &&
    actual.status === reported.status &&
    Number(actual.journal_seq) === Number(reported.journal_seq) &&
    Number(actual.captured_samples) === Number(reported.captured_samples) &&
    Number(actual.committed_samples) === Number(reported.committed_samples) &&
    Number.isSafeInteger(actual.overflow_samples) &&
    actual.overflow_samples === reported.overflow_samples &&
    Number.isSafeInteger(actual.input_discontinuity_count) &&
    actual.input_discontinuity_count === reported.input_discontinuity_count &&
    Number.isSafeInteger(actual.input_discontinuity_silence_samples) &&
    actual.input_discontinuity_silence_samples === reported.input_discontinuity_silence_samples &&
    actual.device_id === reported.device_id &&
    actual.device_name === reported.device_name &&
    actual.input_sample_format === reported.input_sample_format &&
    actual.capture_share_mode === reported.capture_share_mode &&
    actual.capture_backend === reported.capture_backend &&
    actual.requested_capture_buffer_frames === reported.requested_capture_buffer_frames &&
    actual.capture_buffer_frames === reported.capture_buffer_frames &&
    isDeepStrictEqual(actual.noise_check ?? null, reported.noise_check ?? null) &&
    isDeepStrictEqual(actual.input_audition ?? null, reported.input_audition ?? null) &&
    isDeepStrictEqual(actual.items, reported.items) &&
    isDeepStrictEqual(audioFormatIdentity(actual.audio_format), audioFormatIdentity(reported.audio_format));
}

function sessionSummaryMatchesSnapshot(inspection) {
  const snapshot = inspection?.snapshot;
  const summary = inspection?.session_summary;
  return Boolean(snapshot) && Boolean(summary) &&
    summary.session_id === snapshot.session_id &&
    summary.status === snapshot.status &&
    Number(summary.journal_seq) === Number(snapshot.journal_seq);
}

function independentFaultSessionChecks(inspection, reportedFinal, startSnapshot, requirement, plan, evidence) {
  const snapshot = inspection?.snapshot;
  const segments = Array.isArray(inspection?.segments) ? inspection.segments : [];
  return {
    passed:
      inspection?.exists === true &&
      Array.isArray(inspection?.tree_errors) && inspection.tree_errors.length === 0 &&
      Array.isArray(inspection?.metadata_errors) && inspection.metadata_errors.length === 0 &&
      Array.isArray(inspection?.segment_errors) && inspection.segment_errors.length === 0 &&
      Array.isArray(inspection?.segment_layout_errors) && inspection.segment_layout_errors.length === 0 &&
      Array.isArray(inspection?.descriptor_errors) && inspection.descriptor_errors.length === 0 &&
      Array.isArray(inspection?.descriptor_issues) && inspection.descriptor_issues.length === 0 &&
      snapshot?.status === 'faulted' &&
      replugSnapshotMatches(snapshot, null, requirement, plan) &&
      snapshot?.session_id === startSnapshot?.session_id &&
      snapshotWatermarksMatch(snapshot, reportedFinal) &&
      sessionSummaryMatchesSnapshot(inspection) &&
      faultMarkerPresent(inspection) &&
      inspection?.fault_marker_parse_error !== true &&
      Number.isSafeInteger(snapshot?.overflow_samples) && snapshot.overflow_samples === 0 &&
      Number.isSafeInteger(snapshot?.input_discontinuity_count) && snapshot.input_discontinuity_count === 0 &&
      Number.isSafeInteger(snapshot?.input_discontinuity_silence_samples) &&
        snapshot.input_discontinuity_silence_samples === 0 &&
      evidence?.noise_check?.passed === true &&
      Number(evidence.noise_check.threshold_dbfs) === Number(plan.target.noise_threshold_dbfs) &&
      isDeepStrictEqual(snapshot?.noise_check, evidence.noise_check) &&
      inputAuditionEvidencePassed(
        evidence?.input_audition,
        requirement.sample_rate,
        snapshot?.input_audition,
      ) &&
      auditionPrecedesAttempt(evidence?.input_audition, evidence?.attempt, snapshot) &&
      actualAttemptMatchesFault(snapshot, evidence?.attempt) &&
      evidence?.export?.expected_rejection === true &&
      inspection?.export_bundle_present === false &&
      Number(evidence?.inspection?.total_physical_frames) === Number(inspection?.total_physical_frames) &&
      isDeepStrictEqual(
        segmentEvidenceProjection(evidence?.inspection?.segments),
        segmentEvidenceProjection(inspection?.segments),
      ) &&
      Number.isSafeInteger(Number(inspection?.total_physical_frames)) &&
      Number(inspection.total_physical_frames) > 0 &&
      Number(inspection.total_physical_frames) === Number(snapshot?.committed_samples) &&
      segments.length > 0 &&
      segments.every((segment) =>
        segment?.exact_header === true &&
        Number(segment?.trailing_bytes) === 0 &&
        Number(segment?.sample_rate) === Number(requirement.sample_rate) &&
        Number(segment?.bits_per_sample) === Number(requirement.bit_depth) &&
        Number(segment?.channels) === 1),
    details: {
      inspection,
      reported_final: reportedFinal,
      expected_session_id: startSnapshot?.session_id,
      attempt: evidence?.attempt,
    },
  };
}

function replugInventoryMatches(inventory, requirement, plan) {
  const devices = Array.isArray(inventory?.devices) ? inventory.devices : [];
  const matches = devices.filter((device) => device?.id === plan.target.device_id);
  return matches.length === 1 &&
    matches[0]?.name === plan.target.device_name &&
    replugConfigurationMatches(matches[0], requirement);
}

function validateReplugArchive(entry, requirement, plan, reportsRoot) {
  const report = entry?.report;
  const checks = [];
  const evidenceRoots = [];
  const add = (id, passed, details) => checks.push({ id, status: passed ? 'PASS' : 'FAIL', details });
  if (!report) {
    add('replug-report-present', false, entry?.path ?? null);
    return { checks, evidenceRoots };
  }

  const before = report.replug?.before;
  const transition = report.replug?.transition;
  const after = report.replug?.after;
  const beforeDirectory = path.resolve(String(before?.session_dir ?? ''));
  const afterDirectory = path.resolve(String(after?.session_dir ?? ''));
  const directoryIsSafe = (candidate) => {
    try {
      const metadata = fs.lstatSync(candidate);
      return candidate !== path.resolve('.') &&
        isCanonicalWithin(reportsRoot, candidate) &&
        metadata.isDirectory() &&
        !metadata.isSymbolicLink();
    } catch {
      return false;
    }
  };
  const beforeDirectorySafe = directoryIsSafe(beforeDirectory);
  const afterDirectorySafe = directoryIsSafe(afterDirectory);
  const distinctDirectories = beforeDirectorySafe && afterDirectorySafe &&
    canonicalPath(beforeDirectory) !== canonicalPath(afterDirectory);
  add('replug-session-directories', distinctDirectories, {
    before: beforeDirectory,
    after: afterDirectory,
    before_safe: beforeDirectorySafe,
    after_safe: afterDirectorySafe,
  });
  if (beforeDirectorySafe) evidenceRoots.push(canonicalPath(beforeDirectory));
  if (afterDirectorySafe) evidenceRoots.push(canonicalPath(afterDirectory));

  const beforeStart = before?.start?.snapshot;
  const beforeFinal = before?.stop?.result?.snapshot ?? before?.inspection?.snapshot;
  const afterStart = after?.start?.snapshot;
  const afterFinal = after?.stop?.result?.snapshot ?? after?.inspection?.snapshot;
  const distinctSessions = typeof beforeStart?.session_id === 'string' && beforeStart.session_id.length > 0 &&
    typeof afterStart?.session_id === 'string' && afterStart.session_id.length > 0 &&
    beforeStart.session_id !== afterStart.session_id;
  add(
    'replug-session-identities',
    distinctDirectories && distinctSessions &&
      replugSnapshotMatches(beforeStart, beforeDirectory, requirement, plan) &&
      replugSnapshotMatches(afterStart, afterDirectory, requirement, plan) &&
      beforeFinal?.session_id === beforeStart?.session_id &&
      afterFinal?.session_id === afterStart?.session_id,
    {
      before_session_id: beforeStart?.session_id,
      after_session_id: afterStart?.session_id,
      before_device: { id: beforeStart?.device_id, name: beforeStart?.device_name },
      after_device: { id: afterStart?.device_id, name: afterStart?.device_name },
    },
  );

  let actualBeforeInspection = null;
  let actualAfterInspection = null;
  let actualBeforeError = null;
  let actualAfterError = null;
  if (beforeDirectorySafe) {
    try {
      actualBeforeInspection = inspectSession(beforeDirectory);
    } catch (error) {
      actualBeforeError = error.message;
    }
  }
  if (afterDirectorySafe) {
    try {
      actualAfterInspection = inspectSession(afterDirectory);
    } catch (error) {
      actualAfterError = error.message;
    }
  }
  const independentBefore = independentFaultSessionChecks(
    actualBeforeInspection,
    beforeFinal,
    beforeStart,
    requirement,
    plan,
    before,
  );
  add(
    'replug-before-independent-recording-tree',
    actualBeforeError === null && independentBefore.passed,
    { error: actualBeforeError, ...independentBefore.details },
  );
  const actualAfterChecks = actualAfterInspection
    ? evaluateSealedSession(actualAfterInspection)
    : [];
  const actualAfterFailures = actualAfterChecks.filter((check) => check.status === 'FAIL');
  add(
    'replug-after-independent-recording-tree',
    actualAfterError === null &&
      actualAfterInspection !== null &&
      actualAfterFailures.length === 0 &&
      replugSnapshotMatches(actualAfterInspection.snapshot, null, requirement, plan) &&
      actualAfterInspection.snapshot?.session_id === afterStart?.session_id &&
      snapshotWatermarksMatch(actualAfterInspection.snapshot, afterFinal) &&
      Number.isSafeInteger(actualAfterInspection.snapshot?.input_discontinuity_count) &&
      actualAfterInspection.snapshot.input_discontinuity_count === 0 &&
      Number.isSafeInteger(actualAfterInspection.snapshot?.input_discontinuity_silence_samples) &&
      actualAfterInspection.snapshot.input_discontinuity_silence_samples === 0 &&
      after?.noise_check?.passed === true &&
      Number(after.noise_check.threshold_dbfs) === Number(plan.target.noise_threshold_dbfs) &&
      isDeepStrictEqual(actualAfterInspection.snapshot?.noise_check, after.noise_check) &&
      inputAuditionEvidencePassed(
        after?.input_audition,
        requirement.sample_rate,
        actualAfterInspection.snapshot?.input_audition,
      ) &&
      auditionPrecedesAttempt(after?.input_audition, after?.attempt, actualAfterInspection.snapshot) &&
      actualAttemptMatchesNormal(actualAfterInspection.snapshot, after?.attempt) &&
      actualAfterInspection.export_bundle_present === false &&
      Number(after?.inspection?.total_physical_frames) === Number(actualAfterInspection.total_physical_frames) &&
      isDeepStrictEqual(
        segmentEvidenceProjection(after?.inspection?.segments),
        segmentEvidenceProjection(actualAfterInspection.segments),
      ),
    {
      error: actualAfterError,
      failed_checks: actualAfterFailures,
      checks: actualAfterChecks,
      actual_inspection: actualAfterInspection,
      reported_final: afterFinal,
      attempt: after?.attempt,
    },
  );

  const beforeProgress = before?.progress_summary;
  const healthyPrefix = before?.healthy_prefix_summary;
  const beforePhysicalFrames = Number(before?.inspection?.total_physical_frames);
  add(
    'replug-before-fault-archive',
    beforeFinal?.status === 'faulted' &&
      before?.fault?.first_fault_kind_row?.fault_kind === 'device_unavailable' &&
      before?.fault?.fault_before_trigger == null &&
      typeof before?.fault?.seconds_after_trigger === 'number' &&
      Number.isFinite(before.fault.seconds_after_trigger) &&
      Number(before.fault.seconds_after_trigger) >= 0 &&
      Number(before.fault.seconds_after_trigger) <= 15 &&
      Number(before?.fault?.captured_before_trigger) >= Number(requirement.sample_rate) * 2 &&
      Number(healthyPrefix?.observed_capture_rate) >= Number(requirement.sample_rate) * 0.95 &&
      Number(healthyPrefix?.observed_capture_rate) <= Number(requirement.sample_rate) * 1.05 &&
      Number(healthyPrefix?.maximum_peak_dbfs) > -50 &&
      (before?.inspection?.fault_marker_exists === true ||
        before?.inspection?.fault_marker_temporary_exists === true) &&
      before?.inspection?.fault_marker_parse_error !== true &&
      before?.export?.expected_rejection === true &&
      before?.resume?.expected_rejection === true &&
      Number.isSafeInteger(beforePhysicalFrames) && beforePhysicalFrames > 0 &&
      beforePhysicalFrames === Number(beforeFinal?.committed_samples) &&
      Array.isArray(before?.inspection?.segments) && before.inspection.segments.length > 0 &&
      before.inspection.segments.every((segment) => Number(segment?.trailing_bytes) === 0),
    {
      final_status: beforeFinal?.status,
      fault: before?.fault,
      progress: beforeProgress,
      healthy_prefix: healthyPrefix,
      fault_marker_exists: before?.inspection?.fault_marker_exists,
      fault_marker_temporary_exists: before?.inspection?.fault_marker_temporary_exists,
      physical_frames: beforePhysicalFrames,
      committed_samples: beforeFinal?.committed_samples,
      export: before?.export,
      resume: before?.resume,
    },
  );

  const disappeared = transition?.disappearance;
  const reappeared = transition?.reappearance;
  add(
    'replug-report-transition',
    Number(report.replug?.required_consecutive_matches) >= 2 &&
      transition?.disappearance_timed_out === false &&
      transition?.reappearance_timed_out === false &&
      transition?.target_id === plan.target.device_id &&
      transition?.target_name === plan.target.device_name &&
      disappeared?.target_id === plan.target.device_id &&
      disappeared?.target_name === plan.target.device_name &&
      disappeared?.target_present === false &&
      Array.isArray(disappeared?.observed_device_ids) &&
      !disappeared.observed_device_ids.includes(plan.target.device_id) &&
      reappeared?.target_id === plan.target.device_id &&
      reappeared?.target_name === plan.target.device_name &&
      reappeared?.target_present === true &&
      reappeared?.target_match_count === 1 &&
      reappeared?.target_name_matches === true &&
      reappeared?.target_configuration_matches === true &&
      reappeared?.exact_match === true &&
      Number(reappeared?.consecutive_matches) >= 2 &&
      reappeared?.target_device?.id === plan.target.device_id &&
      reappeared?.target_device?.name === plan.target.device_name &&
      replugConfigurationMatches(reappeared?.target_device, requirement),
    { transition },
  );

  const afterProgress = after?.progress_summary;
  const requiredAfterSeconds = Number(report.options?.seconds);
  const afterPhysicalFrames = Number(after?.inspection?.total_physical_frames);
  add(
    'replug-after-capture-archive',
    Number.isFinite(requiredAfterSeconds) && requiredAfterSeconds >= 5 &&
      Number(afterProgress?.last?.elapsed_seconds) >= requiredAfterSeconds &&
      Number(afterProgress?.observed_capture_rate) >= Number(requirement.sample_rate) * 0.95 &&
      Number(afterProgress?.observed_capture_rate) <= Number(requirement.sample_rate) * 1.05 &&
      Number(afterProgress?.maximum_peak_dbfs) > -50 &&
      afterFinal?.status === 'stopped' &&
      Number(afterFinal?.overflow_samples ?? 0) === 0 &&
      after?.inspection?.fault_marker_exists !== true &&
      after?.inspection?.fault_marker_temporary_exists !== true &&
      Number.isSafeInteger(afterPhysicalFrames) && afterPhysicalFrames > 0 &&
      Number.isSafeInteger(Number(afterFinal?.captured_samples)) &&
      Number.isSafeInteger(Number(afterFinal?.committed_samples)) &&
      Number(afterFinal.captured_samples) === Number(afterFinal.committed_samples) &&
      afterPhysicalFrames === Number(afterFinal?.committed_samples) &&
      Array.isArray(after?.inspection?.segments) && after.inspection.segments.length > 0 &&
      after.inspection.segments.every((segment) =>
        segment?.exact_header === true &&
        Number(segment?.trailing_bytes) === 0 &&
        Number(segment?.sample_rate) === Number(requirement.sample_rate) &&
        Number(segment?.bits_per_sample) === Number(requirement.bit_depth) &&
        Number(segment?.channels) === 1),
    {
      required_seconds: requiredAfterSeconds,
      progress: afterProgress,
      final_status: afterFinal?.status,
      physical_frames: afterPhysicalFrames,
      committed_samples: afterFinal?.committed_samples,
      segments: after?.inspection?.segments,
    },
  );

  const reportDirectory = path.dirname(entry.path);
  let telemetryRows = [];
  let telemetryError = null;
  try {
    telemetryRows = readNdjsonRegularFile(
      path.join(reportDirectory, 'telemetry.jsonl'),
      'replug telemetry',
    );
  } catch (error) {
    telemetryError = error.message;
  }
  const inventoryRows = telemetryRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row?.phase === 'replug-inventory');
  const presentRows = inventoryRows.filter(({ row }) => row.state === 'present-before-unplug');
  const absentRows = inventoryRows.filter(({ row }) => row.state === 'absent-after-unplug');
  const stableRows = inventoryRows.filter(({ row }) => row.state === 'stable-reappearance');
  const presentIndex = presentRows[0]?.index ?? -1;
  const absentIndex = absentRows[0]?.index ?? -1;
  const stableIndex = stableRows[0]?.index ?? -1;
  const matchingBeforeStable = inventoryRows.filter(({ row, index }) =>
    index > absentIndex && index < stableIndex &&
    row?.state === 'matching-reappearance' && row?.exact_match === true &&
    row?.target_id === plan.target.device_id && row?.target_name === plan.target.device_name &&
    row?.target_device?.id === plan.target.device_id &&
    row?.target_device?.name === plan.target.device_name &&
    replugConfigurationMatches(row?.target_device, requirement));
  const aRows = telemetryRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => String(row?.phase ?? '').startsWith('replug-a-'));
  const bRows = telemetryRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => String(row?.phase ?? '').startsWith('replug-b-'));
  const aFaultRows = aRows.filter(({ row }) =>
    row?.phase === 'replug-a-fault-observation' && row?.fault_kind === 'device_unavailable');
  const aRecordingRows = aRows.filter(({ row }) => row?.phase === 'replug-a-recording');
  const aPrematureFaultRows = aRecordingRows.filter(({ row }) =>
    row?.faulted === true ||
    Number(row?.overflow_samples ?? 0) > 0 ||
    row?.fault_marker_exists === true ||
    typeof row?.fault_kind === 'string' && row.fault_kind.trim() !== '');
  const bRecordingRows = bRows.filter(({ row }) => row?.phase === 'replug-b-recording');
  const telemetryRate = (entries) => {
    const first = entries[0]?.row;
    const last = entries.at(-1)?.row;
    const elapsed = Number(last?.elapsed_seconds) - Number(first?.elapsed_seconds);
    return elapsed > 0
      ? (Number(last?.captured_samples) - Number(first?.captured_samples)) / elapsed
      : null;
  };
  const aTelemetryRate = telemetryRate(aRecordingRows);
  const bTelemetryRate = telemetryRate(bRecordingRows);
  const aMaximumPeak = Math.max(...aRecordingRows.map(({ row }) => Number(row?.peak ?? 0)), 0);
  const bMaximumPeak = Math.max(...bRecordingRows.map(({ row }) => Number(row?.peak ?? 0)), 0);
  const bElapsed = bRows.map(({ row }) => Number(row?.elapsed_seconds)).filter(Number.isFinite);
  add(
    'replug-telemetry-transition',
    telemetryError === null &&
      presentRows.length === 1 && absentRows.length === 1 && stableRows.length === 1 &&
      presentRows[0]?.row?.exact_match === true &&
      presentRows[0]?.row?.target_id === plan.target.device_id &&
      presentRows[0]?.row?.target_name === plan.target.device_name &&
      presentRows[0]?.row?.target_device?.id === plan.target.device_id &&
      presentRows[0]?.row?.target_device?.name === plan.target.device_name &&
      replugConfigurationMatches(presentRows[0]?.row?.target_device, requirement) &&
      absentRows[0]?.row?.target_id === plan.target.device_id &&
      absentRows[0]?.row?.target_name === plan.target.device_name &&
      absentRows[0]?.row?.target_present === false &&
      Array.isArray(absentRows[0]?.row?.observed_device_ids) &&
      !absentRows[0].row.observed_device_ids.includes(plan.target.device_id) &&
      presentIndex < aRows[0]?.index &&
      aPrematureFaultRows.length === 0 &&
      aFaultRows.length > 0 && aFaultRows[0].index < absentIndex &&
      absentIndex < stableIndex && matchingBeforeStable.length >= 1 &&
      Number(stableRows[0]?.row?.consecutive_matches) >= 2 &&
      stableRows[0]?.row?.target_device?.id === plan.target.device_id &&
      stableRows[0]?.row?.target_device?.name === plan.target.device_name &&
      replugConfigurationMatches(stableRows[0]?.row?.target_device, requirement) &&
      bRows.length >= 2 && bRows[0].index > stableIndex &&
      aRows.every(({ row }) => row?.session_id === beforeStart?.session_id) &&
      bRows.every(({ row }) => row?.session_id === afterStart?.session_id) &&
      aTelemetryRate !== null &&
      aTelemetryRate >= Number(requirement.sample_rate) * 0.95 &&
      aTelemetryRate <= Number(requirement.sample_rate) * 1.05 &&
      bTelemetryRate !== null &&
      bTelemetryRate >= Number(requirement.sample_rate) * 0.95 &&
      bTelemetryRate <= Number(requirement.sample_rate) * 1.05 &&
      aMaximumPeak > 10 ** (-50 / 20) && bMaximumPeak > 10 ** (-50 / 20) &&
      bElapsed.length > 0 && Math.max(...bElapsed) >= requiredAfterSeconds,
    {
      error: telemetryError,
      present_rows: presentRows.length,
      absent_rows: absentRows.length,
      stable_rows: stableRows.length,
      matching_before_stable: matchingBeforeStable.length,
      a_rows: aRows.length,
      a_fault_rows: aFaultRows.length,
      a_premature_fault_rows: aPrematureFaultRows.length,
      b_rows: bRows.length,
      a_observed_capture_rate: aTelemetryRate,
      b_observed_capture_rate: bTelemetryRate,
      a_maximum_peak: aMaximumPeak,
      b_maximum_peak: bMaximumPeak,
      b_max_elapsed_seconds: bElapsed.length > 0 ? Math.max(...bElapsed) : null,
    },
  );

  let protocolRows = [];
  let protocolError = null;
  try {
    protocolRows = readNdjsonRegularFile(
      path.join(reportDirectory, 'protocol.jsonl'),
      'replug protocol',
    );
  } catch (error) {
    protocolError = error.message;
  }
  const indexedProtocol = protocolRows.map((row, index) => ({ row, index }));
  const requests = indexedProtocol.filter(({ row }) => row?.direction === 'tool' && row?.message?.command);
  const responseFor = ({ row: request, index }) => indexedProtocol.find(({ row, index: responseIndex }) =>
    responseIndex > index && row?.direction === 'engine' &&
    row?.message?.request_id === request?.message?.request_id);
  const commandRequests = (command) => requests.filter(({ row }) => row.message.command === command);
  const startRequests = commandRequests('start_session');
  const startPairMatches = (requestEntry, expectedDirectory, expectedSessionId) => {
    const payload = requestEntry?.row?.message?.payload;
    const response = requestEntry ? responseFor(requestEntry) : null;
    const snapshot = response?.row?.message?.result?.snapshot;
    return Boolean(requestEntry) &&
      path.resolve(String(payload?.session_dir ?? '')) === path.resolve(expectedDirectory) &&
      payload?.session_id === expectedSessionId &&
      payload?.device_id === plan.target.device_id &&
      payload?.device_name === plan.target.device_name &&
      Number(payload?.sample_rate) === Number(requirement.sample_rate) &&
      Number(payload?.bit_depth) === Number(requirement.bit_depth) &&
      Number(payload?.input_channel) === Number(requirement.channel) &&
      response?.row?.message?.ok === true &&
      snapshot?.session_id === expectedSessionId &&
      replugSnapshotMatches(snapshot, expectedDirectory, requirement, plan);
  };
  const firstStart = startRequests[0];
  const secondStart = startRequests[1];
  const listPairs = commandRequests('list_devices').map((request) => ({
    request,
    response: responseFor(request),
  }));
  const firstStartIndex = firstStart?.index ?? Number.POSITIVE_INFINITY;
  const secondStartIndex = secondStart?.index ?? Number.POSITIVE_INFINITY;
  const readyRows = indexedProtocol.filter(({ row, index }) =>
    index < firstStartIndex &&
    row?.direction === 'engine' &&
    row?.message?.event === 'engine_ready' &&
    isDeepStrictEqual(row.message.payload ?? row.message, report.engine?.ready));
  const initialLists = listPairs.filter(({ request, response }) =>
    request.index < firstStartIndex && response?.row?.message?.ok === true &&
    replugInventoryMatches(response.row.message.result, requirement, plan));
  const betweenLists = listPairs.filter(({ request }) =>
    request.index > firstStartIndex && request.index < secondStartIndex);
  let absentListIndex = -1;
  let reappearanceStreak = 0;
  let maximumReappearanceStreak = 0;
  for (let index = 0; index < betweenLists.length; index += 1) {
    const responseMessage = betweenLists[index].response?.row?.message;
    if (responseMessage?.ok !== true) {
      if (absentListIndex >= 0) reappearanceStreak = 0;
      continue;
    }
    const result = responseMessage.result;
    const devices = Array.isArray(result?.devices) ? result.devices : [];
    if (absentListIndex < 0 && !devices.some((device) => device?.id === plan.target.device_id)) {
      absentListIndex = index;
      reappearanceStreak = 0;
      continue;
    }
    if (absentListIndex >= 0 && replugInventoryMatches(result, requirement, plan)) {
      reappearanceStreak += 1;
      maximumReappearanceStreak = Math.max(maximumReappearanceStreak, reappearanceStreak);
    } else if (absentListIndex >= 0) {
      reappearanceStreak = 0;
    }
  }
  const oldCommandRejected = (command) => {
    const matches = commandRequests(command).filter(({ row, index }) =>
      index > firstStartIndex && index < secondStartIndex &&
      path.resolve(String(row.message?.payload?.session_dir ?? '')) === beforeDirectory &&
      (command !== 'resume_session' ||
        row.message?.payload?.expected_session_id === beforeStart?.session_id));
    return matches.length === 1 && responseFor(matches[0])?.row?.message?.ok === false;
  };
  const oldExport = commandRequests('export_session').find(({ index }) =>
    index > firstStartIndex && index < secondStartIndex);
  const oldResume = commandRequests('resume_session').find(({ index }) =>
    index > firstStartIndex && index < secondStartIndex);
  const absentProtocolRequestIndex = absentListIndex >= 0
    ? betweenLists[absentListIndex].request.index
    : -1;
  const successfulStops = commandRequests('stop_session')
    .map((request) => ({ request, response: responseFor(request) }))
    .filter(({ response }) => response?.row?.message?.ok === true);
  const beforeStops = successfulStops.filter(({ request, response }) =>
    request.index > firstStartIndex && request.index < secondStartIndex &&
    response.row.message.result?.snapshot?.session_id === beforeStart?.session_id &&
    response.row.message.result?.snapshot?.status === 'faulted');
  const afterStops = successfulStops.filter(({ request, response }) =>
    request.index > secondStartIndex &&
    response.row.message.result?.snapshot?.session_id === afterStart?.session_id &&
    response.row.message.result?.snapshot?.status === 'stopped');
  const successfulShutdowns = commandRequests('shutdown')
    .map((request) => ({ request, response: responseFor(request) }))
    .filter(({ request, response }) =>
      request.index > (afterStops.at(-1)?.request?.index ?? Number.POSITIVE_INFINITY) &&
      response?.row?.message?.ok === true);
  add(
    'replug-protocol-two-starts',
    protocolError === null && startRequests.length === 2 &&
      startPairMatches(firstStart, beforeDirectory, beforeStart?.session_id) &&
      startPairMatches(secondStart, afterDirectory, afterStart?.session_id) &&
      firstStart?.row?.message?.request_id !== secondStart?.row?.message?.request_id,
    {
      error: protocolError,
      start_count: startRequests.length,
      start_requests: startRequests.map(({ row }) => row.message),
    },
  );
  add(
    'replug-protocol-transition',
    protocolError === null && initialLists.length >= 1 &&
      absentListIndex >= 0 && maximumReappearanceStreak >= 2 &&
      oldCommandRejected('export_session') && oldCommandRejected('resume_session') &&
      oldExport?.index < absentProtocolRequestIndex && oldResume?.index < absentProtocolRequestIndex,
    {
      error: protocolError,
      initial_matching_lists: initialLists.length,
      between_start_list_count: betweenLists.length,
      absent_list_index: absentListIndex,
      maximum_reappearance_streak: maximumReappearanceStreak,
      old_export_rejected: oldCommandRejected('export_session'),
      old_resume_rejected: oldCommandRejected('resume_session'),
    },
  );
  add(
    'replug-protocol-seals-and-shutdown',
    protocolError === null &&
      readyRows.length >= 1 &&
      beforeStops.length >= 1 &&
      afterStops.length >= 1 &&
      successfulShutdowns.length === 1,
    {
      error: protocolError,
      engine_ready_rows: readyRows.length,
      before_successful_stops: beforeStops.length,
      after_successful_stops: afterStops.length,
      successful_shutdowns: successfulShutdowns.length,
    },
  );

  return { checks, evidenceRoots };
}

function validateBoundRuns(results, reportsRoot) {
  const byId = new Map(results.map((result) => [result.id, result]));
  for (const result of results) {
    if (!result.bound_to || !result.report) continue;
    const source = byId.get(result.bound_to);
    const sourceReport = source?.report;
    const current = result.report;
    const sourceSession = sourceReport?.inspection?.snapshot?.session_id ?? sourceReport?.recovery?.result?.snapshot?.session_id;
    const currentSession = current?.inspection?.snapshot?.session_id;
    const sourceDirectory = sourceReport?.session_dir ?? sourceReport?.inspection?.session_dir;
    const currentDirectory = current?.session_dir ?? current?.inspection?.session_dir;
    const passed = source?.status === 'PASS' && sourceSession && sourceSession === currentSession &&
      sourceDirectory && currentDirectory && path.resolve(sourceDirectory) === path.resolve(currentDirectory);
    result.checks.push({
      id: 'bound-run-identity',
      status: passed ? 'PASS' : 'FAIL',
      details: { bound_to: result.bound_to, source_session: sourceSession, current_session: currentSession, source_directory: sourceDirectory, current_directory: currentDirectory },
    });
    if (!passed) result.status = 'FAIL';
  }

  const claims = [];
  for (const result of results) {
    const sealedMode = result.mode === 'recover' || result.mode === 'inspect';
    if ((!CAPTURE_MODES.has(result.mode) && !sealedMode) || !result.report || !result.report_path) continue;
    const phases = result.mode === 'replug'
      ? [
          { name: 'before', evidence: result.report.replug?.before },
          { name: 'after', evidence: result.report.replug?.after },
        ]
      : [{ name: 'capture', evidence: result.report }];
    const reportDirectory = path.dirname(result.report_path);
    const claimDetails = [];
    let allBound = phases.length > 0;
    for (const { name, evidence } of phases) {
      const pathValues = result.mode === 'recover'
        ? [
            evidence?.session_dir,
            evidence?.inspection?.session_dir,
            evidence?.recovery?.result?.session_dir,
            evidence?.phase1?.evidence?.session_dir,
          ].filter((value) => typeof value === 'string' && value.length > 0)
        : [evidence?.session_dir, evidence?.inspection?.session_dir]
          .filter((value) => typeof value === 'string' && value.length > 0);
      const sessionIds = result.mode === 'recover'
        ? [
            evidence?.phase1?.evidence?.session_id,
            evidence?.pre_recovery_inspection?.snapshot?.session_id,
            evidence?.recovery?.result?.snapshot?.session_id,
            evidence?.inspection?.snapshot?.session_id,
          ]
        : result.mode === 'inspect'
          ? [evidence?.inspection?.snapshot?.session_id]
          : [
              evidence?.start?.snapshot?.session_id,
              evidence?.stop?.result?.snapshot?.session_id,
              evidence?.inspection?.snapshot?.session_id,
            ];
      let canonicalDirectory = null;
      let canonicalPathValues = [];
      let pathError = null;
      try {
        canonicalDirectory = canonicalPath(String(evidence?.session_dir ?? ''));
        canonicalPathValues = pathValues.map((value) => canonicalPath(value));
      } catch (error) {
        pathError = error.message;
      }
      const pathsBound = canonicalDirectory !== null &&
        pathValues.length === (result.mode === 'recover' ? 4 : 2) &&
        canonicalPathValues.every((value) => value === canonicalDirectory) &&
        (
          sealedMode
            ? isCanonicalWithin(reportsRoot, canonicalDirectory)
            : isCanonicalWithin(reportDirectory, canonicalDirectory)
        );
      const identity = sessionIds[0];
      const idsBound = typeof identity === 'string' && identity.length > 0 &&
        sessionIds.every((value) => value === identity);
      const bound = pathError === null && pathsBound && idsBound;
      allBound = allBound && bound;
      const claim = {
        result,
        run_id: result.id,
        mode: result.mode,
        phase: name,
        report_directory: reportDirectory,
        canonical_directory: canonicalDirectory,
        session_id: identity,
        path_values: pathValues,
        session_ids: sessionIds,
        path_error: pathError,
        binding_group: result.mode === 'inspect' ? result.bound_to : result.id,
        allows_bound_sharing: sealedMode,
        bound,
      };
      claims.push(claim);
      claimDetails.push({ ...claim, result: undefined });
    }
    result.checks.push({
      id: 'capture-session-claims-bound',
      status: allBound ? 'PASS' : 'FAIL',
      details: claimDetails,
    });
    if (!allBound) result.status = 'FAIL';
  }

  const directoryClaims = new Map();
  const sessionIdClaims = new Map();
  for (const claim of claims) {
    if (claim.canonical_directory) {
      const matching = directoryClaims.get(claim.canonical_directory) ?? [];
      matching.push(claim);
      directoryClaims.set(claim.canonical_directory, matching);
    }
    if (typeof claim.session_id === 'string' && claim.session_id.length > 0) {
      const matching = sessionIdClaims.get(claim.session_id) ?? [];
      matching.push(claim);
      sessionIdClaims.set(claim.session_id, matching);
    }
  }
  const peersMayShare = (claim, peers) => peers.every((peer) =>
    peer === claim ||
    claim.allows_bound_sharing === true &&
      peer.allows_bound_sharing === true &&
      typeof claim.binding_group === 'string' &&
      claim.binding_group.length > 0 &&
      peer.binding_group === claim.binding_group);
  for (const result of results) {
    const ownClaims = claims.filter((claim) => claim.result === result);
    if (ownClaims.length === 0) continue;
    const duplicates = ownClaims.filter((claim) =>
      (claim.canonical_directory && !peersMayShare(
        claim,
        directoryClaims.get(claim.canonical_directory) ?? [],
      )) ||
      (claim.session_id && !peersMayShare(claim, sessionIdClaims.get(claim.session_id) ?? [])));
    const passed = duplicates.length === 0;
    result.checks.push({
      id: 'capture-session-claims-unique',
      status: passed ? 'PASS' : 'FAIL',
      details: duplicates.map((claim) => ({
        run_id: claim.run_id,
        mode: claim.mode,
        phase: claim.phase,
        canonical_directory: claim.canonical_directory,
        directory_claim_count: (directoryClaims.get(claim.canonical_directory) ?? []).length,
        session_id: claim.session_id,
        session_id_claim_count: (sessionIdClaims.get(claim.session_id) ?? []).length,
        binding_group: claim.binding_group,
      })),
    });
    if (!passed) result.status = 'FAIL';
  }
}

async function hashRegularFile(filePath) {
  const metadata = fs.lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`只能对普通文件计算 SHA-256: ${filePath}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return { sha256: hash.digest('hex'), bytes };
}

function collectEvidenceFiles(roots, excludedPaths = []) {
  const files = new Set();
  const excluded = new Set(excludedPaths.map((item) => {
    try { return canonicalPath(item); } catch { return path.resolve(item); }
  }));
  const visit = (candidate) => {
    const metadata = fs.lstatSync(candidate);
    if (metadata.isSymbolicLink()) throw new Error(`证据树不允许链接或 junction: ${candidate}`);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(candidate).sort()) visit(path.join(candidate, name));
    } else if (metadata.isFile()) {
      const canonicalFile = canonicalPath(candidate);
      if (!excluded.has(canonicalFile)) files.add(canonicalFile);
    } else {
      throw new Error(`证据树包含非普通文件: ${candidate}`);
    }
  };
  for (const root of [...new Set(roots.map((item) => path.resolve(item)))].sort()) visit(root);
  return [...files].sort();
}

function manifestPathLabel(filePath, reportsRoot) {
  const canonicalRoot = canonicalPath(reportsRoot);
  const canonicalFile = canonicalPath(filePath);
  const relative = isWithin(canonicalRoot, canonicalFile)
    ? path.relative(canonicalRoot, canonicalFile)
    : `external/${path.basename(canonicalFile)}`;
  const portable = relative.split(path.sep).join('/');
  if (/\r|\n/.test(portable)) throw new Error(`证据路径包含换行，无法写入 SHA256 manifest: ${filePath}`);
  return portable;
}

async function buildEvidenceManifest(files, reportsRoot) {
  const labels = new Set();
  const entries = [];
  for (const filePath of files) {
    const label = manifestPathLabel(filePath, reportsRoot);
    if (labels.has(label)) throw new Error(`证据 manifest 路径冲突: ${label}`);
    labels.add(label);
    const digest = await hashRegularFile(filePath);
    entries.push({ path: label, ...digest, source: filePath });
  }
  return entries;
}

async function runQualification(options) {
  const planPath = path.resolve(options.plan);
  const reportsRoot = path.resolve(options.reports);
  const outputPath = path.resolve(options.output ?? path.join(reportsRoot, 'qualification-report.json'));
  const manifestPath = path.join(path.dirname(outputPath), 'qualification-evidence.sha256');
  const plan = readJsonRegularFile(planPath, '资格计划');
  validatePlanSchema(plan);
  const reportsMetadata = fs.lstatSync(reportsRoot);
  if (!reportsMetadata.isDirectory() || reportsMetadata.isSymbolicLink()) {
    throw new Error(`reports 必须是真实目录，不能是链接或 junction: ${reportsRoot}`);
  }
  prepareContainedOutput(reportsRoot, outputPath);
  const canonicalOutput = path.join(canonicalPath(path.dirname(outputPath)), path.basename(outputPath));
  const canonicalManifest = path.join(canonicalPath(path.dirname(manifestPath)), path.basename(manifestPath));
  const canonicalPlan = canonicalPath(planPath);
  if (canonicalOutput === canonicalPlan || canonicalManifest === canonicalPlan) {
    throw new Error('聚合输出不能覆盖资格计划');
  }
  const implementedModes = options.implementedModes ?? IMPLEMENTED_ACCEPTANCE_MODES;
  const planChecks = validatePlan(plan);
  planChecks.push({
    id: 'plan-file-contained',
    status: isCanonicalWithin(reportsRoot, planPath) ? 'PASS' : 'FAIL',
    details: { plan_path: planPath, reports_root: reportsRoot },
  });
  const installerPath = path.resolve(path.dirname(planPath), String(plan?.release?.installer_path ?? ''));
  let canonicalInstaller = null;
  try { canonicalInstaller = canonicalPath(installerPath); } catch {}
  if (canonicalInstaller !== null &&
      (canonicalOutput === canonicalInstaller || canonicalManifest === canonicalInstaller)) {
    throw new Error('聚合输出不能覆盖安装包');
  }
  let installerDigest = null;
  try {
    installerDigest = await hashRegularFile(installerPath);
    planChecks.push({
      id: 'installer-file-contained',
      status: isCanonicalWithin(reportsRoot, installerPath) ? 'PASS' : 'FAIL',
      details: { installer_path: installerPath, reports_root: reportsRoot },
    });
    planChecks.push({
      id: 'installer-file-hash',
      status: installerDigest.sha256 === normalizeHash(plan?.release?.installer_sha256) ? 'PASS' : 'FAIL',
      details: { path: installerPath, expected: plan?.release?.installer_sha256, actual: installerDigest.sha256, bytes: installerDigest.bytes },
    });
  } catch (error) {
    planChecks.push({ id: 'installer-file-contained', status: 'FAIL', details: { path: installerPath, error: error.message } });
    planChecks.push({ id: 'installer-file-hash', status: 'FAIL', details: { path: installerPath, error: error.message } });
  }

  const discovered = findAcceptanceReports(reportsRoot);
  const unreadableReports = discovered
    .filter((entry) => entry.parse_error)
    .map((entry) => ({ path: entry.path, error: entry.parse_error }));
  planChecks.push({
    id: 'all-acceptance-reports-readable',
    status: unreadableReports.length === 0 ? 'PASS' : 'FAIL',
    details: { unreadable: unreadableReports },
  });
  const bindingGroups = new Map();
  for (const entry of discovered) {
    const qualificationId = entry.report?.qualification?.qualification_id;
    const runId = entry.report?.qualification?.run_id;
    if (qualificationId !== plan.qualification_id || typeof runId !== 'string' || runId.length === 0) continue;
    const group = bindingGroups.get(runId) ?? [];
    group.push(entry.path);
    bindingGroups.set(runId, group);
  }
  const duplicateBindings = [...bindingGroups.entries()]
    .filter(([, reportPaths]) => reportPaths.length > 1)
    .map(([runId, reportPaths]) => ({ run_id: runId, reports: reportPaths }));
  planChecks.push({
    id: 'unique-qualification-run-bindings',
    status: duplicateBindings.length === 0 ? 'PASS' : 'FAIL',
    details: { qualification_id: plan.qualification_id, duplicates: duplicateBindings },
  });
  const results = [];
  const evidenceRoots = [planPath];
  if (installerDigest) evidenceRoots.push(installerPath);
  for (const sourceRequirement of Array.isArray(plan.required_runs) ? plan.required_runs : []) {
    const requirement = { ...sourceRequirement, qualification_id: plan.qualification_id };
    const result = {
      id: requirement.id,
      mode: requirement.mode,
      bound_to: requirement.bound_to ?? null,
      status: 'FAIL',
      report_path: null,
      phase1_report_path: null,
      checks: [],
      report: null,
    };
    if (!implementedModes.has(requirement.mode)) {
      result.status = 'NOT_IMPLEMENTED';
      result.checks.push({
        id: 'acceptance-mode-implemented',
        status: 'FAIL',
        details: `${requirement.mode} 尚未在 windows-audio-acceptance.cjs 中实现，不得用人工声明替代`,
      });
      results.push(result);
      continue;
    }
    const selected = selectReport(requirement, reportsRoot, discovered);
    if (!selected.selected || selected.error) {
      result.checks.push({
        id: 'required-report-selected',
        status: 'FAIL',
        details: {
          error: selected.error,
          candidates: selected.candidates.map((entry) => entry.path),
        },
      });
      results.push(result);
      continue;
    }
    result.report_path = selected.selected.path;
    result.report = selected.selected.report;
    const validation = validateReport(selected.selected, requirement, plan, reportsRoot);
    result.checks.push(...validation.checks);
    if (requirement.mode === 'replug') {
      const replugValidation = validateReplugArchive(
        selected.selected,
        requirement,
        plan,
        reportsRoot,
      );
      result.checks.push(...replugValidation.checks);
      validation.evidenceRoots.push(...replugValidation.evidenceRoots);
    }
    if (requirement.mode === 'recover') {
      const phase1Selection = selectPhase1Report(requirement, plan, reportsRoot, discovered);
      if (!phase1Selection.selected || phase1Selection.error) {
        result.checks.push({
          id: 'phase1-original-report-selected',
          status: 'FAIL',
          details: {
            error: phase1Selection.error,
            candidates: phase1Selection.candidates.map((entry) => entry.path),
          },
        });
      } else {
        result.phase1_report_path = phase1Selection.selected.path;
        const phase1Validation = validatePhase1Archive(
          phase1Selection.selected,
          selected.selected.report,
          requirement,
          plan,
          reportsRoot,
        );
        result.checks.push(...phase1Validation.checks);
        validation.evidenceRoots.push(...phase1Validation.evidenceRoots);
      }
    }
    result.status = result.checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
    evidenceRoots.push(...validation.evidenceRoots);
    results.push(result);
  }
  validateBoundRuns(results, reportsRoot);

  let overall = planChecks.every((check) => check.status === 'PASS') &&
    results.length > 0 && results.every((result) => result.status === 'PASS')
    ? 'QUALIFIED'
    : 'NOT_QUALIFIED';
  const qualificationReport = {
    schema_version: 1,
    profile: QUALIFICATION_PROFILE,
    qualification_id: plan.qualification_id ?? null,
    generated_at: new Date().toISOString(),
    overall,
    plan_path: planPath,
    reports_root: reportsRoot,
    release: plan.release ?? null,
    target: plan.target ?? null,
    discovered_report_count: discovered.length,
    plan_checks: planChecks,
    requirements: results.map(({ report, ...result }) => result),
    evidence: null,
  };

  let manifestEntries = [];
  if (overall === 'QUALIFIED') {
    try {
      // An explicit output may live under a selected run directory. Exclude
      // previous aggregate outputs so rerunning cannot hash its own stale
      // report or manifest recursively.
      const evidenceFiles = collectEvidenceFiles(evidenceRoots, [outputPath, manifestPath]);
      manifestEntries = await buildEvidenceManifest(evidenceFiles, reportsRoot);
      qualificationReport.evidence = {
        status: 'PASS',
        manifest_file: manifestPath,
        input_file_count: manifestEntries.length,
        input_bytes: manifestEntries.reduce((total, entry) => total + entry.bytes, 0),
      };
    } catch (error) {
      overall = 'NOT_QUALIFIED';
      qualificationReport.overall = overall;
      qualificationReport.evidence = { status: 'FAIL', error: error.message };
    }
  } else {
    qualificationReport.evidence = { status: 'NOT_GENERATED', reason: '资格项未全部通过' };
  }

  writeFileAtomic(outputPath, `${JSON.stringify(qualificationReport, null, 2)}\n`);
  if (overall === 'QUALIFIED') {
    const outputDigest = await hashRegularFile(outputPath);
    manifestEntries.push({
      path: manifestPathLabel(outputPath, reportsRoot),
      ...outputDigest,
      source: outputPath,
    });
    const manifest = `${manifestEntries
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => `${entry.sha256} *${entry.path}`)
      .join('\n')}\n`;
    writeFileAtomic(manifestPath, manifest);
  } else {
    try { fs.unlinkSync(manifestPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { report: qualificationReport, outputPath, manifestPath, manifestEntries };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  try {
    const result = await runQualification(options);
    process.stdout.write(`Windows 音频资格结果: ${result.report.overall}\n`);
    for (const requirement of result.report.requirements) {
      process.stdout.write(`  [${requirement.status}] ${requirement.id} (${requirement.mode})\n`);
    }
    process.stdout.write(`报告: ${result.outputPath}\n`);
    if (result.report.overall === 'QUALIFIED') process.stdout.write(`证据校验和: ${result.manifestPath}\n`);
    process.exitCode = result.report.overall === 'QUALIFIED' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  IMPLEMENTED_ACCEPTANCE_MODES,
  KNOWN_ACCEPTANCE_MODES,
  QUALIFICATION_PROFILE,
  REQUIRED_BIT_DEPTHS,
  REQUIRED_SAMPLE_RATES,
  parseArgs,
  requiredAcceptanceCheckIds,
  runQualification,
  validatePlan,
  validatePlanSchema,
};
