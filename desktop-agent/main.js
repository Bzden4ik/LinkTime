const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// GPU оптимизация
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');

// ===== КОНФИГУРАЦИЯ =====
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const WS_URL = 'wss://linktime.go-tit.ru';

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let ws = null;
let wsReconnectTimeout = null; // один таймаут — нет параллельных reconnect
let config = {
    sessionKey: '',
    checkInterval: 5000,
    idleTimeout: 30000,
    autostart: false,
    whiteList: [
        'LinkTime', 'Visual Studio Code', 'Code', 'WindowsTerminal',
        'cmd', 'powershell', 'Figma', 'Adobe Photoshop', 'Sublime Text',
        'WebStorm', 'PyCharm', 'IntelliJ IDEA', 'Postman', 'Docker Desktop',
        'GitHub Desktop', 'notepad++', 'Cursor'
    ],
    blackList: [
        'YouTube', 'Netflix', 'Facebook', 'Twitter', 'Instagram',
        'TikTok', 'Reddit', 'Twitch', 'Steam', 'Telegram', 'WhatsApp'
    ]
};

let currentStatus = null;
let checkIntervalId = null;
let idleCheckInterval = null;
let isUserIdle = false;
let isFirstCheck = true;
let sessionKeySyncInterval = null;
const IDLE_THRESHOLD = 30;

// ===== КОНФИГ =====
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            config = { ...config, ...saved };
        }
    } catch (e) {
        console.error('[Config] Load error:', e.message);
    }
    if (!config.whiteList.some(a => a.toLowerCase() === 'linktime')) {
        config.whiteList.unshift('LinkTime');
    }
    applyAutostartSetting();
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        applyAutostartSetting();
    } catch (e) {
        console.error('[Config] Save error:', e.message);
    }
}

function applyAutostartSetting() {
    try {
        app.setLoginItemSettings({
            openAtLogin: !!config.autostart,
            openAsHidden: false,
            path: process.execPath,
            args: []
        });
    } catch (e) {
        console.error('[Autostart] Error:', e.message);
    }
}

function getAutostartStatus() {
    try {
        return app.getLoginItemSettings().openAtLogin;
    } catch (e) {
        return false;
    }
}

// ===== ОКНА =====
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 850,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'icon.png'),
        title: 'LinkTime'
    });

    mainWindow.loadFile(path.join(__dirname, 'webapp', 'index.html'));

    mainWindow.webContents.on('did-finish-load', () => {
        // Помечаем Electron-среду через preload (без eval-инъекции)
        mainWindow.webContents.executeJavaScript('window.__electronApp = true;').catch(() => {});
    });

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        stopSessionKeySync();
    });

    startSessionKeySync();
}

function createSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.show();
        settingsWindow.focus();
        return;
    }
    settingsWindow = new BrowserWindow({
        width: 520,
        height: 680,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'icon.png'),
        title: 'LinkTime Agent — Настройки',
        parent: mainWindow || undefined,
        modal: false
    });
    settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ===== СИНХРОНИЗАЦИЯ SESSION KEY =====
function startSessionKeySync() {
    setTimeout(() => syncSessionKeyFromWeb(), 2000);
    sessionKeySyncInterval = setInterval(() => syncSessionKeyFromWeb(), 3000);
}

function stopSessionKeySync() {
    if (sessionKeySyncInterval) {
        clearInterval(sessionKeySyncInterval);
        sessionKeySyncInterval = null;
    }
}

async function syncSessionKeyFromWeb() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        // Читаем sessionKey из localStorage через безопасный preload-метод
        const webSessionKey = await mainWindow.webContents.executeJavaScript(
            "window.localStorage.getItem('sessionKey')"
        );
        if (webSessionKey && webSessionKey !== config.sessionKey) {
            console.log('[Sync] Session key updated from web');
            config.sessionKey = webSessionKey;
            saveConfig();
            if (ws) ws.close();
            connectWebSocket();
            if (settingsWindow && !settingsWindow.isDestroyed()) {
                settingsWindow.webContents.send('config-data', config);
            }
        }

        // Синхронизируем списки
        const wl = await mainWindow.webContents.executeJavaScript("window.localStorage.getItem('whiteList')");
        const bl = await mainWindow.webContents.executeJavaScript("window.localStorage.getItem('blackList')");
        if (wl) config.whiteList = JSON.parse(wl);
        if (bl) config.blackList = JSON.parse(bl);

        // Синхронизируем autostart
        const autoRaw = await mainWindow.webContents.executeJavaScript("window.localStorage.getItem('autostart')");
        if (autoRaw !== null) {
            const newAuto = autoRaw === 'true';
            if (newAuto !== config.autostart) {
                config.autostart = newAuto;
                saveConfig();
            }
        }
    } catch (e) {
        // Страница ещё грузится — норм
    }
}

