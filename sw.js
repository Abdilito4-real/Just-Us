// ════════════════════════════════════════
//  OUR SPACE — Service Worker
//  Handles: offline cache + push notifications
// ════════════════════════════════════════
const CACHE = 'our-space-v2';
const ASSETS = [
  '/', '/index.html', '/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png'
];

// ── Install: pre-cache static assets ──────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS.filter(a => !a.endsWith('.png'))))
  );
  self.skipWaiting();
});

// ── Activate: clear old caches ─────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first, fallback to cache ────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Don't cache Supabase API or CDN calls
  if (e.request.url.includes('supabase') || e.request.url.includes('fonts.gstatic')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Message: show notification from app ────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, icon, badge, tag, renotify } = e.data;
    self.registration.showNotification(title, {
      body, icon, badge, tag, renotify,
      vibrate: [100, 50, 100],
      data: { url: self.location.origin },
    });
  }
});

// ── Push: handle server-sent push events ───────
// (Only needed if you add a push server / VAPID backend)
self.addEventListener('push', e => {
  let payload = { title: 'Our Space 💛', body: 'New message from your babe ❤️' };
  try { if (e.data) payload = { ...payload, ...e.data.json() }; } catch(err) {}
  e.waitUntil(
    self.registration.showNotification(payload.title, {
      body:    payload.body,
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     'our-space-msg',
      renotify: true,
      vibrate: [100, 50, 100],
      data: { url: self.location.origin },
    })
  );
});

// ── Notification click: focus or open app ──────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.startsWith(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow(e.notification.data?.url || self.location.origin);
    })
  );
});
