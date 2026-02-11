const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// Конфигурация
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const WS_URL = 'wss://linktime.onrender.com';

// Состояние приложения
let mainWindow = null;
let tray = null;
let ws = null;
let config = {
    sessionKey: '',
    checkInterval: 5000, // 5 секунд
    idleTimeout: 30000, // 30 секунд для определения idle
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
let currentStatus = null; // null = ещё не определён, чтобы первый статус всегда отправлялся
let checkIntervalId = null;
let isFirstCheck = true;

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
    // LinkTime всегда в белом списке
    if (!config.whiteList.some(a => a.toLowerCase() === 'linktime')) {
        config.whiteList.unshift('LinkTime');
    }
    console.log('WhiteList:', config.whiteList);
}

// Сохранение конфигурации
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('Config saved');
    } catch (error) {
        console.error('Error saving config:', error);
    }
}

// Создание главного окна
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 500,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'icon.png'),
        skipTaskbar: false
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Создание системного трея
function createTray() {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Статус: Запуск...',
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Открыть настройки',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                } else {
                    createWindow();
                }
            }
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

    tray.setToolTip('LinkTime Agent');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.show();
        } else {
            createWindow();
        }
    });
}

// Обновление статуса в трее
function updateTrayStatus(status, windowTitle = '') {
    if (!tray) return;

    let statusText = '';
    let statusIcon = '';

    switch (status) {
        case 'working':
            statusText = '🟢 Работа';
            statusIcon = 'working';
            break;
        case 'distracted':
            statusText = '🟡 Отвлечение';
            statusIcon = 'distracted';
            break;
        case 'idle':
            statusText = '🔴 Неактивен';
            statusIcon = 'idle';
            break;
    }

    if (windowTitle) {
        statusText += `: ${windowTitle}`;
    }

    const contextMenu = Menu.buildFromTemplate([
        {
            label: statusText,
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Открыть настройки',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                } else {
                    createWindow();
                }
            }
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

// Подключение к WebSocket
function connectWebSocket() {
    if (!config.sessionKey) {
        console.log('No session key configured');
        return;
    }

    try {
        ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            console.log('WebSocket connected');
            
            // Отправляем с небольшой задержкой чтобы соединение точно было готово
            setTimeout(() => {
                if (!ws || ws.readyState !== WebSocket.OPEN) return;
                
                // Присоединяемся к сессии
                wsSend({ type: 'join', sessionKey: config.sessionKey });

                // Сообщаем серверу что Desktop Agent подключён
                wsSend({ type: 'agent_connected', sessionKey: config.sessionKey });

                // Обновляем UI агента
                if (mainWindow) {
                    mainWindow.webContents.send('status-update', {
                        status: 'working',
                        windowTitle: 'Подключено, мониторинг запущен'
                    });
                }

                // Запускаем мониторинг активности
                isFirstCheck = true;
                startActivityMonitoring();
            }, 500);
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                console.log('Received from server:', message.type);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

        ws.on('close', () => {
            console.log('WebSocket disconnected');
            stopActivityMonitoring();
            
            // Переподключение через 5 секунд
            setTimeout(() => {
                console.log('Reconnecting...');
                connectWebSocket();
            }, 5000);
        });
    } catch (error) {
        console.error('Failed to connect WebSocket:', error);
    }
}

// Определение статуса на основе заголовка окна
function determineStatus(windowTitle) {
    if (!windowTitle) return 'idle';

    const lower = windowTitle.toLowerCase();
    console.log(`[DETERMINE] Checking: "${lower}"`);

    // Проверка белого списка (рабочие приложения)
    for (const app of config.whiteList) {
        if (lower.includes(app.toLowerCase())) {
            console.log(`[DETERMINE] MATCH whiteList: "${app}"`);
            return 'working';
        }
    }

    // Проверка черного списка (отвлекающие приложения)
    for (const app of config.blackList) {
        if (lower.includes(app.toLowerCase())) {
            console.log(`[DETERMINE] MATCH blackList: "${app}"`);
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
        
        // Парсим название вкладки из заголовка браузера
        let displayTitle = windowInfo.title;
        const pName = windowInfo.processName.toLowerCase();
        
        // Для браузеров берём только название вкладки (до " — " или " - " с именем браузера)
        if (['msedge', 'chrome', 'firefox', 'opera', 'brave'].includes(pName)) {
            // "YouTube - Google Chrome" → "YouTube"
            // "LinkTime - Таймер работы и еще 7 страниц — Личный: Microsoft Edge" → "LinkTime - Таймер работы"
            displayTitle = windowInfo.title
                .replace(/\s*и еще \d+ страниц?/gi, '')
                .replace(/\s*—\s*(Личный|Personal|InPrivate):?\s*Microsoft Edge/gi, '')
                .replace(/\s*-\s*(Google Chrome|Mozilla Firefox|Opera|Brave)/gi, '')
                .trim();
        }
        
        // Для определения статуса используем полный заголовок
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
    
    // Всегда обновляем UI
    updateTrayStatus(status, windowTitle);
    
    // Всегда отправляем на сервер (чтобы браузер знал актуальный статус)
    sendActivityUpdate(status, windowTitle);
    
    if (mainWindow) {
        mainWindow.webContents.send('status-update', { status, windowTitle });
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

// Отправка обновления активности на сервер
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

// Запуск мониторинга активности
function startActivityMonitoring() {
    if (checkIntervalId) {
        clearInterval(checkIntervalId);
    }

    console.log('Activity monitoring started');
    
    // Первая проверка сразу
    checkActiveWindow();
    
    // Проверка каждые 5 секунд
    checkIntervalId = setInterval(() => {
        checkActiveWindow();
    }, config.checkInterval);
}

// Остановка мониторинга активности
function stopActivityMonitoring() {
    if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
    }
    console.log('Activity monitoring stopped');
}

// IPC обработчики для связи с окном настроек
ipcMain.on('get-config', (event) => {
    event.reply('config-data', config);
});

ipcMain.on('save-config', (event, newConfig) => {
    config = { ...config, ...newConfig };
    saveConfig();
    
    // Переподключаемся если изменился sessionKey
    if (ws) {
        ws.close();
    }
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
    
    // Подключаемся к WebSocket если есть sessionKey
    if (config.sessionKey) {
        connectWebSocket();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // Не закрываем приложение на macOS
    if (process.platform !== 'darwin') {
        // На других платформах продолжаем работать в фоне
    }
});

app.on('before-quit', () => {
    stopActivityMonitoring();
    if (ws) {
        ws.close();
    }
});
