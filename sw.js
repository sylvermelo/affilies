/* Service worker espace affilié : coquille en cache (hors-ligne), pages et
   scripts en network-first (jamais de vieille version servie quand le réseau
   existe). Même principe que la vitrine. */
const CACHE = "affilies-v2";
const COQUILLE = [
  "./", "./index.html",
  "./assets/app.js", "./assets/config.js",
  "./manifest.webmanifest", "./assets/manifest.webmanifest",
  "./assets/icons-192.png", "./assets/icons-512.png", "./assets/logo.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(COQUILLE.map((u) =>
      c.add(u).catch(() => null))))   // tolérant : jamais d'échec global
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(
    ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;           // CDNs : réseau direct
  const estNavig = e.request.mode === "navigate";
  const estScript = /\.(js|json|webmanifest)(\?|$)/.test(url.pathname);
  if (estNavig || estScript) {
    /* network-first : toujours la dernière version, cache seulement en secours */
    e.respondWith(fetch(e.request)
      .then((r) => {
        const copie = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copie)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("./index.html"))));
    return;
  }
  e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request)));
});
