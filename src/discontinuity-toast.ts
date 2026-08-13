export const DISCONTINUITY_TOAST_MS = 8_000;

export function discontinuityDurationMs(silenceSamples: number, sampleRate: number): number {
  return Math.round(silenceSamples / Math.max(1, sampleRate) * 1_000);
}

export function shouldShowDiscontinuityToast(previousCount: number, nextCount: number): boolean {
  return nextCount > previousCount && nextCount > 0;
}
