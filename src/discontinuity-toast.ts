export const DISCONTINUITY_TOAST_MS = 8_000;
export const DISCONTINUITY_TOAST_MIN_GAP_MS = 10;
export const DISCONTINUITY_TOAST_STREAK_WINDOW_MS = 50;

export type DiscontinuityToastState = {
  lastCount: number;
  lastSilenceSamples: number;
  consecutiveSilenceSamples: number;
  lastIncreaseAtMs: number;
  primed: boolean;
};

export function initialDiscontinuityToastState(): DiscontinuityToastState {
  return {
    lastCount: 0,
    lastSilenceSamples: 0,
    consecutiveSilenceSamples: 0,
    lastIncreaseAtMs: 0,
    primed: false,
  };
}

export function discontinuityDurationMs(silenceSamples: number, sampleRate: number): number {
  return Math.round(silenceSamples / Math.max(1, sampleRate) * 1_000);
}

export function shouldShowDiscontinuityToast(
  state: DiscontinuityToastState,
  next: {
    count: number;
    silenceSamples: number;
    sampleRate: number;
    nowMs: number;
  },
): { show: boolean; state: DiscontinuityToastState } {
  if (!state.primed) {
    return {
      show: false,
      state: {
        lastCount: next.count,
        lastSilenceSamples: next.silenceSamples,
        consecutiveSilenceSamples: 0,
        lastIncreaseAtMs: 0,
        primed: true,
      },
    };
  }

  if (!(next.count > state.lastCount && next.count > 0)) {
    return {
      show: false,
      state: {
        ...state,
        lastCount: next.count,
        lastSilenceSamples: next.silenceSamples,
        consecutiveSilenceSamples: next.count < state.lastCount ? 0 : state.consecutiveSilenceSamples,
      },
    };
  }

  const addedSamples = Math.max(0, next.silenceSamples - state.lastSilenceSamples);
  const inStreak = state.lastIncreaseAtMs > 0
    && next.nowMs - state.lastIncreaseAtMs <= DISCONTINUITY_TOAST_STREAK_WINDOW_MS;
  const consecutiveSilenceSamples = (inStreak ? state.consecutiveSilenceSamples : 0) + addedSamples;
  const nextState: DiscontinuityToastState = {
    lastCount: next.count,
    lastSilenceSamples: next.silenceSamples,
    consecutiveSilenceSamples,
    lastIncreaseAtMs: next.nowMs,
    primed: true,
  };
  return {
    show: discontinuityDurationMs(consecutiveSilenceSamples, next.sampleRate) >= DISCONTINUITY_TOAST_MIN_GAP_MS,
    state: nextState,
  };
}
