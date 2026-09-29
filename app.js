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
// 后退手势参数：只在屏幕左缘起手，避免与 iframe 内横向滚动/侧边栏手势冲突。
const edgeZonePx = 22;
const swipeTriggerPx = 56;
const swipeMaxVerticalPx = 70;
// 远程视图会在历史里压入一条哨兵记录，使系统返回键/手势能先回到设备列表。
const remoteViewHistoryState = { codingns4dsh: "remote-view" };

let session = readSession();
let activeRuntime = null;
let devicePresenceTimer = null;
let deviceRefreshTimer = null;
let deviceRefreshInFlight = false;
let devicePresence = new Map();
let logoutInProgress = false;
// 当前视图：login | devices | remote。后退手势与系统返回键都依据它决定语义。
let currentView = "login";

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
//
// 但 iOS 主屏 Web App 切到后台也会触发 pagehide，若立即 dispose 会导致
// 每次切换应用都断连。因此改为「宽限期 + 可取消」：只有确认没有回到前台
// 才真正释放。即使真的残留，getClientSessionId 的固定 sessionId 也会让
// 新连接顶掉旧连接，不会产生 TOO_MANY_CLIENTS。
const pageHideDisposeGraceMs = 30_000;
let pendingDisposeTimer = null;

function scheduleRuntimeDispose() {
  cancelPendingDispose();
  pendingDisposeTimer = window.setTimeout(() => {
    pendingDisposeTimer = null;
    const runtime = activeRuntime;
    if (runtime === null) return;
    activeRuntime = null;
    void runtime.dispose().catch(() => undefined);
  }, pageHideDisposeGraceMs);
}

function cancelPendingDispose() {
  if (pendingDisposeTimer === null) return;
  window.clearTimeout(pendingDisposeTimer);
  pendingDisposeTimer = null;
}

window.addEventListener("pagehide", () => {
  scheduleRuntimeDispose();
});

// 回到前台时取消待释放的运行时，保持 WebRTC 会话存活。
window.addEventListener("pageshow", () => {
  cancelPendingDispose();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") cancelPendingDispose();
});

// 启动顺序集中在文件末尾：这些函数会读取下方的 let/const 状态
// （如 backButton、hapticPatterns），提前调用会命中 TDZ 而抛 ReferenceError。

function setRemoteWebMode(enabled) {
  document.body.classList.toggle("remote-web-mode", enabled);
}

// 视图状态是后退语义的唯一依据：remote 内后退回设备列表，列表页后退才允许退出。
// 只有这里触发哨兵与手势的同步，避免在退出过程中被重新压入历史记录。
function setView(view) {
  currentView = view;
  syncBackAffordances();
}

function render() {
  stopDeviceTimers();
  document.body.classList.remove("dsh-device-list-mode");
  setRemoteWebMode(false);
  if (!session) {
    renderLogin();
    // iOS 主屏 Web App 的 sessionStorage 与 Safari 隔离，但 Cookie 可能仍有效。
    void restoreSessionFromCookie();
    return;
  }

  renderDevices();
}

function renderLogin(errorMessage = "") {
  document.body.classList.remove("dsh-device-list-mode");
  setRemoteWebMode(false);
  setView("login");
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
    // currentTarget 在 await 之后会被置为 null，必须提前捕获表单引用，
    // 否则登录失败时 catch 里的 setBusy 会抛 TypeError 并吞掉真正的错误提示。
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(formElement, true);
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
      setBusy(formElement, false);
      renderLogin(error instanceof Error ? error.message : "登录失败");
    }
  });
}

