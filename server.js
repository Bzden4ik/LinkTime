const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Хранилище активных сессий: { sessionKey: [connections] }
const sessions = new Map();

// Хранилище данных сессий: { sessionKey: { tasks, sessions, lastUpdate, timerState, lastTickTimestamp, activityStatus, lastHeartbeat } }
const sessionData = new Map();

console.log(`WebSocket server running on port ${PORT}`);

wss.on('connection', (ws) => {
    let currentSessionKey = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join':
                    handleJoin(ws, data);
                    break;
                case 'sync':
                    handleSync(ws, data);
                    break;
                case 'timer_sync':
                    handleTimerSync(ws, data);
                    break;
                case 'activity_update':
                    handleActivityUpdate(ws, data);
                    break;
                case 'heartbeat':
                    handleHeartbeat(ws, data);
                    break;
                case 'request_state':
                    handleRequestState(ws, data);
                    break;
                case 'browser_event':
                    handleBrowserEvent(ws, data);
                    break;
                case 'agent_connected':
                    handleAgentConnected(ws, data);
                    break;
                case 'disconnect':
                    handleDisconnect(ws);
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws);
    });

    function handleJoin(ws, data) {
        const { sessionKey } = data;
        currentSessionKey = sessionKey;

        // Добавляем соединение к сессии
        if (!sessions.has(sessionKey)) {
            sessions.set(sessionKey, new Set());
        }
        sessions.get(sessionKey).add(ws);

        // Отправляем текущие данные сессии новому подключению
        if (sessionData.has(sessionKey)) {
            const data = sessionData.get(sessionKey);
            ws.send(JSON.stringify({
                type: 'init',
                data: data
            }));
            
            // Отправляем состояние таймера отдельно, если оно есть
            if (data.timerState) {
                ws.send(JSON.stringify({
                    type: 'timer_state',
                    data: data.timerState
                }));
            }
            
            // Отправляем статус агента
            if (data.agentConnected) {
                ws.send(JSON.stringify({
                    type: 'agent_status',
                    connected: true
                }));
            }
        }

        console.log(`Client joined session: ${sessionKey}`);
        console.log(`Active connections in session: ${sessions.get(sessionKey).size}`);
    }

    function handleSync(ws, data) {
        const { sessionKey, tasks, sessions: userSessions, date } = data;

        // Обновляем данные сессии
        const currentData = sessionData.get(sessionKey) || {};
        const updatedData = {
            ...currentData,
            tasks: tasks || currentData.tasks || [],
            sessions: userSessions || currentData.sessions || {},
            lastUpdate: Date.now()
        };
        sessionData.set(sessionKey, updatedData);

        // Рассылаем обновления всем подключенным клиентам в этой сессии
        if (sessions.has(sessionKey)) {
            const message = JSON.stringify({
                type: 'update',
                data: updatedData,
                from: 'server'
            });

            sessions.get(sessionKey).forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
        }

        console.log(`Sync received for session: ${sessionKey}`);
    }

    function handleTimerSync(ws, data) {
        const { sessionKey, action, data: timerData } = data;

        // Обновляем состояние таймера в сессии
        const currentData = sessionData.get(sessionKey) || {};
        const now = Date.now();
        
        // Центральный расчет времени на сервере
        if (action === 'start' || action === 'resume') {
            currentData.lastTickTimestamp = now;
        } else if (action === 'stop' || action === 'pause') {
            if (currentData.lastTickTimestamp) {
                const elapsed = now - currentData.lastTickTimestamp;
                currentData.totalWorkTime = (currentData.totalWorkTime || 0) + elapsed;
            }
            currentData.lastTickTimestamp = null;
        }
        
        currentData.timerState = { action, ...timerData };
        currentData.lastUpdate = now;
        currentData.lastHeartbeat = now;
        sessionData.set(sessionKey, currentData);

        // Рассылаем обновление таймера всем подключенным клиентам в этой сессии
        if (sessions.has(sessionKey)) {
            const message = JSON.stringify({
                type: 'timer_state',
                data: { action, ...timerData }
            });

            sessions.get(sessionKey).forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
        }

        console.log(`Timer sync (${action}) for session: ${sessionKey}`);
    }

    function handleActivityUpdate(ws, data) {
        const { sessionKey, status, windowTitle } = data;

        // Обновляем статус активности в сессии
        const currentData = sessionData.get(sessionKey) || {};
        currentData.activityStatus = status; // working / distracted / idle
        currentData.activeWindow = windowTitle;
        currentData.lastUpdate = Date.now();
        currentData.lastHeartbeat = Date.now();
        sessionData.set(sessionKey, currentData);

        // Рассылаем статус активности всем участникам сессии
        if (sessions.has(sessionKey)) {
            const message = JSON.stringify({
                type: 'activity_status',
                status: status,
                windowTitle: windowTitle
            });

            sessions.get(sessionKey).forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
        }

        console.log(`Activity update for session ${sessionKey}: ${status} (${windowTitle})`);
        
        // Если статус distracted или idle, отправляем команду force_pause через 5 секунд
        if (status === 'distracted' || status === 'idle') {
            setTimeout(() => {
                const latestData = sessionData.get(sessionKey);
                // Проверяем что статус всё ещё не working
                if (latestData && latestData.activityStatus !== 'working') {
                    sendForcePause(sessionKey, status);
                }
            }, 5000);
        }
    }

    function handleHeartbeat(ws, data) {
        const { sessionKey } = data;
        
        const currentData = sessionData.get(sessionKey) || {};
        currentData.lastHeartbeat = Date.now();
        sessionData.set(sessionKey, currentData);
        
        // Отправляем подтверждение heartbeat
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'heartbeat_ack',
                timestamp: Date.now()
            }));
        }
    }

    function sendForcePause(sessionKey, reason) {
        if (sessions.has(sessionKey)) {
            const message = JSON.stringify({
                type: 'force_pause',
                reason: reason // distracted / idle
            });

            sessions.get(sessionKey).forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
            
            console.log(`Force pause sent to session ${sessionKey} (reason: ${reason})`);
        }
    }

    function handleRequestState(ws, data) {
        const { sessionKey } = data;
        
        // Отправляем текущее состояние сессии клиенту
        if (sessionData.has(sessionKey)) {
            const currentData = sessionData.get(sessionKey);
            
            // Отправляем все данные сессии
            ws.send(JSON.stringify({
                type: 'init',
                data: currentData
            }));
            
            // Отправляем состояние таймера отдельно
            if (currentData.timerState) {
                ws.send(JSON.stringify({
                    type: 'timer_state',
                    data: currentData.timerState
                }));
            }
            
            // Отправляем статус активности если есть
            if (currentData.activityStatus) {
                ws.send(JSON.stringify({
                    type: 'activity_status',
                    status: currentData.activityStatus,
                    windowTitle: currentData.activeWindow || ''
                }));
            }
            
            console.log(`State sent to client for session ${sessionKey}`);
        }
    }

    function handleBrowserEvent(ws, data) {
        const { sessionKey, event } = data;
        
        console.log(`Browser event for session ${sessionKey}: ${event}`);
        
        // Обновляем информацию о состоянии браузера в данных сессии
        const currentData = sessionData.get(sessionKey) || {};
        currentData.browserEvent = event;
        currentData.lastUpdate = Date.now();
        sessionData.set(sessionKey, currentData);
        
        // Можно добавить дополнительную логику для разных событий
        // Например, при tab_hidden или browser_blur можно установить статус idle
        if (event === 'tab_hidden' || event === 'browser_blur') {
            // Только если нет Desktop-агента, который подтверждает работу
            if (!currentData.activityStatus || currentData.activityStatus === 'idle') {
                // Ставим задержку перед паузой
                setTimeout(() => {
                    const latestData = sessionData.get(sessionKey);
                    if (latestData && latestData.browserEvent === event) {
                        // Всё ещё скрыто/без фокуса
                        sendForcePause(sessionKey, 'browser_inactive');
                    }
                }, 30000); // 30 секунд задержка
            }
        }
    }

    function handleAgentConnected(ws, data) {
        const { sessionKey } = data;
        
        console.log(`Desktop Agent connected for session ${sessionKey}`);
        
        // Помечаем это соединение как агент
        ws.isAgent = true;
        ws.agentSessionKey = sessionKey;
        
        // Отмечаем в данных сессии что агент подключён
        const currentData = sessionData.get(sessionKey) || {};
        currentData.agentConnected = true;
        currentData.lastUpdate = Date.now();
        sessionData.set(sessionKey, currentData);
        
        // Рассылаем всем клиентам в сессии
        if (sessions.has(sessionKey)) {
            const message = JSON.stringify({
                type: 'agent_status',
                connected: true
            });

            sessions.get(sessionKey).forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
        }
    }

    function handleDisconnect(ws) {
        if (currentSessionKey && sessions.has(currentSessionKey)) {
            sessions.get(currentSessionKey).delete(ws);
            
            // Если отключился агент — уведомляем браузеры
            if (ws.isAgent) {
                const key = ws.agentSessionKey || currentSessionKey;
                console.log(`Desktop Agent disconnected from session: ${key}`);
                
                const currentData = sessionData.get(key) || {};
                currentData.agentConnected = false;
                sessionData.set(key, currentData);
                
                if (sessions.has(key)) {
                    const message = JSON.stringify({
                        type: 'agent_status',
                        connected: false
                    });
                    sessions.get(key).forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(message);
                        }
                    });
                }
            }
            
            if (sessions.get(currentSessionKey).size === 0) {
                sessions.delete(currentSessionKey);
                console.log(`Session ${currentSessionKey} removed (no active connections)`);
            } else {
                console.log(`Client disconnected from session: ${currentSessionKey}`);
                console.log(`Remaining connections: ${sessions.get(currentSessionKey).size}`);
            }
        }
    }
});

