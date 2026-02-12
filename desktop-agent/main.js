const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// Fix GPU crashes
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// Конфигурация
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const WS_URL = 'wss://linktime.onrender.com';
const SITE_URL = 'https://bzden4ik.github.io/LinkTime/';
const CHECK_INTERVAL = 5000;
const IDLE_TIMEOUT = 30;
const HEARTBEAT_INTERVAL = 8000;

// Состояние
let mainWindow = null;
let tray = null;
let ws = null;
let sessionKey = '';
let monitorInterval = null;
let heartbeatInterval = null;
let lastStatus = '';
let reconnectTimeout = null;

const whiteList = [
    'Visual Studio Code', 'Code.exe', 'Terminal', 'cmd.exe',
    'PowerShell', 'powershell.exe', 'Figma', 'Adobe Photoshop',
    'Sublime Text', 'WebStorm', 'PyCharm', 'IntelliJ IDEA',
    'Postman', 'Docker', 'Git', 'GitHub Desktop', 'LinkTime'
];

const blackList = [
    'YouTube', 'Netflix', 'Facebook', 'Twitter', 'Instagram',
    'TikTok', 'Reddit', 'Twitch', 'Steam', 'Discord'
];

// === CONFIG ===
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            sessionKey = data.sessionKey || '';
        }
    } catch (e) {
        console.error('Config load error:', e);
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ sessionKey }), 'utf8');
    } catch (e) {
        console.error('Config save error:', e);
    }
}

// === WINDOW MONITORING ===
async function checkActiveWindow() {
    try {
        const activeWin = (await import('active-win')).default;
        const win = await activeWin();
        if (!win) return 'idle';

        const title = win.title || '';
        const owner = win.owner?.name || '';
        const combined = `${title} ${owner}`;

        // Check blacklist first
        for (const b of blackList) {
            if (combined.toLowerCase().includes(b.toLowerCase())) {
                return 'distracted';
            }
        }
        // Check whitelist
        for (const w of whiteList) {
            if (combined.toLowerCase().includes(w.toLowerCase())) {
                return 'working';
            }
        }
        return 'working'; // Default: not in blacklist = working
    } catch (e) {
        return 'idle';
    }
}

function getIdleTime() {
    try {
        return powerMonitor.getSystemIdleTime();
    } catch (e) {
        return 0;
    }
}

async function monitorActivity() {
    const idleTime = getIdleTime();
    let status;
    let activeApp = '';

    if (idleTime > IDLE_TIMEOUT) {
        status = 'idle';
    } else {
        try {
            const activeWin = (await import('active-win')).default;
            const win = await activeWin();
            activeApp = win ? (win.owner?.name || win.title || '') : '';
        } catch (e) {}
        
        status = await checkActiveWindow();
    }

    // Send only on change or every heartbeat
    if (status !== lastStatus) {
        lastStatus = status;
        sendActivityUpdate(status, activeApp);
    }
}

// === WEBSOCKET ===
function connectWebSocket() {
    if (!sessionKey) return;
    if (ws && ws.readyState === WebSocket.OPEN) return;

    try {
        ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            console.log('Agent WS connected, key:', sessionKey);
            // Register as agent
            ws.send(JSON.stringify({
                type: 'agent_connected',
                sessionKey: sessionKey
            }));
            // Start monitoring
            startMonitoring();
        });

        ws.on('close', () => {
            console.log('Agent WS disconnected');
            stopMonitoring();
            // Reconnect after 5s
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(connectWebSocket, 5000);
        });

        ws.on('error', (err) => {
            console.error('Agent WS error:', err.message);
        });
    } catch (e) {
        console.error('WS connect failed:', e);
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectWebSocket, 5000);
    }
}

function sendActivityUpdate(status, activeApp) {
    if (ws && ws.readyState === WebSocket.OPEN && sessionKey) {
        ws.send(JSON.stringify({
            type: 'activity_update',
            sessionKey: sessionKey,
            status: status,
            activeApp: activeApp || '',
            timestamp: Date.now()
        }));
    }
}

function sendHeartbeat() {
    if (ws && ws.readyState === WebSocket.OPEN && sessionKey) {
        ws.send(JSON.stringify({
            type: 'heartbeat',
            sessionKey: sessionKey
        }));
    }
}

function startMonitoring() {
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = setInterval(monitorActivity, CHECK_INTERVAL);
    
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
}

function stopMonitoring() {
    if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// === MAIN WINDOW (Site + Agent) ===
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 400,
        minHeight: 600,
        icon: path.join(__dirname, 'icon.png'),
        title: 'LinkTime',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    // Load site with sessionKey in URL so app.js picks it up
    const url = sessionKey ? `${SITE_URL}?sessionKey=${sessionKey}` : SITE_URL;
    mainWindow.loadURL(url);

    // Grab sessionKey from the page when it loads
    mainWindow.webContents.on('did-finish-load', () => {
        // Inject script to listen for sessionKey changes
        mainWindow.webContents.executeJavaScript(`
            (function() {
                // Send current sessionKey
                const key = localStorage.getItem('sessionKey');
                if (key && window.__electronAPI) {
                    window.__electronAPI.sendSessionKey(key);
                }
                // Watch for changes
                const origSet = localStorage.setItem.bind(localStorage);
                localStorage.setItem = function(k, v) {
                    origSet(k, v);
                    if (k === 'sessionKey' && window.__electronAPI) {
                        window.__electronAPI.sendSessionKey(v);
                    }
                };
            })();
        `).catch(() => {});
    });

    mainWindow.on('close', (e) => {
        e.preventDefault();
        mainWindow.hide();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// === TRAY ===
function createTray() {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Открыть LinkTime',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                } else {
                    createMainWindow();
                }
            }
        },
        { type: 'separator' },
        {
            label: `Агент: ${sessionKey ? 'подключён' : 'нет ключа'}`,
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Выход',
            click: () => {
                stopMonitoring();
                if (ws) ws.close();
                mainWindow?.destroy();
                app.quit();
            }
        }
    ]);

    tray.setToolTip('LinkTime Agent');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// === IPC: send saved sessionKey to preload (sync) ===
ipcMain.on('get-session-key', (event) => {
    event.returnValue = sessionKey || '';
});

// === IPC: receive sessionKey from page ===
ipcMain.on('session-key', (event, key) => {
    if (key && key !== sessionKey) {
        console.log('Got sessionKey from page:', key);
        sessionKey = key;
        saveConfig();
        // Reconnect with new key
        if (ws) ws.close();
        connectWebSocket();
        // Update tray
        if (tray) createTray();
    }
});

// === APP LIFECYCLE ===
app.whenReady().then(() => {
    loadConfig();
    createMainWindow();
    createTray();

    if (sessionKey) {
        connectWebSocket();
    }

    // Sleep/wake detection
    powerMonitor.on('suspend', () => {
        sendActivityUpdate('idle', '');
        stopMonitoring();
    });

    powerMonitor.on('resume', () => {
        if (sessionKey) {
            connectWebSocket();
        }
    });

    powerMonitor.on('lock-screen', () => {
        sendActivityUpdate('idle', '');
    });
});

app.on('window-all-closed', (e) => {
    // Don't quit — keep running in tray
});

app.on('activate', () => {
    if (!mainWindow) createMainWindow();
    else mainWindow.show();
});

app.on('before-quit', () => {
    stopMonitoring();
    if (ws) ws.close();
    mainWindow?.removeAllListeners('close');
});
