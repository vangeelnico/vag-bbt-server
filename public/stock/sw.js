// Service worker: enkel de app-schil offline klaarzetten. Stockdata (API) wordt NOOIT gecachet.
const CACHE = "vag-stock-v1";
const SHELL = ["./", "app.js", "app.css", "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/stock/api/")) return; // API: altijd netwerk
  // Netwerk eerst (altijd de nieuwste versie), cache enkel als terugval.
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request)));
});