// Мониторинг heartbeat - проверка каждые 5 секунд
setInterval(() => {
    const now = Date.now();
    const heartbeatTimeout = 15000; // 15 секунд
    
    for (const [sessionKey, data] of sessionData.entries()) {
        // Если есть активная сессия и нет heartbeat больше 15 секунд
        if (data.lastHeartbeat && (now - data.lastHeartbeat) > heartbeatTimeout) {
            // Проверяем что таймер был активен
            if (data.timerState && data.timerState.action === 'start') {
                console.log(`Heartbeat timeout for session ${sessionKey}, forcing pause`);
                
                // Обновляем статус на паузу
                data.timerState.action = 'pause';
                data.activityStatus = 'idle';
                
                // Рассчитываем время
                if (data.lastTickTimestamp) {
                    const elapsed = now - data.lastTickTimestamp;
                    data.totalWorkTime = (data.totalWorkTime || 0) + elapsed;
                    data.lastTickTimestamp = null;
                }
                
                sessionData.set(sessionKey, data);
                
                // Отправляем force_pause всем клиентам сессии
                sendForcePause(sessionKey, 'timeout');
            }
        }
    }
}, 5000); // Проверка каждые 5 секунд

// Очистка старых данных сессий (старше 7 дней)
setInterval(() => {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    for (const [key, data] of sessionData.entries()) {
        if (data.lastUpdate < sevenDaysAgo && !sessions.has(key)) {
            sessionData.delete(key);
            console.log(`Cleaned up old session data: ${key}`);
        }
    }
}, 60 * 60 * 1000); // Проверка каждый час
