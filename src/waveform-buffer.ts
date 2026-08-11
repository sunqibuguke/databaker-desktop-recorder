export const WAVEFORM_BIN_SAMPLES = 64;
export const WAVEFORM_WINDOW_SECONDS = 12;
// Keep the live edge inside the canvas instead of drawing it on the clipped
// right border. This small future gutter makes a new consonant visible on the
// first packet rather than only after it has travelled into the viewport.
export const WAVEFORM_LIVE_EDGE_GUTTER_SECONDS = 0.5;
// Rust normally publishes a preview packet every 80 ms. Interpolate only up to
// the authoritative capture cursor. If renderer/IPC congestion creates a much
// larger gap, snap to that cursor instead of replaying stale data at high speed.
export const WAVEFORM_MAX_INTERPOLATION_LAG_MS = 250;

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

export function waveformWindowSampleCount(sampleRate: number): number {
  return Math.max(1, sampleRate) * WAVEFORM_WINDOW_SECONDS;
}

/**
 * The capture cursor is the live clock; a waveform packet may be older after
 * IPC or renderer congestion. Never place an old packet on the live edge and
 * then visually fast-forward it when a newer packet arrives.
 */
export function reconcileWaveformTimelineSample(
  capturedSample: number | undefined,
  waveformEndSample: number | undefined,
  previousTimelineSample: number | null,
): number {
  const previous = Number.isSafeInteger(previousTimelineSample) && (previousTimelineSample ?? -1) >= 0
    ? Number(previousTimelineSample)
    : 0;
  // captured_samples is authoritative whenever present. waveform_end_sample
  // is only a compatibility fallback and must never move the display beyond a
  // valid capture watermark.
  const received = Number.isSafeInteger(capturedSample) && (capturedSample ?? -1) >= 0
    ? Number(capturedSample)
    : Number.isSafeInteger(waveformEndSample) && (waveformEndSample ?? -1) >= 0
      ? Number(waveformEndSample)
      : previous;
  return Math.max(previous, received);
}

export function advanceWaveformPlayhead(
  currentSample: number,
  latestReceivedSample: number,
  elapsedMs: number,
  sampleRate: number,
): number {
  const rate = Math.max(1, sampleRate);
  const latest = Math.max(0, latestReceivedSample);
  const current = Math.min(latest, Math.max(0, Number.isFinite(currentSample) ? currentSample : latest));
  const advance = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) * rate / 1_000;
  const maximumInterpolationLag = rate * WAVEFORM_MAX_INTERPOLATION_LAG_MS / 1_000;
  if (latest - current > maximumInterpolationLag) return latest;
  return Math.min(latest, current + advance);
}

export function waveformSampleHorizontalPosition(
  sample: number,
  playheadSample: number,
  sampleRate: number,
): number {
  const liveEdgeGutterSamples = Math.max(1, sampleRate) * WAVEFORM_LIVE_EDGE_GUTTER_SECONDS;
  return 1 - (
    (playheadSample - sample + liveEdgeGutterSamples)
    / waveformWindowSampleCount(sampleRate)
    * 2
  );
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
