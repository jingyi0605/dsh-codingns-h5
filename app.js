const config = window.__DSH_BOOTSTRAP_CONFIG__ ?? {};
const controlApiBaseUrl = String(config.controlApiBaseUrl ?? "").replace(/\/+$/, "");
const sessionStorageKey = "dsh-codingns.h5.session";
const activeDeviceStorageKey = "dsh-codingns.h5.active-device";
const app = document.querySelector("#app");

let session = readSession();
let activeRuntime = null;
let deviceStatusTimer = null;

// 页面刷新或关闭时必须释放 WebRTC、信令和 iframe WebSocket，避免 Relay 房间
// 长时间保留旧 Client，最终触发 TOO_MANY_CLIENTS 并污染下一次联调。
window.addEventListener("pagehide", () => {
  const runtime = activeRuntime;
  activeRuntime = null;
  void runtime?.dispose().catch(() => undefined);
});

startParticleField();
render();

function setRemoteWebMode(enabled) {
  document.body.classList.toggle("remote-web-mode", enabled);
}

function render() {
  stopDeviceStatusTimer();
  document.body.classList.remove("dsh-device-list-mode");
  setRemoteWebMode(false);
  if (!session) {
    renderLogin();
    return;
  }

  renderDevices();
}

function renderLogin(errorMessage = "") {
  document.body.classList.remove("dsh-device-list-mode");
  setRemoteWebMode(false);
  app.innerHTML = `
    <form class="cyber-form" id="login-form">
      <div class="cyber-card-header-wrap">
        <div class="cyber-card-header"><div class="cyber-line"></div><span class="cyber-card-label">DSH WEB ACCESS</span><div class="cyber-line"></div></div>
      </div>
      <p class="cyber-connect-hint">使用 CodingNS Connect 账号登录，随后进入在线设备自己的 DSH Web。</p>
      <div class="cyber-field">
        <div class="cyber-field-border"><div class="cyber-field-border-glow"></div></div>
        <label class="cyber-field-label" for="login-email"><span class="cyber-field-icon" aria-hidden="true">✉</span>邮箱</label>
        <input class="cyber-input" id="login-email" name="email" type="email" autocomplete="email" placeholder="输入 Connect 邮箱" required />
      </div>
      <div class="cyber-field">
        <div class="cyber-field-border"><div class="cyber-field-border-glow"></div></div>
        <label class="cyber-field-label" for="login-password"><span class="cyber-field-icon" aria-hidden="true">⚷</span>密码</label>
        <input class="cyber-input" id="login-password" name="password" type="password" autocomplete="current-password" placeholder="输入账号密码" required />
      </div>
      ${errorMessage ? `<p class="error cyber-status" role="alert"><span class="cyber-status-icon">⚠</span><span>${escapeHtml(errorMessage)}</span></p>` : ""}
      <button class="cyber-submit" type="submit"><span class="cyber-submit-glow"></span><span class="cyber-submit-border"></span><span class="cyber-submit-text"><span class="cyber-submit-icon" aria-hidden="true">➤</span>登录 DSH Web</span></button>
      <div class="cyber-footer">
        <div class="cyber-divider"><span class="cyber-divider-line"></span><span class="cyber-divider-text">CONNECT</span><span class="cyber-divider-line"></span></div>
        <div class="cyber-links"><a href="https://channel.codingns.com" target="_blank" rel="noopener noreferrer">注册 CodingNS Connect 账号</a><a href="https://github.com/jingyi0605/DSH-CodingNS" target="_blank" rel="noopener noreferrer">GitHub 项目仓库</a></div>
      </div>
    </form>
  `;

  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(event.currentTarget, true);
    try {
      const response = await request("/api/public/auth/h5/login", {
        method: "POST",
        body: {
          email: form.get("email"),
          password: form.get("password"),
        },
      });
      session = {
        expiresAt: response.expiresAt,
        email: response.account?.email,
      };
      sessionStorage.setItem(sessionStorageKey, JSON.stringify(session));
      render();
    } catch (error) {
      setBusy(event.currentTarget, false);
      renderLogin(error instanceof Error ? error.message : "登录失败");
    }
  });
}

