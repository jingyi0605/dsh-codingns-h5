const config = window.__DSH_BOOTSTRAP_CONFIG__ ?? {};
const controlApiBaseUrl = String(config.controlApiBaseUrl ?? "").replace(/\/+$/, "");
const sessionStorageKey = "codingns4dsh.h5.session";
const activeDeviceStorageKey = "codingns4dsh.h5.active-device";
const app = document.querySelector("#app");
// 心跳阈值只作为控制站缺少 online 字段时的兜底；设备列表会周期性重新拉取，
// lastHeartbeatAt 不会再像只拉取一次时那样停留在页面加载时的快照上。
const deviceHeartbeatTimeoutMs = 45_000;
const devicePresenceTickMs = 1_000;
const deviceRefreshIntervalMs = 15_000;

let session = readSession();
let activeRuntime = null;
let devicePresenceTimer = null;
let deviceRefreshTimer = null;
let deviceRefreshInFlight = false;
let devicePresence = new Map();
let logoutInProgress = false;

window.addEventListener("message", (event) => {
  const iframeWindow = activeRuntime?.webContext?.iframe?.contentWindow;
  if (iframeWindow === null || iframeWindow === undefined || event.source !== iframeWindow) return;
  if (event.data?.kind !== "codingns4dsh:remote-logout") return;
  void logoutBrowserSession();
});

// 后台标签页的定时器会被浏览器节流，回到前台时立即补一次同步，避免展示过期状态。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || devicePresenceTimer === null) return;
  void refreshDeviceList();
});

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
  stopDeviceTimers();
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
      <p class="cyber-connect-hint">使用 Codingns4DSH Connect 账号登录，随后进入在线设备自己的 DSH Web。</p>
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
        <div class="cyber-links"><a href="https://channel.codingns.com:1443" target="_blank" rel="noopener noreferrer">注册 Codingns4DSH Connect 账号</a><a href="https://github.com/jingyi0605/Codingns4DSH" target="_blank" rel="noopener noreferrer">GitHub 项目仓库</a></div>
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
  stopDeviceTimers();
  document.body.classList.add("dsh-device-list-mode");
  setRemoteWebMode(false);
  app.innerHTML = `
    <div class="loading"><span class="spinner"></span><span>读取 DSH 设备…</span></div>
  `;

  try {
    const devices = await fetchVisibleDevices();
    renderDeviceList(devices);
    startDeviceTimers();
    const rememberedDeviceId = sessionStorage.getItem(activeDeviceStorageKey);
    if (rememberedDeviceId && devices.some((device) => device.dshDeviceId === rememberedDeviceId && isDeviceOnline(device))) {
      // 让设备列表先完成挂载，再启动自动恢复，确保状态节点可更新。
      queueMicrotask(() => startBootstrap(rememberedDeviceId));
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      expireSession();
      return;
    }
    app.innerHTML = `<p class="error">${escapeHtml(error instanceof Error ? error.message : "读取设备失败")}</p>`;
  }
}

function renderDeviceList(devices) {
  devicePresence = new Map(devices.map((device) => [device.dshDeviceId, device]));
  app.innerHTML = `
    <div class="panel-heading">
      <div>
        <p class="eyebrow">${escapeHtml(session.email ?? "已登录")}</p>
        <h2>选择 DSH Host</h2>
      </div>
      <button class="quiet" id="logout" type="button">退出</button>
    </div>
    ${devices.length === 0 ? `<p class="empty">当前没有已注册的 DSH Host。</p>` : `<div class="device-list">${devices.map(deviceCard).join("")}</div>`}
    <p id="status" class="muted status" role="status"></p>
  `;
  document.querySelector("#logout").addEventListener("click", async () => {
    await logoutBrowserSession();
  });
  for (const button of document.querySelectorAll("[data-device-id]")) {
    button.addEventListener("click", () => startBootstrap(button.dataset.deviceId));
  }
  for (const button of document.querySelectorAll("[data-remove-device]")) {
    button.addEventListener("click", () => void removeDevice(button.dataset.removeDevice, button));
  }
  refreshDevicePresence();
}

async function fetchVisibleDevices() {
  const response = await request("/api/v1/dsh/devices", { cache: "no-store" });
  const devices = Array.isArray(response.devices) ? response.devices.map(normalizeDevice) : [];
  // 控制站会返回账号下全部 DSH 设备；离线设备保留在列表中，避免用户误以为设备已被删除。
  return devices.filter((device) => device.status === "active" || device.status === "disabled");
}

