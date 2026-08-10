import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('recorder', {
  request: (command: string, payload: unknown = {}) => ipcRenderer.invoke('engine:request', command, payload),
  openScript: () => ipcRenderer.invoke('dialog:open-script'),
  chooseOutput: () => ipcRenderer.invoke('dialog:choose-output'),
  defaultOutput: () => ipcRenderer.invoke('app:default-output'),
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
    const wrapped = (_event: Electron.IpcRendererEvent, message: unknown) => listener(message);
    ipcRenderer.on('engine:event', wrapped);
    return () => ipcRenderer.removeListener('engine:event', wrapped);
  },
  onEngineOffline: (listener: (message: string) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on('engine:offline', wrapped);
    return () => ipcRenderer.removeListener('engine:offline', wrapped);
  },
});
