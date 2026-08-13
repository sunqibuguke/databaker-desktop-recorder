export function formatPlaybackClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalTenths = Math.floor(safe * 10);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  const clock = `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}.${tenths}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}

export function playbackProgress(currentTime: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(currentTime) || currentTime <= 0) return 0;
  return Math.min(1, currentTime / duration);
}

export function seekTimeFromClientX(
  clientX: number,
  left: number,
  width: number,
  duration: number,
): number {
  if (!Number.isFinite(duration) || duration <= 0 || width <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - left) / width));
  return ratio * duration;
}
