// ═══════════════════════════════════════════════════
// SERVICE WORKER — Легкий Словарь PWA
// Стратегия: Cache First для статики, Network First для API
// ═══════════════════════════════════════════════════

const VERSION    = 'slovar-v3';
const CACHE_STATIC  = `${VERSION}-static`;
const CACHE_DYNAMIC = `${VERSION}-dynamic`;

const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/app.js',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=Outfit:wght@300;400;500;600;700&display=swap',
];

// ── Установка: кешируем всю статику ──────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_STATIC)
            .then(cache => cache.addAll(STATIC_ASSETS.map(url => new Request(url, { mode: 'cors' })))
                .catch(err => console.warn('[SW] Some assets failed to cache:', err))
            )
            .then(() => self.skipWaiting())
    );
});

// ── Активация: чистим старые кеши ────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(k => k !== CACHE_STATIC && k !== CACHE_DYNAMIC)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ── Fetch: умная стратегия ───────────────────────────
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // API запросы — Network First, fallback null
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirst(request));
        return;
    }

    // Google Fonts — Cache First (долгоживущие)
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
        event.respondWith(cacheFirst(request, CACHE_DYNAMIC));
        return;
    }

    // Всё остальное (HTML, JS, иконки) — Cache First, обновляем в фоне
    if (request.method === 'GET') {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }
});

// ── Стратегии ────────────────────────────────────────

// Cache First: отдаём из кеша, если нет — идём в сеть
async function cacheFirst(request, cacheName = CACHE_STATIC) {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        return new Response('Нет соединения', { status: 503 });
    }
}

// Network First: сначала сеть, при ошибке — кеш
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_DYNAMIC);
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        const cached = await caches.match(request);
        return cached || new Response(JSON.stringify({ error: 'offline' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 503
        });
    }
}

// Stale While Revalidate: отдаём кеш мгновенно, обновляем в фоне
async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_STATIC);
    const cached = await cache.match(request);

    const fetchPromise = fetch(request)
        .then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
        })
        .catch(() => null);

    return cached || await fetchPromise || new Response('Offline', { status: 503 });
}

// ── Push уведомления (будущее) ───────────────────────
self.addEventListener('push', event => {
    if (!event.data) return;
    const data = event.data.json();
    self.registration.showNotification(data.title || 'Легкий Словарь', {
        body: data.body || 'Время повторить слова!',
        icon: '/icon-192.png',
        badge: '/icon-96.png',
        tag: 'review-reminder',
        renotify: true,
    });
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(clients.openWindow('/'));
});