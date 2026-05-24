const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// GPU оптимизация — убираем ошибки и ускоряем рендер
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder');

// Конфигурация
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
// WS_URL: всегда production по умолчанию.
// Локальная разработка — только через явный LINKTIME_WS env или --ws= флаг.
// NODE_ENV больше НЕ влияет на выбор сервера (раньше это был источник путаницы).
const PRODUCTION_WS = 'wss://linktime.go-tit.ru';
function resolveWsUrl() {
    const envUrl = process.env.LINKTIME_WS;
    if (envUrl) return envUrl;
    const flagArg = process.argv.find(a => a.startsWith('--ws='));
    if (flagArg) return flagArg.slice(5);
    return PRODUCTION_WS;
}
const WS_URL = resolveWsUrl();
console.log('[CONFIG] WS_URL =', WS_URL,
    WS_URL === PRODUCTION_WS ? '(production)' : '(custom)');

// Состояние приложения
let mainWindow = null;
let settingsWindow = null;
let tray = null;
let ws = null;
let config = {
sessionKey: '',
checkInterval: 5000,
idleTimeout: 30000,
    autostart: false,
    autoUpdate: true,
whiteList: [
'LinkTime',
'Visual Studio Code',
'Code.exe',
'Terminal',
'cmd.exe',
'PowerShell',
'Figma',
'Adobe Photoshop',
'Sublime Text',
'WebStorm',
'PyCharm',
'IntelliJ IDEA',
'Eclipse',
'Postman',
'Docker',
'Git',
'GitHub Desktop'
],
blackList: [
'YouTube',
'Netflix',
'Facebook',
'Twitter',
'Instagram',
'TikTok',
'Reddit',
'Twitch',
'Steam',
'Discord - ',
'Telegram',
'WhatsApp'
]
};

let lastActivity = Date.now();
let currentStatus = null;
let checkIntervalId = null;
let isFirstCheck = true;
let sessionKeySyncInterval = null;
let idleCheckInterval = null;
let isUserIdle = false;
const IDLE_THRESHOLD = 30; // секунд бездействия до авто-паузы

// === APPS TRACKER — rolling 10-min window of unique active apps ===
const APPS_WINDOW_MS = 10 * 60 * 1000;
const APPS_SNAPSHOT_INTERVAL = 15000;
const appsTracker = new Map(); // key: lowercase process — value: {process, title, firstSeen, lastSeen, count, match}
let appsSnapshotInterval = null;

function classifyApp(process, title, exePath) {
    // Matching is substring against any of: process name, window title, full exe path.
    // Rule may also be an object {match, path?, label?} for richer entries.
    const subject = ((process || '') + ' ' + (title || '') + ' ' + (exePath || '')).toLowerCase();

    function ruleMatches(rule) {
        if (!rule) return false;
        // Plain string — legacy
        if (typeof rule === 'string') {
            return rule && subject.includes(rule.toLowerCase());
        }
        // Object form {match, path}
        if (typeof rule === 'object') {
            if (rule.path && exePath && exePath.toLowerCase() === String(rule.path).toLowerCase()) return true;
            if (rule.match && subject.includes(String(rule.match).toLowerCase())) return true;
        }
        return false;
    }

    for (const r of config.whiteList || []) { if (ruleMatches(r)) return 'white'; }
    for (const r of config.blackList || []) { if (ruleMatches(r)) return 'black'; }
    return 'none';
}

function recordApp(processName, displayTitle, exePath) {
    if (!processName) return;
    const key = processName.toLowerCase();
    const now = Date.now();
    const match = classifyApp(processName, displayTitle, exePath);
    if (appsTracker.has(key)) {
        const e = appsTracker.get(key);
        if (displayTitle) e.title = displayTitle;
        if (exePath) e.path = exePath;
        e.lastSeen = now;
        e.count++;
        e.match = match;
    } else {
        appsTracker.set(key, {
            process: processName,
            title: displayTitle || '',
            path: exePath || null,
            firstSeen: now,
            lastSeen: now,
            count: 1,
            match
        });
    }
}

