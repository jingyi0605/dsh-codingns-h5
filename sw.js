/*
 * Codingns4DSH H5 引导页 Service Worker。
 *
 * 设计边界（务必保持）：
 * - 只缓存同源的应用壳（HTML/CSS/JS/图标/manifest）。
 * - 绝不缓存控制站 API（/api/*）、跨域信令与 TURN 请求，也不缓存非 GET 请求。
 *   远程 DSH Web 的 boot、脚本、样式全部经加密 DataChannel（web.asset.get）下发，
 *   不经过 HTTP，因此不受本 SW 影响。
 * - 缓存失败绝不能影响功能：所有 cache 操作都做了容错，失败时直接走网络。
 */

const CACHE_VERSION = "codingns4dsh-h5-v1";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

// 应用壳：离线时至少能打开登录页并给出明确提示。
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/config.js",
  "/pwa.js",
  "/runtime.js",
  "/app.js",
  "/logo.svg",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个 add，单个资源失败（例如某个图标被改名）不应让整个安装失败。
      await Promise.all(
        SHELL_ASSETS.map((asset) =>
          cache.add(new Request(asset, { cache: "reload" })).catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

/** 控制站 API、鉴权与跨域请求一律不介入。 */
function isBypassed(request, url) {
  if (request.method !== "GET") return true;
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith("/api/")) return true;
  return false;
}

/**
 * 离线兜底查找：先精确匹配，再忽略查询串匹配。
 * 应用壳资源带有 ?v= 版本号，若版本号更新后处于离线状态，
 * 精确匹配会落空；此时回退到旧版本比直接失败更可用。
 */
async function matchWithFallback(request) {
  const exact = await caches.match(request);
  if (exact) return exact;
  return caches.match(request, { ignoreSearch: true });
}

/** 导航请求：优先拿最新页面，离线时回退到缓存的应用壳。 */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put("/index.html", response.clone()).catch(() => undefined);
    return response;
  } catch {
    const cached = (await caches.match("/index.html")) ?? (await caches.match("/"));
    if (cached) return cached;
    return new Response("当前处于离线状态，且没有可用的缓存页面。", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

/** 脚本与样式：网络优先，确保 runtime.js / app.js 的 no-cache 语义不被缓存掩盖。 */
async function handleFresh(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(ASSET_CACHE);
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = await matchWithFallback(request);
    if (cached) return cached;
    throw new Error("offline and not cached");
  }
}

/** 图标等静态资源：缓存优先，后台静默更新。 */
async function handleStaleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await matchWithFallback(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone()).catch(() => undefined);
      return response;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (isBypassed(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  const path = url.pathname;
  if (/\.(?:js|css)$/.test(path) || path === "/manifest.webmanifest") {
    event.respondWith(handleFresh(request));
    return;
  }

  if (/\.(?:png|svg|ico|webp|woff2?)$/.test(path)) {
    event.respondWith(handleStaleWhileRevalidate(request));
  }
});
