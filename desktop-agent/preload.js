const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Setting up Electron bridge...');

// Expose Electron API
contextBridge.exposeInMainWorld('electronAPI', {
    // Флаг что это Electron
    isElectron: true,
    
    // Обновления
    onUpdateInfo: (callback) => ipcRenderer.on('update-info', callback),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
    onUpdateError: (callback) => ipcRenderer.on('update-error', callback),
    checkUpdates: () => ipcRenderer.send('check-updates'),
    installUpdate: (downloadUrl) => ipcRenderer.send('install-update', downloadUrl),
    
    // Утилиты
    removeListener: (channel, callback) => ipcRenderer.removeListener(channel, callback),

    // Настройки (settings.html)
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.send('save-config', config),
    testConnection: () => ipcRenderer.send('test-connection'),
    onStatusUpdate: (callback) => ipcRenderer.on('status-update', (_e, data) => callback(data)),
    onConnectionStatus: (callback) => ipcRenderer.on('connection-status', (_e, data) => callback(data)),
    onConfigSaved: (callback) => ipcRenderer.on('config-saved', () => callback()),
    // Window controls
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close'),
    onMaximizeChange: (cb) => {
        ipcRenderer.on('maximize-change', (_e, isMax) => cb(isMax));
    },
});

console.log('[Preload] Electron API exposed');

