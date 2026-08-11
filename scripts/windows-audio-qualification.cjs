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
      Number(payload?.input_channel) === Number(requirement.channel);
  });
  const matchingStartResponses = matchingStartRequests.filter((requestRow) =>
    protocolRows.some((row) =>
      row?.direction === 'engine' &&
      row?.message?.request_id === requestRow.message.request_id &&
      row?.message?.ok === true &&
      row?.message?.result?.snapshot?.session_id === originalEvidence?.session_id &&
      row?.message?.result?.snapshot?.device_id === plan.target.device_id &&
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
  return Boolean(snapshot) &&
    snapshot.device_id === plan.target.device_id &&
    snapshot.device_name === plan.target.device_name &&
    typeof snapshot.input_sample_format === 'string' && snapshot.input_sample_format.length > 0 &&
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
    Number(actual.overflow_samples ?? 0) === Number(reported.overflow_samples ?? 0) &&
    actual.device_id === reported.device_id &&
    actual.device_name === reported.device_name &&
    actual.input_sample_format === reported.input_sample_format &&
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

function independentFaultSessionChecks(inspection, reportedFinal, startSnapshot, requirement, plan) {
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
      snapshot?.status === 'faulted' &&
      replugSnapshotMatches(snapshot, null, requirement, plan) &&
      snapshot?.session_id === startSnapshot?.session_id &&
      snapshotWatermarksMatch(snapshot, reportedFinal) &&
      sessionSummaryMatchesSnapshot(inspection) &&
      faultMarkerPresent(inspection) &&
      inspection?.fault_marker_parse_error !== true &&
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
      snapshotWatermarksMatch(actualAfterInspection.snapshot, afterFinal),
    {
      error: actualAfterError,
      failed_checks: actualAfterFailures,
      checks: actualAfterChecks,
      actual_inspection: actualAfterInspection,
      reported_final: afterFinal,
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

function validateBoundRuns(results) {
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
  validateBoundRuns(results);

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
  runQualification,
  validatePlan,
  validatePlanSchema,
};
