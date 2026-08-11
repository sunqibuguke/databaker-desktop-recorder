import { contextBridge, ipcRenderer } from 'electron';
import {
  ENGINE_EVENT_CHANNEL,
  ENGINE_METER_ACK_CHANNEL,
  ENGINE_METER_CHANNEL,
} from './meter-backpressure';

type EngineEventListener = (message: unknown) => void;

const engineEventListeners = new Set<EngineEventListener>();

function dispatchEngineEvent(message: unknown): void {
  for (const listener of [...engineEventListeners]) listener(message);
}

// Install the meter receiver during preload, before React mounts. Even if no
// UI listener exists yet, every delivered packet is acknowledged so the main
// process can keep the latest-only lane moving instead of waiting forever.
ipcRenderer.on(ENGINE_EVENT_CHANNEL, (_event, message: unknown) => {
  dispatchEngineEvent(message);
});
ipcRenderer.on(
  ENGINE_METER_CHANNEL,
  (_event, deliveryId: unknown, message: unknown) => {
    try {
      dispatchEngineEvent(message);
    } finally {
      if (Number.isSafeInteger(deliveryId) && (deliveryId as number) > 0) {
        ipcRenderer.send(ENGINE_METER_ACK_CHANNEL, deliveryId);
      }
    }
  },
);

contextBridge.exposeInMainWorld('recorder', {
  request: (command: string, payload: unknown = {}) => ipcRenderer.invoke('engine:request', command, payload),
  openScript: () => ipcRenderer.invoke('dialog:open-script'),
  chooseOutput: () => ipcRenderer.invoke('dialog:choose-output'),
  defaultOutput: () => ipcRenderer.invoke('app:default-output'),
  loadCapturePresets: () => ipcRenderer.invoke('capture-presets:load'),
  saveCapturePreset: (preset: unknown) => ipcRenderer.invoke('capture-presets:save', preset),
  deleteCapturePreset: (id: string) => ipcRenderer.invoke('capture-presets:delete', id),
  setLastCapturePreset: (id: string | null) => ipcRenderer.invoke('capture-presets:select', id),
  listRecordings: (root: string) => ipcRenderer.invoke('recordings:list', root),
  joinPath: (...parts: string[]) => ipcRenderer.invoke('path:join', ...parts),
  readAudio: (filePath: string) => ipcRenderer.invoke('audio:read', filePath),
  openPath: (target: string) => ipcRenderer.invoke('shell:open-path', target),
  openPrompter: () => ipcRenderer.invoke('prompter:open'),
  closePrompter: () => ipcRenderer.invoke('prompter:close'),
  togglePrompterFullscreen: () => ipcRenderer.invoke('prompter:toggle-fullscreen'),
  getPrompterState: () => ipcRenderer.invoke('prompter:get-state'),
  sendPrompterState: (state: unknown) => ipcRenderer.send('prompter:update', state),
  onPrompterState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on('prompter:state', wrapped);
    return () => ipcRenderer.removeListener('prompter:state', wrapped);
  },
  onEngineEvent: (listener: (message: unknown) => void) => {
    engineEventListeners.add(listener);
    return () => engineEventListeners.delete(listener);
  },
  onEngineOffline: (listener: (message: string) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on('engine:offline', wrapped);
    return () => ipcRenderer.removeListener('engine:offline', wrapped);
  },
});