// 设备列表只在进入页面时拉取一次时，在线判定会停在加载时的心跳快照上：页面静置超过心跳
// 阈值后所有设备都会被误判为离线，直到刷新页面重新拉取。这里定期重新拉取，
// 设备集合不变时就地更新状态，避免列表在用户操作过程中被重建。
async function refreshDeviceList() {
  if (deviceRefreshInFlight || logoutInProgress || devicePresenceTimer === null) return;
  deviceRefreshInFlight = true;
  try {
    const devices = await fetchVisibleDevices();
    if (devicePresenceTimer === null) return;
    applyDeviceSnapshot(devices);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) expireSession();
  } finally {
    deviceRefreshInFlight = false;
  }
}

function applyDeviceSnapshot(devices) {
  const cards = [...document.querySelectorAll(".device-card")];
  const sameLayout = cards.length === devices.length
    && cards.every((card, index) => card.dataset.deviceCard === devices[index].dshDeviceId);
  if (!sameLayout) {
    renderDeviceList(devices);
    return;
  }
  devicePresence = new Map(devices.map((device) => [device.dshDeviceId, device]));
  refreshDevicePresence();
}

async function logoutBrowserSession() {
  if (logoutInProgress) return;
  logoutInProgress = true;
  const runtime = activeRuntime;
  activeRuntime = null;
  await runtime?.dispose().catch(() => undefined);
  await request("/api/public/auth/h5/logout", { method: "POST" }).catch(() => undefined);
  session = null;
  sessionStorage.removeItem(sessionStorageKey);
  sessionStorage.removeItem(activeDeviceStorageKey);
  render();
  logoutInProgress = false;
}

// 会话过期时统一回到登录页并停掉设备列表定时器，
// 否则轮询会持续收到 401 并反复重绘登录表单。
function expireSession() {
  session = null;
  sessionStorage.removeItem(sessionStorageKey);
  sessionStorage.removeItem(activeDeviceStorageKey);
  stopDeviceTimers();
  renderLogin("登录已过期，请重新登录");
}

// 设备列表是跨版本边界，兼容旧控制站可能返回的下划线字段，避免明细因 DTO 命名差异丢失。
function normalizeDevice(device) {
  return {
    ...device,
    dshDeviceId: device.dshDeviceId ?? device.dsh_device_id ?? device.deviceId ?? device.device_id,
    displayName: device.displayName ?? device.display_name,
    dshVersion: device.dshVersion ?? device.dsh_version,
    computerName: device.computerName ?? device.computer_name,
    lastHeartbeatAt: device.lastHeartbeatAt ?? device.last_heartbeat_at ?? null,
  };
}

function deviceCard(device) {
  const id = escapeHtml(device.dshDeviceId);
  const name = escapeHtml(device.displayName || device.dshDeviceId);
  const online = isDeviceOnline(device);
  return `
    <article class="device-card" data-device-card="${id}" data-status="${escapeHtml(device.status ?? "")}" data-online="${online ? "true" : "false"}">
      <div>
        <div class="device-card__title"><span class="device-status-dot" aria-hidden="true"></span><h3>${name}</h3><span class="mono device-id" title="${id}">${id}</span></div>
        <p class="muted device-details"><span>版本：${escapeHtml(device.dshVersion || "未知")}</span><span>计算机名：${escapeHtml(device.computerName || "未知")}</span></p>
        <p class="muted device-heartbeat" data-online="${online ? "true" : "false"}"${online ? " hidden" : ""}></p>
      </div>
      <div class="device-card__actions">
        <button class="primary" data-device-id="${id}" type="button" ${online ? "" : "disabled"}>${online ? "连接" : "不可用"}</button>
        <button class="danger" data-remove-device="${id}" type="button" title="删除这台离线 DSH Host" ${online ? "hidden" : ""}>删除</button>
      </div>
    </article>
  `;
}