function evictStaleApps() {
    const cutoff = Date.now() - APPS_WINDOW_MS;
    for (const [k, v] of appsTracker) {
        if (v.lastSeen < cutoff) appsTracker.delete(k);
    }
}

function getAppsSnapshot() {
    evictStaleApps();
    const arr = [];
    for (const [, v] of appsTracker) {
        // Reclassify in case lists changed
        v.match = classifyApp(v.process, v.title, v.path);
        arr.push({ ...v });
    }
    arr.sort((a, b) => b.lastSeen - a.lastSeen);
    return arr;
}

function sendAppsSnapshot() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!config.sessionKey) return;
    wsSend({
        type: 'apps_snapshot',
        sessionKey: config.sessionKey,
        apps: getAppsSnapshot()
    });
}

function sendAppsLists() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!config.sessionKey) return;
    wsSend({
        type: 'apps_lists',
        sessionKey: config.sessionKey,
        whiteList: config.whiteList || [],
        blackList: config.blackList || []
    });
}

// === FULL PROCESS LIST — снимок всех процессов системы по запросу из UI ===
// Используем PowerShell Get-Process: name, id, path, MainWindowTitle.
// Файл с путём может быть null для системных/защищённых процессов.
function listAllProcesses() {
    return new Promise((resolve) => {
        const ps = `
            $ErrorActionPreference = 'SilentlyContinue'
            $procs = Get-Process | ForEach-Object {
                $path = $null
                try { $path = $_.Path } catch {}
                $title = ''
                try { $title = $_.MainWindowTitle } catch {}
                [PSCustomObject]@{
                    name  = $_.ProcessName
                    pid   = $_.Id
                    path  = $path
                    title = $title
                }
            }
            $procs | ConvertTo-Json -Compress -Depth 2
        `;
        const child = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' + ps
        ]);
        let out = '';
        let err = '';
        child.stdout.on('data', d => { out += d.toString('utf8'); });
        child.stderr.on('data', d => { err += d.toString('utf8'); });
        child.on('close', (code) => {
            if (code !== 0 && !out) {
                console.error('[PROCESSES] PowerShell exit', code, err);
                return resolve([]);
            }
            try {
                let parsed = JSON.parse(out);
                if (!Array.isArray(parsed)) parsed = [parsed];
                // Дедуп по name+path (несколько инстансов того же exe = одна запись)
                const seen = new Map();
                for (const p of parsed) {
                    if (!p || !p.name) continue;
                    const key = (p.name + '|' + (p.path || '')).toLowerCase();
                    if (seen.has(key)) {
                        const e = seen.get(key);
                        e.instances++;
                        if (p.title && !e.title) e.title = p.title;
                    } else {
                        seen.set(key, {
                            name: p.name,
                            path: p.path || null,
                            title: p.title || '',
                            instances: 1,
                            match: classifyApp(p.name, p.title || '', p.path || '')
                        });
                    }
                }
                const arr = Array.from(seen.values()).sort((a, b) => {
                    // Сначала те у кого есть title (то есть это видимые окна) — наверх
                    const aHas = a.title ? 1 : 0;
                    const bHas = b.title ? 1 : 0;
                    if (aHas !== bHas) return bHas - aHas;
                    return a.name.localeCompare(b.name);
                });
                resolve(arr);
            } catch (e) {
                console.error('[PROCESSES] Parse error', e.message);
                resolve([]);
            }
        });
        // 10s timeout
        setTimeout(() => { try { child.kill(); } catch (_) {} }, 10000);
    });
}

async function sendAllProcesses() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !config.sessionKey) return;
    const procs = await listAllProcesses();
    wsSend({
        type: 'all_processes',
        sessionKey: config.sessionKey,
        processes: procs
    });
}

function handleWsMessage(message) {
    if (!message || !message.type) return;
    switch (message.type) {
        case 'apps_lists_update': {
            if (Array.isArray(message.whiteList)) config.whiteList = message.whiteList;
            if (Array.isArray(message.blackList)) config.blackList = message.blackList;
            saveConfig();
            console.log(`[APPS] Lists updated from browser: ${config.whiteList.length} white / ${config.blackList.length} black`);
            // Echo current lists so browser cache stays canonical
            sendAppsLists();
            // Send a fresh snapshot with reclassified matches
            sendAppsSnapshot();
            break;
        }
        case 'request_apps_snapshot':
            sendAppsSnapshot();
            break;
        case 'request_all_processes':
            sendAllProcesses().catch(e => console.error('[PROCESSES]', e));
            break;
    }
}

