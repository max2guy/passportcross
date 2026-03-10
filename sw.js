const CACHE_NAME = 'passport-cross-v77';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  // skipWaiting 제거 → 사용자 확인 후 업데이트 적용
});

// 앱에서 "업데이트" 버튼 클릭 시 메시지 수신 → 즉시 활성화
self.addEventListener('message', e => {
  if(e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 외부 도메인(Firebase, Google API, CDN 등)은 SW 개입 없이 그대로 통과
  if (url.origin !== self.location.origin) return;

  // HTML은 Network-First → 항상 최신 HTML + 새 SW 즉시 감지
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // JS/CSS/이미지 등 정적 파일은 Cache-First (빠른 로딩)
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
