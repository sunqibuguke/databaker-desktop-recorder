import { contextBridge, ipcRenderer } from 'electron';

// Keep preload self-contained. Sandboxed Electron preload scripts can load
// built-in modules such as `electron`, but cannot require our compiled sibling
// modules from disk.
const ENGINE_EVENT_CHANNEL = 'engine:event';
const ENGINE_METER_CHANNEL = 'engine:meter';
const ENGINE_METER_ACK_CHANNEL = 'engine:meter-ack';

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
  runtime: 'desktop',
  request: (command: string, payload: unknown = {}) => ipcRenderer.invoke('engine:request', command, payload),
  openScript: () => ipcRenderer.invoke('dialog:open-script'),
  chooseOutput: () => ipcRenderer.invoke('dialog:choose-output'),
  defaultOutput: () => ipcRenderer.invoke('app:default-output'),
  loadCapturePresets: () => ipcRenderer.invoke('capture-presets:load'),
  saveCapturePreset: (preset: unknown) => ipcRenderer.invoke('capture-presets:save', preset),
  deleteCapturePreset: (id: string) => ipcRenderer.invoke('capture-presets:delete', id),
  setLastCapturePreset: (id: string | null) => ipcRenderer.invoke('capture-presets:select', id),
  listRecordings: (root: string, options?: { offset?: number; limit?: number }) => (
    ipcRenderer.invoke('recordings:list', root, options)
  ),
  deleteRecording: (root: string, sessionDir: string, sessionId: string) => (
    ipcRenderer.invoke('recordings:delete', { root, session_dir: sessionDir, session_id: sessionId })
  ),
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
