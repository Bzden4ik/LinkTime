const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// === LOGGER — minimal zero-dep, level-gated, JSON in production ============
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const LOG_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LOG_LEVELS.info;
const LOG_JSON = process.env.LOG_JSON === '1' || process.env.NODE_ENV === 'production';

// REDACT — маскируем sessionKey'и в логах. Утечка через логи = silent disaster.
// Паттерн: sk_<hex> (новый) или session_<id>_<ts> (legacy).
const SK_RE = /\b(sk_[a-f0-9]{4})[a-f0-9]+\b|\b(session_[a-z0-9]{2,4})[a-z0-9]+(_\d{2,4})\d+\b/gi;
function redactStr(s) {
    if (typeof s !== 'string') return s;
    return s.replace(SK_RE, (m, sk1, ses1, ses2) =>
        sk1 ? sk1 + '***' :
        ses1 ? ses1 + '***' + ses2 + '***' : m);
}
function redactDeep(v) {
    if (typeof v === 'string') return redactStr(v);
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(redactDeep);
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        // Полностью скрываем поля с очевидным секретом
        if (/^(session[_-]?key|sessionkey|token|password|secret)$/i.test(k)) {
            out[k] = typeof val === 'string' ? '***' : val;
        } else {
            out[k] = redactDeep(val);
        }
    }
    return out;
}

function makeLogger(scope) {
    function emit(level, ...args) {
        if (LOG_LEVELS[level] < LOG_LEVEL) return;
        const ts = new Date().toISOString();
        const redacted = args.map(a => {
            if (a instanceof Error) return { name: a.name, message: redactStr(a.message), stack: redactStr(a.stack || '') };
            return redactDeep(a);
        });
        if (LOG_JSON) {
            try {
                process.stdout.write(JSON.stringify({ ts, level, scope, msg: redacted }) + '\n');
            } catch {
                process.stdout.write(JSON.stringify({ ts, level, scope, msg: '[unserializable]' }) + '\n');
            }
        } else {
            const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
            out(`[${ts.slice(11, 19)}] [${level.toUpperCase().padEnd(5)}] [${scope}]`, ...redacted);
        }
    }
    return {
        debug: (...a) => emit('debug', ...a),
        info:  (...a) => emit('info', ...a),
        warn:  (...a) => emit('warn', ...a),
        error: (...a) => emit('error', ...a),
    };
}
const log = makeLogger('server');
const dbLog = makeLogger('db');
const wsLog = makeLogger('ws');

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
        avatar TEXT DEFAULT NULL,
        created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT DEFAULT 'Команда',
        created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS team_members (
        team_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        sharing_time INTEGER DEFAULT 0,
        joined_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
        PRIMARY KEY (team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS team_boards (
        team_id INTEGER PRIMARY KEY,
        data TEXT DEFAULT '{"cards":[],"connections":[]}',
        updated_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS personal_boards (
        session_key TEXT PRIMARY KEY,
        data TEXT DEFAULT '{"cards":[],"connections":[]}',
        updated_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
`);

// === VERSIONED MIGRATIONS =====================================================
// Replaces the old try/catch ALTER TABLE pattern.
// Each migration runs once, tracked in schema_versions table.
db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
`);

function columnExists(table, column) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => r.name === column);
}

const migrations = [
    {
        version: 1,
        name: 'users.avatar',
        up: () => { if (!columnExists('users', 'avatar')) db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT NULL`); }
    },
    {
        version: 2,
        name: 'team_members.sharing_time',
        up: () => { if (!columnExists('team_members', 'sharing_time')) db.exec(`ALTER TABLE team_members ADD COLUMN sharing_time INTEGER DEFAULT 0`); }
    },
    {
        version: 3,
        name: 'team_boards table',
        up: () => db.exec(`CREATE TABLE IF NOT EXISTS team_boards (
            team_id INTEGER PRIMARY KEY,
            data TEXT DEFAULT '{"cards":[],"connections":[]}',
            updated_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
        )`)
    },
    {
        version: 4,
        name: 'personal_boards table',
        up: () => db.exec(`CREATE TABLE IF NOT EXISTS personal_boards (
            session_key TEXT PRIMARY KEY,
            data TEXT DEFAULT '{"cards":[],"connections":[]}',
            updated_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
        )`)
    },
    {
        version: 5,
        name: 'projects + project_tasks tables',
        up: () => db.exec(`
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_key TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#ff6b1f',
                icon TEXT DEFAULT '📁',
                sort_order INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
            );
            CREATE TABLE IF NOT EXISTS project_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_key TEXT NOT NULL,
                project_id INTEGER DEFAULT NULL,
                text TEXT NOT NULL,
                completed INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
                completed_at INTEGER DEFAULT NULL,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
            );
        `)
    },
    {
        version: 6,
        name: 'project_tasks extra columns',
        up: () => {
            const cols = [
                ['description', 'TEXT DEFAULT NULL'],
                ['due_date', 'TEXT DEFAULT NULL'],
                ['time_start', 'TEXT DEFAULT NULL'],
                ['time_end', 'TEXT DEFAULT NULL'],
                ['time_spent', 'INTEGER DEFAULT 0'],
                ['media', 'TEXT DEFAULT NULL'],
            ];
            for (const [col, def] of cols) {
                if (!columnExists('project_tasks', col)) {
                    db.exec(`ALTER TABLE project_tasks ADD COLUMN ${col} ${def}`);
                }
            }
        }
    },
    {
        version: 7,
        name: 'performance indices',
        up: () => db.exec(`
            CREATE INDEX IF NOT EXISTS idx_project_tasks_session ON project_tasks(session_key);
            CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id);
            CREATE INDEX IF NOT EXISTS idx_projects_session ON projects(session_key);
            CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
            CREATE INDEX IF NOT EXISTS idx_invitations_to_user ON invitations(to_user_id);
            CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
            CREATE INDEX IF NOT EXISTS idx_session_data_heartbeat ON session_data(last_heartbeat);
        `)
    },
    {
        version: 8,
        name: 'users.avatar_url (file-backed avatars)',
        up: () => { if (!columnExists('users', 'avatar_url')) db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT NULL`); }
    },
];

const getCurrentVersion = db.prepare('SELECT MAX(version) AS v FROM schema_versions');
const insertVersion = db.prepare('INSERT INTO schema_versions (version, name, applied_at) VALUES (?, ?, ?)');

