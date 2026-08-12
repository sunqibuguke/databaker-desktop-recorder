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
