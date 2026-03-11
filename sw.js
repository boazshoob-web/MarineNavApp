// Service Worker — Maritime navigation assist App
// Cache version: bump this to force re-cache after code changes
var CACHE_VERSION = 'v6';
var SHELL_CACHE  = 'shell-' + CACHE_VERSION;
var CDN_CACHE    = 'cdn-' + CACHE_VERSION;
var TILE_CACHE   = 'tiles-v1';

// App shell files to pre-cache on install
var SHELL_FILES = [
    './',
    './index.html',
    './manifest.json'
];

// CDN resources to cache on first fetch
var CDN_ORIGINS = [
    'unpkg.com'
];

// Tile origins — cache-first strategy
var TILE_ORIGINS = [
    'basemaps.cartocdn.com',
    'tiles.emodnet-bathymetry.eu',
    'wms.gebco.net',
    'tiles.openseamap.org',
    'depth.openseamap.org'
];

// API origins — network-first strategy (will be used in Phase 2)
var API_ORIGINS = [
    'api.open-meteo.com',
    'marine-api.open-meteo.com'
];

// ---- Install: pre-cache app shell ----
self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(SHELL_CACHE).then(function (cache) {
            return cache.addAll(SHELL_FILES);
        }).then(function () {
            return self.skipWaiting();
        })
    );
});

// ---- Activate: clean old caches ----
self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names.filter(function (name) {
                    // Remove old shell/cdn caches but keep tile cache
                    if (name.startsWith('shell-') && name !== SHELL_CACHE) return true;
                    if (name.startsWith('cdn-') && name !== CDN_CACHE) return true;
                    return false;
                }).map(function (name) {
                    return caches.delete(name);
                })
            );
        }).then(function () {
            return self.clients.claim();
        })
    );
});

// ---- Fetch: routing strategy per origin ----
self.addEventListener('fetch', function (event) {
    var url = new URL(event.request.url);

    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    // 1) Tile requests → cache-first
    if (isTileRequest(url)) {
        event.respondWith(cacheFirst(event.request, TILE_CACHE));
        return;
    }

    // 2) CDN resources (Leaflet JS/CSS) → cache-first
    if (isCdnRequest(url)) {
        event.respondWith(cacheFirst(event.request, CDN_CACHE));
        return;
    }

    // 3) API requests → network-first (Phase 2 will enhance this)
    if (isApiRequest(url)) {
        event.respondWith(networkFirst(event.request, SHELL_CACHE));
        return;
    }

    // 4) App shell (same-origin HTML/manifest) → network-first
    if (url.origin === self.location.origin) {
        event.respondWith(networkFirst(event.request, SHELL_CACHE));
        return;
    }

    // 5) Everything else → passthrough (no caching)
});

// ---- Strategies ----

function cacheFirst(request, cacheName) {
    return caches.open(cacheName).then(function (cache) {
        return cache.match(request).then(function (cached) {
            if (cached) return cached;
            return fetch(request).then(function (response) {
                if (response.ok) {
                    cache.put(request, response.clone());
                }
                return response;
            });
        });
    }).catch(function () {
        return new Response('', { status: 503, statusText: 'Offline' });
    });
}

function networkFirst(request, cacheName) {
    return fetch(request).then(function (response) {
        if (response.ok) {
            var clone = response.clone();
            caches.open(cacheName).then(function (cache) {
                cache.put(request, clone);
            });
        }
        return response;
    }).catch(function () {
        return caches.match(request).then(function (cached) {
            return cached || new Response('', { status: 503, statusText: 'Offline' });
        });
    });
}

// ---- Origin matchers ----

function isTileRequest(url) {
    return TILE_ORIGINS.some(function (origin) {
        return url.hostname.indexOf(origin) !== -1;
    });
}

function isCdnRequest(url) {
    return CDN_ORIGINS.some(function (origin) {
        return url.hostname.indexOf(origin) !== -1;
    });
}

function isApiRequest(url) {
    return API_ORIGINS.some(function (origin) {
        return url.hostname.indexOf(origin) !== -1;
    });
}