(function runMigrations() {
    const current = getCurrentVersion.get().v || 0;
    const pending = migrations.filter(m => m.version > current);
    if (!pending.length) {
        console.log(`[DB] Schema up-to-date (v${current})`);
        return;
    }
    console.log(`[DB] Running ${pending.length} pending migrations (from v${current})...`);
    const tx = db.transaction(() => {
        for (const m of pending) {
            try {
                m.up();
                insertVersion.run(m.version, m.name, Date.now());
                console.log(`[DB] ✓ v${m.version} — ${m.name}`);
            } catch (e) {
                console.error(`[DB] ✗ v${m.version} — ${m.name}: ${e.message}`);
                throw e;
            }
        }
    });
    tx();
})();

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
    updateAvatar: db.prepare('UPDATE users SET avatar = ? WHERE session_key = ?'),
    // Invitations
    createInvitation: db.prepare('INSERT INTO invitations (from_user_id, to_user_id) VALUES (?, ?)'),
    getPendingInvitations: db.prepare('SELECT i.*, u.username as from_username FROM invitations i JOIN users u ON i.from_user_id = u.user_id WHERE i.to_user_id = ? AND i.status = ?'),
    updateInvitation: db.prepare('UPDATE invitations SET status = ? WHERE id = ? AND to_user_id = ?'),
    countPending: db.prepare('SELECT COUNT(*) as cnt FROM invitations WHERE to_user_id = ? AND status = ?'),
    checkInvitationExists: db.prepare('SELECT id FROM invitations WHERE from_user_id = ? AND to_user_id = ? AND status = ?'),
    // Teams
    createTeam: db.prepare('INSERT INTO teams (name) VALUES (?)'),
    addTeamMember: db.prepare('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)'),
    getUserTeam: db.prepare('SELECT t.* FROM teams t JOIN team_members tm ON t.id = tm.team_id WHERE tm.user_id = ?'),
    getTeamMembers: db.prepare('SELECT u.user_id, u.username, u.email, u.avatar, tm.role, tm.sharing_time, tm.joined_at FROM team_members tm JOIN users u ON tm.user_id = u.user_id WHERE tm.team_id = ?'),
    checkTeamMember: db.prepare('SELECT team_id FROM team_members WHERE user_id = ?'),
    updateSharingTime: db.prepare('UPDATE team_members SET sharing_time = ? WHERE team_id = ? AND user_id = ?'),
    // Team board
    getTeamBoard: db.prepare('SELECT data FROM team_boards WHERE team_id = ?'),
    upsertTeamBoard: db.prepare(`INSERT INTO team_boards (team_id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(team_id) DO UPDATE SET data = ?, updated_at = ?`),
    // Personal board
    getPersonalBoard: db.prepare('SELECT data FROM personal_boards WHERE session_key = ?'),
    upsertPersonalBoard: db.prepare(`INSERT INTO personal_boards (session_key, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET data = ?, updated_at = ?`),
    // Projects
    getProjects: db.prepare('SELECT * FROM projects WHERE session_key = ? ORDER BY sort_order, created_at'),
    createProject: db.prepare('INSERT INTO projects (session_key, name, color, icon) VALUES (?, ?, ?, ?)'),
    updateProject: db.prepare('UPDATE projects SET name = ?, color = ?, icon = ? WHERE id = ? AND session_key = ?'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ? AND session_key = ?'),
    // Project tasks
    getProjectTasks: db.prepare('SELECT * FROM project_tasks WHERE session_key = ? ORDER BY completed, sort_order, created_at DESC'),
    getProjectTasksPaged: db.prepare('SELECT * FROM project_tasks WHERE session_key = ? ORDER BY completed, sort_order, created_at DESC LIMIT ? OFFSET ?'),
    countProjectTasks: db.prepare('SELECT COUNT(*) AS cnt FROM project_tasks WHERE session_key = ?'),
    getTasksByProject: db.prepare('SELECT * FROM project_tasks WHERE project_id = ? AND session_key = ? ORDER BY completed, sort_order, created_at DESC'),
    getTasksNoProject: db.prepare('SELECT * FROM project_tasks WHERE project_id IS NULL AND session_key = ? ORDER BY completed, sort_order, created_at DESC'),
    createProjectTask: db.prepare('INSERT INTO project_tasks (session_key, project_id, text) VALUES (?, ?, ?)'),
    updateProjectTask: db.prepare('UPDATE project_tasks SET text = ?, project_id = ? WHERE id = ? AND session_key = ?'),
    toggleProjectTask: db.prepare('UPDATE project_tasks SET completed = ?, completed_at = ?, time_spent = ? WHERE id = ? AND session_key = ?'),
    deleteProjectTask: db.prepare('DELETE FROM project_tasks WHERE id = ? AND session_key = ?'),
    moveTaskToProject: db.prepare('UPDATE project_tasks SET project_id = ? WHERE id = ? AND session_key = ?'),
    updateTaskDetails: db.prepare('UPDATE project_tasks SET description = ?, due_date = ?, time_start = ?, time_end = ?, media = ? WHERE id = ? AND session_key = ?'),
    getTaskById: db.prepare('SELECT * FROM project_tasks WHERE id = ? AND session_key = ?'),
};

// === ВАЛИДАЦИЯ INPUT ===

// sessionKey accepts both legacy (session_xxx_NNN) and new (sk_<hex>) shapes
const SESSION_KEY_RE = /^(?:sk_[a-f0-9]{8,128}|session_[a-z0-9]{4,32}_\d{6,20})$/i;
function isValidSessionKey(k) {
    return typeof k === 'string' && SESSION_KEY_RE.test(k);
}

// XSS sanitizer: strip control chars, cap length, escape angle brackets so anything
// that ends up in innerHTML on the client is harmless. The client also escapes —
// belt-and-braces.
function sanitizeText(s, maxLen) {
    if (typeof s !== 'string') return '';
    // Drop NULs and other low control chars except tab/newline
    let out = s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
    if (out.length > maxLen) out = out.slice(0, maxLen);
    return out.trim();
}

// Cheap object-shape validator. Returns array of issues; empty = OK.
function validateShape(obj, schema) {
    const issues = [];
    if (typeof obj !== 'object' || obj === null) return ['payload must be object'];
    for (const [key, rule] of Object.entries(schema)) {
        const v = obj[key];
        if (rule.required && (v === undefined || v === null)) {
            issues.push(`${key} required`); continue;
        }
        if (v === undefined || v === null) continue;
        if (rule.type === 'string' && typeof v !== 'string') issues.push(`${key} must be string`);
        if (rule.type === 'number' && typeof v !== 'number') issues.push(`${key} must be number`);
        if (rule.type === 'array'  && !Array.isArray(v)) issues.push(`${key} must be array`);
        if (rule.type === 'object' && (typeof v !== 'object' || Array.isArray(v))) issues.push(`${key} must be object`);
        if (rule.maxLen != null && typeof v === 'string' && v.length > rule.maxLen) issues.push(`${key} too long (max ${rule.maxLen})`);
        if (rule.maxItems != null && Array.isArray(v) && v.length > rule.maxItems) issues.push(`${key} too many items (max ${rule.maxItems})`);
        if (rule.regex && typeof v === 'string' && !rule.regex.test(v)) issues.push(`${key} bad format`);
    }
    return issues;
}

// Express middleware to guard :sessionKey param
function requireValidSessionKey(req, res, next) {
    if (!isValidSessionKey(req.params.sessionKey)) {
        return res.status(400).json({ error: 'invalid sessionKey' });
    }
    next();
}

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