async function renderDevices() {
  stopDeviceStatusTimer();
  document.body.classList.add("dsh-device-list-mode");
  setRemoteWebMode(false);
  app.innerHTML = `
    <div class="loading"><span class="spinner"></span><span>读取 DSH 设备…</span></div>
  `;

  try {
    const response = await request("/api/v1/dsh/devices");
    const devices = Array.isArray(response.devices) ? response.devices : [];
    // 控制站会返回账号下全部 DSH 设备；离线设备保留在列表中，避免用户误以为设备已被删除。
    const visibleDevices = devices.filter((device) => device.status === "active" || device.status === "disabled");
    app.innerHTML = `
      <div class="panel-heading">
        <div>
          <p class="eyebrow">${escapeHtml(session.email ?? "已登录")}</p>
          <h2>选择 DSH Host</h2>
        </div>
        <button class="quiet" id="logout" type="button">退出</button>
      </div>
      ${visibleDevices.length === 0 ? `<p class="empty">当前没有已注册的 DSH Host。</p>` : `<div class="device-list">${visibleDevices.map(deviceCard).join("")}</div>`}
      <p id="status" class="muted status" role="status"></p>
    `;
    document.querySelector("#logout").addEventListener("click", async () => {
      await activeRuntime?.dispose().catch(() => undefined);
      activeRuntime = null;
      await request("/api/public/auth/h5/logout", { method: "POST" }).catch(() => undefined);
      session = null;
      sessionStorage.removeItem(sessionStorageKey);
      sessionStorage.removeItem(activeDeviceStorageKey);
      render();
    });
    for (const button of document.querySelectorAll("[data-device-id]")) {
      button.addEventListener("click", () => startBootstrap(button.dataset.deviceId));
    }
    refreshDevicePresenceLabels();
    deviceStatusTimer = window.setInterval(refreshDevicePresenceLabels, 1000);
    const rememberedDeviceId = sessionStorage.getItem(activeDeviceStorageKey);
    if (rememberedDeviceId && visibleDevices.some((device) => device.dshDeviceId === rememberedDeviceId && device.online)) {
      // 让设备列表先完成挂载，再启动自动恢复，确保状态节点可更新。
      queueMicrotask(() => startBootstrap(rememberedDeviceId));
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      session = null;
      sessionStorage.removeItem(sessionStorageKey);
      sessionStorage.removeItem(activeDeviceStorageKey);
      renderLogin("登录已过期，请重新登录");
      return;
    }
    app.innerHTML = `<p class="error">${escapeHtml(error instanceof Error ? error.message : "读取设备失败")}</p>`;
  }
}

function deviceCard(device) {
  const id = escapeHtml(device.dshDeviceId);
  const name = escapeHtml(device.displayName || device.dshDeviceId);
  const heartbeat = escapeHtml(device.lastHeartbeatAt ?? "");
  const online = device.status === "active" && device.online;
  return `
    <article class="device-card" data-status="${escapeHtml(device.status)}" data-online="${online ? "true" : "false"}">
      <div>
        <div class="device-card__title"><span class="device-status-dot" aria-hidden="true"></span><h3>${name}</h3><span class="device-status-label">${online ? "在线" : "离线"}</span></div>
        <p class="mono">${id}</p>
        <p class="muted device-heartbeat" data-heartbeat="${heartbeat}" data-online="${online ? "true" : "false"}">${formatDevicePresence(device)}</p>
      </div>
      <button class="primary" data-device-id="${id}" type="button" ${online ? "" : "disabled"}>${online ? "连接" : "不可用"}</button>
    </article>
  `;
}

async function startBootstrap(deviceId) {
  const status = document.querySelector("#status");
  const buttons = [...document.querySelectorAll("[data-device-id]")];
  stopDeviceStatusTimer();
  buttons.forEach((button) => setBusy(button, true));
    status.textContent = "正在申请 Client ticket…";
  try {
    const api = window.DshCodingNsH5;
    if (!api) throw new Error("H5 runtime 尚未加载");
    status.textContent = "正在建立加密 WebRTC 通道并读取远程 DSH Web…";
    activeRuntime = await api.startDshH5BrowserBootstrap({
      controlApi: api.createHttpDshH5ControlApi(controlApiBaseUrl),
      dshDeviceId: deviceId,
      clientSessionId: getClientSessionId(deviceId),
      webContext: { container: app },
      onStatus: (phase) => {
        if (!status) return;
        status.textContent = phase === "ticket"
          ? "正在申请 Client ticket…"
          : phase === "webrtc"
            ? "正在建立加密 WebRTC 通道…"
            : phase === "session-ready"
              ? "WebRTC 已建立，正在协商 DSH Session…"
              : "正在读取远程 DSH Web…";
      },
    });
    stopDeviceStatusTimer();
    sessionStorage.setItem(activeDeviceStorageKey, deviceId);
    setRemoteWebMode(true);
    window.dispatchEvent(new CustomEvent("dsh-bootstrap-ready", { detail: { deviceId, runtime: activeRuntime } }));
  } catch (error) {
    await activeRuntime?.dispose().catch(() => undefined);
    activeRuntime = null;
    setRemoteWebMode(false);
    sessionStorage.removeItem(activeDeviceStorageKey);
    buttons.forEach((button) => setBusy(button, false));
    status.className = "status error";
    status.textContent = error instanceof Error ? error.message : "申请 ticket 失败";
  }
}

