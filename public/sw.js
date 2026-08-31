/* Daily Deck service worker: decks are network-first (a deck can be
   regenerated same-day) with cache fallback for offline; everything else
   same-origin is stale-while-revalidate so updates land on next open. */
const CACHE = "daily-deck-v2";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Daily decks: network-first, cached copy as offline fallback
  if (url.origin === location.origin && url.pathname.includes("/decks/")) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const res = await fetch(e.request);
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        } catch {
          const hit = await cache.match(e.request);
          if (hit) return hit;
          throw new Error("offline, no cached deck");
        }
      })
    );
    return;
  }

  // App shell + fonts: stale-while-revalidate
  if (url.origin === location.origin || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com")) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(e.request);
        const refresh = fetch(e.request)
          .then((res) => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
  }
});
