// まきば在庫 - Service Worker
// 戦略: アプリ本体(index.html)とアイコンはキャッシュファースト
// データは常にネットワーク(Supabaseに直接)

const CACHE_VERSION = "makiba-v1";
const CACHE_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CACHE_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Supabaseのデータ取得・保存は常にネットワークから(キャッシュしない)
  if (url.hostname.includes("supabase.co")) return;

  // CDN(React/Babel/SheetJSなど)もネットワーク優先(失敗時はキャッシュ)
  if (
    url.hostname.includes("unpkg.com") ||
    url.hostname.includes("cdn.jsdelivr.net") ||
    url.hostname.includes("cdnjs.cloudflare.com") ||
    url.hostname.includes("googleapis.com")
  ) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // アプリ自身はキャッシュ優先（オフラインでも開ける）
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) {
        // バックグラウンドで最新版も取得しておく
        fetch(e.request).then((res) => {
          if (res && res.ok) {
            caches.open(CACHE_VERSION).then((c) => c.put(e.request, res));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(e.request);
    })
  );
});
