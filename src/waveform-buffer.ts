export const WAVEFORM_BIN_SAMPLES = 64;
// A wider viewport keeps the live trace readable on production workstations
// without slowing or otherwise falsifying the authoritative PCM timeline.
export const WAVEFORM_WINDOW_SECONDS = 20;
// Keep the live edge far enough inside the canvas that a new consonant is
// unmistakably visible on its first packet. With a 20-second viewport this
// reserves the rightmost 10% as a stable live lane instead of hiding new
// speech in the clipped last few pixels.
export const WAVEFORM_LIVE_EDGE_GUTTER_SECONDS = 2;
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

export function reviewBinHorizontalPosition(index: number, count: number): number {
  if (count <= 0) return 0;
  return -1 + (index + 0.5) / Math.max(1, count) * 2;
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

export function waveformWindowStartSample(playheadSample: number, sampleRate: number): number {
  return playheadSample
    + Math.max(1, sampleRate) * WAVEFORM_LIVE_EDGE_GUTTER_SECONDS
    - waveformWindowSampleCount(sampleRate);
}

export type WaveformTakeSpan = {
  startSample: number;
  endSample: number | null;
  /** True while the current take is still being captured, even if a predicted end is known. */
  live?: boolean;
};

/**
 * Pending silence after the operator clicks is not a deliverable take.
 * The live scope only paints a recorded slice once speech has started;
 * a discarded silent stop therefore leaves no red band or markers.
 */
export function waveformTakeIsActive(recording: boolean, hasSpoken: boolean): boolean {
  return recording && hasSpoken;
}

/**
 * Recorded-take spans ride the same PCM clock as the scrolling waveform.
 * A rising recording edge opens a span; a falling edge closes it at the
 * live capture cursor so start/end markers keep their historical place.
 */
export function reconcileWaveformTakeSpans(
  spans: readonly WaveformTakeSpan[],
  recording: boolean,
  takeStartSample: number | undefined,
  cursorSample: number,
  takeEndSample?: number,
): WaveformTakeSpan[] {
  const cursor = Math.max(0, Number.isFinite(cursorSample) ? cursorSample : 0);
  const resolvedStart = Number.isSafeInteger(takeStartSample) && (takeStartSample ?? -1) >= 0
    ? Number(takeStartSample)
    : cursor;
  const last = spans[spans.length - 1];
  const liveOpen = Boolean(last && (last.endSample === null || last.live));
  const predictedEnd = Number.isSafeInteger(takeEndSample)
    && Number(takeEndSample) > resolvedStart
    && Number(takeEndSample) < cursor
    ? Number(takeEndSample)
    : null;

  if (recording) {
    const next: WaveformTakeSpan = predictedEnd === null
      ? { startSample: resolvedStart, endSample: null }
      : { startSample: resolvedStart, endSample: predictedEnd, live: true };
    if (!last || !liveOpen) {
      return [...spans, next];
    }
    if (last.startSample !== next.startSample || last.endSample !== next.endSample || Boolean(last.live) !== Boolean(next.live)) {
      return [...spans.slice(0, -1), next];
    }
    return spans as WaveformTakeSpan[];
  }

  if (last && liveOpen) {
    return [...spans.slice(0, -1), {
      startSample: last.startSample,
      endSample: last.endSample ?? Math.max(last.startSample, cursor),
    }];
  }
  return spans as WaveformTakeSpan[];
}

export function pruneWaveformTakeSpans(
  spans: readonly WaveformTakeSpan[],
  windowStartSample: number,
): WaveformTakeSpan[] {
  return spans.filter((span) => (span.endSample ?? Number.POSITIVE_INFINITY) > windowStartSample);
}

export function sampleIsRecordedTake(
  sample: number,
  spans: readonly WaveformTakeSpan[],
): boolean {
  return spans.some((span) => (
    sample >= span.startSample
    && (span.endSample === null || sample < span.endSample)
  ));
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
