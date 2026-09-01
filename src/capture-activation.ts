import type { AudioDevice, InspectedSessionState, SessionSnapshot } from './types';

export type CaptureActivationTarget = Readonly<{
  sessionDir: string;
  snapshot: SessionSnapshot;
  device: AudioDevice | null;
  blocked: boolean;
}>;

/**
 * Freezes the inspected task context before React state updates. This keeps an
 * immediate inspect/recreate -> activate request and its error recovery tied
 * to the task that was actually sent to the engine.
 */
export function captureActivationTarget(
  inspected: InspectedSessionState,
  availableDevices: readonly AudioDevice[],
): CaptureActivationTarget {
  const { snapshot } = inspected;
  const device = snapshot.device_id
    ? availableDevices.find((candidate) => candidate.id === snapshot.device_id) ?? null
    : availableDevices.find((candidate) => candidate.name === snapshot.device_name) ?? null;
  const blocked = inspected.data_health === 'readonly' || Boolean(
    inspected.faulted
    || snapshot.status === 'faulted'
    || snapshot.overflow_samples > 0,
  );
  return { sessionDir: inspected.session_dir, snapshot, device, blocked };
}
