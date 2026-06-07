const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Setting up Electron bridge...');

// === Pass server URL + sessionKey config to renderer ========================
// main.js passes these in additionalArguments.
const wsArg = process.argv.find(a => a.startsWith('--linktime-ws='));
const WS_URL = wsArg ? wsArg.slice('--linktime-ws='.length) : 'wss://linktime.go-tit.ru';
const API_BASE = WS_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

// sessionKey из config.json — авторитетный источник. Если он есть, app.js
// обязан использовать именно его (а не генерировать новый при пустом localStorage).
const skArg = process.argv.find(a => a.startsWith('--linktime-session='));
const SESSION_KEY = skArg ? skArg.slice('--linktime-session='.length) : '';

contextBridge.exposeInMainWorld('_linkTimeConfig', {
    wsUrl: WS_URL,
    apiBase: API_BASE,
    sessionKey: SESSION_KEY || null,
    isElectron: true,
});
console.log('[Preload] _linkTimeConfig:', { wsUrl: WS_URL, apiBase: API_BASE, hasSessionKey: !!SESSION_KEY });

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

    // Явная смена sessionKey (когда пользователь вводит ключ в web)
    setSessionKey: (key) => ipcRenderer.send('set-session-key', key),
});

console.log('[Preload] Electron API exposed');

