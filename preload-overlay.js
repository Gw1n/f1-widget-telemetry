const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('overlay', {
  onSession: subscribe('overlay:session'),
  onFrame: subscribe('overlay:frame'),
  onSettings: subscribe('overlay:settings'),
});
