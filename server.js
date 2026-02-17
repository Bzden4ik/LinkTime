const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const Database = require('better-sqlite3');

// === КОНФИГУРАЦИЯ ===
const PORT = process.env.PORT || 3002;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'linktime.db');
const NODE_ENV = process.env.NODE_ENV || 'development';

// === БАЗА ДАННЫХ ===
const fs = require('fs');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Создание таблиц
db.exec(`
    CREATE TABLE IF NOT EXISTS session_data (
        session_key TEXT PRIMARY KEY,
        tasks TEXT DEFAULT '[]',
        work_sessions TEXT DEFAULT '{}',
        timer_state TEXT DEFAULT NULL,
        activity_status TEXT DEFAULT NULL,
        active_window TEXT DEFAULT NULL,
        agent_connected INTEGER DEFAULT 0,
        last_heartbeat INTEGER,
        last_update INTEGER,
        created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT UNIQUE NOT NULL,
        user_id TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        email TEXT DEFAULT NULL,
        created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
`);

console.log(`[DB] SQLite database initialized at ${DB_PATH}`);

// Prepared statements для производительности
const stmts = {
    getSession: db.prepare('SELECT * FROM session_data WHERE session_key = ?'),
    upsertSession: db.prepare(`
        INSERT INTO session_data (session_key, tasks, work_sessions, timer_state, activity_status, active_window, agent_connected, last_heartbeat, last_update)
        VALUES (@session_key, @tasks, @work_sessions, @timer_state, @activity_status, @active_window, @agent_connected, @last_heartbeat, @last_update)
        ON CONFLICT(session_key) DO UPDATE SET
            tasks = COALESCE(@tasks, tasks),
            work_sessions = COALESCE(@work_sessions, work_sessions),
            timer_state = @timer_state,
            activity_status = @activity_status,
            active_window = @active_window,
            agent_connected = @agent_connected,
            last_heartbeat = COALESCE(@last_heartbeat, last_heartbeat),
            last_update = @last_update
    `),
    updateTimerState: db.prepare(`
        UPDATE session_data SET timer_state = ?, last_update = ?, last_heartbeat = ? WHERE session_key = ?
    `),
    updateActivity: db.prepare(`
        UPDATE session_data SET activity_status = ?, active_window = ?, last_update = ?, last_heartbeat = ? WHERE session_key = ?
    `),
    updateHeartbeat: db.prepare(`
        UPDATE session_data SET last_heartbeat = ? WHERE session_key = ?
    `),
    updateAgentStatus: db.prepare(`
        UPDATE session_data SET agent_connected = ?, activity_status = CASE WHEN ? = 0 THEN NULL ELSE activity_status END, active_window = CASE WHEN ? = 0 THEN NULL ELSE active_window END, last_update = ? WHERE session_key = ?
    `),
    updateSync: db.prepare(`
        UPDATE session_data SET tasks = ?, work_sessions = ?, last_update = ? WHERE session_key = ?
    `),
    getAllSessions: db.prepare('SELECT session_key, last_heartbeat, timer_state FROM session_data WHERE last_heartbeat IS NOT NULL'),
    // Users
    getUserBySession: db.prepare('SELECT * FROM users WHERE session_key = ?'),
    getUserByUserId: db.prepare('SELECT * FROM users WHERE user_id = ?'),
    getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    createUser: db.prepare('INSERT INTO users (session_key, user_id, username, email) VALUES (?, ?, ?, ?)'),
    updateUsername: db.prepare('UPDATE users SET username = ? WHERE session_key = ?'),
    updateEmail: db.prepare('UPDATE users SET email = ? WHERE session_key = ?'),
    // Invitations
    createInvitation: db.prepare('INSERT INTO invitations (from_user_id, to_user_id) VALUES (?, ?)'),
    getPendingInvitations: db.prepare('SELECT i.*, u.username as from_username FROM invitations i JOIN users u ON i.from_user_id = u.user_id WHERE i.to_user_id = ? AND i.status = ?'),
    updateInvitation: db.prepare('UPDATE invitations SET status = ? WHERE id = ? AND to_user_id = ?'),
    countPending: db.prepare('SELECT COUNT(*) as cnt FROM invitations WHERE to_user_id = ? AND status = ?'),
    checkInvitationExists: db.prepare('SELECT id FROM invitations WHERE from_user_id = ? AND to_user_id = ? AND status = ?'),
};

