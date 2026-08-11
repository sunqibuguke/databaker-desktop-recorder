/**
 * Mirrors the recorder engine's input representation precision policy.
 * This is the driver's digital sample representation, not the interface ADC's
 * effective number of bits (ENOB).
 */
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