// Security headers — proper CSP (replaces "off" mode).
// Inline scripts are still permitted via 'unsafe-inline' because index.html has them;
// proper nonces are a Phase 4 refactor. Until then, this is a meaningful net positive:
// frame-ancestors, base-uri, object-src, plus origin-restricted third-party allowlist.
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            'default-src': ["'self'"],
            'script-src': [
                "'self'",
                // unsafe-inline удалён — все inline-IIFE вынесены в dashboard-init.js
                'https://cdn.jsdelivr.net',
                'https://cdnjs.cloudflare.com',
            ],
            // CSP3: inline event handlers (onclick="...") тоже требуют отдельной директивы
            // Мы их все убрали через event delegation, так что разрешаем только nonce.
            'script-src-attr': ["'none'"],
            'style-src': [
                "'self'",
                "'unsafe-inline'",
                'https://fonts.googleapis.com',
            ],
            'font-src': [
                "'self'",
                'https://fonts.gstatic.com',
                'data:',
            ],
            'img-src': [
                "'self'",
                'data:',
                'blob:',
                'https:',
            ],
            'connect-src': [
                "'self'",
                'ws:',
                'wss:',
                'https://api.github.com',                // agent update check
                'https://fonts.googleapis.com',          // SW fetches Google Fonts CSS
                'https://fonts.gstatic.com',             // SW fetches font files
                'https://cdn.jsdelivr.net',              // QR lib source maps in devtools
                'https://cdnjs.cloudflare.com',          // QR lib source maps in devtools
            ],
            'media-src': ["'self'", 'data:', 'blob:'],
            'worker-src': ["'self'", 'blob:'],
            'frame-src':  ["'self'"],                     // allow our own iframe overlay (board)
            'frame-ancestors': ["'self'"],                // anti-clickjacking, but own-origin OK
            'object-src': ["'none'"],
            'base-uri': ["'self'"],
            'form-action': ["'self'"],
            'upgrade-insecure-requests': [],
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// Optional HTTPS-only redirect — enable via env FORCE_HTTPS=1 when behind a TLS terminator.
if (process.env.FORCE_HTTPS === '1') {
    app.use((req, res, next) => {
        const proto = req.headers['x-forwarded-proto'] || req.protocol;
        if (proto !== 'https') {
            return res.redirect(308, 'https://' + req.headers.host + req.url);
        }
        next();
    });
}

// Rate limiting для API — key = IP + sessionKey, чтобы юзеры за общим NAT
// не делили лимит, и наоборот один юзер не флудил с нескольких IP.
function ipKey(req) {
    return req.headers['x-forwarded-for']
        ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
        : req.ip;
}
function rateKey(req) {
    const sk = req.params.sessionKey
        || (req.body && req.body.sessionKey)
        || (req.body && req.body.fromSessionKey)
        || '';
    return ipKey(req) + ':' + (sk ? sk.slice(0, 16) : 'anon');
}

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 600,                  // 40 req/min — реалистично с учётом синков
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateKey,
    message: { error: 'Слишком много запросов, попробуйте позже' },
});
app.use('/api/', apiLimiter);

// Жёсткий лимит на чувствительные эндпоинты (приглашения, удаление аккаунта, аватар)
const sensitiveLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateKey,
    message: { error: 'Слишком часто — подождите минуту' },
});
app.use('/api/invite', sensitiveLimiter);
app.use('/api/account', sensitiveLimiter);
app.use('/api/user/:sessionKey/avatar', sensitiveLimiter);

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-LinkTime-Key');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Avatars storage on disk
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

// Сервинг загруженных файлов
app.use('/uploads', express.static(UPLOADS_DIR, {
    maxAge: '7d',
    fallthrough: true,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
}));

// Статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// JSON body parser
app.use(express.json({ limit: '10mb' }));

// Validate every :sessionKey route param in one shot
app.param('sessionKey', (req, res, next, value) => {
    if (!isValidSessionKey(value)) {
        return res.status(400).json({ error: 'Invalid sessionKey format' });
    }
    next();
});

// === AUTH HEADER (preferred over URL path) ==================================
// Клиенты могут слать `Authorization: Bearer sk_xxx` вместо ?sessionKey в URL.
// Это убирает утечку через access-logs / referrer / browser history.
// Если ключ в header — он переопределяет path-param (плавная миграция).
// CORS уже allowlist'нут, поэтому добавляем заголовок в Access-Control-Allow-Headers выше.
function extractAuthKey(req) {
    const h = req.headers.authorization || req.headers['x-linktime-key'];
    if (!h) return null;
    const m = /^Bearer\s+([\w-]+)$/i.exec(h);
    const key = m ? m[1] : h;
    return isValidSessionKey(key) ? key : null;
}
// Middleware: если есть header — подставляем в req.params.sessionKey для backwards-compat.
app.use('/api/', (req, res, next) => {
    const k = extractAuthKey(req);
    if (k) {
        req.authSessionKey = k;
        // Только если в роуте есть placeholder и сейчас он пустой — заполняем
        if (req.params && !req.params.sessionKey) {
            req.params.sessionKey = k;
        }
    }
    next();
});

// Health check — extended for monitoring
const healthCountStmts = {
    sessions: db.prepare('SELECT COUNT(*) AS c FROM session_data'),
    users: db.prepare('SELECT COUNT(*) AS c FROM users'),
    projectTasks: db.prepare('SELECT COUNT(*) AS c FROM project_tasks'),
    schemaVersion: db.prepare('SELECT MAX(version) AS v FROM schema_versions'),
};
function dbFileSize() {
    try { return fs.statSync(DB_PATH).size; } catch (_) { return null; }
}
app.get('/api/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.round(process.uptime()),
        env: NODE_ENV,
        version: require('./package.json').version,
        connections: {
            total: wss.clients.size,
            sessions: connections.size,
            board_teams: boardSessions.size,
        },
        db: {
            schema_version: healthCountStmts.schemaVersion.get().v,
            file_bytes: dbFileSize(),
            sessions: healthCountStmts.sessions.get().c,
            users: healthCountStmts.users.get().c,
            project_tasks: healthCountStmts.projectTasks.get().c,
        },
        memory: {
            rss_mb: Math.round(mem.rss / 1024 / 1024),
            heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
            heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        },
        apps_cache: { sessions: appsCache.size },
        lists_cache: { sessions: listsCache.size },
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
    const { tasks, sessions } = req.body || {};

    // Shape checks — abort early on bad payload
    if (tasks !== undefined && !Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be array' });
    if (sessions !== undefined && (typeof sessions !== 'object' || Array.isArray(sessions) || sessions === null))
        return res.status(400).json({ error: 'sessions must be object' });
    if (Array.isArray(tasks) && tasks.length > 10000) return res.status(413).json({ error: 'too many tasks (max 10000)' });

    // Sanitize task texts — these get broadcast via WS to other devices
    const safeTasks = Array.isArray(tasks) ? tasks.map(t => {
        if (typeof t !== 'object' || t === null) return null;
        return {
            ...t,
            text: typeof t.text === 'string' ? sanitizeText(t.text, 1000) : '',
            date: typeof t.date === 'string' ? sanitizeText(t.date, 32) : '',
            completed: !!t.completed,
        };
    }).filter(Boolean) : [];

    ensureSession(sessionKey);
    stmts.updateSync.run(
        JSON.stringify(safeTasks),
        JSON.stringify(sessions || {}),
        Date.now(),
        sessionKey
    );

    res.json({ ok: true, totalTasks: safeTasks.length, totalDays: Object.keys(sessions || {}).length });
});

