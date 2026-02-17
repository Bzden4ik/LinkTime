const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// GPU оптимизация — убираем ошибки и ускоряем рендер
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder');

// Конфигурация
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const WS_URL = 'wss://linktime.go-tit.ru';

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
webPreferences: {
nodeIntegration: false,
contextIsolation: true,
backgroundThrottling: false
},
icon: path.join(__dirname, 'icon.png'),
skipTaskbar: false,
title: 'LinkTime'
});

mainWindow.loadFile(path.join(__dirname, 'webapp', 'index.html'));

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
nodeIntegration: true,
contextIsolation: false
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

// Синхронизируем списки приложений из веб-страницы
const webWhiteList = await mainWindow.webContents.executeJavaScript(
"localStorage.getItem('whiteList')"
);
const webBlackList = await mainWindow.webContents.executeJavaScript(
"localStorage.getItem('blackList')"
);
if (webWhiteList) {
config.whiteList = JSON.parse(webWhiteList);
}
if (webBlackList) {
config.blackList = JSON.parse(webBlackList);
}
        
        // Синхронизируем настройку автозапуска из веб-страницы
        const webAutostart = await mainWindow.webContents.executeJavaScript(
            "localStorage.getItem('autostart')"
        );
        if (webAutostart !== null) {
            const newAutostart = webAutostart === 'true';
            if (newAutostart !== config.autostart) {
                console.log(`Autostart setting synced from web: ${newAutostart}`);
                config.autostart = newAutostart;
                saveConfig(); // saveConfig уже вызывает applyAutostartSetting()
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

// Проверка активного окна
async function checkActiveWindow() {
try {
const { execFile } = require('child_process');

const windowInfo = await new Promise((resolve, reject) => {
const script = `
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
[WinHelper]::GetActiveWindow()
`;
execFile('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' + script], { timeout: 4000, encoding: 'utf8' }, (error, stdout) => {
if (error) return reject(error);
const output = stdout.trim();
if (!output) return resolve(null);
const parts = output.split('|||');
resolve({ processName: parts[0] || '', title: parts[1] || '' });
});
});

if (!windowInfo) {
console.log('[MONITOR] No active window');
updateStatus('idle', 'Нет активного окна');
return;
}

lastActivity = Date.now();

let displayTitle = windowInfo.title;
const pName = windowInfo.processName.toLowerCase();

if (['msedge', 'chrome', 'firefox', 'opera', 'brave'].includes(pName)) {
displayTitle = windowInfo.title
.replace(/\s*и еще \d+ страниц?/gi, '')
.replace(/\s*—\s*(Личный|Personal|InPrivate):?\s*Microsoft Edge/gi, '')
.replace(/\s*-\s*(Google Chrome|Mozilla Firefox|Opera|Brave)/gi, '')
.trim();
}

const fullTitle = `${windowInfo.processName} - ${windowInfo.title}`;
console.log(`[MONITOR] Active: "${fullTitle}"`);

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
checkActiveWindow();

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
ipcMain.on('get-config', (event) => {
    const currentAutostart = getAutostartStatus();
    const configWithAutostart = { ...config, autostart: currentAutostart };
    event.reply('config-data', configWithAutostart);
});

ipcMain.on('save-config', (event, newConfig) => {
config = { ...config, ...newConfig };
saveConfig();

// Если изменился sessionKey — инжектим его в веб-страницу
if (newConfig.sessionKey && mainWindow && !mainWindow.isDestroyed()) {
mainWindow.webContents.executeJavaScript(
`localStorage.setItem('sessionKey', '${newConfig.sessionKey}'); location.reload();`
).catch(() => {});
}

// Переподключаем WebSocket
if (ws) ws.close();
connectWebSocket();

event.reply('config-saved');
});

ipcMain.on('test-connection', (event) => {
if (ws && ws.readyState === WebSocket.OPEN) {
event.reply('connection-status', { connected: true });
} else {
event.reply('connection-status', { connected: false });
}
});

// Инициализация приложения
app.whenReady().then(() => {
loadConfig();
createTray();
createWindow();

// Если есть сохранённый ключ — инжектим его в веб-страницу при загрузке
if (config.sessionKey) {
mainWindow.webContents.on('did-finish-load', () => {
mainWindow.webContents.executeJavaScript(
`if (!localStorage.getItem('sessionKey')) { localStorage.setItem('sessionKey', '${config.sessionKey}'); location.reload(); }`
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
if (ws) ws.close();
});