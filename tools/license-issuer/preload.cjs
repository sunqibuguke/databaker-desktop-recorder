'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('issuer', {
  issue: (payload) => ipcRenderer.invoke('issuer:issue', payload),
  verify: (ticket) => ipcRenderer.invoke('issuer:verify', ticket),
});