// === API: Пользователь — получить/создать профиль ===
app.get('/api/user/:sessionKey', (req, res) => {
    const user = ensureUser(req.params.sessionKey);
    res.json({ userId: user.user_id, username: user.username, email: user.email, avatar: user.avatar });
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
app.post('/api/user/:sessionKey/email', (req, res) => {
    const { email } = req.body || {};
    if (email !== null && email !== undefined && email !== '') {
        if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
            return res.status(400).json({ error: 'Некорректный email' });
        }
    }
    stmts.updateEmail.run(email || null, req.params.sessionKey);
    res.json({ ok: true });
});

// === API: Обновить аватар ===
// Decodes the base64 data URL on server, writes to disk, stores only the URL in DB.
// Backwards compatible: clients still POST { avatar: 'data:image/...' } as before.
const AVATAR_MAX_BYTES = 500 * 1024;       // 500 KB
const AVATAR_MIME_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const cleanupOldAvatar = (sessionKey) => {
    const row = stmts.getUserBySession.get(sessionKey);
    if (!row) return;
    const old = row.avatar || '';
    if (old && old.startsWith('/uploads/avatars/')) {
        const abs = path.join(UPLOADS_DIR, old.replace(/^\/uploads\//, ''));
        if (abs.startsWith(AVATARS_DIR) && fs.existsSync(abs)) {
            try { fs.unlinkSync(abs); } catch (_) {}
        }
    }
};

app.post('/api/user/:sessionKey/avatar', (req, res) => {
    const { avatar } = req.body || {};

    // Removal — null or empty string
    if (avatar === null || avatar === '') {
        cleanupOldAvatar(req.params.sessionKey);
        stmts.updateAvatar.run(null, req.params.sessionKey);
        return res.json({ ok: true, avatar: null });
    }

    if (typeof avatar !== 'string') return res.status(400).json({ error: 'avatar must be data URL or null' });
    if (avatar.length > AVATAR_MAX_BYTES * 2) return res.status(413).json({ error: 'Аватар слишком большой (макс 500 КБ)' });

    const m = AVATAR_MIME_RE.exec(avatar);
    if (!m) return res.status(400).json({ error: 'Неверный формат изображения (поддерживаются PNG/JPEG/WebP/GIF)' });

    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const b64 = m[2];
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (_) { return res.status(400).json({ error: 'bad base64' }); }
    if (buf.length > AVATAR_MAX_BYTES) return res.status(413).json({ error: 'Аватар слишком большой (макс 500 КБ)' });

    // Unguessable filename — нельзя угадать чужой аватар по sessionKey
    const filename = crypto.randomBytes(16).toString('hex') + '.' + ext;
    const abs = path.join(AVATARS_DIR, filename);
    cleanupOldAvatar(req.params.sessionKey);
    try {
        fs.writeFileSync(abs, buf);
    } catch (e) {
        console.error('[Avatar] write failed:', e.message);
        return res.status(500).json({ error: 'storage failed' });
    }
    const url = `/uploads/avatars/${filename}`;
    stmts.updateAvatar.run(url, req.params.sessionKey);

    // Notify team
    const user = stmts.getUserBySession.get(req.params.sessionKey);
    if (user) {
        const team = stmts.getUserTeam.get(user.user_id);
        if (team) {
            const members = stmts.getTeamMembers.all(team.id);
            members.forEach(m => {
                const memberUser = stmts.getUserByUserId.get(m.user_id);
                if (memberUser) notifyUser(memberUser.session_key, { type: 'team_updated', teamId: team.id });
            });
        }
    }
    res.json({ ok: true, avatar: url });
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
    const { sessionKey, action } = req.body;
    const user = stmts.getUserBySession.get(sessionKey);
    if (!user) return res.status(400).json({ error: 'Профиль не найден' });
    
    const status = action === 'accept' ? 'accepted' : 'declined';
    const invitation = db.prepare('SELECT * FROM invitations WHERE id = ? AND to_user_id = ?').get(req.params.id, user.user_id);
    if (!invitation) return res.status(404).json({ error: 'Приглашение не найдено' });
    
    stmts.updateInvitation.run(status, req.params.id, user.user_id);
    
    if (action === 'accept') {
        // Проверяем есть ли команда у отправителя
        const fromUser = stmts.getUserByUserId.get(invitation.from_user_id);
        let team = stmts.getUserTeam.get(fromUser.user_id);
        
        if (!team) {
            // Создаём новую команду
            const result = stmts.createTeam.run('Команда');
            const teamId = result.lastInsertRowid;
            stmts.addTeamMember.run(teamId, fromUser.user_id, 'owner');
            team = { id: teamId };
        }
        
        // Добавляем принявшего в команду
        stmts.addTeamMember.run(team.id, user.user_id, 'member');
        
        // Уведомляем всех участников команды
        const members = stmts.getTeamMembers.all(team.id);
        members.forEach(m => {
            const memberUser = stmts.getUserByUserId.get(m.user_id);
            notifyUser(memberUser.session_key, { type: 'team_updated', teamId: team.id });
        });
    }
    
    const cnt = stmts.countPending.get(user.user_id, 'pending').cnt;
    res.json({ ok: true, count: cnt });
});

// === API: Получить команду пользователя ===
app.get('/api/team/:sessionKey', (req, res) => {
    const user = stmts.getUserBySession.get(req.params.sessionKey);
    if (!user) return res.json({ team: null, members: [] });
    const team = stmts.getUserTeam.get(user.user_id);
    if (!team) return res.json({ team: null, members: [] });
    const members = stmts.getTeamMembers.all(team.id);
    res.json({ team, members });
});

// === API: Включить/выключить шеринг времени ===
// === API: Выгнать участника из команды (только owner) ===
app.post('/api/team/kick', (req, res) => {
    const { sessionKey, targetUserId } = req.body;
    const user = stmts.getUserBySession.get(sessionKey);
    if (!user) return res.status(400).json({ error: 'Профиль не найден' });
    const team = stmts.getUserTeam.get(user.user_id);
    if (!team) return res.status(404).json({ error: 'Команда не найдена' });

    // Проверяем что текущий пользователь — owner
    const myMembership = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(team.id, user.user_id);
    if (!myMembership || myMembership.role !== 'owner') return res.status(403).json({ error: 'Только владелец может выгонять участников' });

    // Нельзя выгнать самого себя через этот эндпоинт
    if (targetUserId === user.user_id) return res.status(400).json({ error: 'Нельзя выгнать себя' });

    db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, targetUserId);

    // Cut off any board WS this user has — prevent malicious clients from continuing
    if (boardSessions.has(team.id)) {
        const members = boardSessions.get(team.id);
        for (const [bws, info] of members) {
            if (info.userId === targetUserId) {
                members.delete(bws);
                bws._boardTeamId = null;
                if (bws.readyState === WebSocket.OPEN) {
                    bws.send(JSON.stringify({ type: 'kicked_from_team' }));
                }
            }
        }
    }

    // Уведомляем выгнанного
    const targetUser = stmts.getUserByUserId.get(targetUserId);
    if (targetUser) notifyUser(targetUser.session_key, { type: 'kicked_from_team' });

    // Проверяем: если owner остался один — расформировываем команду
    const remaining = stmts.getTeamMembers.all(team.id);
    if (remaining.length <= 1) {
        // Уведомляем owner что команда расформирована
        notifyUser(user.session_key, { type: 'team_disbanded' });
        // Удаляем всех участников и саму команду
        db.prepare('DELETE FROM team_members WHERE team_id = ?').run(team.id);
        db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
        db.prepare('DELETE FROM team_boards WHERE team_id = ?').run(team.id);
        return res.json({ ok: true, disbanded: true });
    }

    // Уведомляем остальных
    const members = stmts.getTeamMembers.all(team.id);
    members.forEach(m => {
        const memberUser = stmts.getUserByUserId.get(m.user_id);
        if (memberUser) notifyUser(memberUser.session_key, { type: 'team_updated', teamId: team.id });
    });

    res.json({ ok: true });
});

app.post('/api/team/sharing', (req, res) => {
    const { sessionKey, enabled } = req.body;
    const user = stmts.getUserBySession.get(sessionKey);
    if (!user) return res.status(400).json({ error: 'Профиль не найден' });
    const team = stmts.getUserTeam.get(user.user_id);
    if (!team) return res.status(404).json({ error: 'Команда не найдена' });
    
    stmts.updateSharingTime.run(enabled ? 1 : 0, team.id, user.user_id);
    
    // Уведомляем всех участников команды
    const members = stmts.getTeamMembers.all(team.id);
    members.forEach(m => {
        const memberUser = stmts.getUserByUserId.get(m.user_id);
        notifyUser(memberUser.session_key, { type: 'team_updated', teamId: team.id });
    });
    
    res.json({ ok: true });
});

// === API: Получить личную доску ===
app.get('/api/board/personal/:sessionKey', (req, res) => {
    const { sessionKey } = req.params;
    const row = stmts.getPersonalBoard.get(sessionKey);
    const data = row ? JSON.parse(row.data) : { cards: [], connections: [] };
    res.json(data);
});

// === API: Сохранить личную доску ===
app.post('/api/board/personal/:sessionKey', (req, res) => {
    const { sessionKey } = req.params;
    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Invalid data' });
    const json = JSON.stringify(data);
    if (json.length > 4_000_000) return res.status(413).json({ error: 'Board too large (max 4MB)' });
    const now = Date.now();
    stmts.upsertPersonalBoard.run(sessionKey, json, now, json, now);
    res.json({ ok: true });
});

// === API: Получить командную доску ===
app.get('/api/board/team/:sessionKey', (req, res) => {
    const user = stmts.getUserBySession.get(req.params.sessionKey);
    if (!user) return res.status(403).json({ error: 'Not found' });
    const team = stmts.getUserTeam.get(user.user_id);
    if (!team) return res.status(404).json({ error: 'No team' });
    const row = stmts.getTeamBoard.get(team.id);
    const data = row ? JSON.parse(row.data) : { cards: [], connections: [] };
    res.json(data);
});

// === API: Проекты ===
// Pagination: ?limit (default 500, max 5000) + ?offset (default 0).
// Without params behavior is backwards-compatible: returns up to 500 tasks.
app.get('/api/projects/:sessionKey', (req, res) => {
    const projects = stmts.getProjects.all(req.params.sessionKey);
    let limit = parseInt(req.query.limit, 10);
    let offset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 500;
    if (limit > 5000) limit = 5000;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const tasks = stmts.getProjectTasksPaged.all(req.params.sessionKey, limit + 1, offset);
    const hasMore = tasks.length > limit;
    if (hasMore) tasks.pop();
    const total = stmts.countProjectTasks.get(req.params.sessionKey).cnt;
    res.json({ projects, tasks, pagination: { limit, offset, total, hasMore } });
});

app.post('/api/projects/:sessionKey', (req, res) => {
    const { name, color, icon } = req.body || {};
    const safeName = sanitizeText(name || '', 80);
    if (!safeName) return res.status(400).json({ error: 'Name required (max 80 chars)' });
    const safeColor = (typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color)) ? color : '#ff6b1f';
    const safeIcon = sanitizeText(icon || '📁', 16);
    const result = stmts.createProject.run(req.params.sessionKey, safeName, safeColor, safeIcon);
    res.json({ id: result.lastInsertRowid, session_key: req.params.sessionKey, name: safeName, color: safeColor, icon: safeIcon, sort_order: 0, created_at: Date.now() });
});

app.put('/api/projects/:sessionKey/:id', (req, res) => {
    const { name, color, icon } = req.body;
    stmts.updateProject.run(name, color, icon, +req.params.id, req.params.sessionKey);
    res.json({ ok: true });
});

app.delete('/api/projects/:sessionKey/:id', (req, res) => {
    stmts.deleteProject.run(+req.params.id, req.params.sessionKey);
    res.json({ ok: true });
});

// === API: Задачи проектов ===
app.post('/api/tasks/:sessionKey', (req, res) => {
    const { text, projectId } = req.body || {};
    const safeText = sanitizeText(text || '', 1000);
    if (!safeText) return res.status(400).json({ error: 'Text required (max 1000 chars)' });
    const pid = (typeof projectId === 'number') ? projectId : null;
    const result = stmts.createProjectTask.run(req.params.sessionKey, pid, safeText);
    res.json({ id: result.lastInsertRowid, session_key: req.params.sessionKey, project_id: pid, text: safeText, completed: 0, sort_order: 0, created_at: Date.now(), completed_at: null });
});

app.put('/api/tasks/:sessionKey/:id', (req, res) => {
    const { text, projectId } = req.body || {};
    const safeText = sanitizeText(text || '', 1000);
    if (!safeText) return res.status(400).json({ error: 'Text required (max 1000 chars)' });
    const pid = (typeof projectId === 'number') ? projectId : null;
    stmts.updateProjectTask.run(safeText, pid, +req.params.id, req.params.sessionKey);
    res.json({ ok: true });
});

app.patch('/api/tasks/:sessionKey/:id/toggle', (req, res) => {
    const { completed, timeSpent } = req.body;
    stmts.toggleProjectTask.run(completed ? 1 : 0, completed ? Date.now() : null, timeSpent || 0, +req.params.id, req.params.sessionKey);
    res.json({ ok: true });
});

app.delete('/api/tasks/:sessionKey/:id', (req, res) => {
    stmts.deleteProjectTask.run(+req.params.id, req.params.sessionKey);
    res.json({ ok: true });
});

app.patch('/api/tasks/:sessionKey/:id/move', (req, res) => {
    const { projectId } = req.body;
    stmts.moveTaskToProject.run(projectId || null, +req.params.id, req.params.sessionKey);
    res.json({ ok: true });
});

app.get('/api/tasks/:sessionKey/:id', (req, res) => {
    const task = stmts.getTaskById.get(+req.params.id, req.params.sessionKey);
    if (!task) return res.status(404).json({ error: 'Not found' });
    res.json(task);
});

app.patch('/api/tasks/:sessionKey/:id/details', (req, res) => {
    const { description, dueDate, timeStart, timeEnd, media } = req.body || {};
    const safeDesc = description ? sanitizeText(description, 5000) : null;
    const safeDue = typeof dueDate === 'string' ? sanitizeText(dueDate, 32) : null;
    const safeTs  = typeof timeStart === 'string' ? sanitizeText(timeStart, 16) : null;
    const safeTe  = typeof timeEnd === 'string' ? sanitizeText(timeEnd, 16) : null;
    // Media: limit to 20 items, each name/data within reason
    let mediaJson = null;
    if (Array.isArray(media)) {
        const safeMedia = media.slice(0, 20).map(m => ({
            name: typeof m?.name === 'string' ? sanitizeText(m.name, 200) : '',
            type: m?.type === 'video' ? 'video' : 'image',
            data: typeof m?.data === 'string' && m.data.length < 2_000_000 ? m.data : ''
        })).filter(m => m.data);
        mediaJson = safeMedia.length ? JSON.stringify(safeMedia) : null;
    }
    stmts.updateTaskDetails.run(safeDesc, safeDue, safeTs, safeTe, mediaJson, +req.params.id, req.params.sessionKey);
    res.json({ ok: true });
});

// === API: Удаление аккаунта (GDPR-style "right to be forgotten") =============
// Полностью затирает все данные пользователя: задачи, проекты, доски,
// командные участия, приглашения, аватар-файл и сам user record.
// После этого sessionKey становится "чистым" — повторный заход создаст новый профиль.
const deleteAccountStmts = {
    getUser:              db.prepare('SELECT user_id, avatar FROM users WHERE session_key = ?'),
    deleteSessionData:    db.prepare('DELETE FROM session_data    WHERE session_key = ?'),
    deletePersonalBoard:  db.prepare('DELETE FROM personal_boards WHERE session_key = ?'),
    deleteProjectTasks:   db.prepare('DELETE FROM project_tasks   WHERE session_key = ?'),
    deleteProjects:       db.prepare('DELETE FROM projects        WHERE session_key = ?'),
    deleteUser:           db.prepare('DELETE FROM users           WHERE session_key = ?'),
    getUserTeams:         db.prepare('SELECT team_id FROM team_members WHERE user_id = ?'),
    deleteMyMemberships:  db.prepare('DELETE FROM team_members    WHERE user_id = ?'),
    countTeamMembers:     db.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?'),
    deleteTeam:           db.prepare('DELETE FROM teams           WHERE id = ?'),
    deleteTeamBoard:      db.prepare('DELETE FROM team_boards     WHERE team_id = ?'),
    deleteAllTeamMembers: db.prepare('DELETE FROM team_members    WHERE team_id = ?'),
    deleteMyInvitations:  db.prepare('DELETE FROM invitations     WHERE from_user_id = ? OR to_user_id = ?'),
};
app.delete('/api/account/:sessionKey', (req, res) => {
    const { sessionKey } = req.params;
    const user = deleteAccountStmts.getUser.get(sessionKey);
    if (!user) return res.status(404).json({ error: 'not_found' });

    // Удаляем аватар-файл с диска ДО удаления записи
    if (user.avatar && user.avatar.startsWith('/uploads/avatars/')) {
        const abs = path.join(UPLOADS_DIR, user.avatar.replace(/^\/uploads\//, ''));
        if (abs.startsWith(AVATARS_DIR) && fs.existsSync(abs)) {
            try { fs.unlinkSync(abs); } catch (_) {}
        }
    }

    // Атомарная транзакция
    const tx = db.transaction(() => {
        // 1. Команды: если я был единственным членом → удалить команду целиком
        const teams = deleteAccountStmts.getUserTeams.all(user.user_id);
        deleteAccountStmts.deleteMyMemberships.run(user.user_id);
        for (const { team_id } of teams) {
            const left = deleteAccountStmts.countTeamMembers.get(team_id).c;
            if (left === 0) {
                deleteAccountStmts.deleteAllTeamMembers.run(team_id);
                deleteAccountStmts.deleteTeamBoard.run(team_id);
                deleteAccountStmts.deleteTeam.run(team_id);
            }
        }
        // 2. Приглашения (входящие + исходящие)
        deleteAccountStmts.deleteMyInvitations.run(user.user_id, user.user_id);
        // 3. Данные сессии
        deleteAccountStmts.deletePersonalBoard.run(sessionKey);
        deleteAccountStmts.deleteProjectTasks.run(sessionKey);
        deleteAccountStmts.deleteProjects.run(sessionKey);
        deleteAccountStmts.deleteSessionData.run(sessionKey);
        // 4. Сам пользователь
        deleteAccountStmts.deleteUser.run(sessionKey);
    });

    try {
        tx();
    } catch (e) {
        log.error('Account delete failed:', e);
        return res.status(500).json({ error: 'delete_failed' });
    }

    // Уведомить оставшихся участников команд об изменениях (после tx чтобы не подвешиваться на ws)
    // (опускаем — clients их получат при следующем запросе)

    // Закрыть все WS-соединения этого sessionKey
    if (connections.has(sessionKey)) {
        for (const client of connections.get(sessionKey)) {
            try {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'account_deleted' }));
                    client.close(1000, 'account deleted');
                }
            } catch (_) {}
        }
        connections.delete(sessionKey);
    }
    log.info('Account deleted');
    res.json({ ok: true });
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

// Rate limiting для WebSocket: только для обычных сообщений, не для real-time событий
const wsRateLimit = new Map(); // ip -> { count, resetAt }
function checkWsRateLimit(ip, isRealtime) {
    if (isRealtime) return true; // cursor/live throttle на клиенте, сервер не ограничивает
    const now = Date.now();
    const entry = wsRateLimit.get(ip);
    if (!entry || now > entry.resetAt) {
        wsRateLimit.set(ip, { count: 1, resetAt: now + 60000 });
        return true;
    }
    if (entry.count >= 300) return false;
    entry.count++;
    return true;
}
// Чистим старые записи каждые 5 минут
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of wsRateLimit) {
        if (now > entry.resetAt) wsRateLimit.delete(ip);
    }
}, 300000);

