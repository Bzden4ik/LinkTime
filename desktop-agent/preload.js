const { contextBridge, ipcRenderer } = require('electron');

// Устанавливаем флаг что это Electron
window.__electronApp = true;

// Expose ipcRenderer для renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Обновления
    onUpdateInfo: (callback) => ipcRenderer.on('update-info', callback),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
    onUpdateError: (callback) => ipcRenderer.on('update-error', callback),
    checkUpdates: () => ipcRenderer.send('check-updates'),
    installUpdate: (downloadUrl) => ipcRenderer.send('install-update', downloadUrl),
    
    // Утилиты
    removeListener: (channel, callback) => ipcRenderer.removeListener(channel, callback)
});

console.log('[Preload] Electron API exposed, __electronApp flag set');
