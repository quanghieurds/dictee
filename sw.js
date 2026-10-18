// Service worker: cho app mở được khi không có mạng sau lần mở đầu.
// File của app: lấy bản mới từ mạng khi có, mất mạng thì dùng bản đã lưu.
// Font Google: lưu lại một lần rồi dùng mãi. Bộ nhận dạng giọng nói tự lưu riêng nên bỏ qua.
const VERSION = 'dictee-v4';
const APP_FILES = [
  './', 'index.html', 'styles.css', 'i18n.js', 'core.js', 'lessons-builtin.js', 'audio.js', 'app.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dictee-') && k !== VERSION && k !== 'dictee-fonts').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Dùng bản đã lưu khi mất mạng HOẶC khi máy chủ báo lỗi (vd trang GitHub bị xóa → 404),
    // để app đã cài vẫn chạy tiếp.
    const fromCache = () => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'));
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
            return res;
          }
          return fromCache().then((r) => r || res);
        })
        .catch(fromCache),
    );
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open('dictee-fonts').then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      }))),
    );
  }
});
