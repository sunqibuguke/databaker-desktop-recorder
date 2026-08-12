export {};

declare module '*.css';

import type { DebugLogDraft, DebugLogEntry, DebugLogSnapshot } from './debug-log';
import type { CapturePresetDraft, CapturePresetLoadResult, CapturePresetStore, DefaultOutputResult, PrompterState, RecordingHistoryPage } from './types';

declare global {
  interface Window {
    recorder: {
      runtime: 'desktop' | 'preview';
      platform?: string;
      request<T = unknown>(command: string, payload?: unknown): Promise<T>;
      openScript(): Promise<{ filePath: string; name: string; content: string } | null>;
      chooseOutput(): Promise<string | null>;
      defaultOutput(): Promise<DefaultOutputResult>;
      getLocale?(): Promise<string>;
      setLocale?(locale: string): Promise<string>;
      onLocaleChanged?(listener: (locale: string) => void): () => void;
      loadCapturePresets(): Promise<CapturePresetLoadResult>;
      saveCapturePreset(preset: CapturePresetDraft): Promise<CapturePresetStore>;
      deleteCapturePreset(id: string): Promise<CapturePresetStore>;
      setLastCapturePreset(id: string | null): Promise<CapturePresetStore>;
      listRecordings(root: string, options?: { offset?: number; limit?: number }): Promise<RecordingHistoryPage>;
      deleteRecording(root: string, sessionDir: string, sessionId: string): Promise<{ session_dir: string; session_id: string }>;
      joinPath(...parts: string[]): Promise<string>;
      readAudio(filePath: string): Promise<ArrayBuffer>;
      openPath(target: string): Promise<void>;
      openPrompter(): Promise<boolean>;
      closePrompter(): Promise<void>;
      togglePrompterFullscreen(): Promise<boolean>;
      getPrompterState(): Promise<PrompterState | null>;
      getPrompterStatus(): Promise<{ open: boolean; ready: boolean }>;
      sendPrompterState(state: PrompterState): void;
      onPrompterState(listener: (state: PrompterState) => void): () => void;
      onPrompterStatus(listener: (status: { open: boolean; ready: boolean }) => void): () => void;
      onEngineEvent(listener: (message: unknown) => void): () => void;
      onEngineOffline(listener: (message: string) => void): () => void;
      getDebugLog?(): Promise<DebugLogSnapshot>;
      appendDebugLog?(entry: DebugLogDraft): Promise<DebugLogEntry>;
      bindDebugLog?(sessionDir: string, sessionId: string): Promise<DebugLogSnapshot>;
      unbindDebugLog?(reason?: string): Promise<void>;
      saveDebugLog?(content: string, defaultName: string): Promise<string | null>;
      onDebugLog?(listener: (entry: DebugLogEntry) => void): () => void;
    };
  }
}