// Загрузка конфигурации
function loadConfig() {
try {
if (fs.existsSync(CONFIG_FILE)) {
const data = fs.readFileSync(CONFIG_FILE, 'utf8');
const savedConfig = JSON.parse(data);
config = { ...config, ...savedConfig };
}
} catch (error) {
console.error('Error loading config:', error);
}
if (!config.whiteList.some(a => a.toLowerCase() === 'linktime')) {
config.whiteList.unshift('LinkTime');
}
console.log('WhiteList:', config.whiteList);
    
    // Применяем настройку автозапуска при загрузке
    applyAutostartSetting();
}

// Сохранение конфигурации
function saveConfig() {
try {
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
console.log('Config saved');
        applyAutostartSetting();
} catch (error) {
console.error('Error saving config:', error);
}
}

// Применить настройку автозапуска
function applyAutostartSetting() {
    try {
        app.setLoginItemSettings({
            openAtLogin: config.autostart,
            openAsHidden: false,
            path: process.execPath,
            args: []
        });
        console.log(`Autostart ${config.autostart ? 'enabled' : 'disabled'}`);
    } catch (error) {
        console.error('Error setting autostart:', error);
    }
}

// Получить текущий статус автозапуска
function getAutostartStatus() {
    try {
        const settings = app.getLoginItemSettings();
        return settings.openAtLogin;
    } catch (error) {
        console.error('Error getting autostart status:', error);
        return false;
    }
}

// Создание главного окна (веб-приложение LinkTime)
function createWindow() {
mainWindow = new BrowserWindow({
width: 1300,
height: 850,
minWidth: 800,
minHeight: 600,
frame: false,
webPreferences: {
nodeIntegration: false,
contextIsolation: true,
preload: path.join(__dirname, 'preload.js'),
backgroundThrottling: false,
// Pass server URL down to the renderer via preload
additionalArguments: ['--linktime-ws=' + WS_URL]
},
icon: path.join(__dirname, 'icon.png'),
skipTaskbar: false,
title: 'LinkTime'
});

if (!process.env.NODE_ENV || process.env.NODE_ENV === 'production') {
Menu.setApplicationMenu(null);
}

ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow && (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()));
ipcMain.on('window-close',    () => { if (mainWindow) { app.isQuitting ? mainWindow.close() : mainWindow.hide(); } });

mainWindow.on('maximize',   () => mainWindow.webContents.send('maximize-change', true));
mainWindow.on('unmaximize', () => mainWindow.webContents.send('maximize-change', false));

// Открывать DevTools автоматом только в dev-режиме. В production молчит.
if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// F12 / Ctrl+Shift+I — открыть DevTools в любом режиме (для тестов production-сборки).
// Меню в production отключено, поэтому нужен ручной accelerator.
mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const f12 = input.key === 'F12';
    const devCombo = input.key === 'I' && input.control && input.shift;
    if (f12 || devCombo) {
        mainWindow.webContents.isDevToolsOpened()
            ? mainWindow.webContents.closeDevTools()
            : mainWindow.webContents.openDevTools({ mode: 'detach' });
        event.preventDefault();
    }
    // Ctrl+R — reload (вернуть стандартный браузерный шорткат)
    if (input.key.toLowerCase() === 'r' && input.control) {
        mainWindow.webContents.reload();
        event.preventDefault();
    }
});

// Prefer loading from the live server — single origin = no file:// quirks, no
// CSP frame-ancestors mismatch when opening the board iframe.
// Fall back to bundled local copy if the server is unreachable.
const APP_URL = WS_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const LOCAL_FALLBACK = path.join(__dirname, 'webapp', 'index.html');
let usingFallback = false;