// === ХЕЛПЕРЫ ДЛЯ БД ===

function getSessionData(sessionKey) {
    const row = stmts.getSession.get(sessionKey);
    if (!row) return null;
    return {
        tasks: JSON.parse(row.tasks || '[]'),
        sessions: JSON.parse(row.work_sessions || '{}'),
        timerState: row.timer_state ? JSON.parse(row.timer_state) : null,
        activityStatus: row.activity_status,
        activeWindow: row.active_window,
        agentConnected: !!row.agent_connected,
        lastHeartbeat: row.last_heartbeat,
        lastUpdate: row.last_update,
    };
}

function ensureSession(sessionKey) {
    const existing = stmts.getSession.get(sessionKey);
    if (!existing) {
        stmts.upsertSession.run({
            session_key: sessionKey,
            tasks: '[]',
            work_sessions: '{}',
            timer_state: null,
            activity_status: null,
            active_window: null,
            agent_connected: 0,
            last_heartbeat: null,
            last_update: Date.now(),
        });
    }
}

// === ХЕЛПЕРЫ ПОЛЬЗОВАТЕЛЕЙ ===

function generateUserId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id;
    do {
        id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (stmts.getUserByUserId.get(id));
    return id;
}

function generateUsername() {
    let name;
    do {
        const num = String(Math.floor(10000 + Math.random() * 90000));
        name = 'user' + num;
    } while (stmts.getUserByUsername.get(name));
    return name;
}

function ensureUser(sessionKey) {
    let user = stmts.getUserBySession.get(sessionKey);
    if (!user) {
        const userId = generateUserId();
        const username = generateUsername();
        stmts.createUser.run(sessionKey, userId, username, null);
        user = stmts.getUserBySession.get(sessionKey);
    }
    return user;
}

// === EXPRESS СЕРВЕР ===
const app = express();

// CORS
app.use((req, res, next) => {
    const allowedOrigins = [
        'https://linktime.go-tit.ru',
        'http://localhost:3002',
        'http://127.0.0.1:3002',
    ];
    const origin = req.headers.origin;
    if (!origin || allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// JSON body parser
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.round(process.uptime()),
        connections: wss.clients.size,
        env: NODE_ENV,
    });
});

// === API: Получить данные сессии ===
app.get('/api/data/:sessionKey', (req, res) => {
    const { sessionKey } = req.params;
    const row = stmts.getSession.get(sessionKey);
    if (!row) return res.json({ tasks: [], sessions: {} });
    res.json({
        tasks: JSON.parse(row.tasks || '[]'),
        sessions: JSON.parse(row.work_sessions || '{}')
    });
});

// === API: Сохранить данные сессии (прямая запись) ===
app.post('/api/data/:sessionKey', (req, res) => {
    const { sessionKey } = req.params;
    const { tasks, sessions } = req.body;
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' });
    ensureSession(sessionKey);

    stmts.updateSync.run(
        JSON.stringify(tasks || []),
        JSON.stringify(sessions || {}),
        Date.now(),
        sessionKey
    );

    res.json({ ok: true, totalTasks: (tasks || []).length, totalDays: Object.keys(sessions || {}).length });
});

// === API: Пользователь — получить/создать профиль ===
app.get('/api/user/:sessionKey', (req, res) => {
    const user = ensureUser(req.params.sessionKey);
    res.json({ userId: user.user_id, username: user.username, email: user.email });
});

// === API: Обновить имя ===
app.post('/api/user/:sessionKey/username', (req, res) => {
    const { username } = req.body;
    if (!username || username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Имя: 3–20 символов' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Только буквы, цифры, _' });
    const existing = stmts.getUserByUsername.get(username);
    const me = stmts.getUserBySession.get(req.params.sessionKey);
    if (existing && existing.session_key !== req.params.sessionKey) return res.status(409).json({ error: 'Имя занято' });
    stmts.updateUsername.run(username, req.params.sessionKey);
    res.json({ ok: true });
});

