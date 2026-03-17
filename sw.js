// ════════════════════════════════════════
//  OUR SPACE — Service Worker  v4
//  Full WhatsApp-style push: badge, banner, sound, lock screen
// ════════════════════════════════════════
const CACHE = 'our-space-v4';
const ASSETS = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json'];

self.addEventListener('install',  e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('supabase') || e.request.url.includes('fonts.gstatic')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// ── In-app notification relay ───────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (e.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, icon, badge, tag, renotify, vibrate, data, silent } = e.data;
    self.registration.showNotification(title, {
      body, icon, badge, tag, renotify,
      vibrate: vibrate || [100, 50, 100],
      silent:  silent  || false,
      data:    data    || { url: self.location.origin },
      requireInteraction: false,
    });
  }
});

// ── VAPID Push — fires even when app is FULLY CLOSED ───────────
// This is exactly how WhatsApp delivers notifications.
// The OS (Android FCM / iOS APNs) wakes the SW, which shows the banner.
self.addEventListener('push', e => {
  let payload = {
    title:  'Our Space 💛',
    body:   'New message from your babe ❤️',
    icon:   '/icon-192.png',
    badge:  '/icon-192.png',
    tag:    'our-space-msg',
    silent: false,
    data:   { url: self.location.origin },
  };

  try {
    if (e.data) payload = { ...payload, ...e.data.json() };
  } catch (_) {
    try { if (e.data) payload.body = e.data.text(); } catch (_) {}
  }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Don't show OS banner if the user is actively looking at the app
      const appFocused = clients.some(c =>
        c.url.startsWith(self.location.origin) && c.focused
      );
      if (appFocused) return;

      // Build unread count label for title
      const unread = payload.data?.unreadCount;
      const title  = unread > 1
        ? `Our Space 💛 (${unread} new)`
        : (payload.title || 'Our Space 💛');

      return self.registration.showNotification(title, {
        // ── Visible content ──────────────────────────
        body:    payload.body,

        // ── Icons ────────────────────────────────────
        // icon  = large image in notification body (Android)
        icon:    payload.icon  || '/icon-192.png',
        // badge = tiny monochrome icon in status bar (Android)
        badge:   payload.badge || '/icon-192.png',

        // ── Behaviour ────────────────────────────────
        tag:      payload.tag || 'our-space-msg',
        // renotify: play sound/vibrate again even for same tag
        renotify: true,
        // silent:false = play the device's default notification sound
        silent:   false,
        // vibrate pattern in ms: buzz, pause, buzz
        vibrate:  [100, 50, 200],

        // ── Lock screen / notification shade ─────────
        // requireInteraction:false = banner auto-dismisses (like WhatsApp)
        requireInteraction: false,

        // ── Actions (Android notification shade) ─────
        actions: [
          { action: 'open', title: '💬 Open chat' },
        ],

        // ── Data passed to notificationclick handler ─
        data: payload.data || { url: self.location.origin },
      });
    })
  );
});

// ── Notification click → focus or open app ──────────────────────
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

// ── Push subscription rotation ──────────────────────────────────
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
