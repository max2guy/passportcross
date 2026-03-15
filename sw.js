/* ===== FCM 백그라운드 메시지 (앱이 꺼져있을 때 푸시 수신) =====
 * Firebase Messaging은 반드시 SW 상단에 초기화해야 함
 */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCxCyx8-wtwVNmDzOUuVKdJ4kfFcw2VBpY",
  authDomain: "passport-cross.firebaseapp.com",
  projectId: "passport-cross",
  storageBucket: "passport-cross.firebasestorage.app",
  messagingSenderId: "68059868627",
  appId: "1:68059868627:web:9191ca01a05edaf055d326"
});

const messaging = firebase.messaging();

// 백그라운드 수신 → 기기 시스템 알림으로 표시
messaging.onBackgroundMessage(function(payload) {
  const d = payload.data || {};
  self.registration.showNotification(d.title || 'THE CROSS PASSPORT', {
    body: d.body || '',
    icon: './notification-icon.svg',
    badge: './notification-icon.svg',
    data: { url: self.location.origin + self.location.pathname.replace(/sw\.js$/, '') }
  });
});

// 알림 탭 → 앱 열기 (이미 열려있으면 포커스, 없으면 새 창)
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || self.location.origin;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.startsWith(self.location.origin) && 'focus' in list[i]) {
          return list[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

/* ===== 캐시 전략 ===== */
const CACHE_NAME = 'passport-cross-v90';
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