// === API: Обновить email ===
app.post('/api/user/:sessionKey/email', (req, res) => {
    const { email } = req.body;
    stmts.updateEmail.run(email || null, req.params.sessionKey);
    res.json({ ok: true });
});

// === API: Найти пользователя по userId или username ===
app.get('/api/user/find/:query', (req, res) => {
    const q = req.params.query.trim();
    const user = stmts.getUserByUserId.get(q) || stmts.getUserByUsername.get(q);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ userId: user.user_id, username: user.username });
});

// === API: Отправить приглашение ===
app.post('/api/invite', (req, res) => {
    const { fromSessionKey, toQuery } = req.body;
    const fromUser = stmts.getUserBySession.get(fromSessionKey);
    if (!fromUser) return res.status(400).json({ error: 'Профиль не найден' });
    const toUser = stmts.getUserByUserId.get(toQuery) || stmts.getUserByUsername.get(toQuery);
    if (!toUser) return res.status(404).json({ error: 'Пользователь не найден' });
    if (toUser.user_id === fromUser.user_id) return res.status(400).json({ error: 'Нельзя пригласить себя' });
    const exists = stmts.checkInvitationExists.get(fromUser.user_id, toUser.user_id, 'pending');
    if (exists) return res.status(409).json({ error: 'Приглашение уже отправлено' });
    stmts.createInvitation.run(fromUser.user_id, toUser.user_id);
    // Уведомляем получателя через WS если онлайн
    const cnt = stmts.countPending.get(toUser.user_id, 'pending').cnt;
    notifyUser(toUser.session_key, { type: 'notification_count', count: cnt });
    res.json({ ok: true });
});

// === API: Получить входящие приглашения ===
app.get('/api/invitations/:sessionKey', (req, res) => {
    const user = stmts.getUserBySession.get(req.params.sessionKey);
    if (!user) return res.json({ invitations: [], count: 0 });
    const invitations = stmts.getPendingInvitations.all(user.user_id, 'pending');
    res.json({ invitations, count: invitations.length });
});

// === API: Ответить на приглашение ===
app.post('/api/invite/:id/respond', (req, res) => {
    const { sessionKey, action } = req.body; // action: 'accept' | 'decline'
    const user = stmts.getUserBySession.get(sessionKey);
    if (!user) return res.status(400).json({ error: 'Профиль не найден' });
    const status = action === 'accept' ? 'accepted' : 'declined';
    stmts.updateInvitation.run(status, req.params.id, user.user_id);
    const cnt = stmts.countPending.get(user.user_id, 'pending').cnt;
    res.json({ ok: true, count: cnt });
});

// Fallback — отдаём index.html для SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === HTTP СЕРВЕР ===
const server = http.createServer(app);

// === WEBSOCKET СЕРВЕР ===
const wss = new WebSocket.Server({ noServer: true });

// Хранилище активных подключений: { sessionKey: Set<ws> }
const connections = new Map();

