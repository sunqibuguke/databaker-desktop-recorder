export type FrameScheduler = (callback: () => void) => number;
export type FrameCanceller = (handle: number) => void;

export type LatestFrameCommitter<T> = {
  enqueue: (value: T) => void;
  commitImmediately: (value: T) => void;
  invalidate: () => void;
  dispose: () => void;
};

/**
 * Keeps only the newest disposable telemetry value until the next visual
 * frame. `commitImmediately` is reserved for state that must not be dropped,
 * such as an audio capture fault.
 */
export function createLatestFrameCommitter<T>(
  commit: (value: T) => void,
  scheduleFrame: FrameScheduler,
  cancelFrame: FrameCanceller,
): LatestFrameCommitter<T> {
  let pendingValue: T | undefined;
  let hasPendingValue = false;
  let frameHandle: number | null = null;
  let generation = 0;
  let disposed = false;

  const cancelPendingFrame = () => {
    generation += 1;
    if (frameHandle !== null) cancelFrame(frameHandle);
    frameHandle = null;
    pendingValue = undefined;
    hasPendingValue = false;
  };

  return {
    enqueue(value: T) {
      if (disposed) return;
      pendingValue = value;
      hasPendingValue = true;
      if (frameHandle !== null) return;
      const scheduledGeneration = generation;
      frameHandle = scheduleFrame(() => {
        if (disposed || scheduledGeneration !== generation) return;
        frameHandle = null;
        if (!hasPendingValue) return;
        const latest = pendingValue as T;
        pendingValue = undefined;
        hasPendingValue = false;
        commit(latest);
      });
    },

    commitImmediately(value: T) {
      if (disposed) return;
      cancelPendingFrame();
      commit(value);
    },

    invalidate() {
      if (disposed) return;
      cancelPendingFrame();
    },

    dispose() {
      if (disposed) return;
      cancelPendingFrame();
      disposed = true;
    },
  };
}
