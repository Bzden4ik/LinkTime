const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__electronAPI', {
    sendSessionKey: (key) => ipcRenderer.send('session-key', key)
});
