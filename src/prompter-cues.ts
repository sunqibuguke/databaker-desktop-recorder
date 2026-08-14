import type { PrompterCue } from './types';

export type ReaderCueKey = 'wait' | 'hush' | 'read' | 'stop' | 'halt';

export function resolveMonitorCue(cue: PrompterCue, tailSilenceMet: boolean): PrompterCue {
  if (cue === 'recording' && tailSilenceMet) return 'ready';
  return cue;
}

export function readerFacingCue(cue: PrompterCue): PrompterCue {
  return cue === 'ready' ? 'recording' : cue;
}

export function readerCueKey(cue: PrompterCue): ReaderCueKey {
  switch (readerFacingCue(cue)) {
    case 'checking':
    case 'pending':
      return 'hush';
    case 'recording':
    case 'ready':
      return 'read';
    case 'fault':
      return 'halt';
    default:
      return 'wait';
  }
}

export function prompterShowsSilenceRing(cue: PrompterCue): boolean {
  return cue === 'pending' || cue === 'checking';
}

export function readerCueHasKeyboardHint(label: string): boolean {
  return /esc|space|空格|确认/i.test(label);
}
