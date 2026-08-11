'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { createInterface: createPrompt } = require('node:readline/promises');
const { isDeepStrictEqual } = require('node:util');

const PROTOCOL_VERSION = 1;
const TOOL_VERSION = 1;
const MODES = new Set([
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
const DEVICE_UNPLUG_MODES = new Set(['unplug', 'replug']);
const FAULT_MODES = new Set(['unplug', 'replug', 'disk-full']);
const BIT_DEPTHS = new Set([16, 24, 32]);
const PRODUCTION_POWER_CUT_SECONDS = 3_600;
const DEFAULT_POWER_CUT_MAXIMUM_SECONDS = 3_900;
const DEFAULT_MAX_TAIL_LOSS_SECONDS = 15;
const MAX_POWER_CUT_TAIL_LOSS_SECONDS = 30;
const MAX_NORMAL_COMMIT_LAG_SECONDS = 15;
const POWER_CUT_EVIDENCE_KIND = 'databaker.power-cut-phase-1';
const POWER_CUT_SESSION_EVIDENCE = path.join('metadata', 'power-cut.acceptance.json');
const SEGMENT_DESCRIPTOR_KIND = 'databaker.segmented-wav-header';
const EXPORT_CSV_HEADER = 'id,text,label,attempt_id,start_sample,recording_started_sample,head_silence_armed_sample,head_silence_passed_sample,required_head_silence_samples,content_started_sample,content_started_seconds,end_sample,duration_samples,file,forced_without_tail_silence,tail_silence_samples,required_tail_silence_samples';

function testTimeout(name, fallback) {
  if (process.env.NODE_ENV !== 'test') return fallback;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 20 ? value : fallback;
}

const SHUTDOWN_REQUEST_TIMEOUT_MS = testTimeout(
  'DATABAKER_ACCEPTANCE_TEST_SHUTDOWN_REQUEST_TIMEOUT_MS',
  120_000,
);
const SHUTDOWN_EXIT_TIMEOUT_MS = testTimeout(
  'DATABAKER_ACCEPTANCE_TEST_SHUTDOWN_EXIT_TIMEOUT_MS',
  30_000,
);
const FAULT_DRAIN_OBSERVATION_MS = testTimeout(
  'DATABAKER_ACCEPTANCE_TEST_FAULT_DRAIN_MS',
  5_000,
);

let abortRequested = false;
let abortHandlerInstalled = false;

function installAbortHandler() {
  if (abortHandlerInstalled) return;
  abortHandlerInstalled = true;
  process.on('SIGINT', () => {
    if (abortRequested) {
      process.stderr.write('\n已在安全停止，请勿反复强制结束进程。\n');
      return;
    }
    abortRequested = true;
    process.stderr.write('\n收到 Ctrl+C：将先封存当前音频，验收结果会标记为 INCOMPLETE。\n');
  });
}

function usage() {
  return `DataBaker Windows 外置声卡验收工具

用法:
  node scripts/windows-audio-acceptance.cjs --mode <mode> [options]

模式:
  inventory   只枚举 WASAPI 输入设备、稳定 ID 和驱动配置
  short       短录音、进度监测、安全停止、WAV 头和 RIFF/RF64 整轨导出验证
  soak        2–8 小时连续录音和文件增长监测（默认不拷贝整轨）
  unplug      进行中人工拔出 USB 声卡，验证 fail-closed 和故障标记
  replug      拔出后确认设备消失，重插同一 endpoint 并开启全新健康会话
  disk-full   在专用测试卷上人工降低剩余空间，验证磁盘保护
  power-cut   阶段1：开始录音并等待人工断电，需 --session-dir
  recover     阶段2：重启后离线封存并严格验证断电会话，需 --session-dir
  inspect     只读严格检查已封存录制目录，需 --session-dir

常用参数:
  --engine <path>                recorder-engine.exe 路径（可自动定位）
  --output <directory>           验收结果根目录
  --device-id <id>               list_devices 返回的稳定设备 ID
  --device-index <n>             界面打印的 1-based 设备序号
  --sample-rate <hz>             默认 48000
  --bit-depth <16|24|32>         交付 WAV 位深，默认 24
  --minimum-input-format-bits <n> 驱动输入有效数字精度门槛；f32 按 24、f64 按 53；默认 16-bit 交付要求 16，24/32-bit 要求 24
  --channel <n>                  声卡输入通道（1-based），默认 1
  --seconds <n>                  short 录制秒数（默认 20）/ power-cut 最长等待（生产默认 3900）
  --hours <2..8>                 soak 时长，默认 2
  --poll-seconds <n>             进度落盘间隔，默认 1（soak 默认 5）
  --trigger-delay-seconds <n>    故障操作倒计时，power-cut 生产默认/最小 3600
  --fault-timeout-seconds <n>    等待故障被检测的时间，默认 60
  --max-tail-loss-seconds <n>    断电证据允许的最大 captured/committed 尾差，默认 15，上限 30
  --confirm-dedicated-volume     disk-full 确认 1：输出位于可丢弃测试卷
  --confirm-not-system-drive     disk-full 确认 2：该卷不是 Windows 系统盘
  --noise-threshold-dbfs <n>     环境噪声阈值，默认 -40
  --skip-noise-check             不执行 3 秒环境噪声检测
  --export                       soak 也生成 full-track.wav（可能很大）
  --no-export                    short 不生成 full-track.wav
  --yes                          非交互执行；无设备参数时选系统默认设备
  --session-dir <path>           power-cut / recover / inspect 共用的录制目录
  --phase1-report <path>         recover 必需：phase-1 acceptance-report.json 或独立证据 JSON
  --phase1-evidence <path>       --phase1-report 的等价别名
  --qualification-id <id>       生产资格计划 ID；与下两项必须同时提供
  --qualification-run-id <id>   资格计划定义的本次 run / phase-1 证据 ID
  --installer-sha256 <sha256>   本次安装包的 SHA-256
  --test-only-power-cut          显式启用短时无害回归；结果永不具备生产验收资格
  --help                         显示帮助

结果:
  acceptance-report.json   最终配置、WAV 属性、PASS/FAIL 判定
  telemetry.jsonl          连续样本、提交水位、文件增长、磁盘/故障状态
  protocol.jsonl           命令、响应和非高频引擎事件
  engine-stderr.log        Rust/WASAPI 错误输出
`;
}

function parseNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} 必须是有限数字`);
  return parsed;
}

function parseInteger(value, name) {
  const parsed = parseNumber(value, name);
  if (!Number.isInteger(parsed)) throw new Error(`${name} 必须是整数`);
  return parsed;
}

function validateDiskFullTarget(output, platform = process.platform, systemDriveValue = process.env.SystemDrive) {
  if (platform !== 'win32') return;
  const systemDrive = String(systemDriveValue ?? path.win32.parse(process.env.SystemRoot ?? 'C:\\').root)
    .replace(/[\\/]+$/, '')
    .toUpperCase();
  const outputDrive = path.win32.parse(output).root.replace(/[\\/]+$/, '').toUpperCase();
  if (!outputDrive) throw new Error('disk-full --output 必须是有独立根的 Windows 测试卷路径');
  if (outputDrive === systemDrive) {
    throw new Error(`拒绝在 Windows 系统盘 ${systemDrive} 执行 disk-full；请使用可丢弃 VHD/VHDX 或独立测试盘`);
  }
}

function defaultOutputRoot(platform = process.platform, environment = process.env, workingDirectory = process.cwd()) {
  if (platform === 'win32') {
    const localAppData =
      environment.LOCALAPPDATA ||
      (environment.USERPROFILE ? path.win32.join(environment.USERPROFILE, 'AppData', 'Local') : null);
    if (localAppData) return path.win32.resolve(localAppData, 'DataBaker', 'acceptance-results');
  }
  return path.resolve(workingDirectory, 'acceptance-results');
}

function parseArgs(argv) {
  const options = {
    mode: null,
    engine: null,
    output: defaultOutputRoot(),
    outputExplicit: false,
    deviceId: null,
    deviceIndex: null,
    sampleRate: 48_000,
    bitDepth: 24,
    minimumInputFormatBits: null,
    channel: 1,
    seconds: 20,
    hours: 2,
    pollSeconds: null,
    triggerDelaySeconds: 10,
    faultTimeoutSeconds: 60,
    maxTailLossSeconds: DEFAULT_MAX_TAIL_LOSS_SECONDS,
    confirmDedicatedVolume: false,
    confirmNotSystemDrive: false,
    noiseThresholdDbfs: -40,
    skipNoiseCheck: false,
    export: null,
    yes: false,
    sessionDir: null,
    phase1Report: null,
    qualificationId: null,
    qualificationRunId: null,
    installerSha256: null,
    testOnlyPowerCut: false,
    secondsExplicit: false,
    triggerDelayExplicit: false,
    help: false,
  };

  const valueFor = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少参数`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--mode':
        options.mode = valueFor(index, flag);
        index += 1;
        break;
      case '--engine':
        options.engine = path.resolve(valueFor(index, flag));
        index += 1;
        break;
      case '--output':
        options.output = path.resolve(valueFor(index, flag));
        options.outputExplicit = true;
        index += 1;
        break;
      case '--device-id':
        options.deviceId = valueFor(index, flag);
        index += 1;
        break;
      case '--device-index':
        options.deviceIndex = parseInteger(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--sample-rate':
        options.sampleRate = parseInteger(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--bit-depth':
        options.bitDepth = parseInteger(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--minimum-input-format-bits':
        options.minimumInputFormatBits = parseInteger(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--channel':
        options.channel = parseInteger(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--seconds':
        options.seconds = parseNumber(valueFor(index, flag), flag);
        options.secondsExplicit = true;
        index += 1;
        break;
      case '--hours':
        options.hours = parseNumber(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--poll-seconds':
        options.pollSeconds = parseNumber(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--trigger-delay-seconds':
        options.triggerDelaySeconds = parseNumber(valueFor(index, flag), flag);
        options.triggerDelayExplicit = true;
        index += 1;
        break;
      case '--fault-timeout-seconds':
        options.faultTimeoutSeconds = parseNumber(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--max-tail-loss-seconds':
        options.maxTailLossSeconds = parseNumber(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--confirm-dedicated-volume':
        options.confirmDedicatedVolume = true;
        break;
      case '--confirm-not-system-drive':
        options.confirmNotSystemDrive = true;
        break;
      case '--noise-threshold-dbfs':
        options.noiseThresholdDbfs = parseNumber(valueFor(index, flag), flag);
        index += 1;
        break;
      case '--skip-noise-check':
        options.skipNoiseCheck = true;
        break;
      case '--export':
        options.export = true;
        break;
      case '--no-export':
        options.export = false;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--session-dir':
        options.sessionDir = path.resolve(valueFor(index, flag));
        index += 1;
        break;
      case '--phase1-report':
      case '--phase1-evidence':
        if (options.phase1Report !== null) throw new Error('--phase1-report / --phase1-evidence 只能指定一次');
        options.phase1Report = path.resolve(valueFor(index, flag));
        index += 1;
        break;
      case '--qualification-id':
        options.qualificationId = valueFor(index, flag);
        index += 1;
        break;
      case '--qualification-run-id':
        options.qualificationRunId = valueFor(index, flag);
        index += 1;
        break;
      case '--installer-sha256':
        options.installerSha256 = valueFor(index, flag).toLowerCase();
        index += 1;
        break;
      case '--test-only-power-cut':
        options.testOnlyPowerCut = true;
        break;
      default:
        throw new Error(`未知参数: ${flag}`);
    }
  }

  if (options.help) return options;
  if (!MODES.has(options.mode)) throw new Error(`--mode 必须是 ${[...MODES].join(', ')}`);
  if (['inspect', 'power-cut', 'recover'].includes(options.mode) && !options.sessionDir) {
    throw new Error(`${options.mode} 需要 --session-dir`);
  }
  if (options.mode === 'recover' && !options.phase1Report) {
    throw new Error('recover 需要 --phase1-report <phase-1 report/evidence JSON>');
  }
  if (options.phase1Report && options.mode !== 'recover') {
    throw new Error('--phase1-report / --phase1-evidence 只能用于 recover');
  }
  if (options.testOnlyPowerCut && !['power-cut', 'recover'].includes(options.mode)) {
    throw new Error('--test-only-power-cut 只能用于 power-cut / recover');
  }
  const qualificationValues = [
    options.qualificationId,
    options.qualificationRunId,
    options.installerSha256,
  ];
  if (qualificationValues.some((value) => value !== null) && qualificationValues.some((value) => value === null)) {
    throw new Error('--qualification-id、--qualification-run-id 和 --installer-sha256 必须同时提供');
  }
  if (options.qualificationId !== null) {
    const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
    if (!safeId.test(options.qualificationId)) throw new Error('--qualification-id 格式无效');
    if (!safeId.test(options.qualificationRunId)) throw new Error('--qualification-run-id 格式无效');
    if (!/^[0-9a-f]{64}$/.test(options.installerSha256)) throw new Error('--installer-sha256 必须是 64 位十六进制 SHA-256');
  }
  if (
    options.mode === 'disk-full' &&
    (!options.outputExplicit || !options.confirmDedicatedVolume || !options.confirmNotSystemDrive)
  ) {
    throw new Error(
      'disk-full 必须显式传入 --output <专用测试卷路径>、--confirm-dedicated-volume 和 --confirm-not-system-drive',
    );
  }
  if (options.mode === 'disk-full') validateDiskFullTarget(options.output);
  if (!BIT_DEPTHS.has(options.bitDepth)) throw new Error('--bit-depth 必须是 16、24 或 32');
  if (options.minimumInputFormatBits === null) {
    // 32-bit Float 交付通常来自 24-bit ADC。这里只拒绝明显低于
    // 24-bit 有效数字精度的输入，不把数字表示精度误当成 ADC ENOB 证明。
    options.minimumInputFormatBits = options.bitDepth === 16 ? 16 : 24;
  }
  if (![8, 16, 24, 32, 53, 64].includes(options.minimumInputFormatBits)) {
    throw new Error('--minimum-input-format-bits 必须是 8、16、24、32、53 或 64');
  }
  if (options.sampleRate < 8_000 || options.sampleRate > 384_000) {
    throw new Error('--sample-rate 必须在 8000–384000 之间');
  }
  if (options.channel < 1 || options.channel > 256) throw new Error('--channel 必须在 1–256 之间');
  if (options.mode === 'power-cut' && !options.testOnlyPowerCut) {
    if (!options.secondsExplicit) options.seconds = DEFAULT_POWER_CUT_MAXIMUM_SECONDS;
    if (!options.triggerDelayExplicit) options.triggerDelaySeconds = PRODUCTION_POWER_CUT_SECONDS;
  }
  const maximumSeconds = options.mode === 'power-cut' ? 8 * 3_600 : 3_600;
  if (options.seconds < 5 || options.seconds > maximumSeconds) {
    throw new Error(`--seconds 必须在 5–${maximumSeconds} 之间`);
  }
  if (options.mode === 'soak' && (options.hours < 2 || options.hours > 8)) {
    throw new Error('soak --hours 必须在 2–8 之间');
  }
  if (options.pollSeconds !== null && (options.pollSeconds < 0.25 || options.pollSeconds > 60)) {
    throw new Error('--poll-seconds 必须在 0.25–60 之间');
  }
  const maximumTriggerDelay = options.mode === 'power-cut' ? 8 * 3_600 - 1 : 600;
  if (options.triggerDelaySeconds < 2 || options.triggerDelaySeconds > maximumTriggerDelay) {
    throw new Error(`--trigger-delay-seconds 必须在 2–${maximumTriggerDelay} 之间`);
  }
  if (options.mode === 'power-cut' && options.triggerDelaySeconds >= options.seconds) {
    throw new Error('power-cut --trigger-delay-seconds 必须小于 --seconds，以留出断电操作窗口');
  }
  if (
    options.mode === 'power-cut' &&
    !options.testOnlyPowerCut &&
    options.triggerDelaySeconds < PRODUCTION_POWER_CUT_SECONDS
  ) {
    throw new Error(`生产 power-cut --trigger-delay-seconds 不能少于 ${PRODUCTION_POWER_CUT_SECONDS}；短时回归必须显式使用 --test-only-power-cut`);
  }
  if (
    options.maxTailLossSeconds < 0.1 ||
    options.maxTailLossSeconds > MAX_POWER_CUT_TAIL_LOSS_SECONDS
  ) {
    throw new Error(`--max-tail-loss-seconds 必须在 0.1–${MAX_POWER_CUT_TAIL_LOSS_SECONDS} 之间`);
  }
  if (options.faultTimeoutSeconds < 10 || options.faultTimeoutSeconds > 3_600) {
    throw new Error('--fault-timeout-seconds 必须在 10–3600 之间');
  }
  if (options.noiseThresholdDbfs < -96 || options.noiseThresholdDbfs > -6) {
    throw new Error('--noise-threshold-dbfs 必须在 -96–-6 之间');
  }
  if (options.deviceIndex !== null && options.deviceIndex < 1) {
    throw new Error('--device-index 是从 1 开始的序号');
  }
  if (options.pollSeconds === null) options.pollSeconds = options.mode === 'soak' ? 5 : 1;
  if (options.export === null) options.export = options.mode === 'short';
  delete options.secondsExplicit;
  delete options.triggerDelayExplicit;
  return options;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function linearToDbfs(value) {
  if (!Number.isFinite(value) || value <= 0) return -96;
  return Math.max(-96, 20 * Math.log10(value));
}

function inputSampleFormatBits(format) {
  const match = /^\s*([iuf])(\d+)\s*$/i.exec(String(format ?? ''));
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const bits = Number(match[2]);
  if (kind === 'f') {
    // IEEE-754 precision includes the implicit leading significand bit.
    if (bits === 32) return 24;
    if (bits === 64) return 53;
    return null;
  }
  return Number.isSafeInteger(bits) && bits > 0 ? bits : null;
}

function faultEvidenceRows(rows) {
  const isFaultEvidence = (row) => Boolean(
    row?.faulted || Number(row?.overflow_samples ?? 0) > 0 || row?.fault_marker_exists,
  );
  const firstFaultRow = rows.find(isFaultEvidence) ?? null;
  const firstFaultKindRow = rows.find((row) => (
    isFaultEvidence(row)
    && typeof row?.fault_kind === 'string'
    && row.fault_kind.trim() !== ''
  )) ?? firstFaultRow;
  return { firstFaultRow, firstFaultKindRow };
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function pathEntryExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function comparablePath(filePath, platform = process.platform) {
  const resolved = path.resolve(filePath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsEqual(left, right, platform = process.platform) {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

function hostBootIdentity(
  environment = process.env,
  nowMs = Date.now(),
  uptimeSeconds = os.uptime(),
  hostname = os.hostname(),
  allowTestOverride = false,
) {
  if (
    allowTestOverride &&
    environment.NODE_ENV === 'test' &&
    environment.DATABAKER_ACCEPTANCE_TEST_BOOT_ID &&
    environment.DATABAKER_ACCEPTANCE_TEST_BOOTED_AT
  ) {
    const overridden = Date.parse(environment.DATABAKER_ACCEPTANCE_TEST_BOOTED_AT);
    if (!Number.isFinite(overridden)) {
      throw new Error('DATABAKER_ACCEPTANCE_TEST_BOOTED_AT 必须是有效 ISO 时间');
    }
    return {
      id: environment.DATABAKER_ACCEPTANCE_TEST_BOOT_ID,
      booted_at: new Date(overridden).toISOString(),
      observed_uptime_seconds: Math.max(0, (nowMs - overridden) / 1_000),
      source: 'test-override',
    };
  }
  const bootedAtMs = Math.max(0, nowMs - Math.max(0, Number(uptimeSeconds)) * 1_000);
  const roundedBootMinute = Math.floor(bootedAtMs / 60_000) * 60_000;
  return {
    id: `${hostname}:${roundedBootMinute}`,
    booted_at: new Date(bootedAtMs).toISOString(),
    observed_uptime_seconds: Math.max(0, Number(uptimeSeconds)),
    source: 'os-uptime',
  };
}

function readJsonRegularFile(filePath, label = 'JSON', maximumBytes = 2 * 1024 * 1024) {
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} 必须是普通文件，不能是链接: ${filePath}`);
  }
  if (metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} 大小无效: ${filePath} (${metadata.size} bytes)`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} 无法解析: ${filePath}: ${error.message}`);
  }
}

function readTextRegularFile(filePath, label, maximumBytes = 16 * 1024 * 1024) {
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} 必须是普通文件，不能是链接: ${filePath}`);
  }
  if (metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} 大小无效: ${filePath} (${metadata.size} bytes)`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function sha256RegularFile(filePath, label = '文件') {
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} 必须是普通文件，不能是链接: ${filePath}`);
  }
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Capture the script bytes at process load. A long power-cut run must not hash
// a different on-disk script that an updater replaced after this code started.
const ACCEPTANCE_TOOL_SHA256 = sha256RegularFile(__filename, '验收工具');

function exportCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function expectedExportCsv(exported) {
  const lines = [EXPORT_CSV_HEADER];
  for (const row of exported) {
    const integer = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0
      ? String(Number(value))
      : '0';
    const seconds = Number.isFinite(Number(row?.content_started_seconds))
      ? Number(row.content_started_seconds).toFixed(6)
      : '0.000000';
    lines.push([
      exportCsvCell(row?.id),
      exportCsvCell(row?.text),
      exportCsvCell(row?.label),
      exportCsvCell(row?.attempt_id),
      integer(row?.start_sample),
      integer(row?.recording_started_sample),
      integer(row?.head_silence_armed_sample),
      integer(row?.head_silence_passed_sample),
      integer(row?.required_head_silence_samples),
      integer(row?.content_started_sample),
      seconds,
      integer(row?.end_sample),
      integer(row?.duration_samples),
      exportCsvCell(row?.file),
      String(Boolean(row?.forced_without_tail_silence)),
      integer(row?.tail_silence_samples),
      integer(row?.required_tail_silence_samples),
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function loadPhase1Evidence(sourcePath) {
  const source = readJsonRegularFile(sourcePath, 'phase-1 报告/证据');
  if (source?.kind === POWER_CUT_EVIDENCE_KIND) {
    return { evidence: source, source_kind: 'evidence', report: null };
  }
  const evidence = source?.power_cut?.evidence;
  if (source?.mode !== 'power-cut' || !evidence) {
    throw new Error('--phase1-report 不是 power-cut 报告，也不是独立 phase-1 证据');
  }
  if (source.power_cut.phase !== 'armed' || source.completed_at !== null || source.overall !== 'INCOMPLETE') {
    throw new Error('phase-1 报告未停留在已达标 armed 的异常中断状态');
  }
  return { evidence, source_kind: 'report', report: source };
}

function powerCutRequiredDurationSeconds(options) {
  return options.testOnlyPowerCut
    ? Math.max(2, Math.min(options.triggerDelaySeconds, PRODUCTION_POWER_CUT_SECONDS - 1))
    : PRODUCTION_POWER_CUT_SECONDS;
}

function buildPowerCutEvidence(report, options, sessionDirectory, row) {
  const snapshot = report.start?.snapshot;
  const requiredDurationSeconds = powerCutRequiredDurationSeconds(options);
  return {
    schema_version: 1,
    kind: POWER_CUT_EVIDENCE_KIND,
    phase: 'armed',
    nonce: report.power_cut.nonce,
    test_only: options.testOnlyPowerCut,
    production_eligible: !options.testOnlyPowerCut,
    session_dir: path.resolve(sessionDirectory),
    session_id: snapshot?.session_id,
    device_id: snapshot?.device_id,
    device_name: snapshot?.device_name,
    input_sample_format: snapshot?.input_sample_format,
    audio_format: snapshot?.audio_format,
    required_duration_seconds: requiredDurationSeconds,
    production_minimum_seconds: PRODUCTION_POWER_CUT_SECONDS,
    wall_elapsed_seconds: Number(row.elapsed_seconds),
    armed_at: row.at,
    armed_captured_samples: Number(row.captured_samples),
    armed_committed_samples: Number(row.committed_samples),
    max_tail_loss_samples: Math.ceil(options.maxTailLossSeconds * options.sampleRate),
    segment_total_bytes: Number(row.segment_total_bytes),
    segment_count: Number(row.segment_count),
    tool_version: TOOL_VERSION,
    protocol_version: PROTOCOL_VERSION,
    binary_identity: {
      acceptance_tool_sha256: ACCEPTANCE_TOOL_SHA256,
      engine_sha256: report.engine.binary_sha256,
      engine_ready: report.engine.ready,
    },
    qualification: report.qualification,
    host: {
      hostname: report.host.hostname,
      platform: report.host.platform,
      architecture: report.host.architecture,
      boot_id: report.host.boot.id,
      booted_at: report.host.boot.booted_at,
    },
  };
}

function writeJsonDurable(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  const file = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    // Node/Windows versions differ in replacement behavior. The source handle
    // is already closed; CopyFile is the compatibility fallback for this QA
    // report only (never for recorder source-of-truth files).
    fs.copyFileSync(temporary, filePath);
    fs.unlinkSync(temporary);
    if (!fs.existsSync(filePath)) throw error;
  }
  // The temporary contents were synced before rename. Flush the final path as
  // well so a prompt printed immediately afterwards cannot outrun the renamed
  // directory entry on Windows/NTFS.
  const finalFile = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(finalFile);
  } finally {
    fs.closeSync(finalFile);
  }
}

class NdjsonLog {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'a');
    this.lastSync = Date.now();
  }

  write(value, durable = false) {
    fs.writeSync(this.fd, `${JSON.stringify(value)}\n`, null, 'utf8');
    if (durable || Date.now() - this.lastSync >= 60_000) {
      fs.fsyncSync(this.fd);
      this.lastSync = Date.now();
    }
  }

  close() {
    if (this.fd === null) return;
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

function candidateEnginePaths(explicit) {
  const executable = process.platform === 'win32' ? 'recorder-engine.exe' : 'recorder-engine';
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', executable));
  candidates.push(
    path.resolve(__dirname, '..', 'build', 'bin', executable),
    path.resolve(__dirname, '..', 'engine', 'target', 'release', executable),
    path.resolve(__dirname, '..', 'engine', 'target', 'debug', executable),
    path.resolve(__dirname, '..', 'bin', executable),
    path.resolve(process.cwd(), 'build', 'bin', executable),
    path.resolve(process.cwd(), 'engine', 'target', 'release', executable),
    path.resolve(process.cwd(), 'engine', 'target', 'debug', executable),
  );
  return [...new Set(candidates)];
}

function findEngine(explicit) {
  const candidates = candidateEnginePaths(explicit);
  const found = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(`未找到 recorder-engine${process.platform === 'win32' ? '.exe' : ''}\n已检查:\n${candidates.map((item) => `  ${item}`).join('\n')}\n源码环境请先执行 npm run build:engine:release。`);
  }
  return found;
}

class EngineClient {
  constructor(executable, runDirectory, protocolLogPath, stderrPath) {
    this.executable = executable;
    this.runDirectory = runDirectory;
    this.protocolLog = new NdjsonLog(protocolLogPath);
    this.stderrPath = stderrPath;
    this.stderrFd = fs.openSync(stderrPath, 'a+');
    this.stderrText = '';
    this.pending = new Map();
    this.requestSequence = 0;
    this.latestMeter = null;
    this.meterWindow = null;
    this.readyPayload = null;
    this.exitResult = null;
    this.shutdownResult = null;
    this.child = null;
    this.readyPromise = null;
    this.exitPromise = null;
  }

  async start() {
    const scriptEngine = /\.(?:cjs|mjs|js)$/i.test(this.executable);
    this.child = spawn(scriptEngine ? process.execPath : this.executable, scriptEngine ? [this.executable] : [], {
      cwd: this.runDirectory,
      stdio: ['pipe', 'pipe', this.stderrFd],
      detached: true,
      windowsHide: true,
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('engine_ready 超时')), 20_000);
      this.resolveReady = (payload) => {
        clearTimeout(timer);
        resolve(payload);
      };
      this.rejectReady = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exitResult = { code, signal, at: new Date().toISOString() };
        const error = new Error(`引擎已退出 (code=${code}, signal=${signal})`);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        if (!this.readyPayload) this.rejectReady(error);
        resolve(this.exitResult);
      });
    });
    this.child.once('error', (error) => this.rejectReady(error));

    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line));
    await this.readyPromise;
    if (Number(this.readyPayload?.protocol_version) !== PROTOCOL_VERSION) {
      throw new Error(`引擎协议版本不匹配: ${this.readyPayload?.protocol_version}`);
    }
    return this.readyPayload;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.protocolLog.write({ at: new Date().toISOString(), direction: 'engine', invalid_json: line, error: error.message }, true);
      return;
    }
    if (message.event === 'meter') {
      this.latestMeter = { ...message.payload, observed_at: new Date().toISOString() };
      if (!this.meterWindow) {
        this.meterWindow = {
          peak: Number(message.payload?.peak ?? 0),
          rms: Number(message.payload?.rms ?? 0),
        };
      } else {
        this.meterWindow.peak = Math.max(this.meterWindow.peak, Number(message.payload?.peak ?? 0));
        this.meterWindow.rms = Math.max(this.meterWindow.rms, Number(message.payload?.rms ?? 0));
      }
      return;
    }
    this.protocolLog.write({ at: new Date().toISOString(), direction: 'engine', message }, message.event?.includes('fault'));
    if (message.event === 'engine_ready') {
      this.readyPayload = message.payload ?? message;
      this.resolveReady(this.readyPayload);
      return;
    }
    if (!message.request_id) return;
    const pending = this.pending.get(message.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.request_id);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new Error(`${message.error?.code ?? 'COMMAND_FAILED'}: ${message.error?.message ?? 'unknown engine error'}`));
  }

  async request(command, payload = {}, timeoutMs = 30_000) {
    await this.readyPromise;
    if (!this.child || this.exitResult) throw new Error('引擎不在运行');
    const requestId = `acceptance-${process.pid}-${++this.requestSequence}`;
    const envelope = { protocol_version: PROTOCOL_VERSION, request_id: requestId, command, payload };
    this.protocolLog.write({ at: new Date().toISOString(), direction: 'tool', message: envelope }, command === 'stop_session');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${command} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, command });
      this.child.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  consumeMeterWindow() {
    const latest = this.latestMeter ?? {};
    const window = this.meterWindow;
    this.meterWindow = null;
    return {
      ...latest,
      peak: Math.max(Number(latest.peak ?? 0), Number(window?.peak ?? 0)),
      rms: Math.max(Number(latest.rms ?? 0), Number(window?.rms ?? 0)),
    };
  }

  async shutdown() {
    if (!this.child || this.exitResult) {
      this.shutdownResult = this.exitResult;
      return this.exitResult;
    }
    let shutdownError = null;
    try {
      await this.request('shutdown', {}, SHUTDOWN_REQUEST_TIMEOUT_MS);
    } catch (error) {
      shutdownError = error;
    }
    this.child.stdin.end();
    // Clear the losing timeout when the child exits. A bare Promise.race with
    // sleep() would keep Node alive for another 30 seconds after a clean exit.
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ code: null, signal: null, timeout: true, at: new Date().toISOString() }),
        SHUTDOWN_EXIT_TIMEOUT_MS,
      );
      this.exitPromise.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    this.shutdownResult = exit.timeout === true ? this.detachTimedOutChild(exit) : exit;
    if (shutdownError) throw shutdownError;
    return this.shutdownResult;
  }

  detachTimedOutChild(exit) {
    const pid = this.child?.pid ?? null;
    this.protocolLog.write({
      at: new Date().toISOString(),
      direction: 'tool',
      event: 'engine_shutdown_timeout_detached',
      pid,
      detail: '引擎未被强制结束；标准输入已关闭，它可继续安全封存后自行退出。',
    }, true);
    // The recorder protocol writer deliberately ignores a closed stdout. Its
    // stderr is a directly inherited log file rather than a pipe, so detaching
    // the parent cannot make Rust panic while it continues sealing. Never call
    // kill() here: a timed-out engine may still own the only durable tail.
    this.child?.stdout?.destroy();
    this.child?.stdin?.destroy();
    this.child?.unref();
    return { ...exit, detached: true, pid };
  }

  refreshStderrText() {
    if (this.stderrFd === null) return this.stderrText;
    try {
      fs.fsyncSync(this.stderrFd);
      const size = fs.fstatSync(this.stderrFd).size;
      const length = Math.min(size, 1_000_000);
      const bytes = Buffer.alloc(length);
      if (length > 0) fs.readSync(this.stderrFd, bytes, 0, length, size - length);
      this.stderrText = bytes.toString('utf8');
    } catch {
      // The acceptance report still records a clean-exit failure if log I/O is
      // unavailable; do not hide the primary shutdown result behind log tailing.
    }
    return this.stderrText;
  }

  closeLogs() {
    this.refreshStderrText();
    this.protocolLog.close();
    if (this.stderrFd !== null) {
      fs.fsyncSync(this.stderrFd);
      fs.closeSync(this.stderrFd);
      this.stderrFd = null;
    }
  }
}

