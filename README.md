# Codingns4DSH H5 Bootstrap

这是一个独立的静态 H5 引导项目，适合部署到 Vercel、Cloudflare Pages 或任意静态 CDN。它不运行 Host、Relay、TURN，也不在边缘函数中执行 WebRTC；WebRTC 和 DataChannel 必须在访问者浏览器中运行。

当前页面已经完成：

1. 使用控制站登录态登录。
2. 读取独立的 DSH 设备列表。
3. 只选择在线的 DSH Host。
4. 通过控制站 HttpOnly 会话申请 `role: client` 的短期 Relay ticket。Client ticket 不携带、也不需要 Host 的 `deviceCredential`。
5. 在浏览器建立 WebRTC DataChannel，完成 DSH Session hello/ready。
6. 通过 `web.session.open` 和 `web.boot.get` 创建隔离 iframe，动态读取 Host 的 DSH Web boot、资源和 WebSocket。
7. 通过 `dsh-bootstrap-ready` 事件暴露已建立的 runtime，供外层页面观测连接状态。

完整远程 DSH Web 不预先打包在这里。页面只提供引导壳，实际 boot、资源和插件由 Host Gateway 通过加密 DataChannel 返回，因此使用的是用户自己的 DSH 版本和插件，而不是控制站预装的一套固定前端。

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