function loadLocalFallback(reason) {
    if (usingFallback) return;
    usingFallback = true;
    console.warn(`[App] Loading local fallback (${reason})`);
    mainWindow.loadFile(LOCAL_FALLBACK);
}

mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    // Only react to top-frame fails on our APP_URL
    if (validatedURL && validatedURL.startsWith(APP_URL) && !usingFallback) {
        loadLocalFallback(`${errorCode}: ${errorDescription}`);
    }
});

mainWindow.loadURL(APP_URL).catch((err) => {
    loadLocalFallback(err.message || 'loadURL rejected');
});

// Помечаем что это Electron — web-код не будет управлять авто-паузой
mainWindow.webContents.on('did-finish-load', () => {
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

// Запускаем синхронизацию ключа сессии из веб-страницы
startSessionKeySync();
}

// Создание окна настроек агента
function createSettingsWindow() {
if (settingsWindow) {
settingsWindow.show();
settingsWindow.focus();
return;
}

settingsWindow = new BrowserWindow({
width: 500,
height: 650,
webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.js')
},
icon: path.join(__dirname, 'icon.png'),
skipTaskbar: false,
title: 'LinkTime Agent - Настройки',
parent: mainWindow || undefined,
modal: false
});

settingsWindow.loadFile(path.join(__dirname, 'settings.html'));

settingsWindow.on('closed', () => {
settingsWindow = null;
});
}

// Синхронизация ключа сессии из веб-страницы
function startSessionKeySync() {
// Первая проверка через 2 секунды (дать странице загрузиться)
setTimeout(() => syncSessionKeyFromWeb(), 2000);

// Проверяем каждые 3 секунды
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
const webSessionKey = await mainWindow.webContents.executeJavaScript(
"localStorage.getItem('sessionKey')"
);

if (webSessionKey && webSessionKey !== config.sessionKey) {
console.log(`Session key synced from web: ${webSessionKey}`);
config.sessionKey = webSessionKey;
saveConfig();

// Переподключаем WebSocket агента с новым ключом
if (ws) {
ws.close();
}
connectWebSocket();

// Обновляем settings window если открыто
if (settingsWindow && !settingsWindow.isDestroyed()) {
settingsWindow.webContents.send('config-data', config);
}
}

// Списки приложений теперь синхронизируются через WebSocket (apps_lists_update),
// а не через ежетриxсекундное чтение localStorage. См. handleWsMessage.


        // Синхронизируем настройку автозапуска из веб-страницы
        const webAutostart = await mainWindow.webContents.executeJavaScript(
            "localStorage.getItem('autostart')"
        );
        if (webAutostart !== null) {
            const newAutostart = webAutostart === 'true';
            if (newAutostart !== config.autostart) {
                console.log(`Autostart setting synced from web: ${newAutostart}`);
                config.autostart = newAutostart;
                saveConfig();
            }
        }
        // Синхронизируем настройку авто-обновления из веб-страницы
        const webAutoUpdate = await mainWindow.webContents.executeJavaScript(
            "localStorage.getItem('autoUpdate')"
        );
        if (webAutoUpdate !== null) {
            const newAutoUpdate = webAutoUpdate !== 'false';
            if (newAutoUpdate !== config.autoUpdate) {
                console.log(`AutoUpdate setting synced from web: ${newAutoUpdate}`);
                config.autoUpdate = newAutoUpdate;
                saveConfig();
            }
        }
} catch (error) {
// Страница ещё не загрузилась — игнорируем
}
}

// Создание системного трея
function createTray() {
tray = new Tray(path.join(__dirname, 'icon.png'));
updateTrayMenu('Запуск...');

tray.setToolTip('LinkTime Agent');

tray.on('click', () => {
if (mainWindow) {
mainWindow.show();
mainWindow.focus();
} else {
createWindow();
}
});
}

// Обновление меню трея
function updateTrayMenu(statusLabel) {
if (!tray) return;

const contextMenu = Menu.buildFromTemplate([
{ label: `Статус: ${statusLabel}`, enabled: false },
{ type: 'separator' },
{
label: 'Открыть LinkTime',
click: () => {
if (mainWindow) {
mainWindow.show();
mainWindow.focus();
} else {
createWindow();
}
}
},
{
label: 'Настройки агента',
click: () => createSettingsWindow()
},
{ type: 'separator' },
{
label: 'Выход',
click: () => {
app.isQuitting = true;
app.quit();
}
}
]);

tray.setContextMenu(contextMenu);
}