// Отправить сообщение конкретному пользователю по sessionKey
function notifyUser(sessionKey, message) {
    if (!connections.has(sessionKey)) return;
    const msg = JSON.stringify(message);
    connections.get(sessionKey).forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

// === APPS DETECTION CACHE — per-session snapshot of running apps from agent ===
// appsCache: sessionKey -> { apps: [{process,title,match,...}], ts }
const appsCache = new Map();
// listsCache: sessionKey -> { whiteList, blackList, ts }
const listsCache = new Map();
// Cleanup stale entries every 30 min
setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of appsCache) if (v.ts < cutoff) appsCache.delete(k);
    for (const [k, v] of listsCache) if (v.ts < cutoff) listsCache.delete(k);
}, 30 * 60 * 1000);

// === КОМАНДНАЯ ДОСКА ===
// boardSessions: teamId -> Map<ws, {username, userId}>
const boardSessions = new Map();

function boardBroadcast(teamId, message, excludeWs = null) {
    const members = boardSessions.get(teamId);
    if (!members) return;
    const msg = JSON.stringify(message);
    for (const [ws] of members) {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

function handleBoardJoin(ws, data) {
    const { sessionKey, username, color } = data;
    if (!sessionKey || !username) return;

    const user = stmts.getUserBySession.get(sessionKey);
    if (!user) { console.log(`[Board] board_join: user not found for sessionKey=${sessionKey}`); return; }
    const team = stmts.getUserTeam.get(user.user_id);
    if (!team) { console.log(`[Board] board_join: no team for user=${user.user_id} (${username})`); return; }
    console.log(`[Board] board_join: user=${username} teamId=${team.id}`);

    // Defensive: if this ws was already in some other team, evict from there first
    if (ws._boardTeamId && ws._boardTeamId !== team.id && boardSessions.has(ws._boardTeamId)) {
        const prev = boardSessions.get(ws._boardTeamId);
        prev.delete(ws);
        if (prev.size === 0) boardSessions.delete(ws._boardTeamId);
    }

    const teamId = team.id;
    ws._boardTeamId = teamId;
    ws._boardUsername = username;
    ws._boardUserId = user.user_id;
    ws._boardColor = color || null;

    if (!boardSessions.has(teamId)) boardSessions.set(teamId, new Map());
    boardSessions.get(teamId).set(ws, { username, userId: user.user_id, color: ws._boardColor });

    // Отправляем текущее состояние доски
    const row = stmts.getTeamBoard.get(teamId);
    const boardData = row ? JSON.parse(row.data) : { cards: [], connections: [] };
    ws.send(JSON.stringify({ type: 'board_init', data: boardData }));

    // Отправляем список онлайн участников с цветами
    const online = [];
    for (const [, info] of boardSessions.get(teamId)) online.push({ username: info.username, userId: info.userId, color: info.color });
    boardBroadcast(teamId, { type: 'board_online', users: online });
}

// Cheap membership re-check — guards against ws hijack / kicked-while-connected
const checkMembershipStmt = db.prepare('SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ?');
function wsStillInTeam(ws) {
    if (!ws._boardTeamId || !ws._boardUserId) return false;
    const row = checkMembershipStmt.get(ws._boardTeamId, ws._boardUserId);
    return !!row;
}

function handleBoardUpdate(ws, data) {
    const teamId = ws._boardTeamId;
    if (!teamId) return;
    // Persistence path — verify the user still belongs to this team
    if (!wsStillInTeam(ws)) {
        console.warn(`[Board] board_update rejected for user ${ws._boardUserId} → team ${teamId}: no longer a member`);
        return;
    }
    if (!data || typeof data.data !== 'object' || data.data === null) return;

    const now = Date.now();
    const json = JSON.stringify(data.data);
    if (json.length > 4_000_000) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'Board too large' }));
        return;
    }
    stmts.upsertTeamBoard.run(teamId, json, now, json, now);

    boardBroadcast(teamId, {
        type: 'board_update',
        data: data.data,
        from: ws._boardUsername
    }, ws);
}

