import { t } from '../shared/i18n/index.ts';
import type { AudioDevice, CaptureShareMode, DeviceStreamConfiguration } from './types';

/**
 * Mirrors the recorder engine's input representation precision policy.
 * This is the driver's digital sample representation, not the interface ADC's
 * effective number of bits (ENOB).
 */

export function normalizeCaptureShareMode(value: unknown): CaptureShareMode {
  return value === 'shared' ? 'shared' : 'exclusive';
}

export function captureShareModeLabel(mode: CaptureShareMode | string | undefined): string {
  return mode === 'shared' ? t('setup.shared') : t('setup.exclusive');
}

export function configurationsForShareMode(
  device: AudioDevice | null | undefined,
  mode: CaptureShareMode,
): DeviceStreamConfiguration[] {
  const configurations = device?.configurations ?? [];
  const tagged = configurations.filter((configuration) => configuration.share_mode === mode);
  if (tagged.length > 0) return tagged;
  if (mode === 'shared') {
    return configurations.filter((configuration) => !configuration.share_mode);
  }
  return [];
}

export function deviceExclusiveAvailable(device: AudioDevice | null | undefined): boolean {
  if (!device) return false;
  if (device.exclusive_available === true) return true;
  return (device.configurations ?? []).some((configuration) => configuration.share_mode === 'exclusive');
}

export function captureShareModeForDevice(
  device: AudioDevice | null | undefined,
  requestedMode: CaptureShareMode,
  exclusiveCaptureAvailable = true,
): CaptureShareMode {
  if (!exclusiveCaptureAvailable) return 'shared';
  if (device?.backend?.trim().toLocaleLowerCase('en-US') === 'asio') return 'exclusive';
  if (requestedMode === 'exclusive' && !deviceExclusiveAvailable(device)) {
    return 'shared';
  }
  if (requestedMode === 'shared'
    && configurationsForShareMode(device, 'shared').length === 0
    && deviceExclusiveAvailable(device)) {
    return 'exclusive';
  }
  return requestedMode;
}

export function captureShareModeForSelection(
  device: AudioDevice | null | undefined,
  selectedPreset: Readonly<{
    deviceId: string;
    captureShareMode?: CaptureShareMode;
  }> | null | undefined,
  exclusiveCaptureAvailable = true,
): CaptureShareMode {
  const matchingPreset = Boolean(device && selectedPreset?.deviceId === device.id);
  const requestedMode = matchingPreset
    ? normalizeCaptureShareMode(selectedPreset?.captureShareMode)
    : deviceExclusiveAvailable(device)
      ? 'exclusive'
      : 'shared';
  return captureShareModeForDevice(device, requestedMode, exclusiveCaptureAvailable);
}

export function inputSampleFormatRepresentationBits(format: string): number | null {
  switch (format.trim().toLowerCase()) {
    case 'i8':
    case 'u8':
      return 8;
    case 'i16':
    case 'u16':
      return 16;
    case 'i24':
    case 'u24':
      return 24;
    case 'i32':
    case 'u32':
      return 32;
    case 'i64':
    case 'u64':
      return 64;
    case 'f32':
      return 24;
    case 'f64':
      return 53;
    default:
      return null;
  }
}

export function minimumInputRepresentationBits(outputBitDepth: number): number | null {
  if (outputBitDepth === 16) return 16;
  if (outputBitDepth === 24 || outputBitDepth === 32) return 24;
  return null;
}

export function captureFormatsSupportBitDepth(
  formats: readonly string[],
  outputBitDepth: number,
): boolean {
  const minimumBits = minimumInputRepresentationBits(outputBitDepth);
  if (minimumBits === null) return false;
  return formats.some((format) => {
    const representationBits = inputSampleFormatRepresentationBits(format);
    return representationBits !== null && representationBits >= minimumBits;
  });
}

export const CAPTURE_SAMPLE_FORMATS = ['i16', 'i24', 'i32', 'f32'] as const;
export type CaptureSampleFormat = (typeof CAPTURE_SAMPLE_FORMATS)[number];

/** New recording tasks always deliver mono PCM16, regardless of driver input. */
export const DEFAULT_DELIVERY_BIT_DEPTH = 16 as const;

const PREFERRED_CAPTURE_SAMPLE_FORMATS: readonly CaptureSampleFormat[] = ['i24', 'f32', 'i32', 'i16'];