function stopDeviceStatusTimer() {
  if (deviceStatusTimer === null) return;
  window.clearInterval(deviceStatusTimer);
  deviceStatusTimer = null;
}

function refreshDevicePresenceLabels() {
  for (const element of document.querySelectorAll("[data-heartbeat]")) {
    const heartbeat = element.getAttribute("data-heartbeat") || "";
    const card = element.closest(".device-card");
    const active = card?.getAttribute("data-status") === "active";
    const online = active && heartbeat !== "" && Date.now() - Date.parse(heartbeat) < 45_000;
    card?.setAttribute("data-online", online ? "true" : "false");
    element.setAttribute("data-online", online ? "true" : "false");
    const label = card?.querySelector(".device-status-label");
    if (label) label.textContent = online ? "在线" : "离线";
    const button = card?.querySelector("[data-device-id]");
    if (button instanceof HTMLButtonElement) {
      button.disabled = !online;
      button.textContent = online ? "连接" : "不可用";
    }
    element.textContent = formatDevicePresence({
      online,
      lastHeartbeatAt: heartbeat || null,
    });
  }
}

function formatDevicePresence(device) {
  if (device.online) return device.lastHeartbeatAt ? `在线 · 最后心跳 ${formatElapsed(device.lastHeartbeatAt)}前` : "在线 · 等待首个心跳";
  if (!device.lastHeartbeatAt) return "离线 · 从未连接";
  return `离线 · ${formatElapsed(device.lastHeartbeatAt)}前`;
}

function formatElapsed(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours}小时${minutes}分钟${remainingSeconds}秒`;
}

function startParticleField() {
  const canvas = document.querySelector(".particle-canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  let animationId = 0;
  let particles = [];
  const resize = () => {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * ratio);
    canvas.height = Math.floor(window.innerHeight * ratio);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    particles = Array.from({ length: Math.min(50, Math.floor((window.innerWidth * window.innerHeight) / 25000)) }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - .5) * .5,
      vy: (Math.random() - .5) * .5,
      size: Math.random() * 2 + 1,
      opacity: Math.random() * .5 + .2,
    }));
  };
  const draw = () => {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (let index = 0; index < particles.length; index += 1) {
      const particle = particles[index];
      particle.x = (particle.x + particle.vx + window.innerWidth) % window.innerWidth;
      particle.y = (particle.y + particle.vy + window.innerHeight) % window.innerHeight;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fillStyle = `rgba(10, 132, 255, ${particle.opacity})`;
      context.fill();
      for (const other of particles.slice(index + 1)) {
        const distance = Math.hypot(particle.x - other.x, particle.y - other.y);
        if (distance >= 150) continue;
        context.beginPath();
        context.moveTo(particle.x, particle.y);
        context.lineTo(other.x, other.y);
        context.strokeStyle = `rgba(10, 132, 255, ${.1 * (1 - distance / 150)})`;
        context.stroke();
      }
    }
    animationId = window.requestAnimationFrame(draw);
  };
  resize();
  draw();
  window.addEventListener("resize", resize);
  window.addEventListener("pagehide", () => {
    window.removeEventListener("resize", resize);
    window.cancelAnimationFrame(animationId);
  }, { once: true });
}

// Relay 每个设备默认只允许一个 Client。固定浏览器会话标识后，刷新页面会
// 让 Relay 用同一 sessionId 顶掉没有及时收到 pagehide 的旧连接，而不是被
// 误判为第二个并返回 TOO_MANY_CLIENTS。
function getClientSessionId(deviceId) {
  const key = `dsh-codingns.h5.client-session.${deviceId}`;
  const saved = sessionStorage.getItem(key);
  if (saved) return saved;
  const generated = typeof crypto?.randomUUID === "function"
    ? `h5_${crypto.randomUUID()}`
    : `h5_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem(key, generated);
  return generated;
}

async function request(pathname, options = {}) {
  const headers = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${controlApiBaseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    credentials: "include",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload.detail || payload.errorCode || "请求失败");
  return payload;
}

function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionStorageKey) || "null");
    if (!value?.expiresAt || value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}

function setBusy(element, busy) {
  element.disabled = busy;
  if (busy) element.dataset.busy = "true";
  else delete element.dataset.busy;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
