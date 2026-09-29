# Codingns4DSH H5 Bootstrap

这是一个独立的静态 H5 引导项目，适合部署到 Vercel、Cloudflare Pages 或任意静态 CDN。它不运行 Host、Relay、TURN，也不在边缘函数中执行 WebRTC；WebRTC 和 DataChannel 必须在访问者浏览器中运行。

当前页面已经完成：

1. 使用控制站登录态登录。
2. 读取独立的 DSH 设备列表。
3. 只选择在线的 DSH Host；离线设备在列表右侧提供「删除」按钮，确认后调用控制台 `DELETE /api/v1/dsh/devices/:dshDeviceId`。
4. 通过控制站 HttpOnly 会话申请 `role: client` 的短期 Relay ticket。Client ticket 不携带、也不需要 Host 的 `deviceCredential`。
5. 在浏览器建立 WebRTC DataChannel，完成 DSH Session hello/ready。
6. 通过 `web.session.open` 和 `web.boot.get` 创建隔离 iframe，动态读取 Host 的 DSH Web boot、资源和 WebSocket。
7. 通过 `dsh-bootstrap-ready` 事件暴露已建立的 runtime，供外层页面观测连接状态。

完整远程 DSH Web 不预先打包在这里。页面只提供引导壳，实际 boot、资源和插件由 Host Gateway 通过加密 DataChannel 返回，因此使用的是用户自己的 DSH 版本和插件，而不是控制站预装的一套固定前端。

## 移动端能力（PWA / 手势 / 振动）

本目录同时作为 PWA 应用壳发布，支持 Android 与 iOS 添加到主屏。

### 安装

| 平台 | 安装方式 | 说明 |
| --- | --- | --- |
| Android Chrome | 地址栏/菜单出现「安装应用」，或页面底部提示条 | 依赖 manifest + 带 fetch 处理器的 Service Worker |
| iOS Safari | 「分享」→「添加到主屏幕」 | iOS 没有安装 API，只能由页面提示引导 |

**iOS 重要限制**：主屏 Web App 与 Safari 使用**相互隔离的网站数据**。`sessionStorage` 不会共享，因此本页在冷启动时调用 `restoreSessionFromCookie()` 静默探测一次控制站会话：若 HttpOnly Cookie 仍有效就直接进入设备列表，否则显示登录页。

### 后退手势

代码库中原本没有任何 `history` 调用，因此默认行为是：Android 返回键会直接退出 PWA，iOS 主屏 Web App 完全没有边缘滑动返回。现在的语义是：

- **远程 Web 视图内**：边缘右滑、点击左下角返回按钮、或 Android 系统返回键 → 回到设备列表，并**主动释放** WebRTC 运行时（避免 Relay 房间残留旧 Client 触发 `TOO_MANY_CLIENTS`）。
- **设备列表/登录页**：不再拦截，允许按平台默认行为退出。

实现要点：

- 进入远程视图时压入一条哨兵历史记录（`history.pushState`），使系统返回键有可回退目标。
- 边缘手势监听**直接挂在同源 iframe 的 document 上**，因为 iframe 内的 touch 事件不会冒泡到父页面；`srcdoc` 导航会替换文档对象，因此用 `load` 事件重新挂载，并用 `WeakSet` 去重。
- 若 iframe 文档不可访问（跨源或沙箱受限），自动退回一条 20px 宽的左缘手势区。
- 手势仅在屏幕左缘 22px 起手，纵向位移明显时放弃接管，避免与 iframe 内滚动冲突。

### 振动 / 触感

统一入口是 `haptic(kind)`，kind 取 `light` / `medium` / `success` / `error`。

