const CACHE_NAME = 'farmanorte-pharmacy-shell-v6';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('farmanorte-pharmacy-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('push', (event) => {
  let envelope = {};
  try {
    envelope = event.data ? event.data.json() : {};
  } catch (_) {
    envelope = { body: event.data?.text() || 'Hay una actualización en la operación.' };
  }
  // Supabase envía el contenido como { title, body, data }. Conservamos también
  // las claves antiguas de primer nivel para que ninguna alerta quede sin ruta.
  const data = {
    ...(envelope.data && typeof envelope.data === 'object' ? envelope.data : {}),
    ...envelope,
  };
  const title = envelope.title || (data.type === 'chat_message'
    ? 'Nuevo mensaje en el domicilio'
    : 'Nuevo domicilio disponible');
  const options = {
    body: envelope.body || 'Revisa la operación de tu farmacia.',
    icon: `${self.registration.scope}farmanorte-icon.png`,
    badge: `${self.registration.scope}farmanorte-icon.png`,
    tag: data.delivery_id ? `farmanorte-${data.delivery_id}` : 'farmanorte-operation',
    renotify: true,
    requireInteraction: data.type === 'delivery',
    data,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map((client) => client.postMessage({ type: 'farmanorte-pushsubscriptionchange' })));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(self.registration.scope);
  if (data.delivery_id) target.searchParams.set('delivery', data.delivery_id);
  if (data.open_chat === true || data.open_chat === 'true' || data.open_chat === 1) target.searchParams.set('chat', '1');
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const current = windows.find((client) => 'focus' in client);
    if (current) {
      await current.focus();
      if ('navigate' in current) await current.navigate(target.href);
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // La PWA de domiciliarios (/courier/) tiene su propio ciclo de versiones y
  // archivos sin huella (main.dart.js): nunca se sirve desde esta caché.
  if (url.pathname.includes('/courier/')) return;

  if (request.mode === 'navigate') {
    // Primero la red, para que cada publicación se vea al abrir la página. La
    // copia guardada solo se usa sin conexión.
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      } catch (_) {
        return (await caches.match(request)) || Response.error();
      }
    })());
    return;
  }

  // Los archivos de Vite llevan huella en el nombre (index-AbC123.js): son
  // inmutables y pueden salir de la caché. El resto se pide a la red.
  const fingerprinted = /\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(js|css|woff2?|png|svg|jpg|webp)$/.test(url.pathname);
  if (!fingerprinted) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    }),
  );
});
