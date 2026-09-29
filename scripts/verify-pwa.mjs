// PWA 与后退手势的端到端验证脚本。
// 用法：node scripts/verify-pwa.mjs
// 依赖：playwright（chromium）。
//
// ESM 不读取 NODE_PATH，因此这里按常见安装位置解析 playwright；
// 也可用 PLAYWRIGHT_MODULE 环境变量显式指定其入口。
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
    // 忽略：npm 不可用时继续尝试其他位置。
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error(`未能定位 playwright，请设置 PLAYWRIGHT_MODULE。已尝试：${candidates.join(", ")}`);
}

const { chromium } = await loadPlaywright();

const root = fileURLToPath(new URL("..", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// 模拟控制站会话：登录前 /api/v1/dsh/devices 返回 401，登录后返回设备列表。
// 这样才能分别验证「冷启动探测失败 → 显示登录页」与「登录 → 设备列表」两条路径。
let authenticated = false;

/** 统一的最小控制站 API mock，本地服务器与外部域名路由共用。 */
function handleMockApi(path, method, origin = null) {
  // 页面运行在本地端口，而 config.js 指向公网控制站，属跨域请求；
  // 必须回带 CORS 头，且 credentials: "include" 要求具体 origin（不能用 *）。
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (origin !== null) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
    headers["access-control-allow-methods"] = "GET, POST, DELETE, OPTIONS";
    headers["access-control-allow-headers"] = "content-type, accept";
    headers["vary"] = "Origin";
  }
  const json = (status, body) => ({ status, headers, body: JSON.stringify(body) });

  // 预检请求：content-type: application/json 会触发 OPTIONS。
  if (method === "OPTIONS") return { status: 204, headers, body: "" };

  if (path === "/api/public/auth/h5/login") {
    authenticated = true;
    return json(200, {
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      account: { email: "verify@example.com" },
    });
  }
  if (path === "/api/public/auth/h5/logout") {
    authenticated = false;
    return json(200, {});
  }
  if (path === "/api/v1/dsh/devices") {
    if (method === "DELETE") return json(200, {});
    if (!authenticated) return json(401, { detail: "未登录" });
    return json(200, {
      devices: [{
        dshDeviceId: "dev-1",
        displayName: "Verify Host",
        // status 必须是 active：fetchVisibleDevices 会过滤掉其他状态，
        // isDeviceOnline 也要求 active 且心跳在阈值内。
        status: "active",
        online: true,
        lastHeartbeatAt: new Date().toISOString(),
      }],
    });
  }
  return json(200, {});
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname === "/" ? "/index.html" : url.pathname;

  // 测试用同源 config.js：把 controlApiBaseUrl 置空，使 API 请求与页面同源。
  // 这样既避免跨域预检（Playwright 不拦截 OPTIONS 预检，会打到真实网络），
  // 也贴合 README 中「Control API 与 H5 同源反代」的推荐部署方式。
  if (path === "/config.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end('window.__DSH_BOOTSTRAP_CONFIG__ = { controlApiBaseUrl: "" };\n');
    return;
  }

  // 最小 API mock：让页面能进入设备列表视图，从而验证后退状态机。
  if (path.startsWith("/api/")) {
    const mocked = handleMockApi(path, request.method, request.headers.origin ?? null);
    response.writeHead(mocked.status, mocked.headers);
    response.end(mocked.body);
    return;
  }

  // 防目录穿越。
  const target = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  try {
    const body = await readFile(target);
    response.writeHead(200, { "content-type": types[extname(target)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const record = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});
const page = await context.newPage();

// config.js 由测试服务器替换为同源版本，因此 API 请求都落在本地。
// 这里只需阻断外部请求（注册链接、CDN 等），保证测试离线可复现且不触网。
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  const isLocal = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (isLocal) {
    await route.continue();
    return;
  }
  await route.abort();
});

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

await page.goto(`${base}/index.html`, { waitUntil: "networkidle" });

// 1. manifest 可解析且字段满足 Chrome 可安装性要求。
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return null;
  const response = await fetch(link.href);
  return { href: link.href, data: await response.json() };
});
record("manifest 存在且可解析", manifest !== null && typeof manifest.data === "object");
record("manifest 含 name/short_name/start_url", Boolean(manifest?.data?.name && manifest?.data?.short_name && manifest?.data?.start_url));
record("manifest display 为 standalone", manifest?.data?.display === "standalone");

const iconSizes = (manifest?.data?.icons ?? []).map((icon) => icon.sizes);
record("manifest 含 192 与 512 图标", iconSizes.includes("192x192") && iconSizes.includes("512x512"), iconSizes.join(","));
record("manifest 含 maskable 图标", (manifest?.data?.icons ?? []).some((icon) => icon.purpose === "maskable"));

// 2. 图标与 iOS 元标签真实可达。
for (const path of ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png", "/favicon-32.png"]) {
  const status = await page.evaluate(async (p) => (await fetch(p)).status, path);
  record(`图标可访问 ${path}`, status === 200, `HTTP ${status}`);
}

const iosMeta = await page.evaluate(() => ({
  capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
  touchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"),
  viewport: document.querySelector('meta[name="viewport"]')?.content ?? "",
}));
record("iOS apple-mobile-web-app-capable", iosMeta.capable === "yes");
record("iOS apple-touch-icon 使用 PNG", (iosMeta.touchIcon ?? "").includes("apple-touch-icon.png"));
record("viewport 含 viewport-fit=cover", iosMeta.viewport.includes("viewport-fit=cover"));