async function renderDevices() {
  stopDeviceTimers();
  document.body.classList.add("dsh-device-list-mode");
  setRemoteWebMode(false);
  setView("devices");
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
  dropRemoteHistorySentinel();
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

// 从远程视图内登出或会话过期时，历史里的哨兵记录会让后退键无目标可退。
// 回到登录页后统一把它弹掉，避免用户按返回键时出现空白历史项。
function dropRemoteHistorySentinel() {
  if (!hasRemoteHistorySentinel()) return;
  try {
    history.back();
  } catch {
    // 忽略：部分环境不允许脚本触发返回。
  }
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
    setView("remote");
    haptic("success");
    window.dispatchEvent(new CustomEvent("dsh-bootstrap-ready", { detail: { deviceId, runtime: activeRuntime } }));
  } catch (error) {
    await activeRuntime?.dispose().catch(() => undefined);
    activeRuntime = null;
    setRemoteWebMode(false);
    setView("devices");
    haptic("error");
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

/* ===================== 触感反馈 ===================== */

// Android Chrome 支持 navigator.vibrate。iOS Safari 从未实现 Vibration API，
// 社区做法是借隐藏 <input type="switch"> 触发系统开关触感，但该技巧在
// iOS 26.5+ 已被 Apple 封堵（见 flarum/framework#4694）。
// 因此这里把 iOS 路径当作「可选增强」：失败必须静默降级，绝不阻塞交互。
const hapticPatterns = {
  light: [10],
  medium: [18],
  success: [12, 40, 20],
  error: [30, 60, 30],
};

let iosHapticLabel = null;

function isIos() {
  return /iP(?:hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// iOS 技巧：点击关联到 <input type="checkbox" switch> 的 <label>，
// 由系统产生开关切换触感。必须点击 label（而不是 input），
// 且每次需要改变 checked 状态，否则没有状态变化也就没有触感。
// 该技巧在 iOS 26.5+ 已失效，此时静默降级。
function tryIosHaptic() {
  try {
    if (iosHapticLabel === null) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      input.id = "codingns4dsh-haptic";
      input.setAttribute("aria-hidden", "true");
      input.tabIndex = -1;
      input.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;";
      const label = document.createElement("label");
      label.setAttribute("for", input.id);
      label.setAttribute("aria-hidden", "true");
      label.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.append(label, input);
      iosHapticLabel = label;
    }
    const input = document.getElementById("codingns4dsh-haptic");
    if (input instanceof HTMLInputElement) input.checked = !input.checked;
    iosHapticLabel.click();
  } catch {
    // 静默降级：触感永远不是功能依赖。
  }
}

/** 统一的触感入口；不支持时安全返回 false。 */
function haptic(kind = "light") {
  if (typeof navigator.vibrate === "function") {
    try {
      return navigator.vibrate(hapticPatterns[kind] ?? hapticPatterns.light);
    } catch {
      return false;
    }
  }
  if (isIos()) {
    tryIosHaptic();
    return true;
  }
  return false;
}

/* ===================== 后退手势与系统返回键 ===================== */

// 本项目所有视图切换都是内存状态，代码库中没有一处 history 调用，
// 因此默认情况下：Android 返回键会直接退出 PWA，iOS 主屏 Web App 则
// 完全没有边缘滑动返回。这里用「哨兵历史记录 + 视图状态机」补齐语义：
//   远程 Web 内后退 → 回设备列表（并释放 Relay 会话）→ 列表页再后退才退出。
let backButton = null;
let gestureZone = null;
let swipeTracking = false;
let swipeStartX = 0;
let swipeStartY = 0;
let swipeStartAt = 0;

function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches === true
    || window.matchMedia?.("(display-mode: fullscreen)")?.matches === true
    || navigator.standalone === true;
}

function hasRemoteHistorySentinel() {
  return history.state?.codingns4dsh === remoteViewHistoryState.codingns4dsh;
}

// 进入远程视图时压入一条哨兵记录，使系统返回键/手势有可回退的目标。
function ensureRemoteHistorySentinel() {
  if (hasRemoteHistorySentinel()) return;
  try {
    history.pushState(remoteViewHistoryState, "", location.href);
  } catch {
    // 极少数环境禁止 pushState，此时退回「返回按钮 + 自定义手势」。
  }
}

// 释放 WebRTC / 信令 / iframe WebSocket，并回到设备列表。
// 主动释放可避免 Relay 房间长期保留旧 Client 触发 TOO_MANY_CLIENTS。
//
// 关键顺序：必须先同步切走视图状态，再 await dispose()。
// popstate 处理器在调用本函数后会紧接着同步执行 syncBackAffordances()，
// 若此时 currentView 仍是 "remote"，就会重新压入哨兵记录，导致返回后
// 历史状态残留、第二次返回无目标可退。
async function exitRemoteView() {
  if (currentView !== "remote") return;
  const runtime = activeRuntime;
  activeRuntime = null;
  sessionStorage.removeItem(activeDeviceStorageKey);
  setRemoteWebMode(false);
  setView("devices");
  render();
  await runtime?.dispose().catch(() => undefined);
}

function syncBackAffordances() {
  const inRemote = currentView === "remote";
  if (backButton !== null) backButton.hidden = !inRemote;
  if (inRemote) {
    ensureRemoteHistorySentinel();
    attachRemoteSwipe();
  }
}

function handleBackRequest() {
  if (currentView === "remote") {
    haptic("light");
    // 先切换视图，再弹掉哨兵，避免 popstate 二次触发退出逻辑。
    void exitRemoteView().then(() => {
      if (hasRemoteHistorySentinel()) history.back();
    });
    return true;
  }
  return false;
}

function initBackNavigation() {
  backButton = document.querySelector("[data-back-button]");
  gestureZone = document.querySelector("[data-back-gesture-zone]");

  backButton?.addEventListener("click", () => {
    handleBackRequest();
  });

  // Android 返回键、iOS 浏览器内边缘滑动、以及我们自己的 history.back()
  // 最终都会走到这里。
  window.addEventListener("popstate", () => {
    if (currentView === "remote") void exitRemoteView();
    syncBackAffordances();
  });

  // 兜底手势区：仅在无法访问同源 iframe 文档时才启用。
  if (gestureZone !== null) {
    attachSwipeListeners(gestureZone);
  }
}

function beginSwipe(x, y) {
  swipeTracking = true;
  swipeStartX = x;
  swipeStartY = y;
  swipeStartAt = Date.now();
}

// 返回 true 表示这是一次明确的横向手势，应当吞掉事件避免触发 iframe 内滚动。
function moveSwipe(x, y, event) {
  if (!swipeTracking) return false;
  const deltaX = x - swipeStartX;
  const deltaY = y - swipeStartY;
  // 纵向意图明显时放弃接管，交还给页面/iframe 正常滚动。
  if (Math.abs(deltaY) > swipeMaxVerticalPx && Math.abs(deltaY) > Math.abs(deltaX)) {
    swipeTracking = false;
    return false;
  }
  if (deltaX > 0 && Math.abs(deltaX) > Math.abs(deltaY)) {
    event?.preventDefault?.();
    return true;
  }
  return false;
}

function endSwipe(x) {
  if (!swipeTracking) return false;
  swipeTracking = false;
  const deltaX = x - swipeStartX;
  const elapsed = Date.now() - swipeStartAt;
  // 位移足够，或快速轻扫（速度兜底），都判定为返回。
  return deltaX >= swipeTriggerPx || (deltaX >= 30 && elapsed < 250);
}

// 把边缘手势监听挂到同源 iframe 文档上。iframe 内的 touch 事件不会冒泡到
// 父页面，因此必须直接在其文档上监听。srcdoc + allow-same-origin 使
// contentDocument 可访问；若不可访问则退回窄边兜底区。
// 用 WeakSet 去重：srcdoc 导航会替换文档对象，load 之后需要重新挂载。
const swipeAttachedDocuments = new WeakSet();

function attachSwipeListeners(target) {
  if (target === null || swipeAttachedDocuments.has(target)) return;
  swipeAttachedDocuments.add(target);

  target.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch.clientX > edgeZonePx) return;
    beginSwipe(touch.clientX, touch.clientY);
  }, { passive: true });

  target.addEventListener("touchmove", (event) => {
    if (!swipeTracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    // 需要 preventDefault 阻断 iframe 自身滚动，故必须 passive: false。
    moveSwipe(touch.clientX, touch.clientY, event);
  }, { passive: false });

  target.addEventListener("touchend", (event) => {
    if (!swipeTracking) return;
    const touch = event.changedTouches[0];
    if (touch && endSwipe(touch.clientX)) handleBackRequest();
    else swipeTracking = false;
  }, { passive: true });

  target.addEventListener("touchcancel", () => {
    swipeTracking = false;
  }, { passive: true });
}

