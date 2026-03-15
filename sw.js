// ════════════════════════════════════════
//  OUR SPACE — Service Worker  v3
//  Offline cache + VAPID push notifications
// ════════════════════════════════════════
const CACHE = 'our-space-v3';
const ASSETS = [
  '/', '/index.html', '/app.js', '/style.css', '/manifest.json',
  '/icon-192.png', '/icon-512.png'
];

// ── Install ────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      c.addAll(ASSETS.filter(a => !a.endsWith('.png')))
    )
  );
  self.skipWaiting();
});

// ── Activate ───────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ──────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
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

// ── In-app notification (from app via postMessage) ─
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, icon, badge, tag, renotify, data } = e.data;
    self.registration.showNotification(title, {
      body, icon, badge, tag, renotify,
      vibrate: [100, 50, 100],
      data: data || { url: self.location.origin },
      requireInteraction: false,
    });
  }
});

// ── VAPID Push ─────────────────────────────────
// Fires even when the app is CLOSED or in background.
// Same mechanism WhatsApp uses.
self.addEventListener('push', e => {
  let payload = {
    title: 'Our Space 💛',
    body: 'New message from your babe ❤️',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'our-space-msg',
    data: { url: self.location.origin },
  };

  try {
    if (e.data) {
      const received = e.data.json();
      payload = { ...payload, ...received };
    }
  } catch (err) {
    try { if (e.data) payload.body = e.data.text(); } catch (_) {}
  }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const appFocused = clients.some(c =>
        c.url.startsWith(self.location.origin) && c.focused
      );
      if (appFocused) return; // App is open and focused — skip OS banner

      return self.registration.showNotification(payload.title, {
        body:               payload.body,
        icon:               payload.icon  || '/icon-192.png',
        badge:              payload.badge || '/icon-192.png',
        tag:                payload.tag   || 'our-space-msg',
        renotify:           true,
        vibrate:            [100, 50, 100, 50, 100],
        requireInteraction: false,
        data:               payload.data || { url: self.location.origin },
        actions:            [{ action: 'open', title: 'Open' }],
      });
    })
  );
});

// ── Notification click ─────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || self.location.origin;

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.startsWith(self.location.origin));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: 'NOTIFICATION_CLICK' });
        return;
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

// ── Push subscription rotation (iOS/Chrome may do this) ──
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: e.oldSubscription?.options?.applicationServerKey,
    }).then(sub => {
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({
          type: 'PUSH_SUBSCRIPTION_CHANGED',
          subscription: sub.toJSON(),
        }));
      });
    }).catch(() => {})
  );
});