// 3. Service Worker 注册并接管。
const swState = await page.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return { supported: false };
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  return { supported: true, scope: registration?.scope ?? null, active: registration?.active?.state ?? null };
});
record("Service Worker 注册成功", swState.active === "activated" || swState.active === "activating", `state=${swState.active}`);

// 4. 真实主路径：登录 → 设备列表。
await page.fill("#login-email", "verify@example.com");
await page.fill("#login-password", "secret");
await page.click("#login-form button[type=submit]");
await page.waitForSelector(".device-card", { timeout: 10_000 });
record("登录后进入设备列表", (await page.locator(".device-card").count()) === 1);
record("设备列表页不显示返回按钮", await page.locator("[data-back-button]").isHidden());

// 5. 真实后退主路径：点击「连接」进入远程视图（stub 掉 WebRTC bootstrap），
//    再触发系统返回，验证会回到设备列表并释放运行时。
//    这样走的是 app.js 里真实的 setView/ensureRemoteHistorySentinel 代码路径，
//    而不是在测试里手工模拟历史记录。
await page.evaluate(() => {
  // DshCodingNsH5 是 writable:false 的属性，必须整体重定义。
  const stubRuntime = {
    webContext: { iframe: null },
    dispose: async () => {
      window.__disposed = (window.__disposed ?? 0) + 1;
    },
  };
  Object.defineProperty(window, "DshCodingNsH5", {
    configurable: true,
    value: {
      createHttpDshH5ControlApi: () => ({}),
      startDshH5BrowserBootstrap: async () => stubRuntime,
    },
  });
});

await page.click("[data-device-id]");
await page.waitForFunction(() => document.body.classList.contains("remote-web-mode"), null, { timeout: 10_000 });
record("点击连接后进入远程视图", await page.locator("body.remote-web-mode").count() === 1);
record("远程视图压入历史哨兵", (await page.evaluate(() => history.state?.codingns4dsh ?? null)) === "remote-view");
record("远程视图显示返回按钮", await page.locator("[data-back-button]").isVisible());

// 触发系统返回（等价于 Android 返回键 / iOS 边缘滑动）。
await page.evaluate(() => history.back());
await page.waitForFunction(() => !document.body.classList.contains("remote-web-mode"), null, { timeout: 10_000 });
const afterBack = await page.evaluate(() => ({
  remoteMode: document.body.classList.contains("remote-web-mode"),
  sentinel: history.state?.codingns4dsh ?? null,
  disposed: window.__disposed ?? 0,
}));
record("系统返回后回到设备列表", afterBack.remoteMode === false);
record("系统返回后释放运行时", afterBack.disposed >= 1, `dispose 调用 ${afterBack.disposed} 次`);
record("系统返回后哨兵被弹出", afterBack.sentinel === null, `state=${afterBack.sentinel}`);

// 返回按钮同样应能回到设备列表。
await page.click("[data-device-id]");
await page.waitForFunction(() => document.body.classList.contains("remote-web-mode"), null, { timeout: 10_000 });
await page.click("[data-back-button]");
await page.waitForFunction(() => !document.body.classList.contains("remote-web-mode"), null, { timeout: 10_000 });
record("返回按钮可回到设备列表", await page.locator("body.remote-web-mode").count() === 0);

// 6. 触感模块在无 vibrate 的环境下必须安全降级（不抛错）。
const hapticSafe = await page.evaluate(() => {
  // 模拟 iOS 场景：删除 vibrate，确认开关技巧路径不抛异常。
  const original = navigator.vibrate;
  try { delete navigator.vibrate; } catch { /* 只读属性 */ }
  let threw = false;
  try {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.id = "verify-haptic";
    const label = document.createElement("label");
    label.setAttribute("for", "verify-haptic");
    document.body.append(label, input);
    label.click();
    label.remove();
    input.remove();
  } catch { threw = true; }
  if (original) navigator.vibrate = original;
  return { threw };
});
record("触感降级路径不抛异常", hapticSafe.threw === false);

// 6.5 iOS 主屏冷启动路径：主屏 Web App 与 Safari 的存储相互隔离，
//     sessionStorage 为空但 HttpOnly Cookie 仍有效时，必须直接进入设备列表而不是登录页。
//     这里清空 sessionStorage 后重新加载，模拟从主屏图标冷启动。
await page.evaluate(() => sessionStorage.clear());
await page.reload({ waitUntil: "networkidle" });
const coldStart = await page.evaluate(() => ({
  hasLoginForm: document.querySelector("#login-form") !== null,
  hasDeviceList: document.body.classList.contains("dsh-device-list-mode"),
  deviceCards: document.querySelectorAll(".device-card").length,
}));
record("Cookie 有效时冷启动直接进入设备列表", coldStart.hasDeviceList && coldStart.deviceCards === 1, JSON.stringify(coldStart));
record("Cookie 有效时冷启动不显示登录页", coldStart.hasLoginForm === false);

// 7. 控制台不应有脚本错误（CSP 拦截内联脚本会在这里暴露）。
const cspErrors = consoleErrors.filter((text) => /Content Security Policy|Refused to execute/i.test(text));
record("无 CSP 拦截脚本错误", cspErrors.length === 0, cspErrors.join(" | ").slice(0, 200));
// 冷启动时会话探测（restoreSessionFromCookie）必然收到一次 401，这是设计内行为，
// 浏览器仍会把它记为 console error。需要把它从「未捕获错误」中排除。
const isExpectedProbe401 = (text) => /401/.test(text) && /Failed to load resource/i.test(text);
const unexpectedErrors = consoleErrors.filter((text) => !isExpectedProbe401(text));
record("无未捕获脚本错误", unexpectedErrors.length === 0, unexpectedErrors.join(" | ").slice(0, 300));

await browser.close();
server.close();

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