// Обновление статуса в трее
function updateTrayStatus(status, windowTitle = '') {
if (!tray) return;

let statusText = '';
switch (status) {
case 'working':
statusText = '🟢 Работа';
break;
case 'distracted':
statusText = '🟡 Отвлечение';
break;
case 'idle':
statusText = '🔴 Неактивен';
break;
}
if (windowTitle) statusText += `: ${windowTitle}`;

updateTrayMenu(statusText);
}

// Подключение к WebSocket
function connectWebSocket() {
if (!config.sessionKey) {
console.log('No session key configured');
return;
}

try {
ws = new WebSocket(WS_URL);

ws.on('open', () => {
console.log('Agent WebSocket connected');

setTimeout(() => {
if (!ws || ws.readyState !== WebSocket.OPEN) return;

wsSend({ type: 'join', sessionKey: config.sessionKey });
wsSend({ type: 'agent_connected', sessionKey: config.sessionKey });

// Push our current lists so the browser cache is correct
sendAppsLists();
// Start periodic snapshot broadcast
if (appsSnapshotInterval) clearInterval(appsSnapshotInterval);
appsSnapshotInterval = setInterval(sendAppsSnapshot, APPS_SNAPSHOT_INTERVAL);

// Обновляем settings window если открыто
if (settingsWindow && !settingsWindow.isDestroyed()) {
settingsWindow.webContents.send('status-update', {
status: 'working',
windowTitle: 'Подключено, мониторинг запущен'
});
}

isFirstCheck = true;
startActivityMonitoring();
}, 500);
});

ws.on('message', (data) => {
try {
const message = JSON.parse(data);
console.log('Agent received:', message.type);
handleWsMessage(message);
} catch (error) {
console.error('Error parsing message:', error);
}
});

ws.on('error', (error) => {
console.error('Agent WebSocket error:', error);
});

ws.on('close', () => {
console.log('Agent WebSocket disconnected');
stopActivityMonitoring();
if (appsSnapshotInterval) { clearInterval(appsSnapshotInterval); appsSnapshotInterval = null; }

setTimeout(() => {
console.log('Agent reconnecting...');
connectWebSocket();
}, 5000);
});
} catch (error) {
console.error('Failed to connect WebSocket:', error);
}
}

// Безопасная отправка через WebSocket
function wsSend(data) {
try {
if (ws && ws.readyState === WebSocket.OPEN) {
ws.send(JSON.stringify(data));
return true;
}
} catch (error) {
console.error('WebSocket send error:', error.message);
}
return false;
}

// Отправка обновления активности
function sendActivityUpdate(status, windowTitle) {
if (wsSend({
type: 'activity_update',
sessionKey: config.sessionKey,
status: status,
windowTitle: windowTitle
})) {
console.log(`Activity update sent: ${status}`);
}
}

// Определение статуса на основе заголовка окна
function determineStatus(windowTitle) {
if (!windowTitle) return 'idle';

const lower = windowTitle.toLowerCase();
console.log(`[DETERMINE] Checking: "${lower}"`);

for (const appName of config.whiteList) {
if (lower.includes(appName.toLowerCase())) {
console.log(`[DETERMINE] MATCH whiteList: "${appName}"`);
return 'working';
}
}

for (const appName of config.blackList) {
if (lower.includes(appName.toLowerCase())) {
console.log(`[DETERMINE] MATCH blackList: "${appName}"`);
return 'distracted';
}
}

console.log(`[DETERMINE] No match — distracted by default`);
return 'distracted';
}

// Постоянный PowerShell процесс для мониторинга окон
const { spawn } = require('child_process');
let psProcess = null;
let psReady = false;
let psResolve = null;
let psRequestId = 0;
let psWaiting = false;

