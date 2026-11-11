/* Le Fil · service worker
 * - la page s'ouvre tout de suite, même sans réseau : on montre la dernière version enregistrée
 *   si le réseau tarde plus de 2,5 s (la nouvelle version est prise au passage pour la fois suivante) ;
 * - icônes, manifeste et polices sont gardés en mémoire ;
 * - les relevés (/rss, /date, /sync…) ne passent jamais par ce cache : toujours en direct. */
const CACHE = "lefil-21";
const SHELL = ["/", "/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png"];
const DIRECT = /^\/(rss|date|sync|sante|veille|notif-test|fil|direct|push|recherche)\b/;
const POLICES = /^https:\/\/fonts\.(googleapis|gstatic)\.com$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith("lefil-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    if (DIRECT.test(u.pathname)) return;
    if (req.mode === "navigate") { e.respondWith(page(e)); return; }
    if (u.pathname === "/le-fil-modele.apkg") return;
    e.respondWith(caches.match(req).then(m => m || fetch(req)));
  } else if (POLICES.test(u.origin)) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const m = await c.match(req);
      if (m) return m;
      const r = await fetch(req);
      if (r.ok || r.type === "opaque") c.put(req, r.clone());
      return r;
    }));
  }
});
async function page(e) {
  const c = await caches.open(CACHE);
  const net = fetch(e.request).then(r => { if (r.ok) c.put("/", r.clone()); return r; });
  e.waitUntil(net.then(() => {}, () => {}));         // la mise à jour de la copie continue en arrière-plan
  const copie = await c.match("/");
  if (!copie) return net;
  return Promise.race([
    net.catch(() => copie),
    new Promise(res => setTimeout(() => res(copie), 2500)),
  ]);
}

/* Notifications push envoyées par le serveur (infos majeures), même Le Fil fermé. */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {texte: e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.titre || "Le Fil", {
    body: d.texte || "", icon: "/icon-192.png", badge: "/icon-192.png", lang: "fr",
    tag: d.tag || undefined, renotify: !!d.tag, data: {lien: d.lien || "/"},
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const lien = (e.notification.data && e.notification.data.lien) || "/";
  e.waitUntil(clients.openWindow(lien));
});
