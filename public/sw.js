// =============================================================================
// LinkTime Service Worker
// Cache strategy:
//   • Shell (HTML/CSS/JS/fonts/icons) → cache-first, refreshed in background
//   • API GET → network-first, cache fallback (so dashboard works offline with stale data)
//   • API non-GET → never cached, never fallback (writes go through or fail loud)
//   • WebSocket / Range / non-GET → bypass
// =============================================================================

const VERSION = 'linktime-v7-2026-06-07-2';
const SHELL_CACHE = 'shell-' + VERSION;
const DATA_CACHE = 'data-' + VERSION;
const FONT_CACHE = 'fonts-' + VERSION;

const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/dashboard-init.js',
    '/board.html',
    '/board.js',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
];

// === INSTALL ===
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // addAll is atomic — if any fail, none commit
        await Promise.all(SHELL_ASSETS.map(async (url) => {
            try {
                const res = await fetch(url, { cache: 'reload' });
                if (res.ok) await cache.put(url, res.clone());
            } catch (_) {
                // Best-effort precache
            }
        }));
        self.skipWaiting();
    })());
});

// === ACTIVATE — clean up old caches ===
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter(k => k !== SHELL_CACHE && k !== DATA_CACHE && k !== FONT_CACHE)
                .map(k => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

// === FETCH ===
self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);

    // Bypass non-GET
    if (req.method !== 'GET') return;
    // Bypass cross-origin except fonts CDN
    if (url.origin !== self.location.origin) {
        if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
            event.respondWith(fontFirst(req));
        }
        return;
    }
    // Bypass websocket upgrade (shouldn't even reach SW)
    if (req.headers.get('upgrade') === 'websocket') return;
    // Bypass range requests (video streaming)
    if (req.headers.get('range')) return;

    // API: network-first, cache fallback
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirst(req, DATA_CACHE));
        return;
    }

    // Uploaded files (avatars/media): cache-first
    if (url.pathname.startsWith('/uploads/')) {
        event.respondWith(cacheFirst(req, DATA_CACHE));
        return;
    }

    // Shell: cache-first with background revalidate
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

// === STRATEGIES ===

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    // ignoreSearch so `/board.html?sessionKey=…` resolves against cached `/board.html`
    const cached = await cache.match(request, { ignoreSearch: true });
    const networkPromise = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
    }).catch(() => null);
    return cached || (await networkPromise) || new Response(
        '<!doctype html><meta charset=utf-8><title>Offline</title>' +
        '<style>body{font-family:system-ui;background:#15120f;color:#ece7da;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}h1{font-weight:300}p{opacity:.7}</style>' +
        '<div><h1>Сервер недоступен</h1><p>Запустите <code>node server.js</code> и обновите страницу.</p></div>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}

async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch (_) {
        const cached = await cache.match(request);
        if (cached) {
            // Mark stale data with a header for the client
            const headers = new Headers(cached.headers);
            headers.set('X-LinkTime-Cache', 'stale');
            return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
        }
        return new Response(JSON.stringify({ error: 'offline', offline: true }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'X-LinkTime-Cache': 'miss' }
        });
    }
}

async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch (_) {
        return new Response('', { status: 504 });
    }
}

async function fontFirst(request) {
    const cache = await caches.open(FONT_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
    } catch (_) {
        return new Response('', { status: 504 });
    }
}

// === MESSAGE HANDLER === (for forced refresh from client)
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') self.skipWaiting();
    if (event.data === 'clearCache') {
        event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
    }
});
