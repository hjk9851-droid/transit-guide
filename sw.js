// 대중교통 안내 앱 — Service Worker
// 오프라인에서도 열리게 파일을 저장해 둡니다.

const CACHE = 'bus-guide-v2';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon.svg',
];

// 설치: 핵심 파일 캐시에 저장
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 활성화: 이전 캐시 삭제
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 네트워크 요청: 캐시 우선, 없으면 네트워크
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
      )
      .catch(() => caches.match('./index.html'))
  );
});
