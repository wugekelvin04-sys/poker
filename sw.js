/* Service Worker：把全部资源预缓存，飞行模式下也能打开 */
const VERSION = 'v14';
const CACHE = 'poker-cal-' + VERSION;

// 子资源都带 ?v=VERSION，和 index.html 里的引用完全一致。
// 这样换版本时 URL 就变了，绝不会出现新 HTML 配旧 JS 的情况。
const ASSETS = [
  './',
  'index.html',
  'style.css?v=' + VERSION,
  'app.js?v=' + VERSION,
  'engine.js?v=' + VERSION,
  'sim.js?v=' + VERSION,
  'preflop.js?v=' + VERSION,
  'manifest.webmanifest?v=' + VERSION,
  'worker.js?v=' + VERSION,
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 页面本身走网络优先：联网时永远拿到最新的 HTML，它引用的
  // ?v=新版本 资源自然也是新的；断网才回落到缓存。
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // 子资源缓存优先，但必须按完整 URL（含查询串）匹配。
  // 这里如果 ignoreSearch，app.js?v=v7 会命中旧的 app.js?v=v6，
  // 就会出现新 HTML 配旧 JS 的错配。
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && new URL(req.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => new Response('', { status: 504, statusText: 'offline' }));
    })
  );
});