function handleBoardLive(ws, data) {
    const teamId = ws._boardTeamId;
    if (!teamId) return;
    // Просто пробрасываем патч всем кроме отправителя — не сохраняем в БД
    boardBroadcast(teamId, {
        type: 'board_live',
        cardId: data.cardId,
        patch: data.patch,
        from: ws._boardUsername
    }, ws);
}

function handleBoardConnPreview(ws, data) {
    const teamId = ws._boardTeamId;
    if (!teamId) return;
    boardBroadcast(teamId, {
        type: 'board_conn_preview',
        userId: ws._boardUserId,
        color: ws._boardColor,
        fromCardId: data.fromCardId, // null = отменили
        x: data.x,
        y: data.y
    }, ws);
}

function handleBoardSel(ws, data) {
    const teamId = ws._boardTeamId;
    if (!teamId) return;
    boardBroadcast(teamId, {
        type: 'board_sel',
        userId: ws._boardUserId,
        username: ws._boardUsername,
        color: ws._boardColor,
        cardId: data.cardId
    }, ws);
}

function handleBoardColor(ws, data) {
    const teamId = ws._boardTeamId;
    if (!teamId) return;
    ws._boardColor = data.color;
    const members = boardSessions.get(teamId);
    if (members && members.has(ws)) members.get(ws).color = data.color;
    // Рассылаем обновлённый список онлайн
    const online = [];
    for (const [, info] of members) online.push({ username: info.username, userId: info.userId, color: info.color });
    boardBroadcast(teamId, { type: 'board_online', users: online });
}

