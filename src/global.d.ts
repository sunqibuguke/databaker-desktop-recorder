export {};

declare module '*.css';

import type { PrompterState, RecordingHistoryEntry } from './types';

declare global {
  interface Window {
    recorder: {
      request<T = unknown>(command: string, payload?: unknown): Promise<T>;
      openScript(): Promise<{ filePath: string; name: string; content: string } | null>;
      chooseOutput(): Promise<string | null>;
      defaultOutput(): Promise<string>;
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
