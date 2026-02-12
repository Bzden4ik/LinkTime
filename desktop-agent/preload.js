const { contextBridge, ipcRenderer } = require('electron');

// Inject sessionKey into localStorage BEFORE page scripts run
const savedKey = ipcRenderer.sendSync('get-session-key');
if (savedKey) {
    localStorage.setItem('sessionKey', savedKey);
}

contextBridge.exposeInMainWorld('__electronAPI', {
    sendSessionKey: (key) => ipcRenderer.send('session-key', key),
    isElectron: true
});