function handleBoardCursorLeave(ws) {
    const teamId = ws._boardTeamId;
    if (!teamId) return;
    boardBroadcast(teamId, {type:'board_cursor_leave', userId:ws._boardUserId}, ws);
}

function handleBoardCursor(ws, data) {
    const teamId = ws._boardTeamId;
    if (!teamId) { wsLog.debug('board_cursor without teamId (not joined)'); return; }
    // Cursor logs were extremely noisy — gated to debug-only now
    boardBroadcast(teamId, {
        type: 'board_cursor',
        username: ws._boardUsername,
        userId: ws._boardUserId,
        color: ws._boardColor,
        x: data.x,
        y: data.y
    }, ws);
}

// Очищаем при отключении — см. ws.on('close') ниже

// Обработка upgrade — с проверкой Origin (anti-CSWSH)
// Allowlist совпадает с CORS-ом плюс null/undefined для Electron/desktop клиентов
const WS_ALLOWED_ORIGINS = new Set([
    'https://linktime.go-tit.ru',
    'http://localhost:3002',
    'http://127.0.0.1:3002',
]);
server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    // Electron renderers и desktop-agent — без Origin header. Разрешаем.
    // Browser — origin обязательно должен быть в allowlist.
    if (origin && !WS_ALLOWED_ORIGINS.has(origin)) {
        wsLog.warn('WS rejected — bad origin:', origin, 'ip:', request.socket.remoteAddress);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws, request) => {
    let currentSessionKey = null;
    const clientIp = request.headers['x-forwarded-for']?.split(',')[0].trim() || request.socket.remoteAddress || 'unknown';

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch { return; }
        const isCursor = data.type === 'board_cursor';
        const isLive = data.type === 'board_live';
        if (!checkWsRateLimit(clientIp, isCursor || isLive)) {
            if (!isCursor && !isLive && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
            }
            return;
        }
        try {

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
                case 'board_join':
                    handleBoardJoin(ws, data);
                    break;
                case 'board_update':
                    handleBoardUpdate(ws, data);
                    break;
                case 'board_live':
                    handleBoardLive(ws, data);
                    break;
                case 'board_cursor':
                    handleBoardCursor(ws, data);
                    break;
                case 'board_cursor_leave':
                    handleBoardCursorLeave(ws);
                    break;
                case 'board_color':
                    handleBoardColor(ws, data);
                    break;
                case 'board_sel':
                    handleBoardSel(ws, data);
                    break;
                case 'board_conn_preview':
                    handleBoardConnPreview(ws, data);
                    break;
                case 'apps_snapshot':
                    handleAppsSnapshot(ws, data);
                    break;
                case 'apps_lists_update':
                    handleAppsListsUpdate(ws, data);
                    break;
                case 'apps_lists':
                    handleAppsLists(ws, data);
                    break;
                case 'request_apps_state':
                    handleRequestAppsState(ws, data);
                    break;
                case 'request_all_processes':
                    handleRequestAllProcesses(ws, data);
                    break;
                case 'all_processes':
                    handleAllProcesses(ws, data);
                    break;
            }
        } catch (error) {
            wsLog.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws);
        // Убираем из командной доски
        const teamId = ws._boardTeamId;
        if (teamId && boardSessions.has(teamId)) {
            boardSessions.get(teamId).delete(ws);
            const online = [];
            for (const [, info] of boardSessions.get(teamId)) online.push(info.username);
            boardBroadcast(teamId, { type: 'board_online', users: online });
            if (boardSessions.get(teamId).size === 0) boardSessions.delete(teamId);
        }
    });

    ws.on('error', (error) => {
        wsLog.warn('connection error:', error.message);
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

        // Рассылаем обновление таймера своей сессии
        broadcast(sessionKey, { type: 'timer_state', data: timerState }, ws);

        // Если включён шеринг времени — broadcast команде
        const user = stmts.getUserBySession.get(sessionKey);
        if (user) {
            const team = stmts.getUserTeam.get(user.user_id);
            if (team) {
                const members = stmts.getTeamMembers.all(team.id);
                const me = members.find(m => m.user_id === user.user_id);
                if (me && me.sharing_time) {
                    // Считаем завершённые сессии за сегодня (без текущей)
                    const sessionData = getSessionData(sessionKey);
                    const today = new Date().toISOString().split('T')[0];
                    const todayKey = `sessions_${today}`;
                    const todaySessions = (sessionData && sessionData.sessions && sessionData.sessions[todayKey]) || [];
                    let completedWorkMs = 0;
                    todaySessions.forEach(s => {
                        if (s.end) {
                            let dur = s.end - s.start;
                            (s.pauses || []).forEach(p => { if (p.duration) dur -= p.duration; });
                            completedWorkMs += Math.max(0, dur);
                        }
                    });

                    // Broadcast всем участникам команды (кроме себя)
                    members.forEach(m => {
                        if (m.user_id !== user.user_id) {
                            const memberUser = stmts.getUserByUserId.get(m.user_id);
                            notifyUser(memberUser.session_key, {
                                type: 'team_timer_update',
                                userId: user.user_id,
                                username: user.username,
                                avatar: user.avatar,
                                timerState: timerState,
                                completedWorkMs: completedWorkMs
                            });
                        }
                    });
                }
            }
        }

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
                // Проверяем что сессия всё ещё имеет активные подключения
                if (!connections.has(sessionKey)) return;
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
                    // Проверяем что сессия всё ещё имеет активные подключения
                    if (!connections.has(sessionKey)) return;
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

    // === APPS PROTOCOL — relay between agent and browsers in the same session ===
    // Cache last snapshot per session so a fresh browser can ask for state.
    function handleAppsSnapshot(ws, data) {
        const { sessionKey, apps } = data;
        if (!sessionKey || !Array.isArray(apps)) return;
        appsCache.set(sessionKey, { apps, ts: Date.now() });
        // Broadcast to all clients in session except the sender (agent)
        broadcast(sessionKey, { type: 'apps_snapshot', apps, from: 'agent' }, ws);
    }

    function handleAppsLists(ws, data) {
        const { sessionKey, whiteList, blackList } = data;
        if (!sessionKey) return;
        // Cache + broadcast to all browsers (agent sends this on connect)
        listsCache.set(sessionKey, {
            whiteList: Array.isArray(whiteList) ? whiteList : [],
            blackList: Array.isArray(blackList) ? blackList : [],
            ts: Date.now()
        });
        broadcast(sessionKey, {
            type: 'apps_lists',
            whiteList: listsCache.get(sessionKey).whiteList,
            blackList: listsCache.get(sessionKey).blackList,
            from: 'agent'
        }, ws);
    }

    function handleAppsListsUpdate(ws, data) {
        const { sessionKey, whiteList, blackList } = data;
        if (!sessionKey) return;
        listsCache.set(sessionKey, {
            whiteList: Array.isArray(whiteList) ? whiteList : [],
            blackList: Array.isArray(blackList) ? blackList : [],
            ts: Date.now()
        });
        // Broadcast to all clients in session (including agent, who persists to disk)
        broadcast(sessionKey, {
            type: 'apps_lists_update',
            whiteList: listsCache.get(sessionKey).whiteList,
            blackList: listsCache.get(sessionKey).blackList,
            from: 'browser'
        }, ws);
    }

    // Browser → forwarded to agent (asking it to enumerate processes)
    function handleRequestAllProcesses(ws, data) {
        const { sessionKey } = data;
        if (!sessionKey || !connections.has(sessionKey)) return;
        for (const client of connections.get(sessionKey)) {
            if (client.isAgent && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'request_all_processes' }));
                return;
            }
        }
        // No agent online — let browser know
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'all_processes', processes: [], offline: true }));
        }
    }

    // Agent → relay to browsers
    function handleAllProcesses(ws, data) {
        const { sessionKey, processes } = data;
        if (!sessionKey || !Array.isArray(processes)) return;
        broadcast(sessionKey, { type: 'all_processes', processes }, ws);
    }

    function handleRequestAppsState(ws, data) {
        const { sessionKey } = data;
        if (!sessionKey) return;
        // Send cached snapshot + lists if we have them
        const snap = appsCache.get(sessionKey);
        if (snap) ws.send(JSON.stringify({ type: 'apps_snapshot', apps: snap.apps, cached: true }));
        const lists = listsCache.get(sessionKey);
        if (lists) ws.send(JSON.stringify({ type: 'apps_lists', whiteList: lists.whiteList, blackList: lists.blackList, cached: true }));
        // Also ask the agent (if connected) to push a fresh snapshot
        if (connections.has(sessionKey)) {
            for (const client of connections.get(sessionKey)) {
                if (client.isAgent && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'request_apps_snapshot' }));
                    break;
                }
            }
        }
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
