export {};

declare module '*.css';

import type { CapturePresetDraft, CapturePresetLoadResult, CapturePresetStore, PrompterState, RecordingHistoryEntry } from './types';

declare global {
  interface Window {
    recorder: {
      request<T = unknown>(command: string, payload?: unknown): Promise<T>;
      openScript(): Promise<{ filePath: string; name: string; content: string } | null>;
      chooseOutput(): Promise<string | null>;
      defaultOutput(): Promise<string>;
      loadCapturePresets(): Promise<CapturePresetLoadResult>;
      saveCapturePreset(preset: CapturePresetDraft): Promise<CapturePresetStore>;
      deleteCapturePreset(id: string): Promise<CapturePresetStore>;
      setLastCapturePreset(id: string | null): Promise<CapturePresetStore>;
      listRecordings(root: string): Promise<RecordingHistoryEntry[]>;
      joinPath(...parts: string[]): Promise<string>;
      readAudio(filePath: string): Promise<ArrayBuffer>;
      openPath(target: string): Promise<void>;
      openPrompter(): Promise<boolean>;
      closePrompter(): Promise<void>;
      togglePrompterFullscreen(): Promise<boolean>;
      getPrompterState(): Promise<PrompterState | null>;
      sendPrompterState(state: PrompterState): void;
      onPrompterState(listener: (state: PrompterState) => void): () => void;
      onEngineEvent(listener: (message: unknown) => void): () => void;
      onEngineOffline(listener: (message: string) => void): () => void;
    };
  }
}
