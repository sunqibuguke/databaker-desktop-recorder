export type InputAuditionDecisionStatus = 'confirmed' | 'skipped';

export type InputAuditionCacheConfiguration = Readonly<{
  backend: string;
  deviceName: string;
  /**
   * Kept only as diagnostic context. Windows endpoint ids can change when the
   * same interface is moved to another USB socket, so this value is
   * deliberately excluded from the logical cache key.
   */
  deviceId?: string;
  driverName?: string;
  sampleRate: number;
  outputBitDepth: number;
  inputSampleFormat: string;
  inputChannels: number;
  inputChannel: number;
  shareMode: string;
  requestedBufferFrames?: number | null;
  actualBufferFrames?: number | null;
}>;

export type InputAuditionDecision = Readonly<{
  status: InputAuditionDecisionStatus;
  decidedAt: string;
  captureFingerprint: string | null;
  sourceCheckId: string;
}>;

type StoredInputAuditionDecision = InputAuditionDecision & Readonly<{
  logicalKey: string;
}>;

const CACHE_SCHEMA_VERSION = 1;
const MAX_TEXT_LENGTH = 512;

function normalizeLogicalText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

export function normalizeWindowsAudioInstancePrefix(value: string): string {
  return value.replace(/\(\d+\s*-\s*/gu, '(');
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const normalized = normalizeLogicalText(value);
  if (!normalized || normalized.length > MAX_TEXT_LENGTH) throw new Error(`${label}无效`);
  return normalized;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, label);
}

function requiredInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label}无效`);
  }
  return value as number;
}

function optionalInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  return requiredInteger(value, label, 1, 16_777_216);
}

function requiredCheckId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('输入试听操作标识无效');
  const checkId = value.trim();
  if (!checkId || checkId.length > 128) throw new Error('输入试听操作标识无效');
  return checkId;
}

export function normalizeInputAuditionCacheConfiguration(
  value: unknown,
): InputAuditionCacheConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('输入试听配置无效');
  }
  const source = value as Record<string, unknown>;
  const backend = requiredText(source.backend, '音频后端');
  const deviceName = requiredText(source.deviceName, '输入设备名称');
  const driverName = optionalText(source.driverName, '驱动名称');
  const deviceId = optionalText(source.deviceId, '输入设备 ID');
  const inputChannels = requiredInteger(source.inputChannels, '输入声道数', 1, 1_024);
  const inputChannel = requiredInteger(source.inputChannel, '录制声道', 1, inputChannels);
  return {
    backend,
    deviceName,
    deviceId,
    driverName,
    sampleRate: requiredInteger(source.sampleRate, '采样率', 8_000, 768_000),
    outputBitDepth: requiredInteger(source.outputBitDepth, '输出位深', 8, 64),
    inputSampleFormat: requiredText(source.inputSampleFormat, '驱动输入格式'),
    inputChannels,
    inputChannel,
    shareMode: requiredText(source.shareMode, '采集模式'),
    requestedBufferFrames: optionalInteger(source.requestedBufferFrames, '请求缓冲区'),
    actualBufferFrames: optionalInteger(source.actualBufferFrames, '实际缓冲区'),
  };
}

export function logicalInputAuditionKey(value: unknown): string {
  const configuration = normalizeInputAuditionCacheConfiguration(value);
  // ASIO normally exposes a driver/display name, while WASAPI exposes an
  // endpoint display name. Neither branch includes endpoint paths, container
  // ids, USB topology, or the raw deviceId supplied to open the stream.
  const logicalDeviceName = configuration.backend === 'asio' && configuration.driverName
    ? configuration.driverName
    : normalizeWindowsAudioInstancePrefix(configuration.deviceName);
  return JSON.stringify([
    CACHE_SCHEMA_VERSION,
    configuration.backend,
    logicalDeviceName,
    configuration.inputChannels,
    configuration.sampleRate,
    configuration.outputBitDepth,
    configuration.inputSampleFormat,
    configuration.inputChannel,
    configuration.shareMode,
    configuration.requestedBufferFrames ?? null,
    configuration.actualBufferFrames ?? null,
  ]);
}

function optionalCaptureFingerprint(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 256) throw new Error('采集指纹无效');
  return value;
}

export class InputAuditionDecisionCache {
  private readonly decisions = new Map<string, StoredInputAuditionDecision>();

  constructor(private readonly now: () => number = Date.now) {}

  get(configuration: unknown): InputAuditionDecision | null {
    const stored = this.decisions.get(logicalInputAuditionKey(configuration));
    if (!stored) return null;
    return {
      status: stored.status,
      decidedAt: stored.decidedAt,
      captureFingerprint: stored.captureFingerprint,
      sourceCheckId: stored.sourceCheckId,
    };
  }

  remember(
    configuration: unknown,
    status: unknown,
    captureFingerprint?: unknown,
    sourceCheckId?: unknown,
    decidedAt?: unknown,
  ): InputAuditionDecision {
    if (status !== 'confirmed' && status !== 'skipped') {
      throw new Error('输入试听决定无效');
    }
    const normalizedSourceCheckId = requiredCheckId(sourceCheckId);
    const normalizedDecidedAt = decidedAt === undefined
      ? new Date(this.now()).toISOString()
      : requiredDecisionTimestamp(decidedAt);
    const logicalKey = logicalInputAuditionKey(configuration);
    const stored: StoredInputAuditionDecision = {
      logicalKey,
      status,
      decidedAt: normalizedDecidedAt,
      captureFingerprint: optionalCaptureFingerprint(captureFingerprint),
      sourceCheckId: normalizedSourceCheckId,
    };
    this.decisions.set(logicalKey, stored);
    return {
      status: stored.status,
      decidedAt: stored.decidedAt,
      captureFingerprint: stored.captureFingerprint,
      sourceCheckId: stored.sourceCheckId,
    };
  }

  delete(configuration: unknown): boolean {
    return this.decisions.delete(logicalInputAuditionKey(configuration));
  }

  clear(): void {
    this.decisions.clear();
  }

  get size(): number {
    return this.decisions.size;
  }
}

function requiredDecisionTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !value.trim()) {
    throw new Error('输入试听决定时间无效');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('输入试听决定时间无效');
  return new Date(timestamp).toISOString();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function inputAuditionConfigurationFromEngineResult(
  result: unknown,
): InputAuditionCacheConfiguration | null {
  const envelope = record(result);
  const snapshot = record(envelope?.snapshot);
  const audioFormat = record(snapshot?.audio_format);
  if (!snapshot || !audioFormat) return null;
  try {
    return normalizeInputAuditionCacheConfiguration({
      backend: snapshot.capture_backend ?? 'unknown',
      deviceName: snapshot.device_name,
      deviceId: snapshot.device_id,
      sampleRate: audioFormat.sample_rate,
      outputBitDepth: audioFormat.bit_depth,
      inputSampleFormat: snapshot.input_sample_format,
      inputChannels: audioFormat.input_channels,
      inputChannel: audioFormat.input_channel,
      shareMode: snapshot.capture_share_mode ?? 'exclusive',
      requestedBufferFrames: snapshot.requested_capture_buffer_frames,
      actualBufferFrames: snapshot.capture_buffer_frames,
    });
  } catch {
    return null;
  }
}

export function captureFingerprintFromInputAuditionResult(result: unknown): string | null {
  const envelope = record(result);
  const inputAudition = record(envelope?.input_audition)
    ?? record(record(envelope?.snapshot)?.input_audition);
  const value = envelope?.capture_fingerprint
    ?? inputAudition?.capture_fingerprint
    ?? inputAudition?.fingerprint;
  return typeof value === 'string' && value.length <= 256 ? value : null;
}

export function inputAuditionStatusFromResult(result: unknown): string | null {
  const envelope = record(result);
  const inputAudition = record(envelope?.input_audition)
    ?? record(record(envelope?.snapshot)?.input_audition);
  return typeof inputAudition?.status === 'string' ? inputAudition.status : null;
}

export function inputAuditionCheckIdFromResult(result: unknown): string | null {
  const envelope = record(result);
  const inputAudition = record(envelope?.input_audition)
    ?? record(record(envelope?.snapshot)?.input_audition);
  const value = inputAudition?.check_id;
  return typeof value === 'string' && value.trim() && value.length <= 128
    ? value.trim()
    : null;
}

export function inputAuditionDecidedAtFromResult(result: unknown): string | null {
  const envelope = record(result);
  const inputAudition = record(envelope?.input_audition)
    ?? record(record(envelope?.snapshot)?.input_audition);
  const status = inputAudition?.status;
  const value = status === 'confirmed'
    ? inputAudition?.confirmed_at
    : status === 'skipped'
      ? inputAudition?.skipped_at
      : null;
  try {
    return value === null ? null : requiredDecisionTimestamp(value);
  } catch {
    return null;
  }
}

export function invalidatesInputAuditionCache(message: unknown): boolean {
  const envelope = record(message);
  const event = typeof envelope?.event === 'string' ? envelope.event.toLocaleLowerCase('en-US') : '';
  const payload = record(envelope?.payload);
  if (/capture_fault|engine_offline|input_discontinuity|device_(?:lost|unavailable)/u.test(event)) {
    return true;
  }
  if (event !== 'meter' || !payload) return false;
  return payload.faulted === true
    || payload.storage_status === 'critical'
    || (typeof payload.overflow_samples === 'number' && payload.overflow_samples > 0)
    || (typeof payload.input_discontinuity_count === 'number'
      && payload.input_discontinuity_count > 0);
}

type MeterInvalidationBaseline = Readonly<{
  inputDiscontinuityCount: number;
  overflowSamples: number;
  faulted: boolean;
  storageCritical: boolean;
}>;

export type InputAuditionInvalidationScope = Readonly<{
  generation: number;
  sessionDir: string | null;
}>;

/**
 * Meter counters are cumulative for the active capture. A stateless `> 0`
 * check would erase a newly confirmed audition on every later meter packet.
 * This tracker establishes a baseline per engine generation/session and only
 * invalidates on a new counter increase or fault transition.
 */
export class InputAuditionCacheInvalidationTracker {
  private scopeKey = '';
  private baseline: MeterInvalidationBaseline | null = null;
  private consumeNextMeterAsBaseline = false;

  observe(message: unknown, scope: InputAuditionInvalidationScope): boolean {
    const nextScopeKey = `${scope.generation}\u0000${scope.sessionDir ?? ''}`;
    if (this.scopeKey !== nextScopeKey) {
      this.scopeKey = nextScopeKey;
      this.baseline = null;
      this.consumeNextMeterAsBaseline = false;
    }

    const envelope = record(message);
    const event = typeof envelope?.event === 'string'
      ? envelope.event.toLocaleLowerCase('en-US')
      : '';
    const payload = record(envelope?.payload);
    if (/capture_fault|engine_offline|input_discontinuity|device_(?:lost|unavailable)/u.test(event)) {
      // The following cumulative meter packet usually reports the same event.
      // Adopt it as the new baseline so the same incident is not counted twice.
      this.consumeNextMeterAsBaseline = true;
      return true;
    }
    if (event !== 'meter' || !payload) return false;

    const current: MeterInvalidationBaseline = {
      inputDiscontinuityCount: typeof payload.input_discontinuity_count === 'number'
        && Number.isFinite(payload.input_discontinuity_count)
        ? Math.max(0, payload.input_discontinuity_count)
        : 0,
      overflowSamples: typeof payload.overflow_samples === 'number'
        && Number.isFinite(payload.overflow_samples)
        ? Math.max(0, payload.overflow_samples)
        : 0,
      faulted: payload.faulted === true,
      storageCritical: payload.storage_status === 'critical',
    };
    const previous = this.baseline;
    this.baseline = current;
    if (!previous || this.consumeNextMeterAsBaseline) {
      this.consumeNextMeterAsBaseline = false;
      return false;
    }
    return current.inputDiscontinuityCount > previous.inputDiscontinuityCount
      || current.overflowSamples > previous.overflowSamples
      || (current.faulted && !previous.faulted)
      || (current.storageCritical && !previous.storageCritical);
  }

  reset(): void {
    this.scopeKey = '';
    this.baseline = null;
    this.consumeNextMeterAsBaseline = false;
  }
}