function printDevices(inventory) {
  const devices = Array.isArray(inventory?.devices) ? inventory.devices : [];
  process.stdout.write('\n可用输入设备:\n');
  for (const [index, device] of devices.entries()) {
    const marker = device.is_default ? ' [默认]' : '';
    process.stdout.write(`  ${index + 1}. ${device.name}${marker}\n     ID: ${device.id}\n`);
    for (const config of device.configurations ?? []) {
      process.stdout.write(`     ${config.min_sample_rate}–${config.max_sample_rate} Hz / ${config.channels} ch / ${config.sample_format}\n`);
    }
  }
  if (devices.length === 0) process.stdout.write('  （没有可用输入设备）\n');
}

async function selectDevice(inventory, options) {
  const devices = Array.isArray(inventory?.devices) ? inventory.devices : [];
  if (devices.length === 0) throw new Error('引擎未枚举到任何可用输入设备');
  let selected = null;
  if (options.deviceId) selected = devices.find((device) => device.id === options.deviceId);
  if (options.deviceId && !selected) throw new Error(`未找到 --device-id ${options.deviceId}`);
  if (!selected && options.deviceIndex !== null) selected = devices[options.deviceIndex - 1];
  if (options.deviceIndex !== null && !selected) throw new Error(`--device-index ${options.deviceIndex} 超出范围`);
  const defaultIndex = Math.max(0, devices.findIndex((device) => device.id === inventory.default_device_id));
  if (!selected && !options.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = createPrompt({ input: process.stdin, output: process.stdout });
    try {
      const answer = await prompt.question(`选择设备序号 [${defaultIndex + 1}]: `);
      const index = answer.trim() === '' ? defaultIndex : parseInteger(answer.trim(), '设备序号') - 1;
      selected = devices[index];
      if (!selected) throw new Error('设备序号超出范围');
    } finally {
      prompt.close();
    }
  }
  if (!selected) selected = devices[defaultIndex] ?? devices[0];
  return selected;
}

function matchingConfigurations(device, sampleRate, inputChannel) {
  return (device.configurations ?? []).filter(
    (config) =>
      Number(config.min_sample_rate) <= sampleRate &&
      Number(config.max_sample_rate) >= sampleRate &&
      Number(config.channels) >= inputChannel,
  );
}