const PS_INIT_SCRIPT = `
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class WinHelper {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    public static string GetActiveWindow() {
        IntPtr hwnd = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        try {
            Process p = Process.GetProcessById((int)pid);
            return p.ProcessName + "|||" + p.MainWindowTitle;
        } catch { return ""; }
    }
}
"@
Add-Type -TypeDefinition $code
Write-Output "READY"
while ($true) {
    $line = [Console]::ReadLine()
    if ($line -eq "GET") {
        Write-Output ([WinHelper]::GetActiveWindow())
    }
}
`;

function initPsProcess() {
    if (psProcess) return;
    psProcess = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' + PS_INIT_SCRIPT
    ]);

    let buffer = '';
    psProcess.stdout.on('data', (data) => {
        buffer += data.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed === 'READY') {
                psReady = true;
                console.log('[MONITOR] PowerShell process ready');
                // Первая проверка сразу после готовности PS
                checkActiveWindow();
            } else if (psResolve) {
                const resolve = psResolve;
                psResolve = null;
                resolve(trimmed);
            }
        }
    });

    psProcess.stderr.on('data', (data) => {
        console.error('[MONITOR] PS stderr:', data.toString().trim());
    });

    psProcess.on('close', (code) => {
        console.warn(`[MONITOR] PowerShell process exited (${code}), restarting...`);
        psProcess = null;
        psReady = false;
        psWaiting = false;
        if (psResolve) { psResolve(null); psResolve = null; }
        setTimeout(initPsProcess, 2000);
    });
}

function getActiveWindowFromPs() {
    return new Promise((resolve) => {
        if (!psProcess || !psReady || psWaiting) {
            resolve(null);
            return;
        }
        psWaiting = true;
        const myId = ++psRequestId;
        const timeout = setTimeout(() => {
            if (psResolve && psResolve._id === myId) {
                psResolve = null;
            }
            psWaiting = false;
            resolve(null);
        }, 3000);
        psResolve = (val) => { clearTimeout(timeout); psWaiting = false; resolve(val); };
        psResolve._id = myId;
        psProcess.stdin.write('GET\n');
    });
}

// Проверка активного окна
async function checkActiveWindow() {
    try {
        const output = await getActiveWindowFromPs();

        if (!output) {
            console.log('[MONITOR] No active window');
            updateStatus('idle', 'Нет активного окна');
            return;
        }

        lastActivity = Date.now();

        const parts = output.split('|||');
        const processName = parts[0] || '';
        let displayTitle = parts[1] || '';
        const pName = processName.toLowerCase();

        if (['msedge', 'chrome', 'firefox', 'opera', 'brave'].includes(pName)) {
            displayTitle = displayTitle
                .replace(/\s*и еще \d+ страниц?/gi, '')
                .replace(/\s*—\s*(Личный|Personal|InPrivate):?\s*Microsoft Edge/gi, '')
                .replace(/\s*-\s*(Google Chrome|Mozilla Firefox|Opera|Brave)/gi, '')
                .trim();
        }

        const fullTitle = `${processName} - ${displayTitle}`;
        console.log(`[MONITOR] Active: "${fullTitle}"`);

        // Record into rolling tracker for browser settings UI
        recordApp(processName, displayTitle);

        const status = determineStatus(fullTitle);
        console.log(`[MONITOR] Status: ${status}`);
        updateStatus(status, displayTitle);

    } catch (error) {
        console.error('[MONITOR] ERROR:', error.message);
        updateStatus('idle', 'Ошибка мониторинга');
    }
}

// Обновление и отправка статуса
function updateStatus(status, windowTitle) {
const changed = status !== currentStatus || isFirstCheck;
currentStatus = status;
isFirstCheck = false;

if (changed) {
console.log(`[STATUS] Changed: ${status} (${windowTitle})`);
}

updateTrayStatus(status, windowTitle);
sendActivityUpdate(status, windowTitle);

if (settingsWindow && !settingsWindow.isDestroyed()) {
settingsWindow.webContents.send('status-update', { status, windowTitle });
}
}

