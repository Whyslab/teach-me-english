const CACHE_NAME = 'slovar-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/app.js',
    '/manifest.json',
    '/favicon.ico'
];

// Установка — кешируем статику
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS).catch(() => {});
        })
    );
    self.skipWaiting();
});

// Активация — чистим старые кеши
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

// Fetch — игнорируем chrome-extension и нестандартные схемы
self.addEventListener('fetch', (event) => {
    const rawUrl = event.request.url;

    // Обрабатываем ТОЛЬКО http/https — chrome-extension и прочее игнорируем
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) return;

    const url = new URL(rawUrl);

    // API запросы — только сеть, не кешировать
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request).catch(() => new Response('offline', { status: 503 }))
        );
        return;
    }

    // Статика — сначала кеш, потом сеть
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
                }
                return response;
            }).catch(() => cached || new Response('offline', { status: 503 }));
        })
    );
});