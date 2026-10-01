// TradeTracker service worker — offline app shell only.
// Never touches cross-origin requests (Google Sheets API/OAuth, Chart.js/jsPDF CDNs)
// so live sync and library loading always go straight to the network.
const CACHE_NAME = 'tradetracker-v1';
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './apple-touch-icon.png',
    './icon-32.png',
    './icon-16.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .catch(() => { /* offline shell is a nice-to-have, never block install on it */ })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // let Google APIs / CDN libs go straight to network

    if (req.mode === 'navigate') {
        // Network-first for the app shell itself, so a new push is picked up right away;
        // falls back to the last cached copy when offline.
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
                    return res;
                })
                .catch(() => caches.match('./index.html'))
        );
        return;
    }

    // Cache-first for same-origin static assets (icons, manifest).
    event.respondWith(
        caches.match(req).then((cached) => cached || fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
            return res;
        }))
    );
});
