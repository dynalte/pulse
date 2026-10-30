/* Service worker additionnel : Web Push (reçu même app fermée). */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Pulse', body: event.data ? event.data.text() : 'Nouveau message' };
  }
  const title = data.title || 'Pulse';
  const scope = self.registration.scope;
  const canReply = !!data.replyToken && !!data.apiUrl;
  const options = {
    body: data.body || 'Nouveau message',
    icon: scope + 'pwa-192x192.png',
    badge: scope + 'pwa-192x192.png',
    tag: data.tag || 'pulse-message',
    renotify: !!data.renotify,
    silent: !data.sound,
    timestamp: Date.now(),
    data: {
      url: scope + (data.url || '#/'),
      conversationId: data.conversationId || null,
      replyToken: data.replyToken || '',
      apiUrl: data.apiUrl || '',
      senderName: data.senderName || '',
    },
    actions: canReply
      ? [
          { action: 'reply', title: 'Répondre' },
          { action: 'read', title: 'Marquer lu' },
        ]
      : [{ action: 'open', title: 'Ouvrir' }],
  };
  event.waitUntil((async () => {
    // Ne pas doubler les notifications si l'app est réellement visible :
    // le client affiche alors son propre bandeau et joue le son. On teste la
    // visibilité de l'onglet (et non le focus de la fenêtre), sinon un onglet
    // Pulse en arrière-plan dans une fenêtre Chrome active bloquait tout.
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const appVisible = clientList.some((c) => {
      const state = c.visibilityState;
      return typeof state === 'string' ? state === 'visible' : !!c.focused;
    });
    if (appVisible && data.tag !== 'pulse-test') return;
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const info = event.notification.data || {};
  const action = event.action || 'open';
  const target = info.url || self.registration.scope;

  if (action === 'read' && info.replyToken && info.apiUrl) {
    event.waitUntil(
      fetch(`${info.apiUrl}?action=quick_read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: info.replyToken }),
      }).catch(() => undefined),
    );
    return;
  }

  if (action === 'reply' && info.replyToken) {
    const replyUrl = new URL('reply.html', self.registration.scope);
    const params = new URLSearchParams({
      t: info.replyToken,
      c: String(info.conversationId || ''),
      n: info.senderName || '',
    });
    replyUrl.hash = params.toString();
    event.waitUntil(
      (async () => {
        if (self.clients.openWindow) await self.clients.openWindow(replyUrl.href);
      })(),
    );
    return;
  }

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) {
          try {
            await client.focus();
            if ('navigate' in client && target) await client.navigate(target);
            return;
          } catch (e) {
            /* continue */
          }
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // Le client renouvellera l'abonnement à la prochaine ouverture.
  event.waitUntil(Promise.resolve());
});
