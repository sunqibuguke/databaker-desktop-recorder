export const DIGITAL_SILENCE_WARNING = '输入连续为数字零，检查声卡静音/通道';

export function inputQualityWarning(
  isRunning: boolean,
  captureFault: boolean,
  digitalSilenceSuspected: boolean,
): string {
  if (!isRunning || captureFault || !digitalSilenceSuspected) return '';
  return DIGITAL_SILENCE_WARNING;
}

export function shouldHandleLiveMeter(phase: string): boolean {
  return phase === 'running';
}