let swipeBoundIframe = null;

function attachRemoteSwipe() {
  const iframe = activeRuntime?.webContext?.iframe;
  if (iframe === null || iframe === undefined) return;

  // srcdoc 导航完成后文档会被替换，必须在其 load 后重新挂载。
  if (swipeBoundIframe !== iframe) {
    swipeBoundIframe = iframe;
    iframe.addEventListener("load", () => attachRemoteSwipe(), { passive: true });
  }

  let doc = null;
  try {
    doc = iframe.contentDocument;
  } catch {
    doc = null;
  }
  if (doc === null) {
    // 跨源或沙箱受限：启用窄边手势区作为兜底。
    document.body.classList.add("back-gesture-fallback");
    return;
  }
  document.body.classList.remove("back-gesture-fallback");
  attachSwipeListeners(doc);
}

/* ===================== 安装引导 ===================== */

// Android Chrome 触发 beforeinstallprompt 后需要由用户手势调用 prompt()；
// iOS 没有安装 API，只能提示用户手动「添加到主屏幕」。
let deferredInstallPrompt = null;

function initInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    showInstallHint("android");
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    document.querySelector("[data-install-hint]")?.remove();
  });

  // iOS Safari 无安装事件，需要在浏览器标签页中主动提示一次。
  if (isIos() && !isStandalone()) showInstallHint("ios");
}

