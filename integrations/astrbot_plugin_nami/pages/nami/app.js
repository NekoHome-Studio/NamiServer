/**
 * Nami 控制台 —— AstrBot 插件页面脚本。
 *
 * 要点：
 * - 所有数据都来自本插件注册的后端路由（endpoint 不带前导斜杠），
 *   由后端代理访问 Nami，因此 API Key / 管理令牌永远不会到达浏览器。
 * - 所有服务端数据都通过 textContent 写入 DOM，绝不把服务端字符串拼成 HTML，避免 XSS。
 * - 5 秒自动刷新，页面切到后台（document.hidden）时暂停。
 */

const bridge = window.AstrBotPluginPage;

/** 自动刷新间隔（毫秒）。 */
const REFRESH_MS = 5000;

/** 页面上所有需要更新的节点。 */
const dom = {
  banner: document.getElementById("banner"),
  bannerTitle: document.getElementById("banner-title"),
  bannerBody: document.getElementById("banner-body"),
  refreshState: document.getElementById("refresh-state"),
  lastUpdated: document.getElementById("last-updated"),
  pageTitle: document.getElementById("page-title"),
  pageSubtitle: document.getElementById("page-subtitle"),
  card: {
    health: document.getElementById("card-health"),
    healthSub: document.getElementById("card-health-sub"),
    ready: document.getElementById("card-ready"),
    readySub: document.getElementById("card-ready-sub"),
    model: document.getElementById("card-model"),
    provider: document.getElementById("card-provider"),
    uptime: document.getElementById("card-uptime"),
    uptimeSub: document.getElementById("card-uptime-sub"),
    tools: document.getElementById("card-tools"),
    toolsSub: document.getElementById("card-tools-sub"),
    sessions: document.getElementById("card-sessions"),
    sessionsSub: document.getElementById("card-sessions-sub"),
    requests: document.getElementById("card-requests"),
    requestsSub: document.getElementById("card-requests-sub"),
    scopes: document.getElementById("card-scopes"),
    scopesSub: document.getElementById("card-scopes-sub"),
  },
  modelsBody: document.getElementById("models-body"),
  toolsList: document.getElementById("tools-list"),
  toolsSummary: document.getElementById("tools-summary"),
  sessionsBody: document.getElementById("sessions-body"),
  askInput: document.getElementById("ask-input"),
  askSend: document.getElementById("ask-send"),
  askAnswer: document.getElementById("ask-answer"),
  reloadModels: document.getElementById("reload-models"),
  reloadSessions: document.getElementById("reload-sessions"),
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 读取 i18n 文案，缺失时回落到 fallback。 */
function t(key, fallback) {
  try {
    const value = bridge && typeof bridge.t === "function" ? bridge.t(key, fallback) : fallback;
    return typeof value === "string" && value.length > 0 ? value : fallback;
  } catch (error) {
    return fallback;
  }
}

/** 安全地把文本写进节点（永不解析 HTML）。 */
function setText(node, text) {
  if (node) node.textContent = text === null || text === undefined ? "—" : String(text);
}

/** 清空一个节点。 */
function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 创建一个元素，文本一律走 textContent。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 创建一个表格行。 */
function row(cells) {
  const tr = document.createElement("tr");
  cells.forEach((cell) => {
    const td = document.createElement("td");
    if (cell && typeof cell === "object" && cell.node) {
      td.appendChild(cell.node);
    } else {
      td.textContent = cell === null || cell === undefined || cell === "" ? "—" : String(cell);
    }
    tr.appendChild(td);
  });
  return tr;
}

/** 秒 → 中文时长。 */
function fmtUptime(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return "—";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const parts = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分`);
  if (secs || parts.length === 0) parts.push(`${secs} 秒`);
  return parts.join(" ");
}

/** 毫秒时间戳 → 本地时间。 */
function fmtTime(millis) {
  const value = Number(millis);
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Date(value).toLocaleString();
}

/** 危险等级 → 徽章样式。 */
const DANGER_CLASS = { safe: "badge badge-safe", caution: "badge badge-warn", dangerous: "badge badge-danger" };

/** 应用明暗主题。 */
function applyTheme() {
  let isDark = false;
  try {
    isDark = Boolean(bridge.getContext() && bridge.getContext().isDark);
  } catch (error) {
    isDark = false;
  }
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
}

/* ------------------------------------------------------------------ */
/* 各区块渲染                                                          */
/* ------------------------------------------------------------------ */

/** 顶部凭据横幅 + 红色告警横幅。 */
function renderBanner(status) {
  const settings = status.settings || {};
  const health = status.health || {};

  if (!health.ok) {
    dom.banner.className = "banner banner-danger";
    setText(dom.bannerTitle, "Nami 不可达");
    const body = `地址 ${settings.host_root || "—"} 未响应：${health.error || "未知错误"}`;
    setText(dom.bannerBody, body);
    return;
  }

  dom.banner.className = "banner banner-info";
  setText(dom.bannerTitle, `已连接 Nami：${settings.base_url || "—"}`);
  const bits = [
    `服务根地址 ${settings.host_root || "—"}`,
    `API Key ${settings.api_key_configured ? "已配置" : "未配置"}`,
    `管理令牌 ${settings.admin_token_configured ? "已配置" : "未配置"}`,
    `默认模型 ${settings.default_model || "由 Nami 决定"}`,
    `会话作用域 ${settings.session_scope || "—"}`,
    `自动回复 ${settings.auto_reply_enabled ? "已开启" : "已关闭"}`,
  ];
  setText(dom.bannerBody, bits.join(" · "));
}

/** 8 张状态卡片。 */
function renderCards(status) {
  const health = status.health || {};
  const readiness = status.readiness || {};
  const provider = status.provider || {};
  const tools = status.tools || {};
  const sessions = status.sessions || {};
  const requests = status.requests || {};

  setText(dom.card.health, health.ok ? health.status || "ok" : "离线");
  setText(dom.card.healthSub, health.ok ? `版本 ${health.version || "—"} · Node ${health.node || "—"}` : health.error || "");

  setText(dom.card.ready, readiness.ok ? (readiness.ready ? "就绪" : "未就绪") : "查询失败");
  const checks = readiness.checks || {};
  setText(dom.card.readySub, Object.keys(checks).length ? `检查项 ${Object.keys(checks).length} 个` : readiness.error || "");

  setText(dom.card.model, provider.model || "—");
  setText(dom.card.provider, provider.name ? `provider ${provider.name}` : "");

  setText(dom.card.uptime, fmtUptime(health.uptime_seconds));
  setText(dom.card.uptimeSub, health.pid ? `PID ${health.pid}` : "");

  setText(dom.card.tools, `${tools.enabled ?? "—"} / ${tools.total ?? "—"}`);
  setText(dom.card.toolsSub, tools.ok ? "启用 / 总数" : tools.error || "");

  setText(dom.card.sessions, sessions.total ?? "—");
  setText(dom.card.sessionsSub, `消息 ${sessions.messages ?? "—"} 条`);

  setText(dom.card.requests, requests.total ?? "—");
  setText(dom.card.requestsSub, `错误 ${requests.errors ?? "—"} 次`);

  setText(dom.card.scopes, sessions.tracked_scopes ?? "—");
  setText(dom.card.scopesSub, "本插件记住的作用域");
}

/** 模型目录表格。 */
function renderModels(payload) {
  const models = (payload && payload.models) || [];
  clear(dom.modelsBody);
  if (models.length === 0) {
    dom.modelsBody.appendChild(row([{ node: el("span", "muted", "没有模型") }]));
    return;
  }
  models.forEach((model) => {
    const alias = model.alias_of ? el("span", "badge badge-alias", model.alias_of) : "—";
    dom.modelsBody.appendChild(
      row([model.id, { node: alias }, model.parameters, model.quantization, model.size_human, model.owned_by]),
    );
  });
}

/** 工具列表 + 危险等级徽章。 */
function renderTools(payload) {
  const tools = (payload && payload.tools) || [];
  clear(dom.toolsList);
  setText(dom.toolsSummary, payload ? `启用 ${payload.enabled} / ${payload.count}` : "");
  if (tools.length === 0) {
    dom.toolsList.appendChild(el("li", "muted", "没有工具"));
    return;
  }
  tools.forEach((tool) => {
    const li = document.createElement("li");
    li.className = "tool-item";
    li.appendChild(el("span", tool.enabled ? "dot dot-on" : "dot dot-off"));
    li.appendChild(el("span", "tool-name", tool.name));
    li.appendChild(el("span", DANGER_CLASS[tool.danger] || "badge", tool.danger));
    if (!tool.implemented) li.appendChild(el("span", "badge badge-muted", "未实现"));
    if (tool.description) li.appendChild(el("span", "muted small tool-desc", tool.description));
    dom.toolsList.appendChild(li);
  });
}

/** 会话表格，每行一个删除按钮。 */
function renderSessions(payload) {
  const sessions = (payload && payload.sessions) || [];
  clear(dom.sessionsBody);
  if (sessions.length === 0) {
    dom.sessionsBody.appendChild(row([{ node: el("span", "muted", "没有会话") }]));
    return;
  }
  sessions.forEach((session) => {
    const button = el("button", "btn btn-danger btn-small", "删除");
    button.type = "button";
    button.addEventListener("click", () => deleteSession(session.id, button));
    dom.sessionsBody.appendChild(
      row([session.id, session.title, session.message_count, fmtTime(session.updated_at), { node: button }]),
    );
  });
}

/* ------------------------------------------------------------------ */
/* 网络调用                                                            */
/* ------------------------------------------------------------------ */

/** 拉取并渲染状态卡片与横幅。 */
async function refreshStatus() {
  const status = await bridge.apiGet("status");
  renderBanner(status || {});
  renderCards(status || {});
  setText(dom.lastUpdated, `更新于 ${new Date().toLocaleTimeString()}`);
}

/** 拉取模型目录；失败时不清空旧数据，只提示。 */
async function refreshModels() {
  try {
    renderModels(await bridge.apiGet("models"));
  } catch (error) {
    clear(dom.modelsBody);
    dom.modelsBody.appendChild(row([{ node: el("span", "error-text", describe(error)) }]));
  }
}

/** 拉取工具列表。 */
async function refreshTools() {
  try {
    renderTools(await bridge.apiGet("tools"));
  } catch (error) {
    clear(dom.toolsList);
    dom.toolsList.appendChild(el("li", "error-text", describe(error)));
  }
}

/** 拉取会话列表。 */
async function refreshSessions() {
  try {
    renderSessions(await bridge.apiGet("sessions", { limit: 50 }));
  } catch (error) {
    clear(dom.sessionsBody);
    dom.sessionsBody.appendChild(row([{ node: el("span", "error-text", describe(error)) }]));
  }
}

/** 删除一个会话（POST 到 sessions/delete，后端再转成 DELETE 代理给 Nami）。 */
async function deleteSession(id, button) {
  if (!id) return;
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    await bridge.apiPost("sessions/delete", { id });
    await Promise.all([refreshSessions(), refreshStatus()]);
  } catch (error) {
    button.disabled = false;
    button.textContent = "删除失败";
    window.setTimeout(() => {
      button.textContent = "删除";
    }, 2000);
    setText(dom.askAnswer, describe(error));
  }
}

/** 直接提问。 */
async function ask() {
  const prompt = (dom.askInput.value || "").trim();
  if (!prompt) return;
  dom.askSend.disabled = true;
  setText(dom.askAnswer, "Nami 正在思考…");
  try {
    const result = await bridge.apiPost("ask", { prompt });
    const usage = (result && result.usage) || {};
    const meta = [`模型 ${(result && result.model) || "—"}`, `会话 ${(result && result.session_id) || "—"}`];
    if (usage.total_tokens !== undefined) meta.push(`tokens ${usage.total_tokens}`);
    setText(dom.askAnswer, `${meta.join(" · ")}\n\n${(result && result.answer) || "（空回答）"}`);
    await refreshStatus();
  } catch (error) {
    setText(dom.askAnswer, describe(error));
  } finally {
    dom.askSend.disabled = false;
  }
}

/** 把异常渲染成一句可读的话。 */
function describe(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  return error.message || error.error || JSON.stringify(error);
}

/* ------------------------------------------------------------------ */
/* 刷新调度                                                            */
/* ------------------------------------------------------------------ */

let timer = null;

/** 一轮完整刷新。 */
async function refreshAll() {
  try {
    await Promise.all([refreshStatus(), refreshModels(), refreshTools(), refreshSessions()]);
  } catch (error) {
    setText(dom.bannerTitle, "刷新失败");
    setText(dom.bannerBody, describe(error));
  }
}

/** 启动 5 秒定时刷新；页面隐藏时自动跳过。 */
function startAutoRefresh() {
  stopAutoRefresh();
  timer = window.setInterval(() => {
    if (document.hidden) return;
    refreshAll();
  }, REFRESH_MS);
  dom.refreshState.className = "pill pill-live";
  setText(dom.refreshState, `每 ${REFRESH_MS / 1000} 秒自动刷新`);
}

/** 停止定时刷新。 */
function stopAutoRefresh() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/** 页面可见性变化：后台暂停、回前台立即刷新。 */
function onVisibilityChange() {
  if (document.hidden) {
    stopAutoRefresh();
    dom.refreshState.className = "pill pill-idle";
    setText(dom.refreshState, "自动刷新已暂停");
  } else {
    startAutoRefresh();
    refreshAll();
  }
}

/** 绑定交互。 */
function bindEvents() {
  dom.reloadModels.addEventListener("click", refreshModels);
  dom.reloadSessions.addEventListener("click", refreshSessions);
  dom.askSend.addEventListener("click", ask);
  dom.askInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") ask();
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (typeof bridge.onContext === "function") bridge.onContext(applyTheme);
}

/** 入口。 */
async function main() {
  setText(dom.pageTitle, t("pages.nami.title", "Nami 控制台"));
  setText(dom.pageSubtitle, t("pages.nami.description", dom.pageSubtitle.textContent));
  applyTheme();
  try {
    await bridge.ready();
  } catch (error) {
    setText(dom.bannerTitle, "AstrBot 页面桥接不可用");
    setText(dom.bannerBody, "请在 AstrBot WebUI 的插件详情页中打开本页面。");
    return;
  }
  applyTheme();
  bindEvents();
  await refreshAll();
  startAutoRefresh();
}

main();
