// 部署后自检：对已上线的 HTTPS 站点验证 PWA 关键文件的真实响应。
// 存在的意义：SPA 回退规则（_redirects 的 `/* /index.html 200`、vercel.json 的 rewrites）
// 若先于静态文件生效，会把 /sw.js 重写成 HTML，导致 Service Worker 因 MIME 类型不符
// 而注册失败——表现为「Android 不弹安装提示」，且本地测试无法发现。
//
// 用法：node scripts/verify-deploy.mjs https://dsh.example.com
import { extname } from "node:path";

const base = process.argv[2];
if (!base || !/^https?:\/\//.test(base)) {
  console.error("用法：node scripts/verify-deploy.mjs https://your-deployed-site");
  process.exit(2);
}

const results = [];
const record = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function probe(path) {
  const response = await fetch(new URL(path, base), { redirect: "follow" });
  const text = await response.text();
  return {
    status: response.status,
    type: (response.headers.get("content-type") ?? "").split(";")[0].trim(),
    text,
    headers: response.headers,
  };
}

// 1. 首页必须是 HTML，且引用了 manifest。
const home = await probe("/");
record("首页返回 200", home.status === 200, `status=${home.status}`);
record("首页 Content-Type 为 HTML", home.type === "text/html", home.type);
record("首页引用 manifest", /rel="manifest"/.test(home.text));

// 2. Service Worker 必须返回真正的 JS，而不是被 SPA 回退重写的 HTML。
//    这是本脚本最重要的一项断言。
const sw = await probe("/sw.js");
record("sw.js 返回 200", sw.status === 200, `status=${sw.status}`);
record("sw.js 未被 SPA 回退重写为 HTML", sw.type !== "text/html", `content-type=${sw.type}`);
const swIsJs = /javascript/i.test(sw.type);
record("sw.js Content-Type 为 JavaScript", swIsJs, sw.type);
record("sw.js 内容为真实脚本", /CACHE_VERSION|caches\.open/.test(sw.text));

// 3. 其余关键文件也不能被回退吃掉。
const pwa = await probe("/pwa.js");
record("pwa.js 未被重写为 HTML", pwa.type !== "text/html", pwa.type);
record("pwa.js 含 SW 注册逻辑", /serviceWorker/.test(pwa.text));

const manifest = await probe("/manifest.webmanifest");
record("manifest 返回 200", manifest.status === 200, `status=${manifest.status}`);
record("manifest 可解析为 JSON", (() => {
  try { JSON.parse(manifest.text); return true; } catch { return false; }
})());

const runtime = await probe("/runtime.js");
record("runtime.js 未被重写为 HTML", runtime.type !== "text/html", runtime.type);

// 4. 图标必须是真实 PNG。
for (const icon of ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"]) {
  const asset = await probe(icon);
  record(`${icon} 为 PNG`, asset.status === 200 && asset.type === "image/png", `${asset.status} ${asset.type}`);
}

// 5. manifest 中声明的图标必须真实可访问。
let declared = [];
try { declared = JSON.parse(manifest.text).icons ?? []; } catch { /* 上面已断言 */ }
for (const icon of declared) {
  const asset = await probe(icon.src);
  record(`manifest 图标可访问 ${icon.src}`, asset.status === 200 && asset.type.startsWith("image/"), `${asset.status} ${asset.type}`);
}

// 6. CSP 不得缺失（缺失会破坏远程 DSH Web 的 blob 模块加载）。
const csp = home.headers.get("content-security-policy") ?? "";
record("响应头含 CSP", csp.length > 0);
record("CSP 允许 blob: 脚本", /script-src[^;]*blob:/.test(csp), csp.slice(0, 80));

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