function showInstallHint(platform) {
  if (document.querySelector("[data-install-hint]") !== null) return;
  if (localStorage.getItem("codingns4dsh.h5.install-hint-dismissed") === "1") return;

  const hint = document.createElement("div");
  hint.className = "install-hint";
  hint.setAttribute("data-install-hint", platform);
  hint.setAttribute("role", "note");
  hint.innerHTML = platform === "ios"
    ? `<span>安装到主屏：点底部「分享」<b>⎋</b> → 「添加到主屏幕」，即可全屏使用。</span>`
    : `<span>把 DSH Web 安装到桌面，获得全屏体验。</span>`;
  const action = document.createElement("button");
  action.type = "button";
  action.className = "install-hint__action";
  action.textContent = platform === "ios" ? "知道了" : "安装";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "install-hint__dismiss";
  dismiss.setAttribute("aria-label", "不再提示");
  dismiss.textContent = "×";
  hint.append(action, dismiss);

  action.addEventListener("click", async () => {
    if (platform === "android" && deferredInstallPrompt !== null) {
      const prompt = deferredInstallPrompt;
      deferredInstallPrompt = null;
      hint.remove();
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch {
        // 用户取消或环境不支持，忽略。
      }
      return;
    }
    dismissHint(hint);
  });
  dismiss.addEventListener("click", () => dismissHint(hint));
  document.body.append(hint);
}

function dismissHint(hint) {
  localStorage.setItem("codingns4dsh.h5.install-hint-dismissed", "1");
  hint.remove();
}

/* ===================== 会话恢复（iOS 主屏独立 Cookie 空间） ===================== */

// iOS 主屏 Web App 与 Safari 使用相互隔离的网站数据，因此 sessionStorage
// 里的会话摘要不会带过去，但 HttpOnly Cookie 可能仍然有效。这里静默探测
// 一次：成功则直接进入设备列表，避免每次从主屏启动都要求重新登录。
async function restoreSessionFromCookie() {
  if (session !== null) return;
  try {
    const response = await request("/api/v1/dsh/devices", { cache: "no-store" });
    const devices = Array.isArray(response.devices) ? response.devices.map(normalizeDevice) : [];
    session = { expiresAt: null, email: response?.account?.email ?? null };
    sessionStorage.setItem(sessionStorageKey, JSON.stringify(session));
    // 复用这次探测的结果，避免紧接着再拉一次设备列表。
    stopDeviceTimers();
    document.body.classList.add("dsh-device-list-mode");
    setRemoteWebMode(false);
    setView("devices");
    renderDeviceList(devices);
    startDeviceTimers();
    const rememberedDeviceId = sessionStorage.getItem(activeDeviceStorageKey);
    if (rememberedDeviceId && devices.some((device) => device.dshDeviceId === rememberedDeviceId && isDeviceOnline(device))) {
      queueMicrotask(() => startBootstrap(rememberedDeviceId));
    }
  } catch {
    // 401 或其他错误都保持登录页，不打扰用户。
  }
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

/* ===================== 启动 ===================== */

// 放在文件末尾，确保上方所有 let/const（backButton、hapticPatterns 等）
// 都已初始化，避免 TDZ 抛错。
startParticleField();
render();
initBackNavigation();
initInstallPrompt();
