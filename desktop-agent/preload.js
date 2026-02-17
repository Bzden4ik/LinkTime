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
    removeListener: (channel, callback) => ipcRenderer.removeListener(channel, callback)
});

console.log('[Preload] Electron API exposed');

