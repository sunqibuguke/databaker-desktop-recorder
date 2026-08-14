import type { PrompterCue } from './types';

export type ReaderCueKey = 'wait' | 'hush' | 'read' | 'stop' | 'halt';

export function resolveMonitorCue(cue: PrompterCue, tailSilenceMet: boolean): PrompterCue {
  if (cue === 'recording' && tailSilenceMet) return 'ready';
  return cue;
}

export function readerFacingCue(cue: PrompterCue, showTailReady = false): PrompterCue {
  if (cue === 'ready' && !showTailReady) return 'recording';
  return cue;
}

export function readerCueKey(cue: PrompterCue, showTailReady = false): ReaderCueKey {
  switch (readerFacingCue(cue, showTailReady)) {
    case 'checking':
    case 'pending':
      return 'hush';
    case 'recording':
      return 'read';
    case 'ready':
      return 'stop';
    case 'fault':
      return 'halt';
    default:
      return 'wait';
  }
}

export function prompterShowsSilenceRing(cue: PrompterCue, progress: number): boolean {
  if (cue === 'pending' || cue === 'checking') return true;
  return cue === 'recording' && progress > 0 && progress < 1;
}

export function readerCueHasKeyboardHint(label: string): boolean {
  return /esc|space|空格|确认/i.test(label);
}
