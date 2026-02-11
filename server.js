const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Хранилище активных сессий: { sessionKey: [connections] }
const sessions = new Map();

// Хранилище данных сессий: { sessionKey: { tasks, sessions, lastUpdate } }
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
            ws.send(JSON.stringify({
                type: 'init',
                data: sessionData.get(sessionKey)
            }));
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

    function handleDisconnect(ws) {
        if (currentSessionKey && sessions.has(currentSessionKey)) {
            sessions.get(currentSessionKey).delete(ws);
            
            // Удаляем пустые сессии
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