// Запуск мониторинга активности
function startActivityMonitoring() {
if (checkIntervalId) clearInterval(checkIntervalId);

console.log('Activity monitoring started');
initPsProcess(); // Запускаем постоянный PowerShell процесс
// Первый checkActiveWindow вызовется когда PS будет готов (в обработчике READY)

checkIntervalId = setInterval(() => {
checkActiveWindow();
}, config.checkInterval);

// Запускаем idle-мониторинг
startIdleMonitoring();
}

// Мониторинг бездействия (мышь/клавиатура)
function startIdleMonitoring() {
if (idleCheckInterval) clearInterval(idleCheckInterval);

idleCheckInterval = setInterval(() => {
if (!mainWindow || mainWindow.isDestroyed()) return;

const idleTime = powerMonitor.getSystemIdleTime(); // в секундах

if (idleTime >= IDLE_THRESHOLD && !isUserIdle) {
// Пользователь бездействует — авто-пауза
isUserIdle = true;
console.log(`[IDLE] User idle for ${idleTime}s — triggering auto-pause`);
mainWindow.webContents.executeJavaScript(`
               window.__idlePaused = true;
               console.log('[IDLE-JS] Setting idle pause');
               if (typeof state !== 'undefined' && state.timerRunning && !state.timerPaused) {
                   pauseTimer(true);
                   showToast('Авто-Пауза: нет активности ${IDLE_THRESHOLD} сек', 'info');
               }
           `).catch(() => {});
} else if (idleTime < IDLE_THRESHOLD && isUserIdle) {
// Пользователь вернулся — авто-возобновление
isUserIdle = false;
console.log('[IDLE] User returned — triggering auto-resume');
mainWindow.webContents.executeJavaScript(`
               window.__idlePaused = false;
               console.log('[IDLE-JS] Clearing idle pause, timerPaused=' + state.timerPaused + ', autoPauseActive=' + autoPauseActive + ', manualPause=' + manualPause);
               if (typeof state !== 'undefined' && state.timerRunning && state.timerPaused && autoPauseActive && !manualPause) {
                   console.log('[IDLE-JS] Calling pauseTimer() to resume');
                   pauseTimer(false);
                   showToast('Таймер возобновлён', 'success');
               }
           `).catch(() => {});
}
}, 2000); // проверяем каждые 2 секунды
}

// Остановка мониторинга
function stopActivityMonitoring() {
if (checkIntervalId) {
clearInterval(checkIntervalId);
checkIntervalId = null;
}
if (idleCheckInterval) {
clearInterval(idleCheckInterval);
idleCheckInterval = null;
}
isUserIdle = false;
console.log('Activity monitoring stopped');
}

// IPC обработчики для окна настроек
ipcMain.handle('get-config', () => {
    const currentAutostart = getAutostartStatus();
    return { ...config, autostart: currentAutostart };
});

ipcMain.on('save-config', (event, newConfig) => {
config = { ...config, ...newConfig };
saveConfig();

// Если изменился sessionKey — инжектим его в веб-страницу
if (newConfig.sessionKey && mainWindow && !mainWindow.isDestroyed()) {
mainWindow.webContents.executeJavaScript(
`localStorage.setItem('sessionKey', ${JSON.stringify(newConfig.sessionKey)}); location.reload();`
).catch(() => {});
}

// Переподключаем WebSocket
if (ws) ws.close();
connectWebSocket();

event.reply('config-saved');
});

// ===== IPC: запрос полного списка процессов из браузера через preload =====
ipcMain.handle('list-all-processes', async () => {
    try { return await listAllProcesses(); } catch (e) { return []; }
});

