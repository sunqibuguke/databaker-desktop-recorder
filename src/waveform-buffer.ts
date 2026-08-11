export const WAVEFORM_BIN_SAMPLES = 64;
export const WAVEFORM_WINDOW_SECONDS = 12;
// Keep the live edge inside the canvas instead of drawing it on the clipped
// right border. This small future gutter makes a new consonant visible on the
// first packet rather than only after it has travelled into the viewport.
export const WAVEFORM_LIVE_EDGE_GUTTER_SECONDS = 0.5;
// Rust normally publishes a preview packet every 80 ms. The renderer may move
// the time cursor a little beyond the newest packet so motion remains smooth
// between packets, but it must stop extrapolating if telemetry stalls.
export const WAVEFORM_MAX_EXTRAPOLATION_MS = 200;

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

export function advanceWaveformPlayhead(
  currentSample: number,
  latestReceivedSample: number,
  elapsedMs: number,
  sampleRate: number,
): number {
  const rate = Math.max(1, sampleRate);
  const latest = Math.max(0, latestReceivedSample);
  const current = Math.max(latest, Number.isFinite(currentSample) ? currentSample : latest);
  const advance = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) * rate / 1_000;
  const maximumLead = rate * WAVEFORM_MAX_EXTRAPOLATION_MS / 1_000;
  return Math.min(latest + maximumLead, current + advance);
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
