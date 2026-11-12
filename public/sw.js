// Service Worker: macht das Spiel offline spielbar.
// Beim Installieren wird die Startseite gespeichert; alles, was das Spiel danach lädt (Skripte, Modelle, Symbole),
// landet beim ersten Laden automatisch im Speicher. Ab dann startet das Spiel auch ohne Internet.
// Neue Versionen: Die Startseite wird bei Verbindung immer frisch geholt (und gespeichert); die Dateien darin haben
// eindeutige Namen (Vite-Hash), alte Versionen werden beim nächsten Wechsel aufgeräumt.
const CACHE = 'gipfelsturm-v5';
const CORE = ['./', './index.html', './manifest.webmanifest', './models/models.glb', './icons/icon-192.png', './icons/icon-512.png', './icons/icon.svg'];

// Beim Installieren auch die gehashten Skripte und Stile aus index.html holen: Beim allerersten Besuch lädt die Seite
// diese, bevor der Service Worker aktiv ist – ohne diesen Schritt fehlten sie offline.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE);
    const html = await (await fetch('./index.html', { cache: 'no-cache' })).text();
    const assets = [...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map((m) => m[1]);
    await c.addAll(assets);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Seitenaufruf: erst Netz (neueste Version), sonst gespeicherte Startseite
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./index.html', copy)); return res; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  // Modelle: Netz zuerst (damit neue Modelle ankommen), offline aus dem Speicher
  if (req.url.endsWith('.glb')) {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req)));
    return;
  }
  // Alles andere (gehashte Skripte, Bilder): aus dem Speicher, sonst laden und speichern
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
