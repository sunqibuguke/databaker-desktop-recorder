/** Extra quiet audio captured before and after speech, beyond the configured interval. */
export const SILENCE_SAFETY_MARGIN_MS = 100;

/** Review-only tolerance. Never use it to finish a live capture early. */
export const SILENCE_TIMING_TOLERANCE_MS = 100;

export function captureSilenceDurationMs(configuredMs: number): number {
  return Math.max(0, configuredMs) + SILENCE_SAFETY_MARGIN_MS;
}

export function silenceDurationIsShort(
  measuredMs: number,
  requiredMs: number,
  toleranceMs = SILENCE_TIMING_TOLERANCE_MS,
): boolean {
  if (!(requiredMs > 0)) return false;
  // Missing quiet audio should still be visible even for a very short setting.
  return measuredMs <= 0 || measuredMs + Math.max(0, toleranceMs) < requiredMs;
}

export function silenceSamplesAreShort(
  measuredSamples: number,
  requiredSamples: number,
  sampleRate?: number,
): boolean {
  // A missing rate cannot justify assuming a number of samples equals 100 ms.
  const toleranceSamples = Number.isSafeInteger(sampleRate) && Number(sampleRate) > 0
    ? Math.floor(Number(sampleRate) * SILENCE_TIMING_TOLERANCE_MS / 1_000)
    : 0;
  return silenceDurationIsShort(measuredSamples, requiredSamples, toleranceSamples);
}
