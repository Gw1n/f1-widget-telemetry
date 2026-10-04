const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('f1', {
  get: (endpoint, params, opts) => ipcRenderer.invoke('openf1:get', endpoint, params, opts),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:alwaysOnTop', flag),
  live: {
    account: () => ipcRenderer.invoke('live:account'),
    login: (creds) => ipcRenderer.invoke('live:login', creds),
    logout: () => ipcRenderer.invoke('live:logout'),
    start: (opts) => ipcRenderer.invoke('live:start', opts),
    stop: () => ipcRenderer.invoke('live:stop'),
    onRows: (cb) => ipcRenderer.on('live:rows', (_e, batch) => cb(batch)),
    onStatus: (cb) => ipcRenderer.on('live:status', (_e, status) => cb(status)),
  },
  overlay: {
    toggle: () => ipcRenderer.invoke('overlay:toggle'),
    configure: (patch) => ipcRenderer.invoke('overlay:configure', patch),
    sendSession: (session) => ipcRenderer.send('overlay:session', session),
    sendFrame: (frame) => ipcRenderer.send('overlay:frame', frame),
    onStatus: (cb) => ipcRenderer.on('overlay:status', (_e, status) => cb(status)),
  },
});