// Отправить сообщение конкретному пользователю по sessionKey
function notifyUser(sessionKey, message) {
    if (!connections.has(sessionKey)) return;
    const msg = JSON.stringify(message);
    connections.get(sessionKey).forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

// Обработка upgrade
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

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
            console.error('[WS] Error processing message:', error);
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws);
    });

    ws.on('error', (error) => {
        console.error('[WS] Connection error:', error.message);
    });

    // --- Проверка живого агента ---
    function isAgentAlive(sessionKey) {
        if (!connections.has(sessionKey)) return false;
        for (const client of connections.get(sessionKey)) {
            if (client.isAgent && client.readyState === WebSocket.OPEN) {
                return true;
            }
        }
        return false;
    }

    // --- Broadcast в сессию ---
    function broadcast(sessionKey, message, excludeWs = null) {
        if (!connections.has(sessionKey)) return;
        const msg = typeof message === 'string' ? message : JSON.stringify(message);
        connections.get(sessionKey).forEach((client) => {
            if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
                client.send(msg);
            }
        });
    }

    // --- ОБРАБОТЧИКИ ---

    function handleJoin(ws, data) {
        const { sessionKey } = data;
        currentSessionKey = sessionKey;

        // Добавляем соединение
        if (!connections.has(sessionKey)) {
            connections.set(sessionKey, new Set());
        }
        connections.get(sessionKey).add(ws);

        // Создаём запись в БД если нет
        ensureSession(sessionKey);

        // Отправляем текущие данные
        const sessionData = getSessionData(sessionKey);
        if (sessionData) {
            ws.send(JSON.stringify({ type: 'init', data: sessionData }));

            if (sessionData.timerState) {
                ws.send(JSON.stringify({ type: 'timer_state', data: sessionData.timerState }));
            }

            // Проверяем реальное подключение агента
            const agentAlive = isAgentAlive(sessionKey);
            if (sessionData.agentConnected !== agentAlive) {
                stmts.updateAgentStatus.run(agentAlive ? 1 : 0, agentAlive ? 1 : 0, agentAlive ? 1 : 0, Date.now(), sessionKey);
            }
            ws.send(JSON.stringify({ type: 'agent_status', connected: agentAlive }));
        }

        console.log(`[WS] Client joined session: ${sessionKey} (${connections.get(sessionKey).size} connections)`);
    }

    function handleSync(ws, data) {
        const { sessionKey, tasks, sessions: userSessions } = data;
        const now = Date.now();

        stmts.updateSync.run(
            JSON.stringify(tasks || []),
            JSON.stringify(userSessions || {}),
            now,
            sessionKey
        );

        // Рассылаем обновления другим клиентам (не отправителю)
        const sessionData = getSessionData(sessionKey);
        broadcast(sessionKey, { type: 'update', data: sessionData, from: 'server' }, ws);

        console.log(`[WS] Sync received for session: ${sessionKey} (${(tasks||[]).length} tasks, ${Object.keys(userSessions||{}).length} days)`);
    }

    function handleTimerSync(ws, data) {
        const { sessionKey, action, data: timerData } = data;
        const now = Date.now();

        const timerState = { action, ...timerData };
        stmts.updateTimerState.run(JSON.stringify(timerState), now, now, sessionKey);

        // Рассылаем обновление таймера
        broadcast(sessionKey, { type: 'timer_state', data: timerState }, ws);

        console.log(`[WS] Timer sync (${action}) for session: ${sessionKey}`);
    }

    function handleActivityUpdate(ws, data) {
        const { sessionKey, status, windowTitle } = data;
        const now = Date.now();

        stmts.updateActivity.run(status, windowTitle, now, now, sessionKey);

        // Рассылаем статус активности ВСЕМ (включая отправителя)
        broadcast(sessionKey, { type: 'activity_status', status, windowTitle });

        console.log(`[WS] Activity update for session ${sessionKey}: ${status} (${windowTitle})`);

        // Если distracted/idle — ставим force_pause через 5 секунд
        if (status === 'distracted' || status === 'idle') {
            setTimeout(() => {
                const currentData = getSessionData(sessionKey);
                if (currentData && currentData.activityStatus !== 'working') {
                    broadcast(sessionKey, { type: 'force_pause', reason: status });
                    console.log(`[WS] Force pause sent to session ${sessionKey} (reason: ${status})`);
                }
            }, 5000);
        }
    }

    function handleHeartbeat(ws, data) {
        const { sessionKey } = data;
        stmts.updateHeartbeat.run(Date.now(), sessionKey);

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
        }
    }

    function handleRequestState(ws, data) {
        const { sessionKey } = data;
        const sessionData = getSessionData(sessionKey);

        if (sessionData) {
            ws.send(JSON.stringify({ type: 'init', data: sessionData }));

            if (sessionData.timerState) {
                ws.send(JSON.stringify({ type: 'timer_state', data: sessionData.timerState }));
            }

            if (sessionData.activityStatus) {
                ws.send(JSON.stringify({
                    type: 'activity_status',
                    status: sessionData.activityStatus,
                    windowTitle: sessionData.activeWindow || '',
                }));
            }

            const agentAlive = isAgentAlive(sessionKey);
            if (!agentAlive && sessionData.agentConnected) {
                stmts.updateAgentStatus.run(0, 0, 0, Date.now(), sessionKey);
            }
            ws.send(JSON.stringify({ type: 'agent_status', connected: agentAlive }));

            console.log(`[WS] State sent to client for session ${sessionKey}, agent: ${agentAlive}`);
        }
    }

    function handleBrowserEvent(ws, data) {
        const { sessionKey, event } = data;
        console.log(`[WS] Browser event for session ${sessionKey}: ${event}`);

        // При скрытии вкладки без агента — пауза через 30 секунд
        if (event === 'tab_hidden' || event === 'browser_blur') {
            const sessionData = getSessionData(sessionKey);
            if (!sessionData || !sessionData.activityStatus || sessionData.activityStatus === 'idle') {
                setTimeout(() => {
                    const latestData = getSessionData(sessionKey);
                    // Если агент не подтверждает работу
                    if (!latestData || !latestData.agentConnected || latestData.activityStatus !== 'working') {
                        broadcast(sessionKey, { type: 'force_pause', reason: 'browser_inactive' });
                    }
                }, 30000);
            }
        }
    }

    function handleAgentConnected(ws, data) {
        const { sessionKey } = data;

        ws.isAgent = true;
        ws.agentSessionKey = sessionKey;

        stmts.updateAgentStatus.run(1, 1, 1, Date.now(), sessionKey);

        broadcast(sessionKey, { type: 'agent_status', connected: true });

        console.log(`[WS] Desktop Agent connected for session ${sessionKey}`);
    }

    function handleDisconnect(ws) {
        if (currentSessionKey && connections.has(currentSessionKey)) {
            connections.get(currentSessionKey).delete(ws);

            // Если отключился агент — уведомляем браузеры
            if (ws.isAgent) {
                const key = ws.agentSessionKey || currentSessionKey;
                console.log(`[WS] Desktop Agent disconnected from session: ${key}`);

                stmts.updateAgentStatus.run(0, 0, 0, Date.now(), key);

                broadcast(key, { type: 'agent_status', connected: false });
            }

            if (connections.get(currentSessionKey).size === 0) {
                connections.delete(currentSessionKey);
                console.log(`[WS] Session ${currentSessionKey} removed (no active connections)`);
            } else {
                console.log(`[WS] Client disconnected from session: ${currentSessionKey} (${connections.get(currentSessionKey).size} remaining)`);
            }
        }
    }
});

