const config = window.__DSH_BOOTSTRAP_CONFIG__ ?? {};
const controlApiBaseUrl = String(config.controlApiBaseUrl ?? "").replace(/\/+$/, "");
const sessionStorageKey = "dsh-codingns.h5.session";
const app = document.querySelector("#app");

let session = readSession();
let activeRuntime = null;

render();

function render() {
  if (!session) {
    renderLogin();
    return;
  }

  renderDevices();
}

function renderLogin(errorMessage = "") {
  app.innerHTML = `
    <form class="form" id="login-form">
      <div>
        <h2>登录控制站</h2>
        <p class="muted">使用控制站 HttpOnly 会话，不把 access token 或 refresh token 放进页面存储。</p>
      </div>
      <label>邮箱<input name="email" type="email" autocomplete="email" required /></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required /></label>
      ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
      <button class="primary" type="submit">登录并读取 DSH 设备</button>
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
  app.innerHTML = `
    <div class="loading"><span class="spinner"></span><span>读取 DSH 设备…</span></div>
  `;

  try {
    const response = await request("/api/v1/dsh/devices");
    const devices = Array.isArray(response.devices) ? response.devices : [];
    const online = devices.filter((device) => device.status === "active" && device.online);
    app.innerHTML = `
      <div class="panel-heading">
        <div>
          <p class="eyebrow">${escapeHtml(session.email ?? "已登录")}</p>
          <h2>选择 DSH Host</h2>
        </div>
        <button class="quiet" id="logout" type="button">退出</button>
      </div>
      ${online.length === 0 ? `<p class="empty">当前没有在线的 DSH Host。</p>` : `<div class="device-list">${online.map(deviceCard).join("")}</div>`}
      <p id="status" class="muted status" role="status"></p>
    `;
    document.querySelector("#logout").addEventListener("click", async () => {
      await activeRuntime?.dispose().catch(() => undefined);
      activeRuntime = null;
      await request("/api/public/auth/h5/logout", { method: "POST" }).catch(() => undefined);
      session = null;
      sessionStorage.removeItem(sessionStorageKey);
      render();
    });
    for (const button of document.querySelectorAll("[data-device-id]")) {
      button.addEventListener("click", () => startBootstrap(button.dataset.deviceId));
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      session = null;
      sessionStorage.removeItem(sessionStorageKey);
      renderLogin("登录已过期，请重新登录");
      return;
    }
    app.innerHTML = `<p class="error">${escapeHtml(error instanceof Error ? error.message : "读取设备失败")}</p>`;
  }
}

function deviceCard(device) {
  const id = escapeHtml(device.dshDeviceId);
  const name = escapeHtml(device.displayName || device.dshDeviceId);
  const heartbeat = device.lastHeartbeatAt ? new Date(device.lastHeartbeatAt).toLocaleString() : "未知";
  return `
    <article class="device-card">
      <div>
        <h3>${name}</h3>
        <p class="mono">${id}</p>
        <p class="muted">最后心跳：${escapeHtml(heartbeat)}</p>
      </div>
      <button class="primary" data-device-id="${id}" type="button">连接</button>
    </article>
  `;
}

async function startBootstrap(deviceId) {
  const status = document.querySelector("#status");
  const buttons = [...document.querySelectorAll("[data-device-id]")];
  buttons.forEach((button) => setBusy(button, true));
  status.textContent = "正在申请 Client ticket…";
  try {
    const api = window.DshCodingNsH5;
    if (!api) throw new Error("H5 runtime 尚未加载");
    status.textContent = "正在建立加密 WebRTC 通道并读取远程 DSH Web…";
    activeRuntime = await api.startDshH5BrowserBootstrap({
      controlApi: api.createHttpDshH5ControlApi(controlApiBaseUrl),
      dshDeviceId: deviceId,
      webContext: { container: app },
    });
    window.dispatchEvent(new CustomEvent("dsh-bootstrap-ready", { detail: { deviceId, runtime: activeRuntime } }));
  } catch (error) {
    await activeRuntime?.dispose().catch(() => undefined);
    activeRuntime = null;
    buttons.forEach((button) => setBusy(button, false));
    status.className = "status error";
    status.textContent = error instanceof Error ? error.message : "申请 ticket 失败";
  }
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
