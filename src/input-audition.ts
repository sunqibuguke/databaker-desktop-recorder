import type {
  InputAuditionCacheConfiguration,
  InputAuditionCommandResult,
  InputAuditionDecision,
  InputAuditionFinishResult,
  InputAuditionState,
  SessionSnapshot,
} from './types';

export const INPUT_AUDITION_DURATION_SECONDS = 10;
const INPUT_AUDITION_CACHE_SCHEMA_VERSION = 2;

export type InputAuditionDialogPhase =
  | 'checking-cache'
  | 'idle'
  | 'recording'
  | 'finishing'
  | 'ready'
  | 'confirming'
  | 'skipping'
  | 'cancelling'
  | 'warning'
  | 'error';

export function inputAuditionConfiguration(
  snapshot: SessionSnapshot,
): InputAuditionCacheConfiguration {
  return {
    backend: String(snapshot.capture_backend ?? 'unknown').trim().toLocaleLowerCase('en-US'),
    deviceName: snapshot.device_name,
    deviceId: snapshot.device_id,
    sampleRate: snapshot.audio_format.sample_rate,
    outputBitDepth: snapshot.audio_format.bit_depth,
    inputSampleFormat: snapshot.input_sample_format
      ?? (snapshot.audio_format.encoding === 'float'
        ? 'f32'
        : `i${snapshot.audio_format.bit_depth}`),
    inputChannels: snapshot.audio_format.input_channels,
    inputChannel: snapshot.audio_format.input_channel ?? 1,
    shareMode: snapshot.capture_share_mode ?? 'exclusive',
    requestedBufferFrames: snapshot.requested_capture_buffer_frames ?? null,
    actualBufferFrames: snapshot.capture_buffer_frames ?? null,
  };
}

function normalizeLogicalText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

export function normalizeWindowsAudioInstancePrefix(value: string): string {
  return value.replace(/\(\d+\s*-\s*/gu, '(');
}

export function logicalInputAuditionConfigurationKey(
  configuration: InputAuditionCacheConfiguration,
): string {
  const backend = normalizeLogicalText(configuration.backend);
  const deviceName = normalizeLogicalText(configuration.deviceName);
  const driverName = configuration.driverName
    ? normalizeLogicalText(configuration.driverName)
    : '';
  const logicalDeviceName = backend === 'asio' && driverName
    ? driverName
    : normalizeWindowsAudioInstancePrefix(deviceName);
  return JSON.stringify([
    INPUT_AUDITION_CACHE_SCHEMA_VERSION,
    backend,
    logicalDeviceName,
    configuration.deviceId
      ? normalizeLogicalText(configuration.deviceId)
      : null,
    configuration.inputChannels,
    configuration.sampleRate,
    configuration.outputBitDepth,
    normalizeLogicalText(configuration.inputSampleFormat),
    configuration.inputChannel,
    normalizeLogicalText(configuration.shareMode),
    configuration.requestedBufferFrames ?? null,
    configuration.actualBufferFrames ?? null,
  ]);
}

export function shouldPromptInputAudition(
  decision: InputAuditionDecision | null | undefined,
): boolean {
  return decision?.status !== 'confirmed' && decision?.status !== 'skipped';
}

export function inputAuditionDurationSeconds(
  audition: Pick<InputAuditionState, 'required_samples'> | null | undefined,
  sampleRate: number,
): number {
  if (!audition
    || !Number.isFinite(audition.required_samples)
    || audition.required_samples <= 0
    || !Number.isFinite(sampleRate)
    || sampleRate <= 0) return INPUT_AUDITION_DURATION_SECONDS;
  return audition.required_samples / sampleRate;
}

export function inputAuditionProgress(
  audition: Pick<InputAuditionState, 'captured_samples' | 'required_samples'> | null | undefined,
  elapsedSeconds: number,
  sampleRate: number,
): number {
  const required = audition?.required_samples ?? INPUT_AUDITION_DURATION_SECONDS * sampleRate;
  const captured = audition?.captured_samples;
  const estimated = Math.max(0, elapsedSeconds) * sampleRate;
  const completed = Number.isFinite(captured) && (captured ?? 0) >= 0
    ? Math.max(captured!, estimated)
    : estimated;
  if (!Number.isFinite(required) || required <= 0) return 0;
  return Math.min(1, Math.max(0, completed / required));
}

export function inputAuditionStateFromResult(
  result: InputAuditionCommandResult,
): InputAuditionState | null {
  return result.input_audition ?? result.snapshot.input_audition ?? null;
}

export function validInputAuditionFinishResult(
  value: InputAuditionFinishResult,
): boolean {
  return Boolean(
    value
      && value.input_audition
      && (value.input_audition.status === 'ready' || value.input_audition.status === 'warning')
      && typeof value.file_path === 'string'
      && value.file_path.toLocaleLowerCase('en-US').endsWith('.wav')
      && Array.isArray(value.bins)
      && value.bins.every((bin) => (
        Array.isArray(bin)
        && bin.length === 2
        && bin.every((sample) => Number.isFinite(sample))
      )),
  );
}

export function inputAuditionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return '输入试听未完成';
}

export function inputAuditionCaptureFingerprint(
  value: InputAuditionFinishResult | InputAuditionState | null | undefined,
): string | null {
  if (!value) return null;
  const source = value as InputAuditionFinishResult & InputAuditionState;
  const fingerprint = source.capture_fingerprint
    ?? source.input_audition?.capture_fingerprint
    ?? source.input_audition?.fingerprint
    ?? source.fingerprint;
  return typeof fingerprint === 'string' && fingerprint ? fingerprint : null;
}

export function createCurrentInputAuditionDecision(
  status: 'confirmed' | 'skipped',
  captureFingerprint: string | null,
  sourceCheckId: string,
  now = Date.now(),
): InputAuditionDecision {
  return {
    status,
    captureFingerprint,
    sourceCheckId,
    decidedAt: new Date(now).toISOString(),
  };
}
