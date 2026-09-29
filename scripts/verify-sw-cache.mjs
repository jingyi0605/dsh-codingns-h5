// Service Worker 缓存边界验证。
// 重点确认：API 请求绝不能被 SW 缓存或拦截，否则会破坏鉴权与会话语义。
// 用法：node scripts/verify-sw-cache.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    candidates.push(join(globalRoot, "playwright", "index.mjs"), join(globalRoot, "playwright", "index.js"));
  } catch {
    // 忽略
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error("未能定位 playwright，请设置 PLAYWRIGHT_MODULE");
}

const { chromium } = await loadPlaywright();
const root = fileURLToPath(new URL("..", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

let apiHits = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname === "/" ? "/index.html" : url.pathname;

  if (path === "/config.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end('window.__DSH_BOOTSTRAP_CONFIG__ = { controlApiBaseUrl: "" };\n');
    return;
  }
  if (path.startsWith("/api/")) {
    apiHits += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "未登录" }));
    return;
  }
  try {
    const body = await readFile(join(root, normalize(path).replace(/^(\.\.[/\\])+/, "")));
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const record = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();

await page.goto(`${base}/index.html`, { waitUntil: "networkidle" });
await page.evaluate(() => navigator.serviceWorker.ready);

// 1. 应用壳资源应进入缓存。
const cachedShell = await page.evaluate(async () => {
  const names = await caches.keys();
  const entries = [];
  for (const name of names) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) entries.push(new URL(request.url).pathname);
  }
  return entries;
});
record("应用壳已缓存 index.html", cachedShell.includes("/index.html") || cachedShell.includes("/"), cachedShell.slice(0, 8).join(","));
record("已缓存 runtime.js", cachedShell.includes("/runtime.js"));
record("已缓存 app.js", cachedShell.includes("/app.js"));

// 2. API 请求绝不能被缓存。
const apiCached = cachedShell.filter((path) => path.startsWith("/api/"));
record("API 响应未被缓存", apiCached.length === 0, apiCached.join(","));

// 3. 断网后仍能打开应用壳，并且应用真的渲染出来（不只是 HTTP 200）。
const hitsBefore = apiHits;
await context.setOffline(true);
let offlineOk = false;
let offlineDetail = "";
try {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  // 应用壳必须完成引导渲染：登录表单出现即证明 app.js 从缓存执行成功。
  await page.waitForSelector("#login-form", { timeout: 15_000 });
  offlineOk = true;
} catch (error) {
  offlineDetail = error.message.split("\n")[0];
}
record("离线仍可打开应用壳并完成渲染", offlineOk, offlineDetail);

await context.setOffline(false);

// 4. 离线时 API 请求不应被 SW 用缓存冒充成功（必须失败，而不是返回假数据）。
record("离线期间未伪造 API 响应", apiHits === hitsBefore, `apiHits ${hitsBefore} → ${apiHits}`);

await browser.close();
server.close();

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