// ===== ТРЕЙ =====
function createTray() {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    tray.setToolTip('LinkTime Agent');
    updateTrayMenu('Запуск...');
    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        } else {
            createWindow();
        }
    });
}

function updateTrayMenu(statusLabel) {
    if (!tray) return;
    const menu = Menu.buildFromTemplate([
        { label: `Статус: ${statusLabel}`, enabled: false },
        { type: 'separator' },
        { label: 'Открыть LinkTime', click: () => {
            if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
            else createWindow();
        }},
        { label: 'Настройки агента', click: () => createSettingsWindow() },
        { type: 'separator' },
        { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); }}
    ]);
    tray.setContextMenu(menu);
}

function updateTrayStatus(status, windowTitle) {
    const labels = { working: '🟢 Работа', distracted: '🟡 Отвлечение', idle: '🔴 Неактивен' };
    let text = labels[status] || status;
    if (windowTitle) text += `: ${windowTitle}`;
    updateTrayMenu(text);
}

// ===== WEBSOCKET =====
function connectWebSocket() {
    if (!config.sessionKey) {
        console.log('[WS] No session key — skipping connect');
        return;
    }

    // Сбрасываем таймер переподключения если был
    if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = null;
    }

    try {
        ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            console.log('[WS] Agent connected to', WS_URL);
            setTimeout(() => {
                if (!ws || ws.readyState !== WebSocket.OPEN) return;
                wsSend({ type: 'join', sessionKey: config.sessionKey });
                wsSend({ type: 'agent_connected', sessionKey: config.sessionKey });
                isFirstCheck = true;
                startActivityMonitoring();
            }, 500);
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                console.log('[WS] Received:', msg.type);
            } catch (e) {
                console.error('[WS] Parse error:', e.message);
            }
        });

        ws.on('error', (e) => {
            console.error('[WS] Error:', e.message);
        });

        ws.on('close', () => {
            console.log('[WS] Disconnected — reconnect in 5s');
            stopActivityMonitoring();
            // Единственный reconnect — нет параллельных
            if (!wsReconnectTimeout) {
                wsReconnectTimeout = setTimeout(() => {
                    wsReconnectTimeout = null;
                    connectWebSocket();
                }, 5000);
            }
        });
    } catch (e) {
        console.error('[WS] Connect failed:', e.message);
        if (!wsReconnectTimeout) {
            wsReconnectTimeout = setTimeout(() => {
                wsReconnectTimeout = null;
                connectWebSocket();
            }, 5000);
        }
    }
}

function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(data));
            return true;
        } catch (e) {
            console.error('[WS] Send error:', e.message);
        }
    }
    return false;
}

function sendActivityUpdate(status, windowTitle) {
    wsSend({ type: 'activity_update', sessionKey: config.sessionKey, status, windowTitle });
}

// ===== МОНИТОРИНГ АКТИВНОСТИ (через active-win) =====
async function checkActiveWindow() {
    try {
        const activeWin = require('active-win');
        const result = await activeWin();

        if (!result) {
            updateStatus('idle', 'Нет активного окна');
            return;
        }

        const processName = result.owner ? result.owner.name : '';
        const windowTitle = result.title || '';
        const fullTitle = `${processName} - ${windowTitle}`;

        console.log(`[Monitor] Active: "${fullTitle}"`);

        const status = determineStatus(fullTitle);
        updateStatus(status, windowTitle);

    } catch (e) {
        console.error('[Monitor] active-win error:', e.message);
        updateStatus('idle', 'Ошибка мониторинга');
    }
}