// === МОНИТОРИНГ HEARTBEAT (каждые 5 секунд) ===
setInterval(() => {
    const now = Date.now();
    const heartbeatTimeout = 15000;

    const rows = stmts.getAllSessions.all();
    for (const row of rows) {
        if (row.last_heartbeat && (now - row.last_heartbeat) > heartbeatTimeout) {
            const timerState = row.timer_state ? JSON.parse(row.timer_state) : null;
            if (timerState && timerState.action === 'start') {
                console.log(`[Monitor] Heartbeat timeout for session ${row.session_key}, forcing pause`);

                timerState.action = 'pause';
                stmts.updateTimerState.run(JSON.stringify(timerState), now, null, row.session_key);
                stmts.updateActivity.run('idle', null, now, now, row.session_key);

                // Отправляем force_pause
                if (connections.has(row.session_key)) {
                    const msg = JSON.stringify({ type: 'force_pause', reason: 'timeout' });
                    connections.get(row.session_key).forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(msg);
                        }
                    });
                }
            }
        }
    }
}, 5000);

// === GRACEFUL SHUTDOWN ===
function shutdown(signal) {
    console.log(`\n[Server] ${signal} received, shutting down gracefully...`);

    // Закрываем WebSocket соединения
    wss.clients.forEach((ws) => {
        ws.close(1000, 'Server shutting down');
    });

    // Закрываем HTTP сервер
    server.close(() => {
        console.log('[Server] HTTP server closed');
        db.close();
        console.log('[DB] Database closed');
        process.exit(0);
    });

    // Принудительное закрытие через 10 секунд
    setTimeout(() => {
        console.error('[Server] Forced shutdown');
        db.close();
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// === ЗАПУСК ===
server.listen(PORT, () => {
    console.log(`[Server] LinkTime running on port ${PORT} (${NODE_ENV})`);
    console.log(`[Server] Static files: ${path.join(__dirname, 'public')}`);
    console.log(`[Server] Database: ${DB_PATH}`);
    console.log(`[Server] Health check: http://localhost:${PORT}/api/health`);
});