function replugInventoryEvidence(inventory, selected, options) {
  const devices = Array.isArray(inventory?.devices) ? inventory.devices : [];
  const endpointMatches = devices.filter((device) => device?.id === selected?.id);
  const exact = endpointMatches.length === 1 ? endpointMatches[0] : null;
  const nameMatches = exact?.name === selected?.name;
  const configurationMatches = Boolean(
    exact && matchingConfigurations(exact, options.sampleRate, options.channel).length > 0,
  );
  return {
    target_id: selected?.id ?? null,
    target_name: selected?.name ?? null,
    observed_device_ids: devices.map((device) => device?.id).filter(Boolean),
    observed_same_name_ids: devices
      .filter((device) => device?.name === selected?.name)
      .map((device) => device?.id)
      .filter(Boolean),
    target_match_count: endpointMatches.length,
    target_present: endpointMatches.length > 0,
    target_name_matches: nameMatches,
    target_configuration_matches: configurationMatches,
    exact_match: endpointMatches.length === 1 && nameMatches && configurationMatches,
    target_device: exact,
  };
}

function replugPollTimeoutMs(options) {
  return testTimeout(
    'DATABAKER_ACCEPTANCE_TEST_REPLUG_TIMEOUT_MS',
    options.faultTimeoutSeconds * 1_000,
  );
}

function replugInventoryTelemetry(state, evidence, consecutiveMatches = 0) {
  return {
    at: new Date().toISOString(),
    phase: 'replug-inventory',
    state,
    ...evidence,
    consecutive_matches: consecutiveMatches,
  };
}

function segmentStatSnapshot(sessionDirectory) {
  const directory = path.join(sessionDirectory, 'audio', 'segments');
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => /^master-\d{6}\.wav$/i.test(name)).sort();
  } catch (error) {
    return { files: [], total_bytes: 0, error: error.message };
  }
  const files = [];
  let totalBytes = 0;
  for (const name of names) {
    const filePath = path.join(directory, name);
    try {
      const stat = fs.statSync(filePath);
      files.push({ name, bytes: stat.size, modified_at: stat.mtime.toISOString() });
      totalBytes += stat.size;
    } catch (error) {
      return { files, total_bytes: totalBytes, error: error.message };
    }
  }
  return { files, total_bytes: totalBytes, error: null };
}

