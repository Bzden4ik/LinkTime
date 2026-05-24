const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Setting up Electron bridge...');

// === Pass server URL config to renderer ====================================
// main.js passes `--linktime-ws=<url>` in additionalArguments.
const wsArg = process.argv.find(a => a.startsWith('--linktime-ws='));
const WS_URL = wsArg ? wsArg.slice('--linktime-ws='.length) : 'wss://linktime.go-tit.ru';
const API_BASE = WS_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

contextBridge.exposeInMainWorld('_linkTimeConfig', {
    wsUrl: WS_URL,
    apiBase: API_BASE,
    isElectron: true,
});
console.log('[Preload] _linkTimeConfig:', { wsUrl: WS_URL, apiBase: API_BASE });

// Expose Electron API
contextBridge.exposeInMainWorld('electronAPI', {
    // Флаг что это Electron
    isElectron: true,
    
    // Обновления
    onUpdateInfo: (callback) => ipcRenderer.on('update-info', callback),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
    onUpdateError: (callback) => ipcRenderer.on('update-error', callback),
    onUpdateDownloading: (callback) => ipcRenderer.on('update-downloading', (_e, data) => callback(data)),
    onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_e, data) => callback(data)),
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

    // Process picker
    listAllProcesses: () => ipcRenderer.invoke('list-all-processes'),
    pickExeFile: () => ipcRenderer.invoke('pick-exe-file'),
});

console.log('[Preload] Electron API exposed');

