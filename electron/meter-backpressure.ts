export const ENGINE_EVENT_CHANNEL = 'engine:event';
export const ENGINE_METER_CHANNEL = 'engine:meter';
export const ENGINE_METER_ACK_CHANNEL = 'engine:meter-ack';

type DeliveryState<T> = {
  inFlightDeliveryId: number | null;
  pending: T | undefined;
  hasPending: boolean;
};

export type MeterDeliveryErrorHandler<TTarget extends object> = (
  error: unknown,
  target: TTarget,
) => void;

/**
 * Bounds periodic meter telemetry before it enters Electron's renderer IPC
 * queue. One target may have at most one unacknowledged delivery and one
 * latest-only pending value; intermediate values are intentionally replaced.
 */
export class LatestOnlyMeterBackpressure<TTarget extends object, T> {
  readonly #states = new WeakMap<TTarget, DeliveryState<T>>();
  readonly #send: (target: TTarget, deliveryId: number, value: T) => void;
  readonly #onSendError: MeterDeliveryErrorHandler<TTarget>;
  #nextDeliveryId = 1;

  constructor(
    send: (target: TTarget, deliveryId: number, value: T) => void,
    onSendError: MeterDeliveryErrorHandler<TTarget> = () => undefined,
  ) {
    this.#send = send;
    this.#onSendError = onSendError;
  }

  enqueue(target: TTarget, value: T): void {
    const state = this.#stateFor(target);
    if (state.inFlightDeliveryId !== null) {
      state.pending = value;
      state.hasPending = true;
      return;
    }
    this.#deliver(target, state, value);
  }

  acknowledge(target: TTarget, deliveryId: unknown): void {
    if (!Number.isSafeInteger(deliveryId) || (deliveryId as number) <= 0) return;
    const state = this.#states.get(target);
    if (!state || state.inFlightDeliveryId !== deliveryId) return;

    state.inFlightDeliveryId = null;
    if (!state.hasPending) return;
    const latest = state.pending as T;
    state.pending = undefined;
    state.hasPending = false;
    this.#deliver(target, state, latest);
  }

  /** Clears only the unsent healthy value; an already-sent packet still needs its ACK. */
  clearPending(target: TTarget): void {
    const state = this.#states.get(target);
    if (!state) return;
    state.pending = undefined;
    state.hasPending = false;
  }

  /** Invalidates the lane when a renderer navigates, exits, or is replaced. */
  reset(target: TTarget): void {
    this.#states.delete(target);
  }

  #stateFor(target: TTarget): DeliveryState<T> {
    const existing = this.#states.get(target);
    if (existing) return existing;
    const created: DeliveryState<T> = {
      inFlightDeliveryId: null,
      pending: undefined,
      hasPending: false,
    };
    this.#states.set(target, created);
    return created;
  }

  #deliver(target: TTarget, state: DeliveryState<T>, value: T): void {
    const deliveryId = this.#allocateDeliveryId();
    state.inFlightDeliveryId = deliveryId;
    try {
      this.#send(target, deliveryId, value);
    } catch (error) {
      // A dead/reloading renderer must not wedge a future replacement behind
      // an ACK that can never arrive.
      if (state.inFlightDeliveryId === deliveryId) state.inFlightDeliveryId = null;
      state.pending = undefined;
      state.hasPending = false;
      this.#onSendError(error, target);
    }
  }

  #allocateDeliveryId(): number {
    const deliveryId = this.#nextDeliveryId;
    this.#nextDeliveryId = deliveryId >= Number.MAX_SAFE_INTEGER ? 1 : deliveryId + 1;
    return deliveryId;
  }
}

export function isMeterEngineEvent(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  return (message as { event?: unknown }).event === 'meter';
}
