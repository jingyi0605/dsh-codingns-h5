// 注册 Service Worker，使 Android Chrome 满足可安装性要求
// （带 fetch 处理器的 SW 是触发 beforeinstallprompt 的前提）。
//
// 注意：本文件必须独立存在，不能内联进 index.html。站点的 CSP
// script-src 只允许 'self' 与 blob:，内联脚本会被直接拦截。
//
// iOS 不支持 beforeinstallprompt，安装引导由 app.js 负责。
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      // SW 注册失败（例如非 HTTPS 或隐私模式）不影响页面功能。
    });
  });
}