function inspectWav(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`不是普通 WAV 文件或文件是链接: ${filePath}`);
  if (stat.size < 12) throw new Error(`WAV 文件过短: ${filePath}`);
  const fd = fs.openSync(filePath, 'r');
  let buffer;
  try {
    const readLength = Math.min(stat.size, 1024 * 1024);
    buffer = Buffer.alloc(readLength);
    fs.readSync(fd, buffer, 0, readLength, 0);
  } finally {
    fs.closeSync(fd);
  }
  const containerId = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);
  const isRf64 = containerId === 'RF64';
  if ((containerId !== 'RIFF' && !isRf64) || wave !== 'WAVE') {
    throw new Error(`不是受支持的 RIFF/RF64 WAVE: ${filePath}`);
  }
  const riffSize32 = buffer.readUInt32LE(4);
  const toSafeNumber = (value, field) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${field} 超出 JavaScript 安全整数范围: ${value}`);
    }
    return Number(value);
  };
  let offset = 12;
  let format = null;
  let factFrames = null;
  let ds64 = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size32 = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (id === 'ds64' && size32 >= 28 && payloadOffset + 28 <= buffer.length) {
      ds64 = {
        riff_size: toSafeNumber(buffer.readBigUInt64LE(payloadOffset), 'ds64.riff_size'),
        data_bytes: toSafeNumber(buffer.readBigUInt64LE(payloadOffset + 8), 'ds64.data_bytes'),
        sample_count: toSafeNumber(buffer.readBigUInt64LE(payloadOffset + 16), 'ds64.sample_count'),
        table_length: buffer.readUInt32LE(payloadOffset + 24),
      };
    } else if (id === 'fmt ' && size32 >= 16 && payloadOffset + 16 <= buffer.length) {
      format = {
        format_code: buffer.readUInt16LE(payloadOffset),
        channels: buffer.readUInt16LE(payloadOffset + 2),
        sample_rate: buffer.readUInt32LE(payloadOffset + 4),
        byte_rate: buffer.readUInt32LE(payloadOffset + 8),
        block_align: buffer.readUInt16LE(payloadOffset + 12),
        bits_per_sample: buffer.readUInt16LE(payloadOffset + 14),
      };
    } else if (id === 'fact' && size32 >= 4 && payloadOffset + 4 <= buffer.length) {
      factFrames = buffer.readUInt32LE(payloadOffset);
    } else if (id === 'data') {
      data = { size_32: size32, offset: payloadOffset };
      break;
    }
    const next = payloadOffset + size32 + (size32 % 2);
    if (next <= offset || next > buffer.length) break;
    offset = next;
  }
  if (!format || !data) throw new Error(`WAV 缺少 fmt 或 data chunk: ${filePath}`);
  if (isRf64 && !ds64) throw new Error(`RF64 缺少 ds64 chunk: ${filePath}`);
  const declaredDataBytes = isRf64 ? ds64.data_bytes : data.size_32;
  const physicalPayloadBytes = Math.max(0, stat.size - data.offset);
  const expectedPaddingBytes = declaredDataBytes % 2;
  const payloadMatchesDeclared =
    physicalPayloadBytes === declaredDataBytes ||
    physicalPayloadBytes === declaredDataBytes + expectedPaddingBytes;
  // A finalized export may carry one RIFF word-alignment byte after audio. A
  // recoverable recording segment currently has no padding, and a stale header
  // can legitimately describe fewer bytes than are physically durable. Only
  // strip padding when the complete container sizes prove it is intentional.
  const physicalDataBytes = payloadMatchesDeclared ? declaredDataBytes : physicalPayloadBytes;
  const wordPaddingBytes = payloadMatchesDeclared ? physicalPayloadBytes - declaredDataBytes : 0;
  const blockAlign = format.block_align;
  const formatErrors = [];
  const expectedSampleBytes = format.bits_per_sample / 8;
  const expectedBlockAlign = format.channels * expectedSampleBytes;
  if (!Number.isInteger(expectedSampleBytes) || expectedSampleBytes <= 0) {
    formatErrors.push(`bits_per_sample ${format.bits_per_sample} 不是整字节样本`);
  }
  if (format.channels <= 0 || format.sample_rate <= 0) {
    formatErrors.push('channels / sample_rate 必须大于 0');
  }
  if (!Number.isInteger(expectedBlockAlign) || blockAlign !== expectedBlockAlign) {
    formatErrors.push(`block_align=${blockAlign}，期望 ${expectedBlockAlign}`);
  }
  const expectedByteRate = format.sample_rate * expectedBlockAlign;
  if (!Number.isSafeInteger(expectedByteRate) || format.byte_rate !== expectedByteRate) {
    formatErrors.push(`byte_rate=${format.byte_rate}，期望 ${expectedByteRate}`);
  }
  const supportedEncoding =
    (format.format_code === 1 && (format.bits_per_sample === 16 || format.bits_per_sample === 24)) ||
    (format.format_code === 3 && format.bits_per_sample === 32);
  if (!supportedEncoding) {
    formatErrors.push(`不支持的 format_code/bit_depth: ${format.format_code}/${format.bits_per_sample}`);
  }
  const formatValid = formatErrors.length === 0;
  const completeFrames = blockAlign > 0 ? Math.floor(physicalDataBytes / blockAlign) : 0;
  const trailingBytes = blockAlign > 0 ? physicalDataBytes % blockAlign : physicalDataBytes;
  const declaredFrames = blockAlign > 0 ? Math.floor(declaredDataBytes / blockAlign) : 0;
  const exactRiffHeader =
    !isRf64 &&
    riffSize32 !== 0xffffffff &&
    riffSize32 + 8 === stat.size &&
    payloadMatchesDeclared &&
    formatValid &&
    trailingBytes === 0 &&
    (format.format_code !== 3 || factFrames === completeFrames);
  const exactRf64Header =
    isRf64 &&
    riffSize32 === 0xffffffff &&
    data.size_32 === 0xffffffff &&
    ds64.riff_size + 8 === stat.size &&
    ds64.sample_count === completeFrames &&
    payloadMatchesDeclared &&
    formatValid &&
    ds64.table_length === 0 &&
    wordPaddingBytes === expectedPaddingBytes &&
    trailingBytes === 0 &&
    (format.format_code !== 3 || factFrames === 0xffffffff);
  const exactHeader = exactRiffHeader || exactRf64Header;
  return {
    path: filePath,
    file_name: path.basename(filePath),
    file_bytes: stat.size,
    container: isRf64 ? 'rf64' : 'riff',
    riff_size: isRf64 ? ds64.riff_size : riffSize32,
    riff_size_32: riffSize32,
    ds64,
    ...format,
    format_valid: formatValid,
    format_errors: formatErrors,
    encoding: format.format_code === 1 ? 'pcm' : format.format_code === 3 ? 'float' : `format-${format.format_code}`,
    data_offset: data.offset,
    data_size_32: data.size_32,
    declared_data_bytes: declaredDataBytes,
    physical_payload_bytes: physicalPayloadBytes,
    physical_data_bytes: physicalDataBytes,
    word_padding_bytes: wordPaddingBytes,
    declared_frames: declaredFrames,
    physical_complete_frames: completeFrames,
    trailing_bytes: trailingBytes,
    fact_frames: factFrames,
    duration_seconds: format.sample_rate > 0 ? completeFrames / format.sample_rate : 0,
    exact_header: exactHeader,
  };
}

function inspectDirectory(result, directory, label) {
  try {
    const metadata = fs.lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      result.tree_errors.push(`${label} 必须是真实目录，不能是链接: ${directory}`);
      return false;
    }
    return true;
  } catch (error) {
    result.tree_errors.push(`${label} 无法读取: ${directory}: ${error.message}`);
    return false;
  }
}

function inspectionJson(result, filePath, label) {
  try {
    return readJsonRegularFile(filePath, label);
  } catch (error) {
    result.metadata_errors.push(error.message);
    return null;
  }
}

function expectedSegmentFrames(snapshot) {
  const explicit = Number(snapshot?.segment_frames);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  const sampleRate = Number(snapshot?.audio_format?.sample_rate);
  return Number.isSafeInteger(sampleRate) && sampleRate > 0 ? sampleRate * 300 : null;
}

function validateSegmentDescriptor(result, descriptorPath, descriptorIndex, segmentName) {
  let descriptor;
  try {
    descriptor = readJsonRegularFile(descriptorPath, 'WAV segment descriptor', 4 * 1024);
  } catch (error) {
    try {
      const metadata = fs.lstatSync(descriptorPath);
      if (metadata.isDirectory()) result.descriptor_errors.push(error.message);
      else result.descriptor_issues.push(error.message);
    } catch {
      result.descriptor_issues.push(error.message);
    }
    result.segment_descriptors.push({
      path: descriptorPath,
      segment_index: descriptorIndex,
      valid: false,
      descriptor: null,
    });
    return false;
  }
  const snapshot = result.snapshot;
  const bitDepth = Number(snapshot?.audio_format?.bit_depth);
  const expected = {
    schema_version: 1,
    kind: SEGMENT_DESCRIPTOR_KIND,
    segment_index: descriptorIndex,
    segment_file: segmentName,
    sample_rate: Number(snapshot?.audio_format?.sample_rate),
    channels: 1,
    bit_depth: bitDepth,
    encoding: bitDepth === 32 ? 'float' : 'pcm',
    header_len: bitDepth === 32 ? 56 : 44,
    max_frames_per_segment: expectedSegmentFrames(snapshot),
  };
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = descriptor && typeof descriptor === 'object' ? Object.keys(descriptor).sort() : [];
  const exactKeys = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
  const exactValues = exactKeys && expectedKeys.every((key) => descriptor[key] === expected[key]);
  if (!exactValues) {
    result.descriptor_issues.push(
      `WAV segment descriptor 与会话格式、编号或文件名不匹配: ${descriptorPath}`,
    );
  }
  result.segment_descriptors.push({
    path: descriptorPath,
    segment_index: descriptorIndex,
    valid: exactValues,
    descriptor,
  });
  return exactValues;
}

function inspectSession(sessionDirectory) {
  const result = {
    session_dir: sessionDirectory,
    exists: false,
    snapshot: null,
    session_summary: null,
    fault_marker: null,
    fault_marker_exists: false,
    fault_marker_parse_error: false,
    fault_marker_temporary_exists: false,
    tree_errors: [],
    metadata_errors: [],
    segments: [],
    segment_errors: [],
    segment_error_details: [],
    segment_layout_errors: [],
    descriptor_errors: [],
    descriptor_issues: [],
    segment_descriptors: [],
    preseal_recovery_errors: [],
    total_physical_frames: 0,
    total_file_bytes: 0,
    full_track: null,
    full_track_error: null,
    export_bundle_present: false,
    export_status: null,
    export_metadata: null,
    export_csv: null,
    export_sentence_wavs: [],
    export_sentence_file_names: [],
    export_bundle_errors: [],
  };
  if (!inspectDirectory(result, sessionDirectory, '录制根目录')) return result;
  result.exists = true;
  const audioDirectory = path.join(sessionDirectory, 'audio');
  const metadataDirectory = path.join(sessionDirectory, 'metadata');
  const scriptDirectory = path.join(sessionDirectory, 'script');
  const segmentDirectory = path.join(audioDirectory, 'segments');
  const audioSafe = inspectDirectory(result, audioDirectory, 'audio');
  const metadataSafe = inspectDirectory(result, metadataDirectory, 'metadata');
  inspectDirectory(result, scriptDirectory, 'script');
  const segmentsSafe = audioSafe && inspectDirectory(result, segmentDirectory, 'audio/segments');
  if (metadataSafe) {
    result.snapshot = inspectionJson(
      result,
      path.join(metadataDirectory, 'items.snapshot.json'),
      '会话快照',
    );
    result.session_summary = inspectionJson(result, path.join(sessionDirectory, 'session.json'), '会话摘要');
  }
  const faultMarkerPath = path.join(sessionDirectory, 'metadata', 'audio-fault.json');
  if (metadataSafe) {
    result.fault_marker_exists = pathEntryExists(faultMarkerPath);
    if (result.fault_marker_exists) {
      try {
        result.fault_marker = readJsonRegularFile(faultMarkerPath, '音频故障标记');
      } catch (error) {
        result.fault_marker_parse_error = true;
        result.metadata_errors.push(error.message);
      }
    }
    result.fault_marker_temporary_exists = pathEntryExists(path.join(sessionDirectory, 'metadata', 'audio-fault.tmp'));
  }
  let segmentEntries = [];
  const descriptors = new Map();
  if (segmentsSafe) {
    try {
      for (const entry of fs.readdirSync(segmentDirectory, { withFileTypes: true })) {
        const name = entry.name;
        const segmentMatch = /^master-(\d{6})\.wav$/.exec(name);
        const descriptorMatch = /^master-(\d{6})\.wav\.descriptor\.json$/.exec(name);
        if (segmentMatch) {
          const index = Number(segmentMatch[1]);
          segmentEntries.push({ index, name, path: path.join(segmentDirectory, name) });
        } else if (descriptorMatch) {
          descriptors.set(Number(descriptorMatch[1]), {
            name,
            path: path.join(segmentDirectory, name),
          });
        } else if (/^\.?master-/i.test(name)) {
          result.segment_layout_errors.push(`无效或未清理的分段文件名: ${name}`);
        }
      }
    } catch (error) {
      result.segment_layout_errors.push(error.message);
    }
  }
  segmentEntries.sort((left, right) => left.index - right.index);
  for (const [offset, segment] of segmentEntries.entries()) {
    const expectedIndex = offset + 1;
    if (segment.index !== expectedIndex) {
      result.segment_layout_errors.push(
        `分段编号必须从 master-000001.wav 连续递增；位置 ${expectedIndex} 实际为 ${segment.name}`,
      );
    }
    try {
      const wav = inspectWav(segment.path);
      wav.segment_index = segment.index;
      result.segments.push(wav);
      result.total_physical_frames += wav.physical_complete_frames;
      result.total_file_bytes += wav.file_bytes;
    } catch (error) {
      result.segment_errors.push(`${segment.name}: ${error.message}`);
      result.segment_error_details.push({
        segment_index: segment.index,
        file_name: segment.name,
        error: error.message,
      });
    }
    const descriptor = descriptors.get(segment.index);
    if (descriptor) validateSegmentDescriptor(result, descriptor.path, segment.index, segment.name);
  }
  for (const [index, descriptor] of descriptors) {
    if (!segmentEntries.some((segment) => segment.index === index)) {
      try {
        const metadata = fs.lstatSync(descriptor.path);
        const kind = metadata.isDirectory()
          ? 'directory'
          : metadata.isSymbolicLink()
            ? 'link'
            : metadata.isFile()
              ? 'file'
              : 'other';
        result.descriptor_errors.push(
          `WAV descriptor 没有对应分段，拒绝作为封存会话通过: ${descriptor.name} (${kind})`,
        );
      } catch (error) {
        result.descriptor_errors.push(`无法检查孤立 WAV descriptor ${descriptor.name}: ${error.message}`);
      }
    }
  }
  const lastSegment = segmentEntries.at(-1) ?? null;
  for (const detail of result.segment_error_details) {
    if (!lastSegment || detail.segment_index !== lastSegment.index) {
      result.preseal_recovery_errors.push(
        `已闭合分段无法严格解析，离线恢复不得重建: ${detail.file_name}`,
      );
      continue;
    }
    const descriptorValid = result.segment_descriptors.some(
      (descriptor) => descriptor.segment_index === detail.segment_index && descriptor.valid === true,
    );
    if (!descriptorValid) {
      result.preseal_recovery_errors.push(
        `末段 WAV 头无法解析且缺少有效恢复 descriptor: ${detail.file_name}`,
      );
    }
  }
  const maxFrames = expectedSegmentFrames(result.snapshot);
  if (Number.isSafeInteger(maxFrames) && maxFrames > 0 && result.segments.length > 0) {
    for (const [index, wav] of result.segments.entries()) {
      const isLast = index === result.segments.length - 1;
      if (!isLast && wav.physical_complete_frames !== maxFrames) {
        result.segment_layout_errors.push(
          `已闭合分段 ${wav.file_name} 应为 ${maxFrames} 帧，实际 ${wav.physical_complete_frames}`,
        );
      }
      if (isLast && wav.physical_complete_frames > maxFrames) {
        result.segment_layout_errors.push(
          `末分段 ${wav.file_name} 超过固定上限 ${maxFrames} 帧`,
        );
      }
    }
  }
  const exportDirectory = path.join(sessionDirectory, 'export');
  const previewDirectory = path.join(sessionDirectory, 'preview');
  if (pathEntryExists(previewDirectory)) inspectDirectory(result, previewDirectory, 'preview');
  const exportExists = pathEntryExists(exportDirectory);
  const exportSafe = !exportExists || inspectDirectory(result, exportDirectory, 'export');
  const fullTrack = path.join(exportDirectory, 'full-track.wav');
  const exportStatusPath = path.join(exportDirectory, 'status.json');
  const exportMetadataPath = path.join(exportDirectory, 'metadata.json');
  const exportCsvPath = path.join(exportDirectory, 'metadata.csv');
  const bundlePaths = [fullTrack, exportStatusPath, exportMetadataPath, exportCsvPath];
  result.export_bundle_present = exportExists && exportSafe && bundlePaths.some(pathEntryExists);
  if (result.export_bundle_present) {
    const requiredBundleFiles = [
      [fullTrack, '整轨 WAV'],
      [exportStatusPath, '导出提交状态'],
      [exportMetadataPath, '导出 metadata.json'],
      [exportCsvPath, '导出 metadata.csv'],
    ];
    for (const [requiredPath, label] of requiredBundleFiles) {
      if (!pathEntryExists(requiredPath)) result.export_bundle_errors.push(`${label} 缺失: ${requiredPath}`);
    }
  }
  if (result.export_bundle_present && pathEntryExists(exportStatusPath)) {
    try {
      result.export_status = readJsonRegularFile(exportStatusPath, '导出提交状态');
    } catch (error) {
      result.export_bundle_errors.push(error.message);
    }
  }
  if (result.export_bundle_present && pathEntryExists(exportMetadataPath)) {
    try {
      result.export_metadata = readJsonRegularFile(exportMetadataPath, '导出 metadata.json', 16 * 1024 * 1024);
    } catch (error) {
      result.export_bundle_errors.push(error.message);
    }
  }
  if (result.export_bundle_present && pathEntryExists(exportCsvPath)) {
    try {
      const text = readTextRegularFile(exportCsvPath, '导出 metadata.csv');
      result.export_csv = {
        bytes: Buffer.byteLength(text),
        header: text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0],
        matches_metadata: Array.isArray(result.export_metadata?.exported) &&
          text.replace(/^\uFEFF/, '') === expectedExportCsv(result.export_metadata.exported),
      };
    } catch (error) {
      result.export_bundle_errors.push(error.message);
    }
  }
  if (result.export_bundle_present && exportSafe) {
    const sentenceDirectory = path.join(exportDirectory, 'sentences');
    if (inspectDirectory(result, sentenceDirectory, 'export/sentences')) {
      try {
        result.export_sentence_file_names = fs.readdirSync(sentenceDirectory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.wav$/i.test(entry.name))
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        result.export_bundle_errors.push(`无法枚举导出单句 WAV: ${error.message}`);
      }
    } else {
      result.export_bundle_errors.push('导出 sentences 目录缺失或不是真实目录');
    }
  }
  const exportedRows = Array.isArray(result.export_metadata?.exported)
    ? result.export_metadata.exported
    : [];
  for (const row of exportedRows) {
    const relativeFile = typeof row?.file === 'string' ? row.file.replace(/\\/g, '/') : '';
    const match = /^sentences\/([^/]+\.wav)$/.exec(relativeFile);
    if (!match) {
      result.export_bundle_errors.push(`导出条目文件路径无效: ${String(row?.file)}`);
      continue;
    }
    const sentencePath = path.join(exportDirectory, 'sentences', match[1]);
    try {
      result.export_sentence_wavs.push(inspectWav(sentencePath));
    } catch (error) {
      result.export_bundle_errors.push(`导出条目 WAV 无效 ${relativeFile}: ${error.message}`);
    }
  }
  if (exportExists && exportSafe && pathEntryExists(fullTrack)) {
    try {
      result.full_track = inspectWav(fullTrack);
    } catch (error) {
      result.full_track_error = error.message;
    }
  }
  return result;
}

function faultMarkerPresent(inspection) {
  return Boolean(inspection?.fault_marker_exists || inspection?.fault_marker_temporary_exists);
}

function summarizeProgress(rows, sampleRate, pollSeconds) {
  let capturedMonotonic = true;
  let committedMonotonic = true;
  let bytesMonotonic = true;
  let previous = null;
  let lastGrowthElapsed = null;
  let maxGrowthStallSeconds = 0;
  let maxCommitLagSamples = 0;
  let maxPeak = 0;
  let maxRms = 0;
  let firstFault = null;
  let firstCritical = null;
  for (const row of rows) {
    const captured = Number(row.captured_samples ?? 0);
    const committed = Number(row.committed_samples ?? 0);
    const totalBytes = Number(row.segment_total_bytes ?? 0);
    maxCommitLagSamples = Math.max(maxCommitLagSamples, Math.max(0, captured - committed));
    maxPeak = Math.max(maxPeak, Number(row.peak ?? 0));
    maxRms = Math.max(maxRms, Number(row.rms ?? 0));
    if (!firstFault && (row.faulted || Number(row.overflow_samples ?? 0) > 0 || row.fault_marker_exists)) firstFault = row;
    if (!firstCritical && row.storage_status === 'critical') firstCritical = row;
    if (previous) {
      if (captured < Number(previous.captured_samples ?? 0)) capturedMonotonic = false;
      if (committed < Number(previous.committed_samples ?? 0)) committedMonotonic = false;
      if (totalBytes < Number(previous.segment_total_bytes ?? 0)) bytesMonotonic = false;
      if (totalBytes > Number(previous.segment_total_bytes ?? 0)) lastGrowthElapsed = row.elapsed_seconds;
      if (lastGrowthElapsed !== null && captured > Number(previous.captured_samples ?? 0)) {
        maxGrowthStallSeconds = Math.max(maxGrowthStallSeconds, row.elapsed_seconds - lastGrowthElapsed);
      }
    } else if (totalBytes > 0) {
      lastGrowthElapsed = row.elapsed_seconds;
    }
    previous = row;
  }
  const first = rows[0] ?? null;
  const last = rows.at(-1) ?? null;
  const capturedDelta = first && last ? Number(last.captured_samples ?? 0) - Number(first.captured_samples ?? 0) : 0;
  const elapsedDelta = first && last ? Number(last.elapsed_seconds) - Number(first.elapsed_seconds) : 0;
  return {
    sample_count: rows.length,
    first,
    last,
    captured_monotonic: capturedMonotonic,
    committed_monotonic: committedMonotonic,
    file_bytes_monotonic: bytesMonotonic,
    max_file_growth_stall_seconds: maxGrowthStallSeconds,
    allowed_file_growth_stall_seconds: Math.max(10, pollSeconds * 3),
    max_commit_lag_samples: maxCommitLagSamples,
    max_commit_lag_seconds: sampleRate > 0 ? maxCommitLagSamples / sampleRate : null,
    observed_capture_rate: elapsedDelta > 0 ? capturedDelta / elapsedDelta : null,
    maximum_peak: maxPeak,
    maximum_peak_dbfs: linearToDbfs(maxPeak),
    maximum_rms: maxRms,
    maximum_rms_dbfs: linearToDbfs(maxRms),
    first_fault: firstFault,
    first_storage_critical: firstCritical,
  };
}

function addCheck(checks, id, label, passed, details, severity = 'FAIL') {
  const status = passed ? 'PASS' : severity;
  checks.push({ id, label, status, details });
}

function engineExitWasClean(engine) {
  const exit = engine?.exit;
  return !engine?.shutdown_error &&
    Boolean(exit) &&
    exit.timeout !== true &&
    exit.code === 0 &&
    (exit.signal === null || exit.signal === undefined);
}

function addEngineExitCheck(checks, engine) {
  addCheck(
    checks,
    'engine-clean-exit',
    '原生引擎安全收尾并正常退出',
    engineExitWasClean(engine),
    {
      exit: engine?.exit ?? null,
      shutdown_error: engine?.shutdown_error ?? null,
    },
  );
}

function evaluateInventory(inventory) {
  const checks = [];
  const devices = inventory.devices ?? [];
  addCheck(checks, 'devices-present', '至少枚举一个输入设备', devices.length > 0, { count: devices.length });
  const ids = devices.map((device) => device.id).filter(Boolean);
  addCheck(checks, 'stable-device-ids', '设备都有非空稳定 ID', ids.length === devices.length, { ids });
  addCheck(checks, 'unique-device-ids', '设备 ID 唯一', new Set(ids).size === ids.length, { ids });
  addCheck(
    checks,
    'driver-configurations',
    '每个设备都暴露可用输入配置',
    devices.every((device) => Array.isArray(device.configurations) && device.configurations.length > 0),
    { configurations_per_device: devices.map((device) => ({ id: device.id, count: device.configurations?.length ?? 0 })) },
  );
  return checks;
}

function evaluateSealedSession(inspection) {
  const checks = [];
  const snapshot = inspection?.snapshot ?? null;
  const summary = inspection?.session_summary ?? null;
  const segments = Array.isArray(inspection?.segments) ? inspection.segments : [];
  const captured = Number(snapshot?.captured_samples);
  const committed = Number(snapshot?.committed_samples);
  const physical = Number(inspection?.total_physical_frames);
  const format = snapshot?.audio_format ?? null;

  addCheck(
    checks,
    'real-recording-tree',
    '会话根目录和固定子目录为真实目录而非链接',
    Array.isArray(inspection?.tree_errors) && inspection.tree_errors.length === 0,
    inspection?.tree_errors,
  );
  addCheck(
    checks,
    'metadata-readable',
    '会话元数据是可解析的普通文件',
    Array.isArray(inspection?.metadata_errors) && inspection.metadata_errors.length === 0,
    inspection?.metadata_errors,
  );
  addCheck(checks, 'snapshot-present', '存在可解析的会话快照', Boolean(snapshot), snapshot);
  addCheck(checks, 'segments-present', '存在可解析的分段 WAV', segments.length > 0, inspection);
  addCheck(
    checks,
    'no-segment-errors',
    '分段 WAV 无解析错误',
    Array.isArray(inspection?.segment_errors) && inspection.segment_errors.length === 0,
    inspection?.segment_errors,
  );
  addCheck(
    checks,
    'segment-layout-valid',
    '分段从 000001 连续编号且已闭合分段长度正确',
    Array.isArray(inspection?.segment_layout_errors) && inspection.segment_layout_errors.length === 0,
    inspection?.segment_layout_errors,
  );
  addCheck(
    checks,
    'segment-descriptors-valid',
    'descriptor 路径没有恢复器无法处理的类型',
    Array.isArray(inspection?.descriptor_errors) && inspection.descriptor_errors.length === 0,
    inspection?.descriptor_errors,
  );
  addCheck(
    checks,
    'segment-descriptor-redundancy',
    '冗余 WAV descriptor 均完整（健康 WAV 不依赖该 sidecar）',
    Array.isArray(inspection?.descriptor_issues) && inspection.descriptor_issues.length === 0,
    inspection?.descriptor_issues,
    'WARN',
  );
  addCheck(
    checks,
    'exact-segment-headers',
    '所有分段 WAV 头部与物理 EOF 精确一致',
    segments.length > 0 && segments.every((wav) => wav.exact_header === true),
    segments.map((wav) => ({
      file: wav.file_name,
      exact_header: wav.exact_header,
      declared_frames: wav.declared_frames,
      physical_frames: wav.physical_complete_frames,
      trailing_bytes: wav.trailing_bytes,
    })),
  );
  addCheck(
    checks,
    'no-trailing-frame-bytes',
    '所有分段都以完整音频帧结束',
    segments.length > 0 && segments.every((wav) => wav.trailing_bytes === 0),
    segments.map((wav) => ({ file: wav.file_name, trailing_bytes: wav.trailing_bytes })),
  );
  addCheck(
    checks,
    'segment-format-consistent',
    '所有分段格式与会话快照一致',
    Boolean(format) && segments.length > 0 && segments.every((wav) =>
      wav.sample_rate === Number(format.sample_rate) &&
      wav.bits_per_sample === Number(format.bit_depth) &&
      wav.channels === 1 &&
      wav.encoding === format.encoding &&
      wav.format_valid === true),
    { audio_format: format, segments: segments.map((wav) => ({
      file: wav.file_name,
      sample_rate: wav.sample_rate,
      bits_per_sample: wav.bits_per_sample,
      channels: wav.channels,
      encoding: wav.encoding,
      format_valid: wav.format_valid,
      format_errors: wav.format_errors,
    })) },
  );
  addCheck(checks, 'stopped-status', '会话已离线封存为 stopped', snapshot?.status === 'stopped', {
    status: snapshot?.status,
  });
  addCheck(checks, 'no-overflow', '会话无音频队列溢出', Number(snapshot?.overflow_samples) === 0, {
    overflow_samples: snapshot?.overflow_samples,
  });
  addCheck(checks, 'no-fault-marker', '会话无故障标记或未完成的故障标记', !faultMarkerPresent(inspection), {
    marker: inspection?.fault_marker,
    final_exists: inspection?.fault_marker_exists,
    parse_error: inspection?.fault_marker_parse_error,
    temporary: inspection?.fault_marker_temporary_exists,
  });
  addCheck(
    checks,
    'exact-sample-watermark',
    '采集、持久化与物理 WAV 样本水位完全一致',
    Number.isSafeInteger(captured) &&
      Number.isSafeInteger(committed) &&
      captured >= 0 &&
      captured === committed &&
      committed === physical,
    { captured_samples: captured, committed_samples: committed, physical_frames: physical },
  );
  addCheck(
    checks,
    'session-summary-consistent',
    '会话摘要与快照的身份、序号和状态一致',
    Boolean(snapshot) &&
      Boolean(summary) &&
      summary.session_id === snapshot.session_id &&
      Number(summary.journal_seq) === Number(snapshot.journal_seq) &&
      summary.status === snapshot.status,
    { snapshot: snapshot ? {
      session_id: snapshot.session_id,
      journal_seq: snapshot.journal_seq,
      status: snapshot.status,
    } : null, session_summary: summary },
  );
  addCheck(
    checks,
    'full-track-readable-if-present',
    '若已生成整轨导出，其 WAV 也必须可严格解析',
    !inspection?.full_track_error,
    { error: inspection?.full_track_error, full_track: inspection?.full_track },
  );
  return checks;
}

function evaluatePhase1Evidence(phase1, options, inspection, currentHost) {
  const checks = [];
  const evidence = phase1?.evidence ?? null;
  const snapshot = inspection?.snapshot ?? null;
  const localEvidence = phase1?.session_evidence ?? null;
  const evidenceFormat = evidence?.audio_format ?? null;
  const snapshotFormat = snapshot?.audio_format ?? null;
  const requiredDuration = Number(evidence?.required_duration_seconds);
  const sampleRate = Number(evidenceFormat?.sample_rate);
  const requiredFrames = Number.isFinite(requiredDuration) && Number.isSafeInteger(sampleRate)
    ? Math.ceil(requiredDuration * sampleRate)
    : Number.NaN;
  const armedCaptured = Number(evidence?.armed_captured_samples);
  const armedCommitted = Number(evidence?.armed_committed_samples);
  const evidenceTailLimit = Number(evidence?.max_tail_loss_samples);
  const requestedTailLimit = Number.isSafeInteger(sampleRate)
    ? Math.ceil(options.maxTailLossSeconds * sampleRate)
    : Number.NaN;
  const effectiveTailLimit = Math.min(evidenceTailLimit, requestedTailLimit);
  const armedAtMs = Date.parse(String(evidence?.armed_at ?? ''));
  const phase2BootedAtMs = Date.parse(String(currentHost?.boot?.booted_at ?? ''));

  addCheck(
    checks,
    'phase1-evidence-schema',
    'phase-1 证据类型、版本、nonce 和 armed 状态有效',
    evidence?.schema_version === 1 &&
      evidence?.kind === POWER_CUT_EVIDENCE_KIND &&
      evidence?.phase === 'armed' &&
      typeof evidence?.nonce === 'string' &&
      evidence.nonce.length >= 16 &&
      /^[0-9a-f]{64}$/.test(String(evidence?.binary_identity?.acceptance_tool_sha256 ?? '')) &&
      /^[0-9a-f]{64}$/.test(String(evidence?.binary_identity?.engine_sha256 ?? '')),
    evidence,
  );
  addCheck(
    checks,
    'phase1-source-bound',
    'phase-1 报告/独立证据与证据内的会话身份一致',
    phase1?.source_kind === 'evidence' ||
      (phase1?.source_kind === 'report' &&
        phase1.report?.mode === 'power-cut' &&
        phase1.report?.power_cut?.phase === 'armed' &&
        phase1.report?.start?.snapshot?.session_id === evidence?.session_id),
    { source_kind: phase1?.source_kind, report_mode: phase1?.report?.mode },
  );
  addCheck(
    checks,
    'session-evidence-bound',
    '会话内证据与独立显式 phase-1 输入逐字段一致',
    localEvidence?.kind === POWER_CUT_EVIDENCE_KIND &&
      !pathsEqual(
        String(phase1?.source_path ?? ''),
        path.join(options.sessionDir, POWER_CUT_SESSION_EVIDENCE),
      ) &&
      isDeepStrictEqual(localEvidence, evidence),
    {
      source_path: phase1?.source_path,
      session_evidence_path: path.join(options.sessionDir, POWER_CUT_SESSION_EVIDENCE),
      source: evidence,
      session_evidence: localEvidence,
    },
  );
  addCheck(
    checks,
    'recording-tree-safe-before-seal',
    '离线封存前会话目录、元数据、分段编号和 descriptor 均未越界',
    Array.isArray(inspection?.tree_errors) && inspection.tree_errors.length === 0 &&
      Array.isArray(inspection?.metadata_errors) && inspection.metadata_errors.length === 0 &&
      Array.isArray(inspection?.segment_layout_errors) && inspection.segment_layout_errors.length === 0 &&
      Array.isArray(inspection?.descriptor_errors) && inspection.descriptor_errors.length === 0 &&
      Array.isArray(inspection?.preseal_recovery_errors) && inspection.preseal_recovery_errors.length === 0,
    {
      tree_errors: inspection?.tree_errors,
      metadata_errors: inspection?.metadata_errors,
      segment_layout_errors: inspection?.segment_layout_errors,
      descriptor_errors: inspection?.descriptor_errors,
      descriptor_issues: inspection?.descriptor_issues,
      preseal_recovery_errors: inspection?.preseal_recovery_errors,
    },
  );
  addCheck(
    checks,
    'interrupted-preseal-status',
    '恢复前状态必须是 recording/stopping，不接受正常 stopped 或已恢复会话',
    snapshot?.status === 'recording' || snapshot?.status === 'stopping',
    { status: snapshot?.status },
  );
  addCheck(
    checks,
    'phase1-session-identity',
    'phase-1 证据与磁盘会话的目录、ID、设备和音频格式完全一致',
    Boolean(snapshot) &&
      pathsEqual(String(evidence?.session_dir ?? ''), options.sessionDir) &&
      snapshot.session_id === evidence?.session_id &&
      snapshot.device_id === evidence?.device_id &&
      snapshot.input_sample_format === evidence?.input_sample_format &&
      snapshotFormat?.sample_rate === evidenceFormat?.sample_rate &&
      snapshotFormat?.bit_depth === evidenceFormat?.bit_depth &&
      snapshotFormat?.encoding === evidenceFormat?.encoding &&
      snapshotFormat?.channels === evidenceFormat?.channels &&
      snapshotFormat?.input_channel === evidenceFormat?.input_channel &&
      snapshotFormat?.input_channels === evidenceFormat?.input_channels,
    { session_dir: options.sessionDir, snapshot, evidence },
  );
  const testEvidence = evidence?.test_only === true;
  const productionEvidence = evidence?.test_only === false && evidence?.production_eligible === true;
  addCheck(
    checks,
    'power-cut-qualification-class',
    '生产恢复只接受生产证据，测试证据必须显式声明且不具备生产资格',
    options.testOnlyPowerCut
      ? testEvidence && evidence?.production_eligible === false
      : productionEvidence,
    {
      requested_test_only: options.testOnlyPowerCut,
      evidence_test_only: evidence?.test_only,
      production_eligible: evidence?.production_eligible,
    },
  );
  const minimumDuration = options.testOnlyPowerCut ? 2 : PRODUCTION_POWER_CUT_SECONDS;
  addCheck(
    checks,
    'phase1-minimum-duration',
    options.testOnlyPowerCut
      ? '短时回归证据已达到明确的 test-only 时长'
      : 'phase-1 持久样本水位和墙钟时长均至少 1 小时',
    Number.isFinite(requiredDuration) &&
      requiredDuration >= minimumDuration &&
      Number(evidence?.wall_elapsed_seconds) >= requiredDuration &&
      Number.isSafeInteger(requiredFrames) &&
      Number.isSafeInteger(armedCommitted) &&
      armedCommitted >= requiredFrames,
    {
      required_duration_seconds: requiredDuration,
      wall_elapsed_seconds: evidence?.wall_elapsed_seconds,
      required_frames: requiredFrames,
      armed_committed_samples: armedCommitted,
    },
  );
  addCheck(
    checks,
    'phase1-tail-budget',
    'armed 时 captured/committed 尾差在已持久的 checkpoint+callback 预算内',
    Number.isSafeInteger(armedCaptured) &&
      Number.isSafeInteger(armedCommitted) &&
      Number.isSafeInteger(evidenceTailLimit) &&
      Number.isSafeInteger(requestedTailLimit) &&
      armedCaptured >= armedCommitted &&
      armedCaptured - armedCommitted <= effectiveTailLimit,
    {
      armed_captured_samples: armedCaptured,
      armed_committed_samples: armedCommitted,
      armed_lag_samples: armedCaptured - armedCommitted,
      evidence_tail_limit_samples: evidenceTailLimit,
      requested_tail_limit_samples: requestedTailLimit,
      effective_tail_limit_samples: effectiveTailLimit,
    },
  );
  const sameHost = evidence?.host?.hostname === currentHost?.hostname &&
    evidence?.host?.platform === currentHost?.platform &&
    evidence?.host?.architecture === currentHost?.architecture;
  const bootChangedAfterArm = Number.isFinite(armedAtMs) &&
    Number.isFinite(phase2BootedAtMs) &&
    currentHost?.boot?.id !== evidence?.host?.boot_id &&
    phase2BootedAtMs > armedAtMs + 1_000;
  addCheck(
    checks,
    'host-rebooted-after-arm',
    'phase-2 在同一主机上且系统启动时间晚于 armed，不接受只杀进程',
    sameHost && bootChangedAfterArm && (options.testOnlyPowerCut || currentHost?.platform === 'win32'),
    { phase1_host: evidence?.host, phase2_host: currentHost, armed_at: evidence?.armed_at },
  );
  return checks;
}

function evaluateCommon(report, options, inspection) {
  const checks = [];
  const snapshot = report.start?.snapshot ?? null;
  const finalSnapshot = report.stop?.result?.snapshot ?? inspection.snapshot;
  const progress = report.progress_summary;
  const selected = report.selected_device;
  addCheck(checks, 'engine-ready', '原生录音引擎启动', Boolean(report.engine?.ready), report.engine);
  addEngineExitCheck(checks, report.engine);
  addCheck(checks, 'device-id-match', '实际设备 ID 与选择一致', snapshot?.device_id === selected?.id, {
    requested: selected?.id,
    actual: snapshot?.device_id,
  });
  addCheck(checks, 'sample-rate-match', '实际会话采样率与请求一致', snapshot?.audio_format?.sample_rate === options.sampleRate, {
    requested: options.sampleRate,
    actual: snapshot?.audio_format?.sample_rate,
  });
  addCheck(checks, 'wav-bit-depth-match', '实际 WAV 交付位深与请求一致', snapshot?.audio_format?.bit_depth === options.bitDepth, {
    requested: options.bitDepth,
    actual: snapshot?.audio_format?.bit_depth,
  });
  addCheck(checks, 'input-channel-match', '选定输入通道生效', snapshot?.audio_format?.input_channel === options.channel, {
    requested: options.channel,
    actual: snapshot?.audio_format?.input_channel,
    hardware_input_channels: snapshot?.audio_format?.input_channels,
  });
  addCheck(checks, 'input-format-recorded', '引擎记录驱动实际输入样本格式', Boolean(snapshot?.input_sample_format), {
    input_sample_format: snapshot?.input_sample_format,
  });
  const actualInputFormatBits = inputSampleFormatBits(snapshot?.input_sample_format);
  addCheck(
    checks,
    'input-format-minimum',
    '驱动输入样本表示未明显低于高精度交付门槛',
    actualInputFormatBits !== null && actualInputFormatBits >= options.minimumInputFormatBits,
    {
      input_sample_format: snapshot?.input_sample_format,
      actual_effective_precision_bits: actualInputFormatBits,
      minimum_effective_precision_bits: options.minimumInputFormatBits,
      effective_precision_rule: 'integer n-bit = n; f32 = 24; f64 = 53',
      limitation: '此项只验证驱动交给应用的数字样本有效精度，不证明声卡 ADC ENOB',
    },
  );
  addCheck(checks, 'captured-monotonic', '采集样本水位单调', progress.captured_monotonic, progress);
  addCheck(checks, 'committed-monotonic', '持久化样本水位单调', progress.committed_monotonic, progress);
  addCheck(checks, 'file-growth-monotonic', '分段 WAV 总字节数单调', progress.file_bytes_monotonic, progress);
  addCheck(
    checks,
    'commit-lag',
    `采集与持久化水位差不超过 ${MAX_NORMAL_COMMIT_LAG_SECONDS} 秒`,
    progress.max_commit_lag_seconds !== null &&
      progress.max_commit_lag_seconds <= MAX_NORMAL_COMMIT_LAG_SECONDS,
    { maximum_seconds: progress.max_commit_lag_seconds },
  );
  addCheck(
    checks,
    'segment-wav-readable',
    '所有分段都能解析为 RIFF/WAVE',
    inspection.segments.length > 0 && inspection.segment_errors.length === 0,
    { count: inspection.segments.length, errors: inspection.segment_errors },
  );
  addCheck(
    checks,
    'segment-format-match',
    '分段 WAV 属性为请求采样率/位深/单声道',
    inspection.segments.length > 0 &&
      inspection.segments.every(
        (wav) => wav.sample_rate === options.sampleRate && wav.bits_per_sample === options.bitDepth && wav.channels === 1,
      ),
    inspection.segments.map((wav) => ({
      file: wav.file_name,
      sample_rate: wav.sample_rate,
      bits_per_sample: wav.bits_per_sample,
      channels: wav.channels,
      input_sample_format: snapshot?.input_sample_format,
    })),
  );
  addCheck(
    checks,
    'physical-frame-watermark',
    '物理 WAV 完整帧数与最终提交水位一致',
    Boolean(finalSnapshot) && inspection.total_physical_frames === Number(finalSnapshot?.committed_samples),
    { physical_frames: inspection.total_physical_frames, committed_samples: finalSnapshot?.committed_samples },
  );
  return checks;
}

function evaluateNormal(report, options, inspection) {
  const checks = evaluateCommon(report, options, inspection);
  const progress = report.progress_summary;
  const finalSnapshot = report.stop?.result?.snapshot ?? inspection.snapshot;
  addCheck(checks, 'safe-stop', '录制安全停止并封存', Boolean(report.stop?.result) && !report.stop?.error, report.stop);
  addCheck(checks, 'stopped-status', '最终会话状态为 stopped', finalSnapshot?.status === 'stopped', { status: finalSnapshot?.status });
  const captured = Number(finalSnapshot?.captured_samples);
  const committed = Number(finalSnapshot?.committed_samples);
  const physical = Number(inspection?.total_physical_frames);
  addCheck(
    checks,
    'exact-sample-watermark',
    '安全停止后采集、持久化与物理 WAV 样本水位完全一致',
    Number.isSafeInteger(captured) &&
      Number.isSafeInteger(committed) &&
      Number.isSafeInteger(physical) &&
      captured >= 0 &&
      captured === committed &&
      committed === physical,
    { captured_samples: captured, committed_samples: committed, physical_frames: physical },
  );
  addCheck(checks, 'no-overflow', '无音频队列溢出', Number(finalSnapshot?.overflow_samples ?? 0) === 0, {
    overflow_samples: finalSnapshot?.overflow_samples,
  });
  addCheck(checks, 'no-capture-fault', '监测期间无采集故障', !progress.first_fault, progress.first_fault);
  addCheck(checks, 'no-fault-marker', '无 audio-fault 标记', !faultMarkerPresent(inspection), {
    marker: inspection.fault_marker,
    final_exists: inspection.fault_marker_exists,
    parse_error: inspection.fault_marker_parse_error,
    temporary: inspection.fault_marker_temporary_exists,
  });
  addCheck(
    checks,
    'exact-segment-headers',
    '安全停止后所有分段 WAV 头与物理 EOF 一致',
    inspection.segments.length > 0 && inspection.segments.every((wav) => wav.exact_header),
    inspection.segments.map((wav) => ({ file: wav.file_name, exact_header: wav.exact_header, trailing_bytes: wav.trailing_bytes })),
  );
  addCheck(
    checks,
    'continuous-file-growth',
    '正常采集时文件增长无超时停滞',
    progress.max_file_growth_stall_seconds <= progress.allowed_file_growth_stall_seconds,
    {
      maximum_stall_seconds: progress.max_file_growth_stall_seconds,
      allowed_seconds: progress.allowed_file_growth_stall_seconds,
    },
  );
  addCheck(
    checks,
    'capture-clock-rate',
    '长期平均样本速率在请求采样率的 ±5% 内',
    progress.observed_capture_rate !== null &&
      progress.observed_capture_rate >= options.sampleRate * 0.95 &&
      progress.observed_capture_rate <= options.sampleRate * 1.05,
    { requested: options.sampleRate, observed: progress.observed_capture_rate },
  );
  addCheck(
    checks,
    'signal-observed',
    '检测到可用输入信号（Peak 高于 -50 dBFS）',
    progress.maximum_peak_dbfs > -50,
    { maximum_peak_dbfs: progress.maximum_peak_dbfs },
  );
  addCheck(
    checks,
    'no-clipping',
    '测试信号未达数字满刻度',
    progress.maximum_peak_dbfs < -0.1,
    { maximum_peak_dbfs: progress.maximum_peak_dbfs },
    'WARN',
  );
  const storageStatuses = new Set(report.progress_rows.map((row) => row.storage_status).filter(Boolean));
  addCheck(
    checks,
    'storage-health',
    '长稳期间磁盘状态始终 healthy',
    options.mode !== 'soak' || [...storageStatuses].every((status) => status === 'healthy'),
    { observed: [...storageStatuses] },
    options.mode === 'soak' ? 'FAIL' : 'WARN',
  );
  if (options.export) {
    addCheck(
      checks,
      'full-track-export',
      '整轨 WAV 导出完整且帧数/格式与会话一致',
      inspection.full_track?.exact_header === true &&
        inspection.full_track?.physical_complete_frames === Number(finalSnapshot?.committed_samples) &&
        inspection.full_track?.sample_rate === finalSnapshot?.audio_format?.sample_rate &&
        inspection.full_track?.bits_per_sample === finalSnapshot?.audio_format?.bit_depth &&
        inspection.full_track?.channels === 1,
      {
      export: report.export,
      wav: inspection.full_track,
      error: inspection.full_track_error,
      },
    );
    const status = inspection.export_status;
    const metadata = inspection.export_metadata;
    const exportResult = report.export?.result;
    const exported = Array.isArray(metadata?.exported) ? metadata.exported : null;
    const skipped = Array.isArray(metadata?.skipped) ? metadata.skipped : null;
    const expectedSelections = Array.isArray(finalSnapshot?.items)
      ? finalSnapshot.items.map((item) => ({ id: item.id, attempt_id: item.selected_attempt_id }))
      : null;
    const manifestCoherent =
      inspection.export_bundle_present === true &&
      inspection.export_bundle_errors.length === 0 &&
      status?.schema_version === 2 &&
      status?.status === 'complete' &&
      status?.session_id === finalSnapshot?.session_id &&
      metadata?.schema_version === 1 &&
      metadata?.session_id === finalSnapshot?.session_id &&
      metadata?.full_track === 'full-track.wav' &&
      isDeepStrictEqual(metadata?.audio_format, finalSnapshot?.audio_format) &&
      isDeepStrictEqual(status?.source, metadata?.source) &&
      Number(metadata?.source?.journal_seq) === Number(finalSnapshot?.journal_seq) &&
      Number(metadata?.source?.committed_samples) === Number(finalSnapshot?.committed_samples) &&
      expectedSelections !== null &&
      isDeepStrictEqual(metadata?.source?.selected_attempts, expectedSelections) &&
      exported !== null &&
      skipped !== null &&
      exported.length + skipped.length === expectedSelections.length &&
      Number(status?.exported_count) === exported.length &&
      Number(status?.skipped_count) === skipped.length &&
      Number(exportResult?.exported_count) === exported.length &&
      Number(exportResult?.skipped_count) === skipped.length &&
      pathsEqual(String(exportResult?.export_dir ?? ''), path.join(options.sessionDir ?? report.session_dir, 'export')) &&
      pathsEqual(String(exportResult?.master_file ?? ''), path.join(options.sessionDir ?? report.session_dir, 'export', 'full-track.wav')) &&
      inspection.export_csv?.header === EXPORT_CSV_HEADER &&
      inspection.export_csv?.matches_metadata === true &&
      isDeepStrictEqual(
        inspection.export_sentence_file_names,
        exported.map((row) => path.posix.basename(String(row?.file ?? ''))).sort(),
      ) &&
      inspection.export_sentence_wavs.length === exported.length &&
      inspection.export_sentence_wavs.every((wav, index) =>
        wav.exact_header === true &&
        wav.sample_rate === finalSnapshot?.audio_format?.sample_rate &&
        wav.bits_per_sample === finalSnapshot?.audio_format?.bit_depth &&
        wav.channels === 1 &&
        wav.physical_complete_frames === Number(exported[index]?.duration_samples)
      );
    addCheck(
      checks,
      'delivery-manifest-coherent',
      '导出 status/metadata/CSV/WAV 属于同一已提交交付世代',
      manifestCoherent,
      {
        errors: inspection.export_bundle_errors,
        status,
        metadata,
        csv: inspection.export_csv,
        sentence_wavs: inspection.export_sentence_wavs,
        export_result: exportResult,
      },
    );
  }
  return checks;
}

function evaluateFault(report, options, inspection) {
  const checks = evaluateCommon(report, options, inspection);
  const progress = report.progress_summary;
  const finalSnapshot = report.stop?.result?.snapshot ?? inspection.snapshot;
  const fault = report.fault;
  addCheck(checks, 'healthy-prefix', '故障前已持续采集至少 2 秒', Number(fault?.captured_before_trigger ?? 0) >= options.sampleRate * 2, fault);
  addCheck(checks, 'fault-detected', '引擎检测到采集/存储故障', Boolean(fault?.detected_at), fault);
  if (DEVICE_UNPLUG_MODES.has(options.mode)) {
    const unplugLatency =
      typeof fault?.seconds_after_trigger === 'number'
        ? fault.seconds_after_trigger
        : Number.NaN;
    addCheck(
      checks,
      'fault-after-trigger',
      '采集故障不得早于拔出操作提示',
      fault?.fault_before_trigger == null && Number.isFinite(unplugLatency) && unplugLatency >= 0,
      {
        seconds_after_trigger: fault?.seconds_after_trigger,
        fault_before_trigger: fault?.fault_before_trigger ?? null,
      },
    );
    addCheck(
      checks,
      'unplug-detection-latency',
      '拔出提示后 15 秒内进入 fail-closed',
      Number.isFinite(unplugLatency) && unplugLatency >= 0 && unplugLatency <= 15,
      fault,
    );
    addCheck(
      checks,
      'unplug-fault-kind',
      '拔出声卡明确报告 device_unavailable',
      fault?.first_fault_kind_row?.fault_kind === 'device_unavailable',
      fault?.first_fault_kind_row,
    );
  } else {
    const latency = fault?.seconds_after_storage_critical;
    addCheck(
      checks,
      'disk-critical-latency',
      '首次 storage=critical 后 5 秒内进入 fail-closed',
      latency !== null && latency !== undefined && latency <= 5,
      fault,
    );
  }
  addCheck(checks, 'fault-marker', '持久化 audio-fault 标记', faultMarkerPresent(inspection), {
    marker: inspection.fault_marker,
    final_exists: inspection.fault_marker_exists,
    parse_error: inspection.fault_marker_parse_error,
    temporary: inspection.fault_marker_temporary_exists,
  });
  addCheck(checks, 'faulted-status', '最终会话状态为 faulted', finalSnapshot?.status === 'faulted', {
    status: finalSnapshot?.status,
    stop: report.stop,
  });
  addCheck(checks, 'normal-export-blocked', '故障会话被禁止生成常规交付', Boolean(report.export?.expected_rejection), report.export);
  addCheck(
    checks,
    'captured-prefix-preserved',
    '故障前已采集音频仍保留为完整物理帧',
    inspection.total_physical_frames > 0 && inspection.segments.every((wav) => wav.trailing_bytes === 0),
    { total_physical_frames: inspection.total_physical_frames, segments: inspection.segments },
  );
  const postFaultRows = report.progress_rows.filter((row) => fault?.detected_elapsed_seconds !== null && row.elapsed_seconds >= fault.detected_elapsed_seconds);
  const tail = postFaultRows.slice(-3);
  const tailCaptured = new Set(tail.map((row) => row.captured_samples));
  addCheck(
    checks,
    'timeline-stopped-after-fault',
    '故障后采集时间轴在排空后停止增长',
    tail.length >= 2 && tailCaptured.size === 1,
    { tail: tail.map((row) => ({ elapsed_seconds: row.elapsed_seconds, captured_samples: row.captured_samples })) },
  );
  return checks;
}

function overallFromChecks(checks, incomplete = false) {
  if (incomplete) return 'INCOMPLETE';
  return checks.some((check) => check.status === 'FAIL') ? 'FAIL' : 'PASS';
}

async function safeStopSession(client) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return { result: await client.request('stop_session', {}, 90_000), error: null, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!/safe|sealing|封存|稍后重试/i.test(error.message) || attempt === 4) break;
      await sleep(5_000);
    }
  }
  return { result: null, error: lastError?.message ?? '未知停止错误', attempts: 4 };
}

async function monitorCapture(
  client,
  sessionDirectory,
  options,
  telemetryLog,
  onPowerCutArm = null,
  monitorOptions = {},
) {
  const rows = [];
  const started = Date.now();
  const normalDurationMs = monitorOptions.durationMs ??
    (options.mode === 'soak' ? options.hours * 3_600_000 : options.seconds * 1_000);
  const expectedFault = monitorOptions.expectedFault ?? FAULT_MODES.has(options.mode);
  const powerCut = monitorOptions.powerCut ?? options.mode === 'power-cut';
  const phasePrefix = String(monitorOptions.phasePrefix ?? '');
  const triggerAtMs = expectedFault || powerCut ? started + options.triggerDelaySeconds * 1_000 : null;
  const deadlineMs = expectedFault
    ? triggerAtMs + options.faultTimeoutSeconds * 1_000
    : started + normalDurationMs;
  let announcedTrigger = false;
  let detectedAtMs = null;
  let detectedElapsedSeconds = null;
  let faultBeforeTrigger = null;
  let capturedBeforeTrigger = null;
  let firstCriticalElapsed = null;
  let lastConsoleSecond = -1;

  while (!abortRequested) {
    const now = Date.now();
    if (expectedFault && !announcedTrigger && detectedAtMs === null && now >= triggerAtMs) {
      announcedTrigger = true;
      process.stdout.write('\x07\n============================================================\n');
      process.stdout.write(
        DEVICE_UNPLUG_MODES.has(options.mode)
          ? '现在拔出 USB 声卡（不要点停止），工具正在计时。\n'
          : '现在在专用测试卷上启动填充器，降低剩余空间（勿填系统盘）。\n',
      );
      process.stdout.write('============================================================\n');
    }

    let state = null;
    let stateError = null;
    try {
      state = await client.request('get_state', {}, 15_000);
    } catch (error) {
      stateError = error.message;
    }
    const meter = client.consumeMeterWindow();
    const segmentStats = segmentStatSnapshot(sessionDirectory);
    const markerExists =
      pathEntryExists(path.join(sessionDirectory, 'metadata', 'audio-fault.json')) ||
      pathEntryExists(path.join(sessionDirectory, 'metadata', 'audio-fault.tmp'));
    const elapsedSeconds = (Date.now() - started) / 1_000;
    const row = {
      at: new Date().toISOString(),
      elapsed_seconds: Number(elapsedSeconds.toFixed(3)),
      phase: expectedFault && announcedTrigger
        ? `${phasePrefix}fault-observation`
        : powerCut && announcedTrigger
          ? 'power-cut-armed'
          : `${phasePrefix}recording`,
      session_id: state?.snapshot?.session_id ?? null,
      captured_samples: Number(state?.snapshot?.captured_samples ?? meter.captured_samples ?? 0),
      committed_samples: Number(state?.snapshot?.committed_samples ?? meter.committed_samples ?? 0),
      overflow_samples: Number(state?.snapshot?.overflow_samples ?? meter.overflow_samples ?? 0),
      faulted: Boolean(meter.faulted),
      fault_kind: typeof meter.fault_kind === 'string' ? meter.fault_kind : '',
      fault_reason: typeof meter.fault_reason === 'string' ? meter.fault_reason : '',
      fault_marker_exists: markerExists,
      storage_status: meter.storage_status ?? null,
      storage_safe_remaining_seconds: meter.storage_safe_remaining_seconds ?? null,
      peak: Number(meter.peak ?? 0),
      rms: Number(meter.rms ?? 0),
      silence_samples: Number(meter.silence_samples ?? 0),
      segment_total_bytes: segmentStats.total_bytes,
      segment_count: segmentStats.files.length,
      active_segment: segmentStats.files.at(-1) ?? null,
      segment_stat_error: segmentStats.error,
      state_error: stateError,
    };
    const isFault =
      row.faulted ||
      row.overflow_samples > 0 ||
      markerExists ||
      state?.snapshot?.status === 'faulted';
    if (expectedFault && announcedTrigger && capturedBeforeTrigger === null) {
      capturedBeforeTrigger = row.captured_samples;
    }
    let armedThisRow = false;
    if (powerCut && !announcedTrigger && now >= triggerAtMs && !isFault) {
      const previous = rows.at(-1) ?? null;
      const requiredFrames = Math.ceil(powerCutRequiredDurationSeconds(options) * options.sampleRate);
      const maximumLagFrames = Math.ceil(options.maxTailLossSeconds * options.sampleRate);
      const progressing = Boolean(previous) &&
        row.committed_samples > Number(previous.committed_samples ?? 0) &&
        row.segment_total_bytes > Number(previous.segment_total_bytes ?? 0);
      const eligible =
        stateError === null &&
        state?.snapshot?.status === 'recording' &&
        segmentStats.error === null &&
        row.segment_count > 0 &&
        row.committed_samples >= requiredFrames &&
        row.captured_samples >= row.committed_samples &&
        row.captured_samples - row.committed_samples <= maximumLagFrames &&
        progressing;
      if (eligible) {
        if (typeof onPowerCutArm !== 'function') throw new Error('power-cut 缺少持久证据回调');
        row.phase = 'power-cut-armed';
        await onPowerCutArm(row);
        announcedTrigger = true;
        capturedBeforeTrigger = row.captured_samples;
        armedThisRow = true;
      }
    }
    rows.push(row);
    telemetryLog.write(
      row,
      armedThisRow || row.faulted || row.fault_marker_exists || row.storage_status === 'critical',
    );
    if (armedThisRow) {
      process.stdout.write('\x07\n============================================================\n');
      process.stdout.write('已持久化达标证据。现在切断整台 Windows 测试机的电源！\n');
      process.stdout.write('不要点停止，不要关闭窗口。\n');
      process.stdout.write('============================================================\n');
    }
    if (row.storage_status === 'critical' && firstCriticalElapsed === null) firstCriticalElapsed = elapsedSeconds;
    if (isFault && detectedAtMs === null) {
      detectedAtMs = Date.now();
      detectedElapsedSeconds = elapsedSeconds;
      if (expectedFault && !announcedTrigger) {
        faultBeforeTrigger = row;
        process.stdout.write(
          `\n故障发生在操作提示前: t=${elapsedSeconds.toFixed(1)}s，本轮不得计入拔插验收；继续安全排空。\n`,
        );
      } else {
        process.stdout.write(`\n已检测故障: t=${elapsedSeconds.toFixed(1)}s，继续观察时间轴排空。\n`);
      }
    }

    const wholeSecond = Math.floor(elapsedSeconds);
    if (wholeSecond !== lastConsoleSecond && (wholeSecond < 15 || wholeSecond % Math.max(1, Math.round(options.pollSeconds * 5)) === 0)) {
      lastConsoleSecond = wholeSecond;
      const lag = Math.max(0, row.captured_samples - row.committed_samples) / options.sampleRate;
      process.stdout.write(
        `t=${elapsedSeconds.toFixed(1)}s captured=${row.captured_samples} committed=${row.committed_samples} lag=${lag.toFixed(2)}s bytes=${row.segment_total_bytes} storage=${row.storage_status ?? '?'} fault=${isFault}\n`,
      );
    }

    if (!expectedFault && (Date.now() >= deadlineMs || isFault)) break;
    if (expectedFault) {
      if (
        detectedAtMs !== null &&
        Date.now() - detectedAtMs >= Math.max(FAULT_DRAIN_OBSERVATION_MS, options.pollSeconds * 3_000)
      ) break;
      if (Date.now() >= deadlineMs) break;
    }
    await sleep(options.pollSeconds * 1_000);
  }

  const { firstFaultRow, firstFaultKindRow } = faultEvidenceRows(rows);
  return {
    rows,
    started_at: new Date(started).toISOString(),
    ended_at: new Date().toISOString(),
    aborted: abortRequested,
    trigger_at: triggerAtMs ? new Date(triggerAtMs).toISOString() : null,
    detected_at: detectedAtMs ? new Date(detectedAtMs).toISOString() : null,
    detected_elapsed_seconds: detectedElapsedSeconds,
    captured_before_trigger: capturedBeforeTrigger,
    seconds_after_trigger: detectedAtMs && triggerAtMs ? (detectedAtMs - triggerAtMs) / 1_000 : null,
    first_storage_critical_elapsed_seconds: firstCriticalElapsed,
    seconds_after_storage_critical:
      detectedElapsedSeconds !== null && firstCriticalElapsed !== null ? detectedElapsedSeconds - firstCriticalElapsed : null,
    // Keep the earliest evidence row for detection timing and timeline
    // diagnostics. A durable marker may become visible just before the next
    // telemetry projection carries the stable fault kind, so kind attribution
    // deliberately uses its own first explicit evidence row.
    first_fault_row: firstFaultRow,
    first_fault_kind_row: firstFaultKindRow,
    fault_before_trigger: faultBeforeTrigger,
  };
}

async function maybePromptBeforeCapture(options) {
  if (options.yes || !process.stdin.isTTY || !process.stdout.isTTY) return;
  const prompt = createPrompt({ input: process.stdin, output: process.stdout });
  try {
    let message = '按 Enter 启动验收录制。';
    if (options.mode === 'short') message = '准备好后按 Enter。噪声检测时请保持安静，之后持续朗读或播放测试音。';
    if (options.mode === 'soak') message = '确认信号源、供电、USB 和专用存储均已准备，按 Enter 启动长稳。';
    if (options.mode === 'unplug') message = '保持声卡连接，按 Enter 启动；倒计时结束后按提示拔出。';
    if (options.mode === 'replug') message = '保持声卡连接，按 Enter 启动；只在提示时拔出，确认消失后再按提示插回。';
    if (options.mode === 'disk-full') message = '确认输出在可丢弃的专用测试卷，按 Enter 启动；勿对系统盘做填满测试。';
    if (options.mode === 'power-cut') {
      message = '确认已使用可丢弃的 Windows 测试机和指定录制目录，按 Enter 开始；只在倒计时结束后切断整机电源。';
    }
    await prompt.question(`${message}\n`);
  } finally {
    prompt.close();
  }
}

async function promptForReplug(options) {
  const message = '已确认目标 endpoint 从 Windows 输入列表消失。现在插回同一声卡（使用原 USB 端口）。';
  process.stdout.write(`\n${message}\n`);
  if (options.yes || !process.stdin.isTTY || !process.stdout.isTTY) return;
  const prompt = createPrompt({ input: process.stdin, output: process.stdout });
  try {
    await prompt.question('插回后按 Enter，工具将轮询同一 endpoint ID。\n');
  } finally {
    prompt.close();
  }
}

async function runInventory(options, runDirectory, report) {
  const enginePath = findEngine(options.engine);
  const engineSha256 = sha256RegularFile(enginePath, '录音引擎');
  const client = new EngineClient(
    enginePath,
    runDirectory,
    path.join(runDirectory, 'protocol.jsonl'),
    path.join(runDirectory, 'engine-stderr.log'),
  );
  try {
    const ready = await client.start();
    const inventory = await client.request('list_devices', {}, 30_000);
    printDevices(inventory);
    report.engine = { path: enginePath, binary_sha256: engineSha256, ready };
    report.inventory = inventory;
    try {
      report.engine.exit = await client.shutdown();
    } catch (shutdownError) {
      report.engine.shutdown_error = shutdownError.message;
      report.engine.exit = client.shutdownResult ?? client.exitResult;
    }
    report.checks = evaluateInventory(inventory);
    addEngineExitCheck(report.checks, report.engine);
    report.overall = overallFromChecks(report.checks, Boolean(report.engine.shutdown_error));
  } catch (error) {
    report.tool_error = error.stack ?? error.message;
    report.overall = 'INCOMPLETE';
    try {
      report.engine = report.engine ?? { path: enginePath, binary_sha256: engineSha256, ready: client.readyPayload };
      report.engine.exit = await client.shutdown();
    } catch (shutdownError) {
      report.engine = report.engine ?? { path: enginePath, binary_sha256: engineSha256, ready: client.readyPayload };
      report.engine.shutdown_error = shutdownError.message;
      report.engine.exit = client.shutdownResult ?? client.exitResult;
    }
  } finally {
    client.closeLogs();
  }
}

async function runRecover(options, runDirectory, report) {
  let enginePath = null;
  let engineSha256 = null;
  let client = null;
  try {
    report.session_dir = options.sessionDir;
    const phase1 = loadPhase1Evidence(options.phase1Report);
    phase1.source_path = options.phase1Report;
    try {
      phase1.session_evidence = readJsonRegularFile(
        path.join(options.sessionDir, POWER_CUT_SESSION_EVIDENCE),
        '会话内 phase-1 证据',
      );
    } catch (error) {
      phase1.session_evidence = null;
      phase1.session_evidence_error = error.message;
    }
    const preInspection = inspectSession(options.sessionDir);
    report.phase1 = phase1;
    report.pre_recovery_inspection = preInspection;
    const currentHost = {
      hostname: report.host.hostname,
      platform: report.host.platform,
      architecture: report.host.architecture,
      boot: report.host.boot,
    };
    const preflightChecks = evaluatePhase1Evidence(phase1, options, preInspection, currentHost);
    if (phase1.session_evidence_error) {
      preflightChecks.find((check) => check.id === 'session-evidence-bound').details = {
        error: phase1.session_evidence_error,
      };
    }
    if (overallFromChecks(preflightChecks) !== 'PASS') {
      report.checks = preflightChecks;
      report.production_eligible = false;
      report.overall = 'FAIL';
      return;
    }
    enginePath = findEngine(options.engine);
    engineSha256 = sha256RegularFile(enginePath, '录音引擎');
    const currentBinaryIdentity = {
      acceptance_tool_sha256: ACCEPTANCE_TOOL_SHA256,
      engine_sha256: engineSha256,
    };
    addCheck(
      preflightChecks,
      'phase1-binaries-match',
      'phase-2 使用与 phase-1 完全相同的验收工具和录音引擎',
      currentBinaryIdentity.acceptance_tool_sha256 ===
        phase1.evidence?.binary_identity?.acceptance_tool_sha256 &&
        currentBinaryIdentity.engine_sha256 === phase1.evidence?.binary_identity?.engine_sha256,
      { phase1: phase1.evidence?.binary_identity, phase2: currentBinaryIdentity },
    );
    if (overallFromChecks(preflightChecks) !== 'PASS') {
      report.checks = preflightChecks;
      report.production_eligible = false;
      report.overall = 'FAIL';
      return;
    }
    writeJsonDurable(path.join(runDirectory, 'acceptance-report.json'), report);

    client = new EngineClient(
      enginePath,
      runDirectory,
      path.join(runDirectory, 'protocol.jsonl'),
      path.join(runDirectory, 'engine-stderr.log'),
    );
    const ready = await client.start();
    report.engine = { path: enginePath, binary_sha256: engineSha256, ready };
    report.recovery = {
      result: await client.request(
        'seal_interrupted_session',
        {
          session_dir: options.sessionDir,
          expected_session_id: phase1.evidence?.session_id,
        },
        10 * 60_000,
      ),
    };
    writeJsonDurable(path.join(runDirectory, 'acceptance-report.json'), report);
    try {
      report.engine.exit = await client.shutdown();
    } catch (shutdownError) {
      report.engine.shutdown_error = shutdownError.message;
      report.engine.exit = client.shutdownResult ?? client.exitResult;
    }
    report.inspection = inspectSession(options.sessionDir);
    const checks = [];
    checks.push(...preflightChecks);
    addCheck(checks, 'engine-ready', '原生录音引擎启动', Boolean(report.engine.ready), report.engine);
    addCheck(
      checks,
      'offline-seal-complete',
      '断电会话已执行 seal_interrupted_session',
      Boolean(report.recovery.result?.snapshot) &&
        report.recovery.result?.no_op === false &&
        pathsEqual(String(report.recovery.result?.session_dir ?? ''), options.sessionDir),
      report.recovery,
    );
    checks.push(...evaluateSealedSession(report.inspection));
    addCheck(
      checks,
      'seal-watermark-consistent',
      '离线封存返回的持久水位与磁盘复查一致',
      Number(report.recovery.result?.durable_frames) === report.inspection.total_physical_frames &&
        Number(report.recovery.result?.snapshot?.committed_samples) === report.inspection.total_physical_frames,
      {
        seal_durable_frames: report.recovery.result?.durable_frames,
        seal_committed_samples: report.recovery.result?.snapshot?.committed_samples,
        inspected_physical_frames: report.inspection.total_physical_frames,
      },
    );
    const evidence = phase1.evidence;
    const physicalFrames = Number(report.inspection.total_physical_frames);
    const armedCommitted = Number(evidence.armed_committed_samples);
    const armedCaptured = Number(evidence.armed_captured_samples);
    const evidenceTailLimit = Number(evidence.max_tail_loss_samples);
    const requestedTailLimit = Math.ceil(options.maxTailLossSeconds * Number(evidence.audio_format.sample_rate));
    const effectiveTailLimit = Math.min(evidenceTailLimit, requestedTailLimit);
    const tailLoss = Math.max(0, armedCaptured - physicalFrames);
    addCheck(
      checks,
      'armed-committed-preserved',
      'recovered 物理帧不少于 phase-1 armed 时已持久化水位',
      Number.isSafeInteger(physicalFrames) &&
        Number.isSafeInteger(armedCommitted) &&
        physicalFrames >= armedCommitted,
      { physical_frames: physicalFrames, armed_committed_samples: armedCommitted },
    );
    addCheck(
      checks,
      'power-cut-tail-loss-budget',
      '断电尾部损失不超过 phase-1 确定的 checkpoint+callback 预算',
      Number.isSafeInteger(armedCaptured) &&
        Number.isSafeInteger(effectiveTailLimit) &&
        tailLoss <= effectiveTailLimit,
      {
        armed_captured_samples: armedCaptured,
        recovered_physical_frames: physicalFrames,
        tail_loss_samples: tailLoss,
        maximum_tail_loss_samples: effectiveTailLimit,
      },
    );
    addEngineExitCheck(checks, report.engine);
    report.checks = checks;
    const checkedOverall = overallFromChecks(checks, Boolean(report.engine.shutdown_error));
    report.production_eligible = phase1.evidence.test_only === false && checkedOverall === 'PASS';
    report.overall = checkedOverall === 'PASS' && phase1.evidence.test_only === true
      ? 'TEST_ONLY_PASS'
      : checkedOverall;
  } catch (error) {
    report.tool_error = error.stack ?? error.message;
    report.overall = 'INCOMPLETE';
    try {
      if (!client) throw error;
      report.engine = report.engine ?? {
        path: enginePath,
        binary_sha256: engineSha256,
        ready: client.readyPayload,
      };
      report.engine.exit = await client.shutdown();
    } catch (shutdownError) {
      if (client) {
        report.engine = report.engine ?? {
          path: enginePath,
          binary_sha256: engineSha256,
          ready: client.readyPayload,
        };
        report.engine.shutdown_error = shutdownError.message;
        report.engine.exit = client.shutdownResult ?? client.exitResult;
      }
    }
  } finally {
    client?.closeLogs();
  }
}

function replugStartPayload(sessionDirectory, sessionId, selected, options, phase) {
  return {
    session_dir: sessionDirectory,
    session_id: sessionId,
    script_name: `Windows replug ${phase} acceptance`,
    device_id: selected.id,
    device_name: selected.name,
    sample_rate: options.sampleRate,
    bit_depth: options.bitDepth,
    input_channel: options.channel,
    silence_duration_ms: 1_000,
    silence_threshold_dbfs: options.noiseThresholdDbfs,
    items: [{
      id: `QA-REPLUG-${phase.toUpperCase()}`,
      text: 'DataBaker Windows external audio interface replug acceptance',
      label: `replug-${phase}`,
    }],
  };
}

function prefixChecks(prefix, checks) {
  return checks.map((check) => ({
    ...check,
    id: `${prefix}-${check.id}`,
    label: `${prefix === 'replug-a' ? '拔出前/故障会话' : '重插后新会话'}: ${check.label}`,
  }));
}

async function runReplug(options, runDirectory, report) {
  const enginePath = findEngine(options.engine);
  const engineSha256 = sha256RegularFile(enginePath, '录音引擎');
  const client = new EngineClient(
    enginePath,
    runDirectory,
    path.join(runDirectory, 'protocol.jsonl'),
    path.join(runDirectory, 'engine-stderr.log'),
  );
  const telemetry = new NdjsonLog(path.join(runDirectory, 'telemetry.jsonl'));
  const beforeDirectory = path.join(runDirectory, 'recording-before-unplug');
  const afterDirectory = path.join(runDirectory, 'recording-after-replug');
  let activeSession = false;
  let beforeRows = [];
  let afterRows = [];
  try {
    if (pathEntryExists(beforeDirectory) || pathEntryExists(afterDirectory)) {
      throw new Error('replug 两个会话目录必须均不存在');
    }
    const ready = await client.start();
    report.engine = { path: enginePath, binary_sha256: engineSha256, ready };
    const inventory = await client.request('list_devices', {}, 30_000);
    report.inventory = inventory;
    printDevices(inventory);
    const selected = await selectDevice(inventory, options);
    const configurations = matchingConfigurations(selected, options.sampleRate, options.channel);
    if (configurations.length === 0) {
      throw new Error(`设备 ${selected.name} 不支持 ${options.sampleRate} Hz / 输入 ${options.channel}`);
    }
    report.selected_device = selected;
    report.requested = {
      sample_rate: options.sampleRate,
      wav_bit_depth: options.bitDepth,
      minimum_input_format_bits: options.minimumInputFormatBits,
      output_channels: 1,
      input_channel: options.channel,
      matching_driver_configurations: configurations,
    };
    report.session_dir = afterDirectory;
    report.replug = {
      required_consecutive_matches: 2,
      before: { session_dir: beforeDirectory },
      transition: {
        target_id: selected.id,
        target_name: selected.name,
        disappearance: null,
        disappearance_timed_out: false,
        reappearance: null,
        reappearance_timed_out: false,
      },
      after: { session_dir: afterDirectory },
    };
    const initialEvidence = replugInventoryEvidence(inventory, selected, options);
    report.replug.transition.initial = initialEvidence;
    telemetry.write(
      replugInventoryTelemetry('present-before-unplug', initialEvidence),
      true,
    );
    await maybePromptBeforeCapture(options);

    const beforeSessionId = `acceptance-${timestampForPath().toLowerCase()}-replug-a-${options.bitDepth}bit`;
    const beforeStart = await client.request(
      'start_session',
      replugStartPayload(beforeDirectory, beforeSessionId, selected, options, 'a'),
      60_000,
    );
    activeSession = true;
    report.replug.before.start = beforeStart;
    writeJsonDurable(path.join(runDirectory, 'acceptance-report.json'), report);
    process.stdout.write(`\n已启动会话 A: ${beforeStart.snapshot.device_name}\nID: ${beforeStart.snapshot.device_id}\n\n`);
    if (!options.skipNoiseCheck) {
      try {
        report.replug.before.noise_check = await client.request(
          'check_noise',
          { threshold_dbfs: options.noiseThresholdDbfs },
          20_000,
        );
      } catch (error) {
        report.replug.before.noise_check_error = error.message;
      }
    }
    const beforeMonitor = await monitorCapture(
      client,
      beforeDirectory,
      options,
      telemetry,
      null,
      { expectedFault: true, powerCut: false, phasePrefix: 'replug-a-' },
    );
    beforeRows = beforeMonitor.rows;
    report.replug.before.progress_summary = summarizeProgress(
      beforeRows,
      options.sampleRate,
      options.pollSeconds,
    );
    report.replug.before.fault = {
      trigger_at: beforeMonitor.trigger_at,
      detected_at: beforeMonitor.detected_at,
      detected_elapsed_seconds: beforeMonitor.detected_elapsed_seconds,
      captured_before_trigger: beforeMonitor.captured_before_trigger,
      seconds_after_trigger: beforeMonitor.seconds_after_trigger,
      first_storage_critical_elapsed_seconds: beforeMonitor.first_storage_critical_elapsed_seconds,
      seconds_after_storage_critical: beforeMonitor.seconds_after_storage_critical,
      first_fault_row: beforeMonitor.first_fault_row,
      first_fault_kind_row: beforeMonitor.first_fault_kind_row,
      fault_before_trigger: beforeMonitor.fault_before_trigger,
    };
    report.replug.before.stop = await safeStopSession(client);
    activeSession = !report.replug.before.stop.result;
    try {
      const unexpected = await client.request(
        'export_session',
        { session_dir: beforeDirectory, expected_session_id: beforeSessionId },
        120_000,
      );
      report.replug.before.export = { expected_rejection: false, unexpected_result: unexpected };
    } catch (error) {
      report.replug.before.export = { expected_rejection: true, error: error.message };
    }
    try {
      const unexpected = await client.request(
        'resume_session',
        { session_dir: beforeDirectory, expected_session_id: beforeSessionId },
        60_000,
      );
      activeSession = true;
      report.replug.before.resume = { expected_rejection: false, unexpected_result: unexpected };
      report.replug.before.unexpected_resume_cleanup = await safeStopSession(client);
      activeSession = !report.replug.before.unexpected_resume_cleanup.result;
    } catch (error) {
      report.replug.before.resume = { expected_rejection: true, error: error.message };
    }
    report.replug.before.inspection = inspectSession(beforeDirectory);

    let disappearanceEvidence = null;
    const disappearanceDeadline = Date.now() + replugPollTimeoutMs(options);
    while (!abortRequested && Date.now() <= disappearanceDeadline) {
      const disappearanceInventory = await client.request('list_devices', {}, 30_000);
      disappearanceEvidence = replugInventoryEvidence(
        disappearanceInventory,
        selected,
        options,
      );
      const disappearanceRow = replugInventoryTelemetry(
        disappearanceEvidence.target_present ? 'still-present-after-unplug' : 'absent-after-unplug',
        disappearanceEvidence,
      );
      telemetry.write(disappearanceRow, !disappearanceEvidence.target_present);
      report.replug.transition.last_disappearance_observation = disappearanceRow;
      if (!disappearanceEvidence.target_present) {
        report.replug.transition.disappearance = disappearanceRow;
        break;
      }
      await sleep(options.pollSeconds * 1_000);
    }
    if (!report.replug.transition.disappearance) {
      report.replug.transition.disappearance = report.replug.transition.last_disappearance_observation;
    }
    report.replug.transition.disappearance_timed_out =
      report.replug.transition.disappearance?.target_present !== false;

    const beforeSnapshot = report.replug.before.stop?.result?.snapshot ??
      report.replug.before.inspection?.snapshot;
    const canWaitForReappearance =
      beforeSnapshot?.status === 'faulted' &&
      report.replug.before.fault?.first_fault_kind_row?.fault_kind === 'device_unavailable' &&
      faultMarkerPresent(report.replug.before.inspection) &&
      report.replug.before.export?.expected_rejection === true &&
      report.replug.before.resume?.expected_rejection === true &&
      report.replug.before.fault?.fault_before_trigger == null &&
      disappearanceEvidence?.target_present === false;

    let stableReappearance = null;
    if (canWaitForReappearance) {
      await promptForReplug(options);
      const deadline = Date.now() + replugPollTimeoutMs(options);
      let consecutiveMatches = 0;
      while (!abortRequested && Date.now() <= deadline) {
        const observedInventory = await client.request('list_devices', {}, 30_000);
        const evidence = replugInventoryEvidence(observedInventory, selected, options);
        consecutiveMatches = evidence.exact_match ? consecutiveMatches + 1 : 0;
        const state = consecutiveMatches >= report.replug.required_consecutive_matches
          ? 'stable-reappearance'
          : evidence.exact_match
            ? 'matching-reappearance'
            : evidence.target_present
              ? 'nonmatching-target-reappearance'
              : evidence.observed_same_name_ids.length > 0
                ? 'same-name-different-id'
                : 'waiting-reappearance';
        const row = replugInventoryTelemetry(state, evidence, consecutiveMatches);
        telemetry.write(row, state === 'stable-reappearance');
        report.replug.transition.last_observation = row;
        if (state === 'stable-reappearance') {
          stableReappearance = row;
          report.replug.transition.reappearance = row;
          break;
        }
        await sleep(options.pollSeconds * 1_000);
      }
      report.replug.transition.reappearance_timed_out = stableReappearance === null;
    }

    if (stableReappearance) {
      const afterSessionId = `acceptance-${timestampForPath().toLowerCase()}-replug-b-${options.bitDepth}bit`;
      try {
        report.replug.after.start = await client.request(
          'start_session',
          replugStartPayload(afterDirectory, afterSessionId, selected, options, 'b'),
          60_000,
        );
        activeSession = true;
      } catch (error) {
        report.replug.after.start_error = error.message;
      }
      if (activeSession) {
        if (!options.skipNoiseCheck) {
          try {
            report.replug.after.noise_check = await client.request(
              'check_noise',
              { threshold_dbfs: options.noiseThresholdDbfs },
              20_000,
            );
          } catch (error) {
            report.replug.after.noise_check_error = error.message;
          }
        }
        const afterMonitor = await monitorCapture(
          client,
          afterDirectory,
          options,
          telemetry,
          null,
          {
            expectedFault: false,
            powerCut: false,
            phasePrefix: 'replug-b-',
            durationMs: options.seconds * 1_000,
          },
        );
        afterRows = afterMonitor.rows;
        report.replug.after.progress_summary = summarizeProgress(
          afterRows,
          options.sampleRate,
          options.pollSeconds,
        );
        report.replug.after.stop = await safeStopSession(client);
        activeSession = !report.replug.after.stop.result;
        report.replug.after.export = { skipped: true };
        report.replug.after.inspection = inspectSession(afterDirectory);
      }
    }

    try {
      report.engine.exit = await client.shutdown();
    } catch (error) {
      report.engine.shutdown_error = error.message;
      report.engine.exit = client.shutdownResult ?? client.exitResult;
    }

    const checks = [];
    const beforeView = {
      ...report,
      session_dir: beforeDirectory,
      start: report.replug.before.start,
      stop: report.replug.before.stop,
      export: report.replug.before.export,
      inspection: report.replug.before.inspection,
      progress_summary: report.replug.before.progress_summary,
      progress_rows: beforeRows,
      fault: report.replug.before.fault,
    };
    checks.push(...prefixChecks(
      'replug-a',
      evaluateFault(beforeView, options, report.replug.before.inspection),
    ));
    const healthyPrefixRows = beforeRows.filter((row) => row.phase === 'replug-a-recording');
    const healthyPrefix = summarizeProgress(
      healthyPrefixRows,
      options.sampleRate,
      options.pollSeconds,
    );
    report.replug.before.healthy_prefix_summary = healthyPrefix;
    addCheck(
      checks,
      'replug-a-healthy-prefix-clock',
      '拔出前健康前缀的采样时钟与请求一致',
      healthyPrefix.observed_capture_rate !== null &&
        healthyPrefix.observed_capture_rate >= options.sampleRate * 0.95 &&
        healthyPrefix.observed_capture_rate <= options.sampleRate * 1.05,
      healthyPrefix,
    );
    addCheck(
      checks,
      'replug-a-healthy-prefix-signal',
      '拔出前健康前缀检测到有效信号',
      healthyPrefix.maximum_peak_dbfs > -50,
      { maximum_peak_dbfs: healthyPrefix.maximum_peak_dbfs },
    );
    addCheck(
      checks,
      'replug-old-export-blocked',
      '故障会话禁止常规导出',
      report.replug.before.export?.expected_rejection === true,
      report.replug.before.export,
    );
    addCheck(
      checks,
      'replug-old-resume-blocked',
      '故障会话禁止继续追加',
      report.replug.before.resume?.expected_rejection === true,
      report.replug.before.resume,
    );
    addCheck(
      checks,
      'replug-target-disappeared',
      '拔出后 Windows 输入列表至少一次确认目标 endpoint ID 消失',
      report.replug.transition.disappearance?.target_present === false,
      report.replug.transition.disappearance,
    );
    addCheck(
      checks,
      'replug-same-endpoint-stable',
      '同一 endpoint ID、名称和所需配置连续至少两次出现',
      report.replug.transition.reappearance?.exact_match === true &&
        Number(report.replug.transition.reappearance?.consecutive_matches) >= 2,
      report.replug.transition.reappearance ?? report.replug.transition.last_observation,
    );

    const beforeIdentity = report.replug.before.start?.snapshot;
    const afterIdentity = report.replug.after.start?.snapshot;
    addCheck(
      checks,
      'replug-first-device-exact',
      '故障会话精确绑定计划中的 endpoint ID 和名称',
      beforeIdentity?.device_id === selected.id && beforeIdentity?.device_name === selected.name,
      { expected: selected, actual: beforeIdentity },
    );
    addCheck(
      checks,
      'replug-distinct-session',
      '重插后使用不同目录和不同 session ID 开启全新会话',
      Boolean(beforeIdentity?.session_id) && Boolean(afterIdentity?.session_id) &&
        beforeIdentity.session_id !== afterIdentity.session_id &&
        !pathsEqual(beforeDirectory, afterDirectory),
      {
        before_session_id: beforeIdentity?.session_id,
        after_session_id: afterIdentity?.session_id,
        before_directory: beforeDirectory,
        after_directory: afterDirectory,
      },
    );
    addCheck(
      checks,
      'replug-second-device-exact',
      '新会话精确绑定原 endpoint ID 和名称，未回退到同名或默认设备',
      afterIdentity?.device_id === selected.id && afterIdentity?.device_name === selected.name,
      { expected: selected, actual: afterIdentity },
    );

    if (report.replug.after.start && report.replug.after.stop && report.replug.after.inspection) {
      const afterView = {
        ...report,
        session_dir: afterDirectory,
        start: report.replug.after.start,
        stop: report.replug.after.stop,
        export: report.replug.after.export,
        inspection: report.replug.after.inspection,
        progress_summary: report.replug.after.progress_summary,
        progress_rows: afterRows,
      };
      checks.push(...prefixChecks(
        'replug-b',
        evaluateNormal(afterView, options, report.replug.after.inspection),
      ));
      addCheck(
        checks,
        'replug-b-duration',
        `重插后新会话健康采集至少 ${options.seconds} 秒`,
        Number(report.replug.after.progress_summary?.last?.elapsed_seconds) >= options.seconds,
        report.replug.after.progress_summary,
      );
    } else {
      addCheck(
        checks,
        'replug-b-session-complete',
        '重插后新会话已完整启动、采集和安全停止',
        false,
        report.replug.after,
      );
    }
    const stderrText = client.refreshStderrText();
    const panic = /panicked|fatal runtime error|stack overflow/i.test(stderrText);
    addCheck(checks, 'engine-no-panic', '引擎无 panic/fatal runtime error', !panic, {
      stderr_tail: stderrText.slice(-8_000),
    });
    report.checks = checks;
    report.aborted = abortRequested;
    report.overall = overallFromChecks(
      checks,
      report.aborted ||
        !report.replug.before.stop?.result ||
        (Boolean(report.replug.after.start) && !report.replug.after.stop?.result) ||
        Boolean(report.engine.shutdown_error),
    );
    report.start = report.replug.after.start ?? null;
    report.stop = report.replug.after.stop ?? null;
    report.inspection = report.replug.after.inspection ?? null;
    report.progress_summary = report.replug.after.progress_summary ?? null;
    report.progress_samples_recorded = beforeRows.length + afterRows.length;
  } catch (error) {
    report.tool_error = error.stack ?? error.message;
    report.overall = 'INCOMPLETE';
    if (activeSession) {
      report.emergency_stop = await safeStopSession(client);
      activeSession = !report.emergency_stop.result;
    }
    try {
      report.engine = report.engine ?? {
        path: enginePath,
        binary_sha256: engineSha256,
        ready: client.readyPayload,
      };
      report.engine.exit = await client.shutdown();
    } catch (shutdownError) {
      report.engine = report.engine ?? {
        path: enginePath,
        binary_sha256: engineSha256,
        ready: client.readyPayload,
      };
      report.engine.shutdown_error = shutdownError.message;
      report.engine.exit = client.shutdownResult ?? client.exitResult;
    }
  } finally {
    telemetry.close();
    client.closeLogs();
  }
}

async function runCapture(options, runDirectory, report) {
  const enginePath = findEngine(options.engine);
  const engineSha256 = sha256RegularFile(enginePath, '录音引擎');
  const client = new EngineClient(
    enginePath,
    runDirectory,
    path.join(runDirectory, 'protocol.jsonl'),
    path.join(runDirectory, 'engine-stderr.log'),
  );
  const telemetry = new NdjsonLog(path.join(runDirectory, 'telemetry.jsonl'));
  let sessionStarted = false;
  let sessionDirectory = options.mode === 'power-cut' ? options.sessionDir : path.join(runDirectory, 'recording');
  try {
    if (options.mode === 'power-cut' && pathEntryExists(sessionDirectory)) {
      throw new Error(`power-cut --session-dir 必须是不存在的新目录: ${sessionDirectory}`);
    }
    const ready = await client.start();
    report.engine = { path: enginePath, binary_sha256: engineSha256, ready };
    const inventory = await client.request('list_devices', {}, 30_000);
    report.inventory = inventory;
    printDevices(inventory);
    const selected = await selectDevice(inventory, options);
    report.selected_device = selected;
    const configs = matchingConfigurations(selected, options.sampleRate, options.channel);
    if (configs.length === 0) {
      throw new Error(`设备 ${selected.name} 不支持 ${options.sampleRate} Hz / 输入 ${options.channel}`);
    }
    report.requested = {
      sample_rate: options.sampleRate,
      wav_bit_depth: options.bitDepth,
      minimum_input_format_bits: options.minimumInputFormatBits,
      output_channels: 1,
      input_channel: options.channel,
      matching_driver_configurations: configs,
    };
    await maybePromptBeforeCapture(options);
    const sessionId = `acceptance-${timestampForPath().toLowerCase()}-${options.mode}-${options.bitDepth}bit`;
    const start = await client.request(
      'start_session',
      {
        session_dir: sessionDirectory,
        session_id: sessionId,
        script_name: `Windows ${options.mode} acceptance`,
        device_id: selected.id,
        device_name: selected.name,
        sample_rate: options.sampleRate,
        bit_depth: options.bitDepth,
        input_channel: options.channel,
        silence_duration_ms: 1_000,
        silence_threshold_dbfs: options.noiseThresholdDbfs,
        items: [{ id: 'QA-001', text: 'DataBaker Windows external audio interface acceptance', label: options.mode }],
      },
      60_000,
    );
    sessionStarted = true;
    report.session_dir = sessionDirectory;
    report.start = start;
    if (options.mode === 'power-cut') {
      const phase1ReportPath = path.join(runDirectory, 'acceptance-report.json');
      const phase1EvidencePath = path.join(runDirectory, 'power-cut-evidence.json');
      report.power_cut = {
        phase: 'recording-not-armed',
        nonce: null,
        test_only: options.testOnlyPowerCut,
        production_eligible: !options.testOnlyPowerCut,
        required_duration_seconds: powerCutRequiredDurationSeconds(options),
        cut_after_seconds: options.triggerDelaySeconds,
        maximum_wait_seconds: options.seconds,
        phase1_report_path: phase1ReportPath,
        phase1_evidence_path: phase1EvidencePath,
        session_evidence_path: path.join(sessionDirectory, POWER_CUT_SESSION_EVIDENCE),
        recovery_command: `--mode recover --session-dir "${sessionDirectory}" --phase1-report "${phase1ReportPath}"${options.testOnlyPowerCut ? ' --test-only-power-cut' : ''}`,
        instruction: '只有当证据持久化并显示断电提示后，才能切断整机电源。',
        evidence: null,
      };
      report.production_eligible = !options.testOnlyPowerCut;
    }
    writeJsonDurable(path.join(runDirectory, 'acceptance-report.json'), report);
    process.stdout.write(
      `\n已启动: ${start.snapshot.device_name}\nID: ${start.snapshot.device_id}\n输入: ${start.snapshot.input_sample_format}, ${start.snapshot.audio_format.input_channels} ch\n交付: ${start.snapshot.audio_format.sample_rate} Hz / ${start.snapshot.audio_format.bit_depth}-bit ${start.snapshot.audio_format.encoding} / mono\n\n`,
    );

    if (!options.skipNoiseCheck) {
      process.stdout.write('前 3 秒执行环境噪声检测，请保持安静。\n');
      try {
        report.noise_check = await client.request(
          'check_noise',
          { threshold_dbfs: options.noiseThresholdDbfs },
          20_000,
        );
      } catch (error) {
        report.noise_check_error = error.message;
      }
      if (options.mode === 'short') process.stdout.write('现在请持续朗读或播放测试音。\n');
    }

    const onPowerCutArm = options.mode === 'power-cut'
      ? async (row) => {
          report.power_cut.nonce = randomUUID();
          const evidence = buildPowerCutEvidence(report, options, sessionDirectory, row);
          const sessionEvidencePath = path.join(sessionDirectory, POWER_CUT_SESSION_EVIDENCE);
          const phase1EvidencePath = path.join(runDirectory, 'power-cut-evidence.json');
          if (pathEntryExists(sessionEvidencePath) || pathEntryExists(phase1EvidencePath)) {
            throw new Error('power-cut 证据文件已存在，拒绝覆盖或重复 armed');
          }
          writeJsonDurable(sessionEvidencePath, evidence);
          writeJsonDurable(phase1EvidencePath, evidence);
          report.power_cut.phase = 'armed';
          report.power_cut.armed_at = evidence.armed_at;
          report.power_cut.evidence = evidence;
          writeJsonDurable(path.join(runDirectory, 'acceptance-report.json'), report);
          process.stdout.write(`phase-1 报告: ${path.join(runDirectory, 'acceptance-report.json')}\n`);
          process.stdout.write(`phase-1 证据: ${phase1EvidencePath}\n`);
        }
      : null;
    const monitor = await monitorCapture(
      client,
      sessionDirectory,
      options,
      telemetry,
      onPowerCutArm,
    );
    report.progress_rows = monitor.rows;
    report.progress_summary = summarizeProgress(monitor.rows, options.sampleRate, options.pollSeconds);
    if (FAULT_MODES.has(options.mode)) {
      report.fault = {
        trigger_at: monitor.trigger_at,
        detected_at: monitor.detected_at,
        detected_elapsed_seconds: monitor.detected_elapsed_seconds,
        captured_before_trigger: monitor.captured_before_trigger,
        seconds_after_trigger: monitor.seconds_after_trigger,
        first_storage_critical_elapsed_seconds: monitor.first_storage_critical_elapsed_seconds,
        seconds_after_storage_critical: monitor.seconds_after_storage_critical,
        first_fault_row: monitor.first_fault_row,
        first_fault_kind_row: monitor.first_fault_kind_row,
      };
    }
    report.aborted = monitor.aborted;
    if (options.mode === 'power-cut') {
      // Reaching this branch proves that no real power loss happened. Seal the
      // fixture safely so an unattended or mistimed run cannot be mistaken for
      // a successful destructive test.
      report.stop = await safeStopSession(client);
      sessionStarted = false;
      try {
        report.engine.exit = await client.shutdown();
      } catch (error) {
        report.engine.shutdown_error = error.message;
        report.engine.exit = client.shutdownResult ?? client.exitResult;
      }
      report.inspection = inspectSession(sessionDirectory);
      report.power_cut.phase = 'not-performed';
      report.power_cut.message = '工具在测试机断电前恢复运行，本轮已安全停止，不计入断电验收。';
      report.checks = [{
        id: 'power-cut-observed',
        label: '录制进程由整机断电中断',
        status: 'FAIL',
        details: report.power_cut,
      }];
      addEngineExitCheck(report.checks, report.engine);
      report.overall = 'INCOMPLETE';
      return;
    }
    report.stop = await safeStopSession(client);
    sessionStarted = false;

    if (FAULT_MODES.has(options.mode)) {
      try {
        const unexpected = await client.request(
          'export_session',
          { session_dir: sessionDirectory, expected_session_id: sessionId },
          120_000,
        );
        report.export = { expected_rejection: false, unexpected_result: unexpected };
      } catch (error) {
        report.export = { expected_rejection: true, error: error.message };
      }
    } else if (options.export && report.stop.result) {
      try {
        report.export = {
          result: await client.request(
            'export_session',
            { session_dir: sessionDirectory, expected_session_id: sessionId },
            30 * 60_000,
          ),
        };
      } catch (error) {
        report.export = { error: error.message };
      }
    } else {
      report.export = { skipped: true };
    }

    try {
      report.engine.exit = await client.shutdown();
    } catch (error) {
      report.engine.shutdown_error = error.message;
      report.engine.exit = client.shutdownResult ?? client.exitResult;
    }
    const inspection = inspectSession(sessionDirectory);
    report.inspection = inspection;
    const checks = FAULT_MODES.has(options.mode)
      ? evaluateFault(report, options, inspection)
      : evaluateNormal(report, options, inspection);
    const stderrText = client.refreshStderrText();
    const panic = /panicked|fatal runtime error|stack overflow/i.test(stderrText);
    addCheck(checks, 'engine-no-panic', '引擎无 panic/fatal runtime error', !panic, {
      stderr_tail: stderrText.slice(-8_000),
    });
    report.checks = checks;
    report.overall = overallFromChecks(checks, report.aborted || !report.stop.result);
    report.progress_samples_recorded = report.progress_rows.length;
    delete report.progress_rows;
  } catch (error) {
    report.tool_error = error.stack ?? error.message;
    report.overall = 'INCOMPLETE';
    if (sessionStarted) {
      report.stop = await safeStopSession(client);
      sessionStarted = false;
    }
    try {
      report.engine = report.engine ?? { path: enginePath, binary_sha256: engineSha256, ready: client.readyPayload };
      report.engine.exit = await client.shutdown();
    } catch (shutdownError) {
      report.engine = report.engine ?? { path: enginePath, binary_sha256: engineSha256, ready: client.readyPayload };
      report.engine.shutdown_error = shutdownError.message;
      report.engine.exit = client.shutdownResult ?? client.exitResult;
    }
  } finally {
    telemetry.close();
    client.closeLogs();
  }
}

function printSummary(report, reportPath) {
  process.stdout.write(`\n验收结果: ${report.overall}\n`);
  for (const check of report.checks ?? []) {
    process.stdout.write(`  [${check.status}] ${check.label}\n`);
  }
  if (report.tool_error) process.stdout.write(`\n工具错误:\n${report.tool_error}\n`);
  process.stdout.write(`\n报告: ${reportPath}\n`);
  if (report.session_dir) process.stdout.write(`录制目录: ${report.session_dir}\n`);
}

async function main() {
  installAbortHandler();
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

  const runDirectory = path.join(options.output, `${timestampForPath()}-${options.mode}-${process.pid}`);
  fs.mkdirSync(runDirectory, { recursive: true });
  const reportPath = path.join(runDirectory, 'acceptance-report.json');
  const report = {
    schema_version: 1,
    tool_version: TOOL_VERSION,
    acceptance_tool_sha256: ACCEPTANCE_TOOL_SHA256,
    mode: options.mode,
    started_at: new Date().toISOString(),
    completed_at: null,
    overall: 'INCOMPLETE',
    host: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      hostname: os.hostname(),
      // Test boot injection is deliberately unavailable to production recover.
      // It is only reachable through the explicit test-only qualification class.
      boot: hostBootIdentity(
        process.env,
        Date.now(),
        os.uptime(),
        os.hostname(),
        options.testOnlyPowerCut,
      ),
      node: process.version,
      electron: process.versions.electron ?? null,
      cpus: os.cpus().map((cpu) => cpu.model),
      total_memory_bytes: os.totalmem(),
    },
    options: {
      ...options,
      engine: options.engine,
      output: options.output,
      sessionDir: options.sessionDir,
    },
    qualification: options.qualificationId === null
      ? null
      : {
          qualification_id: options.qualificationId,
          run_id: options.qualificationRunId,
          installer_sha256: options.installerSha256,
        },
    checks: [],
  };
  writeJsonDurable(reportPath, report);

  try {
    if (options.mode === 'inspect') {
      report.session_dir = options.sessionDir;
      report.inspection = inspectSession(options.sessionDir);
      report.checks = evaluateSealedSession(report.inspection);
      report.overall = overallFromChecks(report.checks);
    } else if (options.mode === 'inventory') {
      await runInventory(options, runDirectory, report);
    } else if (options.mode === 'recover') {
      await runRecover(options, runDirectory, report);
    } else if (options.mode === 'replug') {
      await runReplug(options, runDirectory, report);
    } else {
      await runCapture(options, runDirectory, report);
    }
  } catch (error) {
    report.tool_error = error.stack ?? error.message;
    report.overall = 'INCOMPLETE';
  }
  report.completed_at = new Date().toISOString();
  writeJsonDurable(reportPath, report);
  printSummary(report, reportPath);
  process.exitCode = report.overall === 'PASS' || report.overall === 'TEST_ONLY_PASS'
    ? 0
    : report.overall === 'FAIL'
      ? 1
      : 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  candidateEnginePaths,
  defaultOutputRoot,
  evaluateInventory,
  engineExitWasClean,
  evaluateSealedSession,
  faultEvidenceRows,
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
};