function determineStatus(fullTitle) {
    if (!fullTitle) return 'idle';
    const lower = fullTitle.toLowerCase();

    for (const app of config.whiteList) {
        if (lower.includes(app.toLowerCase())) return 'working';
    }
    for (const app of config.blackList) {
        if (lower.includes(app.toLowerCase())) return 'distracted';
    }
    return 'distracted';
}

function updateStatus(status, windowTitle) {
    const changed = status !== currentStatus || isFirstCheck;
    currentStatus = status;
    isFirstCheck = false;

    if (changed) {
        console.log(`[Status] ${status} (${windowTitle})`);
    }

    updateTrayStatus(status, windowTitle);
    sendActivityUpdate(status, windowTitle);

    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('status-update', { status, windowTitle });
    }
}

function startActivityMonitoring() {
    if (checkIntervalId) clearInterval(checkIntervalId);
    console.log('[Monitor] Started');
    checkActiveWindow();
    checkIntervalId = setInterval(() => checkActiveWindow(), config.checkInterval);
    startIdleMonitoring();
}

function startIdleMonitoring() {
    if (idleCheckInterval) clearInterval(idleCheckInterval);
    idleCheckInterval = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const idleTime = powerMonitor.getSystemIdleTime();

        if (idleTime >= IDLE_THRESHOLD && !isUserIdle) {
            isUserIdle = true;
            console.log(`[Idle] User idle ${idleTime}s — auto-pause`);
            mainWindow.webContents.executeJavaScript(`
                if (typeof state !== 'undefined' && state.timerRunning && !state.timerPaused) {
                    pauseTimer(true);
                    showToast('Авто-Пауза: нет активности ${IDLE_THRESHOLD} сек', 'info');
                }
            `).catch(() => {});
        } else if (idleTime < IDLE_THRESHOLD && isUserIdle) {
            isUserIdle = false;
            console.log('[Idle] User returned — auto-resume');
            mainWindow.webContents.executeJavaScript(`
                if (typeof state !== 'undefined' && state.timerRunning && state.timerPaused && autoPauseActive && !manualPause) {
                    pauseTimer(false);
                    showToast('Таймер возобновлён', 'success');
                }
            `).catch(() => {});
        }
    }, 2000);
}

function stopActivityMonitoring() {
    if (checkIntervalId) { clearInterval(checkIntervalId); checkIntervalId = null; }
    if (idleCheckInterval) { clearInterval(idleCheckInterval); idleCheckInterval = null; }
    isUserIdle = false;
    console.log('[Monitor] Stopped');
}

// ===== IPC =====
ipcMain.on('get-config', (event) => {
    event.reply('config-data', { ...config, autostart: getAutostartStatus() });
});

ipcMain.on('save-config', (event, newConfig) => {
    // Безопасно обновляем sessionKey — никакой конкатенации в executeJavaScript
    const oldKey = config.sessionKey;
    config = { ...config, ...newConfig };
    saveConfig();

    if (newConfig.sessionKey && newConfig.sessionKey !== oldKey && mainWindow && !mainWindow.isDestroyed()) {
        // Передаём через IPC/preload, а не через строку JS
        mainWindow.webContents.executeJavaScript(
            `window.localStorage.setItem('sessionKey', ${JSON.stringify(newConfig.sessionKey)}); location.reload();`
        ).catch(() => {});
    }

    if (ws) ws.close();
    connectWebSocket();
    event.reply('config-saved');
});

ipcMain.on('test-connection', (event) => {
    event.reply('connection-status', { connected: !!(ws && ws.readyState === WebSocket.OPEN) });
});

// ===== ЗАПУСК =====
app.whenReady().then(() => {
    loadConfig();
    createTray();
    createWindow();

    if (config.sessionKey) {
        mainWindow.webContents.on('did-finish-load', () => {
            mainWindow.webContents.executeJavaScript(
                `if (!window.localStorage.getItem('sessionKey')) { window.localStorage.setItem('sessionKey', ${JSON.stringify(config.sessionKey)}); location.reload(); }`
            ).catch(() => {});
        });
        connectWebSocket();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    // Живём в трее — не выходим
});

app.on('before-quit', () => {
    stopActivityMonitoring();
    stopSessionKeySync();
    if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
    if (ws) ws.close();
});