// 只有离线设备才允许删除，且删除不可恢复，因此先确认再调用控制台接口。
// 删除走控制台的 DELETE /api/v1/dsh/devices/:dshDeviceId，沿用 H5 的 HttpOnly Cookie 会话。
async function removeDevice(deviceId, trigger) {
  const status = document.querySelector("#status");
  const card = trigger instanceof Element ? trigger.closest(".device-card") : null;
  if (!deviceId || !card) return;
  if (card.getAttribute("data-online") === "true") {
    status.className = "muted status";
    status.textContent = "设备刚刚恢复在线，已取消删除。";
    return;
  }
  const name = card.querySelector("h3")?.textContent?.trim() || deviceId;
  if (!window.confirm(`确定删除离线设备“${name}”？该 DSH Host 需要重新注册并配对后才能再次使用。`)) return;

  setBusy(trigger, true);
  status.className = "muted status";
  status.textContent = `正在删除 DSH Host ${deviceId}…`;
  try {
    await request(`/api/v1/dsh/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
    if (sessionStorage.getItem(activeDeviceStorageKey) === deviceId) sessionStorage.removeItem(activeDeviceStorageKey);
    devicePresence.delete(deviceId);
    const list = card.parentElement;
    card.remove();
    if (list && list.querySelectorAll(".device-card").length === 0) {
      list.outerHTML = `<p class="empty">当前没有已注册的 DSH Host。</p>`;
    }
    status.textContent = `已删除 DSH Host ${deviceId}。`;
  } catch (error) {
    setBusy(trigger, false);
    if (error instanceof ApiError && error.status === 401) {
      expireSession();
      return;
    }
    status.className = "status error";
    status.textContent = error instanceof Error ? error.message : "删除 DSH 设备失败";
  }
}

async function startBootstrap(deviceId) {
  const status = document.querySelector("#status");
  const buttons = [...document.querySelectorAll("[data-device-id]")];
  stopDeviceTimers();
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
    stopDeviceTimers();
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
    // 连接失败会退回设备列表，此时需要恢复在线状态轮询并立即重新同步一次状态。
    if (document.body.classList.contains("dsh-device-list-mode")) {
      startDeviceTimers();
      void refreshDeviceList();
    }
  }
}

function startDeviceTimers() {
  if (devicePresenceTimer === null) devicePresenceTimer = window.setInterval(refreshDevicePresence, devicePresenceTickMs);
  if (deviceRefreshTimer === null) deviceRefreshTimer = window.setInterval(() => void refreshDeviceList(), deviceRefreshIntervalMs);
}

function stopDeviceTimers() {
  if (devicePresenceTimer !== null) {
    window.clearInterval(devicePresenceTimer);
    devicePresenceTimer = null;
  }
  if (deviceRefreshTimer !== null) {
    window.clearInterval(deviceRefreshTimer);
    deviceRefreshTimer = null;
  }
}

function refreshDevicePresence() {
  for (const card of document.querySelectorAll(".device-card")) {
    const device = devicePresence.get(card.dataset.deviceCard);
    if (device) applyDevicePresence(card, device);
  }
}

// 在线设备只保留状态指示器，心跳时间只在离线时展示；
// 状态取自最近一次拉取的设备快照，不会随页面静置而自行变成离线。
function applyDevicePresence(card, device) {
  const online = isDeviceOnline(device);
  card.setAttribute("data-status", device.status ?? "");
  card.setAttribute("data-online", online ? "true" : "false");

  const presence = card.querySelector(".device-heartbeat");
  if (presence instanceof HTMLElement) {
    presence.setAttribute("data-online", online ? "true" : "false");
    presence.hidden = online;
    presence.textContent = online ? "" : formatDevicePresence(device);
  }

  const connectButton = card.querySelector("[data-device-id]");
  if (connectButton instanceof HTMLButtonElement) {
    connectButton.disabled = !online;
    connectButton.textContent = online ? "连接" : "不可用";
  }

  // 设备恢复心跳后立即收回删除入口，避免误删正在使用的设备。
  const removeButton = card.querySelector("[data-remove-device]");
  if (removeButton instanceof HTMLButtonElement) removeButton.hidden = online;
}

// 优先采用控制站返回的在线判定；旧控制站没有该字段时，用最近一次心跳兜底。
function isDeviceOnline(device) {
  if (device.status !== "active") return false;
  if (typeof device.online === "boolean") return device.online;
  const timestamp = Date.parse(device.lastHeartbeatAt ?? "");
  return Number.isFinite(timestamp) && Date.now() - timestamp < deviceHeartbeatTimeoutMs;
}

function formatDevicePresence(device) {
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
  const key = `codingns4dsh.h5.client-session.${deviceId}`;
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
    cache: options.cache,
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
