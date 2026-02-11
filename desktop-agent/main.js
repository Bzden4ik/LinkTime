const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const activeWin = require('active-win');
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
            console.log('Config loaded:', config);
        }
    } catch (error) {
        console.error('Error loading config:', error);
    }
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

    // Проверка белого списка (рабочие приложения)
    const isWorking = config.whiteList.some(app => 
        windowTitle.toLowerCase().includes(app.toLowerCase())
    );
    
    if (isWorking) {
        return 'working';
    }

    // Проверка черного списка (отвлекающие приложения)
    const isDistracted = config.blackList.some(app => 
        windowTitle.toLowerCase().includes(app.toLowerCase())
    );
    
    if (isDistracted) {
        return 'distracted';
    }

    // По умолчанию: если не в белом списке — отвлечение
    return 'distracted';
}

// Проверка активного окна
async function checkActiveWindow() {
    try {
        const window = await activeWin();
        
        if (!window) {
            console.log('No active window detected');
            const idleTime = Date.now() - lastActivity;
            if (idleTime > config.idleTimeout) {
                updateStatus('idle', 'Нет активного окна');
            }
            return;
        }

        lastActivity = Date.now();

        const windowTitle = window.title || '';
        const windowOwner = (window.owner && window.owner.name) ? window.owner.name : '';
        const fullTitle = windowOwner ? `${windowOwner} - ${windowTitle}` : windowTitle;

        console.log(`[MONITOR] Active window: "${fullTitle}" | Owner: "${windowOwner}" | Title: "${windowTitle}"`);

        const status = determineStatus(fullTitle);
        console.log(`[MONITOR] Status: ${status}`);
        updateStatus(status, fullTitle);

    } catch (error) {
        console.error('[MONITOR] ERROR reading active window:', error.message);
        // При ошибке НЕ отправляем working — лучше idle
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
