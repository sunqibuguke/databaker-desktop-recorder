'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { createInterface: createPrompt } = require('node:readline/promises');

const PROTOCOL_VERSION = 1;
const TOOL_VERSION = 1;
const MODES = new Set(['inventory', 'short', 'soak', 'unplug', 'disk-full', 'inspect']);
const FAULT_MODES = new Set(['unplug', 'disk-full']);
const BIT_DEPTHS = new Set([16, 24, 32]);

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

let abortRequested = false;
process.on('SIGINT', () => {
  if (abortRequested) {
    process.stderr.write('\n已在安全停止，请勿反复强制结束进程。\n');
    return;
  }
  abortRequested = true;
  process.stderr.write('\n收到 Ctrl+C：将先封存当前音频，验收结果会标记为 INCOMPLETE。\n');
});

function usage() {
  return `DataBaker Windows 外置声卡验收工具

用法:
  node scripts/windows-audio-acceptance.cjs --mode <mode> [options]

模式:
  inventory   只枚举 WASAPI 输入设备、稳定 ID 和驱动配置
  short       短录音、进度监测、安全停止、WAV 头和 RIFF/RF64 整轨导出验证
  soak        2–8 小时连续录音和文件增长监测（默认不拷贝整轨）
  unplug      进行中人工拔出 USB 声卡，验证 fail-closed 和故障标记
  disk-full   在专用测试卷上人工降低剩余空间，验证磁盘保护
  inspect     只读检查已有录制目录，需 --session-dir

常用参数:
  --engine <path>                recorder-engine.exe 路径（可自动定位）
  --output <directory>           验收结果根目录
  --device-id <id>               list_devices 返回的稳定设备 ID
  --device-index <n>             界面打印的 1-based 设备序号
  --sample-rate <hz>             默认 48000
  --bit-depth <16|24|32>         交付 WAV 位深，默认 24
  --minimum-input-format-bits <n> 驱动输入表示最低位数；默认 16-bit 交付要求 16，24/32-bit 要求 24
  --channel <n>                  声卡输入通道（1-based），默认 1
  --seconds <n>                  short 录制秒数，默认 20
  --hours <2..8>                 soak 时长，默认 2
  --poll-seconds <n>             进度落盘间隔，默认 1（soak 默认 5）
  --trigger-delay-seconds <n>    故障操作倒计时，默认 10
  --fault-timeout-seconds <n>    等待故障被检测的时间，默认 60
  --confirm-dedicated-volume     disk-full 确认 1：输出位于可丢弃测试卷
  --confirm-not-system-drive     disk-full 确认 2：该卷不是 Windows 系统盘
  --noise-threshold-dbfs <n>     环境噪声阈值，默认 -40
  --skip-noise-check             不执行 3 秒环境噪声检测
  --export                       soak 也生成 full-track.wav（可能很大）
  --no-export                    short 不生成 full-track.wav
  --yes                          非交互执行；无设备参数时选系统默认设备
  --session-dir <path>           inspect 的录制目录
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
    confirmDedicatedVolume: false,
    confirmNotSystemDrive: false,
    noiseThresholdDbfs: -40,
    skipNoiseCheck: false,
    export: null,
    yes: false,
    sessionDir: null,
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
        index += 1;
        break;
      case '--fault-timeout-seconds':
        options.faultTimeoutSeconds = parseNumber(valueFor(index, flag), flag);
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
      default:
        throw new Error(`未知参数: ${flag}`);
    }
  }

  if (options.help) return options;
  if (!MODES.has(options.mode)) throw new Error(`--mode 必须是 ${[...MODES].join(', ')}`);
  if (options.mode === 'inspect' && !options.sessionDir) throw new Error('inspect 需要 --session-dir');
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
    // 32-bit Float 交付通常来自 24-bit ADC。这里只拒绝明显的
    // 16-bit driver container 降级，不把样本表示宽度误当成 ADC ENOB 证明。
    options.minimumInputFormatBits = options.bitDepth === 16 ? 16 : 24;
  }
  if (![8, 16, 24, 32, 64].includes(options.minimumInputFormatBits)) {
    throw new Error('--minimum-input-format-bits 必须是 8、16、24、32 或 64');
  }
  if (options.sampleRate < 8_000 || options.sampleRate > 384_000) {
    throw new Error('--sample-rate 必须在 8000–384000 之间');
  }
  if (options.channel < 1 || options.channel > 256) throw new Error('--channel 必须在 1–256 之间');
  if (options.seconds < 5 || options.seconds > 3_600) throw new Error('--seconds 必须在 5–3600 之间');
  if (options.mode === 'soak' && (options.hours < 2 || options.hours > 8)) {
    throw new Error('soak --hours 必须在 2–8 之间');
  }
  if (options.pollSeconds !== null && (options.pollSeconds < 0.25 || options.pollSeconds > 60)) {
    throw new Error('--poll-seconds 必须在 0.25–60 之间');
  }
  if (options.triggerDelaySeconds < 2 || options.triggerDelaySeconds > 600) {
    throw new Error('--trigger-delay-seconds 必须在 2–600 之间');
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
  const match = /^\s*[iuf](\d+)\s*$/i.exec(String(format ?? ''));
  if (!match) return null;
  const bits = Number(match[1]);
  return Number.isSafeInteger(bits) && bits > 0 ? bits : null;
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

function segmentStatSnapshot(sessionDirectory) {
  const directory = path.join(sessionDirectory, 'audio', 'segments');
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => /^master-\d{6}\.wav$/i.test(name)).sort();
  } catch {
    return { files: [], total_bytes: 0, error: null };
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
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`不是普通文件: ${filePath}`);
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
  const completeFrames = blockAlign > 0 ? Math.floor(physicalDataBytes / blockAlign) : 0;
  const trailingBytes = blockAlign > 0 ? physicalDataBytes % blockAlign : physicalDataBytes;
  const declaredFrames = blockAlign > 0 ? Math.floor(declaredDataBytes / blockAlign) : 0;
  const exactRiffHeader =
    !isRf64 &&
    riffSize32 !== 0xffffffff &&
    riffSize32 + 8 === stat.size &&
    payloadMatchesDeclared &&
    trailingBytes === 0 &&
    (format.format_code !== 3 || factFrames === completeFrames);
  const exactRf64Header =
    isRf64 &&
    riffSize32 === 0xffffffff &&
    data.size_32 === 0xffffffff &&
    ds64.riff_size + 8 === stat.size &&
    ds64.sample_count === completeFrames &&
    payloadMatchesDeclared &&
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
    segments: [],
    segment_errors: [],
    total_physical_frames: 0,
    total_file_bytes: 0,
    full_track: null,
    full_track_error: null,
  };
  const stat = fs.statSync(sessionDirectory);
  if (!stat.isDirectory()) throw new Error(`不是录制目录: ${sessionDirectory}`);
  result.exists = true;
  result.snapshot = safeReadJson(path.join(sessionDirectory, 'metadata', 'items.snapshot.json'));
  result.session_summary = safeReadJson(path.join(sessionDirectory, 'session.json'));
  const faultMarkerPath = path.join(sessionDirectory, 'metadata', 'audio-fault.json');
  result.fault_marker_exists = pathEntryExists(faultMarkerPath);
  result.fault_marker = safeReadJson(faultMarkerPath);
  result.fault_marker_parse_error = result.fault_marker_exists && result.fault_marker === null;
  result.fault_marker_temporary_exists = pathEntryExists(path.join(sessionDirectory, 'metadata', 'audio-fault.tmp'));
  const segmentDirectory = path.join(sessionDirectory, 'audio', 'segments');
  let names = [];
  try {
    names = fs.readdirSync(segmentDirectory).filter((name) => /^master-\d{6}\.wav$/i.test(name)).sort();
  } catch (error) {
    result.segment_errors.push(error.message);
  }
  for (const name of names) {
    try {
      const wav = inspectWav(path.join(segmentDirectory, name));
      result.segments.push(wav);
      result.total_physical_frames += wav.physical_complete_frames;
      result.total_file_bytes += wav.file_bytes;
    } catch (error) {
      result.segment_errors.push(`${name}: ${error.message}`);
    }
  }
  const fullTrack = path.join(sessionDirectory, 'export', 'full-track.wav');
  if (fs.existsSync(fullTrack)) {
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
      actual_format_bits: actualInputFormatBits,
      minimum_format_bits: options.minimumInputFormatBits,
      limitation: '此项只验证驱动样本表示宽度，不证明声卡 ADC 有效位数',
    },
  );
  addCheck(checks, 'captured-monotonic', '采集样本水位单调', progress.captured_monotonic, progress);
  addCheck(checks, 'committed-monotonic', '持久化样本水位单调', progress.committed_monotonic, progress);
  addCheck(checks, 'file-growth-monotonic', '分段 WAV 总字节数单调', progress.file_bytes_monotonic, progress);
  addCheck(
    checks,
    'commit-lag',
    '采集与持久化水位差不超过 10 秒',
    progress.max_commit_lag_seconds !== null && progress.max_commit_lag_seconds <= 10,
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
    addCheck(checks, 'full-track-export', '整轨 WAV 导出成功且头部完整', Boolean(inspection.full_track?.exact_header), {
      export: report.export,
      wav: inspection.full_track,
      error: inspection.full_track_error,
    });
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
  if (options.mode === 'unplug') {
    addCheck(
      checks,
      'unplug-detection-latency',
      '拔出提示后 15 秒内进入 fail-closed',
      Number(fault?.seconds_after_trigger) <= 15,
      fault,
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

async function monitorCapture(client, sessionDirectory, options, telemetryLog) {
  const rows = [];
  const started = Date.now();
  const normalDurationMs = options.mode === 'soak' ? options.hours * 3_600_000 : options.seconds * 1_000;
  const expectedFault = FAULT_MODES.has(options.mode);
  const triggerAtMs = expectedFault ? started + options.triggerDelaySeconds * 1_000 : null;
  const deadlineMs = expectedFault ? triggerAtMs + options.faultTimeoutSeconds * 1_000 : started + normalDurationMs;
  let announcedTrigger = false;
  let detectedAtMs = null;
  let detectedElapsedSeconds = null;
  let capturedBeforeTrigger = null;
  let firstCriticalElapsed = null;
  let lastConsoleSecond = -1;

  while (!abortRequested) {
    const now = Date.now();
    if (expectedFault && !announcedTrigger && now >= triggerAtMs) {
      announcedTrigger = true;
      capturedBeforeTrigger = Number(client.latestMeter?.captured_samples ?? 0);
      process.stdout.write('\x07\n============================================================\n');
      process.stdout.write(
        options.mode === 'unplug'
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
      phase: expectedFault && announcedTrigger ? 'fault-observation' : 'recording',
      captured_samples: Number(state?.snapshot?.captured_samples ?? meter.captured_samples ?? 0),
      committed_samples: Number(state?.snapshot?.committed_samples ?? meter.committed_samples ?? 0),
      overflow_samples: Number(state?.snapshot?.overflow_samples ?? meter.overflow_samples ?? 0),
      faulted: Boolean(meter.faulted),
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
    rows.push(row);
    telemetryLog.write(row, row.faulted || row.fault_marker_exists || row.storage_status === 'critical');
    if (row.storage_status === 'critical' && firstCriticalElapsed === null) firstCriticalElapsed = elapsedSeconds;
    const isFault = row.faulted || row.overflow_samples > 0 || markerExists;
    if (isFault && detectedAtMs === null) {
      detectedAtMs = Date.now();
      detectedElapsedSeconds = elapsedSeconds;
      process.stdout.write(`\n已检测故障: t=${elapsedSeconds.toFixed(1)}s，继续观察时间轴排空。\n`);
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
      if (detectedAtMs !== null && Date.now() - detectedAtMs >= Math.max(5_000, options.pollSeconds * 3_000)) break;
      if (Date.now() >= deadlineMs) break;
    }
    await sleep(options.pollSeconds * 1_000);
  }

  const firstFault = rows.find((row) => row.faulted || row.overflow_samples > 0 || row.fault_marker_exists) ?? null;
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
    first_fault_row: firstFault,
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
    if (options.mode === 'disk-full') message = '确认输出在可丢弃的专用测试卷，按 Enter 启动；勿对系统盘做填满测试。';
    await prompt.question(`${message}\n`);
  } finally {
    prompt.close();
  }
}

async function runInventory(options, runDirectory, report) {
  const enginePath = findEngine(options.engine);
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
    report.engine = { path: enginePath, ready };
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
      report.engine = report.engine ?? { path: enginePath, ready: client.readyPayload };
      report.engine.exit = await client.shutdown();
    } catch (shutdownError) {
      report.engine = report.engine ?? { path: enginePath, ready: client.readyPayload };
      report.engine.shutdown_error = shutdownError.message;
      report.engine.exit = client.shutdownResult ?? client.exitResult;
    }
  } finally {
    client.closeLogs();
  }
}

async function runCapture(options, runDirectory, report) {
  const enginePath = findEngine(options.engine);
  const client = new EngineClient(
    enginePath,
    runDirectory,
    path.join(runDirectory, 'protocol.jsonl'),
    path.join(runDirectory, 'engine-stderr.log'),
  );
  const telemetry = new NdjsonLog(path.join(runDirectory, 'telemetry.jsonl'));
  let sessionStarted = false;
  let sessionDirectory = path.join(runDirectory, 'recording');
  try {
    const ready = await client.start();
    report.engine = { path: enginePath, ready };
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

    const monitor = await monitorCapture(client, sessionDirectory, options, telemetry);
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
      };
    }
    report.aborted = monitor.aborted;
    report.stop = await safeStopSession(client);
    sessionStarted = false;

    if (FAULT_MODES.has(options.mode)) {
      try {
        const unexpected = await client.request('export_session', { session_dir: sessionDirectory }, 120_000);
        report.export = { expected_rejection: false, unexpected_result: unexpected };
      } catch (error) {
        report.export = { expected_rejection: true, error: error.message };
      }
    } else if (options.export && report.stop.result) {
      try {
        report.export = { result: await client.request('export_session', { session_dir: sessionDirectory }, 30 * 60_000) };
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
      report.engine = report.engine ?? { path: enginePath, ready: client.readyPayload };
      report.engine.exit = await client.shutdown();
    } catch (shutdownError) {
      report.engine = report.engine ?? { path: enginePath, ready: client.readyPayload };
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
    mode: options.mode,
    started_at: new Date().toISOString(),
    completed_at: null,
    overall: 'INCOMPLETE',
    host: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      hostname: os.hostname(),
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
    checks: [],
  };
  writeJsonDurable(reportPath, report);

  try {
    if (options.mode === 'inspect') {
      report.session_dir = options.sessionDir;
      report.inspection = inspectSession(options.sessionDir);
      const snapshot = report.inspection.snapshot;
      report.checks = [];
      addCheck(report.checks, 'segments-present', '存在可解析的分段 WAV', report.inspection.segments.length > 0, report.inspection);
      addCheck(report.checks, 'no-segment-errors', '分段无解析错误', report.inspection.segment_errors.length === 0, report.inspection.segment_errors);
      addCheck(
        report.checks,
        'physical-frame-watermark',
        '物理完整帧不少于快照持久化水位',
        Boolean(snapshot) && report.inspection.total_physical_frames >= Number(snapshot?.committed_samples),
        { physical: report.inspection.total_physical_frames, committed: snapshot?.committed_samples },
      );
      report.overall = overallFromChecks(report.checks);
    } else if (options.mode === 'inventory') {
      await runInventory(options, runDirectory, report);
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
  process.exitCode = report.overall === 'PASS' ? 0 : report.overall === 'FAIL' ? 1 : 2;
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
};
