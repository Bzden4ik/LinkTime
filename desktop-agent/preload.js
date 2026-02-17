const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,

    // Config
    getConfig: () => ipcRenderer.send('get-config'),
    saveConfig: (config) => ipcRenderer.send('save-config', config),
    testConnection: () => ipcRenderer.send('test-connection'),

    // Listeners
    onConfigData:       (cb) => ipcRenderer.on('config-data',       (_, d) => cb(d)),
    onStatusUpdate:     (cb) => ipcRenderer.on('status-update',     (_, d) => cb(d)),
    onConnectionStatus: (cb) => ipcRenderer.on('connection-status', (_, d) => cb(d)),
    onConfigSaved:      (cb) => ipcRenderer.on('config-saved',      ()    => cb()),
});
