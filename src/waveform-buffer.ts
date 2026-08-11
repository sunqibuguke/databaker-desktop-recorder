export const WAVEFORM_BIN_SAMPLES = 64;
export const WAVEFORM_WINDOW_SECONDS = 8;
// Rust publishes about every 80 ms. Keeping at most another 120 ms of bins
// gives the renderer enough material for smooth rAF scrolling while bounding
// source-to-canvas latency to roughly 200 ms including IPC jitter.
export const WAVEFORM_TARGET_LATENCY_MS = 120;

export type ReconciledWaveformBatch<T> = {
  bins: T[];
  endSample: number;
  reset: boolean;
};

export function waveformWindowBinCount(sampleRate: number): number {
  return Math.max(
    1,
    Math.ceil(Math.max(1, sampleRate) * WAVEFORM_WINDOW_SECONDS / WAVEFORM_BIN_SAMPLES),
  );
}

export function waveformLatencyBinCount(sampleRate: number): number {
  return Math.max(
    1,
    Math.ceil(
      Math.max(1, sampleRate)
      * WAVEFORM_TARGET_LATENCY_MS
      / 1_000
      / WAVEFORM_BIN_SAMPLES,
    ),
  );
}

export function waveformCatchUpCount(pendingBins: number, sampleRate: number): number {
  return Math.max(0, pendingBins - waveformLatencyBinCount(sampleRate));
}

/**
 * Uses Rust's authoritative sample endpoint to reject stale packets and detect
 * a dropped preview packet. Audio capture remains authoritative; a gap merely
 * resets this disposable visualization instead of inventing continuity.
 */
export function reconcileWaveformBatch<T>(
  bins: readonly T[],
  reportedEndSample: number | undefined,
  previousEndSample: number | null,
): ReconciledWaveformBatch<T> {
  if (!bins.length) {
    return {
      bins: [],
      endSample: previousEndSample ?? 0,
      reset: false,
    };
  }

  const inferredEnd = (previousEndSample ?? 0) + bins.length * WAVEFORM_BIN_SAMPLES;
  const endSample = Number.isSafeInteger(reportedEndSample) && (reportedEndSample ?? 0) > 0
    ? Number(reportedEndSample)
    : inferredEnd;
  const batchStartSample = endSample - bins.length * WAVEFORM_BIN_SAMPLES;
  if (batchStartSample < 0) {
    return { bins: [], endSample: previousEndSample ?? 0, reset: false };
  }
  if (previousEndSample === null) {
    return { bins: [...bins], endSample, reset: false };
  }
  if (endSample <= previousEndSample) {
    return { bins: [], endSample: previousEndSample, reset: false };
  }
  if (batchStartSample > previousEndSample) {
    return { bins: [...bins], endSample, reset: true };
  }

  const overlapSamples = Math.max(0, previousEndSample - batchStartSample);
  const overlapBins = Math.min(
    bins.length,
    Math.ceil(overlapSamples / WAVEFORM_BIN_SAMPLES),
  );
  return {
    bins: bins.slice(overlapBins),
    endSample,
    reset: false,
  };
}