// ===== IPC: выбор .exe файла через нативный диалог Electron =====
ipcMain.handle('pick-exe-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
        title: 'Выберите исполняемый файл приложения',
        properties: ['openFile'],
        filters: [
            { name: 'Приложения', extensions: ['exe'] },
            { name: 'Все файлы', extensions: ['*'] }
        ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

ipcMain.on('test-connection', (event) => {
if (ws && ws.readyState === WebSocket.OPEN) {
event.reply('connection-status', { connected: true });
} else {
event.reply('connection-status', { connected: false });
}
});

// ===== AUTO-UPDATE =====
const https = require('https');
const os = require('os');
let pendingUpdateUrl = null;

function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function checkForUpdates(silent = false) {
  const options = {
    hostname: 'api.github.com',
    path: '/repos/Bzden4ik/LinkTime/releases/latest',
    headers: { 'User-Agent': 'LinkTime-Desktop' }
  };
  const req = https.get(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const release = JSON.parse(data);
        const latestTag = release.tag_name;
        if (!latestTag) throw new Error('No tag_name in response');
        const current = app.getVersion();
        console.log(`[UPDATE] Current: ${current}, Latest: ${latestTag}`);
        if (compareVersions(latestTag, current) > 0) {
          const asset = (release.assets || []).find(a => a.name.endsWith('.exe'));
          const url = asset ? asset.browser_download_url
            : `https://github.com/Bzden4ik/LinkTime/releases/download/${latestTag}/LinkTime.Setup.${latestTag}.exe`;
          pendingUpdateUrl = url;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-available', { version: latestTag, url });
          }
        } else {
          if (!silent && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-info', { upToDate: true });
          }
        }
      } catch (e) {
        console.error('[UPDATE] Parse error:', e.message);
        if (!silent && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-info', { error: e.message });
        }
      }
    });
  });
  req.on('error', e => {
    console.error('[UPDATE] Check error:', e.message);
    if (!silent && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-info', { error: e.message });
    }
  });
  req.setTimeout(10000, () => {
    req.destroy();
    if (!silent && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-info', { error: 'timeout' });
    }
  });
}

ipcMain.on('check-updates', () => {
  console.log('[UPDATE] Manual check triggered');
  checkForUpdates(false);
});

ipcMain.on('install-update', (event, url) => {
  const downloadUrl = url || pendingUpdateUrl;
  if (!downloadUrl) return;

  // Сначала сообщаем рендереру — показать оверлей
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-downloading');
  }

  const dest = path.join(os.tmpdir(), 'LinkTime-update.exe');
  const file = require('fs').createWriteStream(dest);

  const download = (dlUrl, redirectCount = 0) => {
    if (redirectCount > 5) return;
    const mod = dlUrl.startsWith('https') ? https : require('http');
    mod.get(dlUrl, { headers: { 'User-Agent': 'LinkTime-Desktop' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return download(res.headers.location, redirectCount + 1);
      }

      // Прогресс скачивания
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', chunk => {
        received += chunk.length;
        if (total > 0 && mainWindow && !mainWindow.isDestroyed()) {
          const pct = Math.round(received / total * 100);
          mainWindow.webContents.send('update-progress', { pct });
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          // Даём рендереру 1.5 сек показать 100% перед закрытием
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-progress', { pct: 100 });
          }
          setTimeout(() => {
            require('child_process').spawn(dest, [], { detached: true, stdio: 'ignore' }).unref();
            app.isQuitting = true;
            app.quit();
          }, 1500);
        });
      });
    }).on('error', e => console.error('[UPDATE] Download error:', e.message));
  };
  download(downloadUrl);
});

// Инициализация приложения
app.whenReady().then(() => {
loadConfig();
createTray();
createWindow();

// Автопроверка обновлений при старте
if (config.autoUpdate !== false) {
  setTimeout(() => checkForUpdates(true), 5000);
}

// Если есть сохранённый ключ — инжектим его в веб-страницу при загрузке
if (config.sessionKey) {
mainWindow.webContents.on('did-finish-load', () => {
mainWindow.webContents.executeJavaScript(
`if (!localStorage.getItem('sessionKey')) { localStorage.setItem('sessionKey', ${JSON.stringify(config.sessionKey)}); location.reload(); }`
).catch(() => {});
});
connectWebSocket();
}

app.on('activate', () => {
if (BrowserWindow.getAllWindows().length === 0) {
createWindow();
}
});
});

app.on('window-all-closed', () => {
// Продолжаем работать в фоне
});

app.on('before-quit', () => {
stopActivityMonitoring();
stopSessionKeySync();
if (psProcess) { psProcess.kill(); psProcess = null; }
if (ws) ws.close();
});