- **Android**：使用 `navigator.vibrate()`，可靠可用。
- **iOS**：Safari 从未实现 Vibration API。这里使用「隐藏 `<input type="checkbox" switch">` + 点击其 `<label>`」的社区技巧，**并且按可选增强处理**：该技巧在 iOS 26.5+ 已被 Apple 封堵（参见 [flarum/framework#4694](https://github.com/flarum/framework/issues/4694)），失效时静默降级，不影响任何功能。

### 生命周期

`pagehide` 不再立即销毁 WebRTC 运行时，而是安排一个 30 秒宽限期的延迟释放；`pageshow` 或页面重新可见时取消。这样 iOS 主屏 Web App 切到后台不会立即断连。即使真的残留，固定的 `clientSessionId` 也会让新连接顶掉旧连接。

### 重新生成图标

图标由 `logo.svg` 生成，iOS 的 `apple-touch-icon` 必须是不透明 PNG（SVG 不被接受）：

```bash
python3 scripts/generate-icons.py   # 需要 rsvg-convert（librsvg）
```

### 本地验证

```bash
node scripts/verify-pwa.mjs        # manifest/图标/SW/登录/后退手势/冷启动，28 项
node scripts/verify-sw-cache.mjs   # SW 缓存边界与离线渲染，6 项
node scripts/verify-deploy.mjs https://你的域名   # 部署后自检，21 项
```

前两个脚本自带静态服务器与 API mock，会把 `config.js` 替换为同源空地址，因此**不会请求真实控制站**。需要 `playwright`（chromium）。

`verify-deploy.mjs` 在部署后对真实域名运行，专门验证**本地无法发现**的部署期故障：SPA 回退规则若先于静态文件生效，会把 `/sw.js` 重写成 HTML，导致 Service Worker 因 MIME 类型不符注册失败（表现为 Android 不弹安装提示）。

> **部署注意**：`_redirects`（`/* /index.html 200`）和 `vercel.json`（`rewrites`）都含 SPA 回退。请确认平台是「先匹配静态文件、再回退」，部署后用 `verify-deploy.mjs` 复核 `sw.js` 的 `Content-Type`。若确实被遮蔽，需要为 `/sw.js`、`/pwa.js`、`/runtime.js`、`/manifest.webmanifest`、图标加排除规则。

### 真机验证清单

自动化只能覆盖 Chromium 桌面内核。以下项目必须在真机上确认（部署到 HTTPS 后）：

**通用（HTTPS 必需）**

- [ ] 页面通过 HTTPS 打开，Service Worker 状态为 `activated`（DevTools → Application → Service Workers）。
- [ ] 断网后重新打开应用，仍能渲染登录页/设备列表，而不是浏览器错误页。

**Android（Chrome）**

- [ ] 地址栏或菜单出现「安装应用」；安装后图标正常（含自适应图标圆形遮罩）。
- [ ] 从主屏图标启动进入独立窗口（无地址栏）。
- [ ] 登录后进入远程 DSH Web，**系统返回键**回到设备列表（不直接退出应用）。
- [ ] 在设备列表页再按返回键，退出应用（符合预期）。
- [ ] 振动生效：连接、返回、错误提示时有可感知的触感。
- [ ] 左缘右滑能回到设备列表，且不干扰远程页面内的横向滚动。

**iOS（Safari → 添加到主屏幕）**

- [ ] 「分享」→「添加到主屏幕」可用；主屏图标显示正确（不是白块或默认字母图标）。
- [ ] 从主屏图标启动为全屏，状态栏区域内容不被刘海/灵动岛遮挡。
- [ ] **冷启动能直接进入设备列表**：先在 Safari 登录，再从主屏图标启动（两者存储隔离，依赖 HttpOnly Cookie 探测）。
- [ ] 左缘右滑回到设备列表（iOS 主屏 Web App 本身没有边缘返回，必须依赖本实现）。
- [ ] 远程视图内点击左下角返回按钮可回到设备列表。
- [ ] 切到后台再切回（约 10 秒内），连接**不应**立即断开（`pagehide` 有 30 秒宽限期）。
- [ ] 振动：iOS 上**预期无振动**，功能不受影响即为通过。请记录 iOS 版本号确认这一结论。

## 部署


### Vercel

将本目录作为项目根目录，Framework 选择 `Other`，Build Command 留空，Output Directory 设为 `.`。如果 Control API 与 `dsh.codingns.com` 同源反代，保持 `config.js` 的空地址即可；如果跨域部署，修改 `config.js` 的 `controlApiBaseUrl`，并在 Control API 的 `CODINGNS_PROXY_CONTROL_CORS_ALLOWED_ORIGINS` 中加入 Bootstrap 域名。

部署响应头必须保留项目中的 CSP 配置：远程 DSH Web 在隔离 iframe 中通过加密 Tunnel 动态加载用户自己的前端模块，因此需要允许 `blob:` 脚本、样式、字体和 Worker；远程脚本本身仍不允许通过 `unsafe-inline` 执行。不要把 `connect-src` 收窄到只允许控制站，否则 WebRTC 信令和 TURN 会被浏览器拦截。

### Cloudflare Pages

将本目录作为 Pages 项目目录，Build command 留空，输出目录填 `.`。`_redirects` 和 `_headers` 已包含 SPA 回退与基础安全响应头。

### Cloudflare Workers Static Assets

本目录带有 `wrangler.toml`，可以在目录内执行 `wrangler deploy`。这使用 Workers Static Assets 提供静态文件；Worker 仍不执行 WebRTC，也不接触 DSH 业务明文。

Cloudflare Worker 可以作为反向代理或注入运行时配置，但不应把它当作 WebRTC 服务器；Host/Relay 仍运行在控制站和用户设备上。

## Tunnel 调试日志

调试日志默认关闭。H5 临时启用方式：

- 在地址后增加 `?dshDebug=1`，例如 `https://dsh.codingns.com/?dshDebug=1`；
- 或在浏览器控制台执行 `localStorage.setItem('codingns4dsh-tunnel-debug', '1')`，刷新页面；
- 停用时执行 `localStorage.removeItem('codingns4dsh-tunnel-debug')`，或使用 `?dshDebug=0`。

日志只输出信令、DataChannel、Session、Envelope 和 Remote Web 请求的元数据，不输出 Envelope body、ticket、Cookie 或 DSH Web 响应正文。
