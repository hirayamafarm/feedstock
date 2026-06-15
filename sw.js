// まきば在庫 - Service Worker
// 戦略:
//   - index.html / ナビゲーションは「ネットワーク優先」（常に最新を表示。オフライン時のみキャッシュ）
//   - アイコン等の静的ファイルはキャッシュ優先
//   - Supabaseデータは常にネットワーク（キャッシュしない）
//
// CACHE_VERSION を変えると、古いキャッシュは activate 時に全削除される。
// コードを大きく更新したらこの数字を上げる。
const CACHE_VERSION = "makiba-v2";
const CACHE_FILES = [
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CACHE_FILES))
      .then(() => self.skipWaiting())   // すぐ新SWを有効化
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())  // 既存タブもすぐ新SW管理下に
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Supabaseのデータ取得・保存は常にネットワーク（キャッシュしない）
  if (url.hostname.includes("supabase.co")) return;

  // CDN（React/Babel/SheetJSなど）はネットワーク優先（失敗時キャッシュ）
  if (
    url.hostname.includes("unpkg.com") ||
    url.hostname.includes("cdn.jsdelivr.net") ||
    url.hostname.includes("cdnjs.cloudflare.com") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("gstatic.com")
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

  // HTML / ナビゲーション（アプリ本体）は「ネットワーク優先」
  // 常に最新の index.html を表示する。オフライン時のみキャッシュにフォールバック。
  const isHTML = e.request.mode === "navigate" ||
    (e.request.destination === "document") ||
    url.pathname.endsWith("/") || url.pathname.endsWith("index.html");
  if (isHTML) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // その他の静的ファイル（アイコン等）はキャッシュ優先
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }))
  );
});