const REJECTED_INPUT_DEVICE = /阵列|array|senary|bluetooth|hands-?free|headset|communications|立体声混音|stereo mix|what u hear|wave out/i;
const DISCOURAGED_INPUT_DEVICE = /built-?in|internal microphone|内置|realtek|generic low latency asio|asio4all|voicemeeter|fl studio asio|virtual asio/i;

export type InputDeviceKind = 'production' | 'discouraged' | 'rejected';

export function classifyInputDevice(device: { name?: string } | null | undefined): InputDeviceKind {
  const name = device?.name?.trim() ?? '';
  if (!name) return 'discouraged';
  if (REJECTED_INPUT_DEVICE.test(name)) return 'rejected';
  if (DISCOURAGED_INPUT_DEVICE.test(name)) return 'discouraged';
  return 'production';
}

export function inputDeviceNeedsWarning(kind: InputDeviceKind): boolean {
  return kind !== 'production';
}

export function preferredInputDevice<T extends {
  id: string;
  name: string;
  is_default?: boolean;
  production_recommended?: boolean;
  production_priority?: number;
}>(
  devices: readonly T[],
  defaultId?: string | null,
): T | null {
  if (!devices.length) return null;
  const recommended = [...devices]
    .filter((device) => (
      device.production_recommended === true
      && classifyInputDevice(device) === 'production'
    ))
    .sort((left, right) => (
      (right.production_priority ?? 0) - (left.production_priority ?? 0)
    ));
  if (recommended.length) return recommended[0] ?? null;
  const production = devices.filter((device) => classifyInputDevice(device) === 'production');
  const usable = production.length
    ? production
    : devices.filter((device) => classifyInputDevice(device) !== 'rejected');
  const pool = usable.length ? usable : [...devices];
  return pool.find((device) => device.id === defaultId) ?? pool[0] ?? null;
}

export function productionSampleRates(rates: readonly number[]): number[] {
  return rates.filter((rate) => rate >= 44_100);
}

export function normalizeCaptureSampleFormat(value: unknown): CaptureSampleFormat | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return CAPTURE_SAMPLE_FORMATS.find((format) => format === normalized) ?? null;
}

export function captureSampleFormatFromBitDepth(bitDepth: number): CaptureSampleFormat {
  if (bitDepth === 16) return 'i16';
  if (bitDepth === 32) return 'f32';
  return 'i24';
}

export function preferredCaptureSampleFormat(formats: readonly string[]): CaptureSampleFormat | null {
  const available = new Set(
    formats
      .map((format) => normalizeCaptureSampleFormat(format))
      .filter((format): format is CaptureSampleFormat => format !== null),
  );
  return PREFERRED_CAPTURE_SAMPLE_FORMATS.find((format) => available.has(format))
    ?? [...available][0]
    ?? null;
}

export function captureSampleFormatsForConfiguration(
  configurations: readonly DeviceStreamConfiguration[],
  sampleRate: number,
  inputChannel: number,
): CaptureSampleFormat[] {
  const available = new Set<CaptureSampleFormat>();
  for (const configuration of configurations) {
    if (configuration.channels < inputChannel) continue;
    if (sampleRate < configuration.min_sample_rate || sampleRate > configuration.max_sample_rate) continue;
    const format = normalizeCaptureSampleFormat(configuration.sample_format);
    if (format) available.add(format);
  }
  return CAPTURE_SAMPLE_FORMATS.filter((format) => available.has(format));
}

export function captureConfigurationSupported(
  device: AudioDevice | null | undefined,
  mode: CaptureShareMode,
  sampleRate: number,
  inputChannel: number,
  inputSampleFormat: string,
): boolean {
  if (!device || device.production_blocked_reason) return false;
  const normalizedFormat = normalizeCaptureSampleFormat(inputSampleFormat);
  if (!normalizedFormat || !Number.isSafeInteger(inputChannel) || inputChannel < 1) return false;
  return captureSampleFormatsForConfiguration(
    configurationsForShareMode(device, mode),
    sampleRate,
    inputChannel,
  ).includes(normalizedFormat);
}

export function captureSampleFormatLabel(format: string): string {
  switch (normalizeCaptureSampleFormat(format)) {
    case 'i16':
      return t('setup.bit16');
    case 'i24':
      return t('setup.bit24');
    case 'i32':
      return t('setup.bit32Int');
    case 'f32':
      return t('setup.bit32');
    default:
      return format.toUpperCase();
  }
}
