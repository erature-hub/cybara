const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4269";
const SOCKET_PATH = "/api/browser-extension/ws";
const PROTOCOL = "cybara-browser-extension.v1";
const PING_INTERVAL_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const GROUP_TITLE = "Cybara";
const RECONNECT_ALARM = "cybara-reconnect";

const state = {
  socket: null,
  status: "disconnected",
  error: "",
  gatewayUrl: DEFAULT_GATEWAY_URL,
  token: "",
  sharedTabs: new Set(),
  ownedTabs: new Set(),
  attachedTabs: new Set(),
  reconnectDelay: 1_000,
  reconnectTimer: null,
  pingTimer: null,
  groupId: null,
  ready: null,
};

function chromeProduct() {
  const match = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
  return match ? `Chrome/${match[1]}` : "Chrome/0";
}

async function loadState() {
  const stored = await chrome.storage.local.get(["gatewayUrl", "token"]);
  state.gatewayUrl = typeof stored.gatewayUrl === "string" && stored.gatewayUrl ? stored.gatewayUrl : DEFAULT_GATEWAY_URL;
  state.token = typeof stored.token === "string" ? stored.token : "";
  const session = await chrome.storage.session.get(["sharedTabs", "ownedTabs"]);
  const openTabs = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
  state.sharedTabs = new Set((session.sharedTabs ?? []).filter((id) => openTabs.has(id)));
  state.ownedTabs = new Set((session.ownedTabs ?? []).filter((id) => openTabs.has(id)));
}

function ensureReady() {
  if (!state.ready) state.ready = loadState();
  return state.ready;
}

async function persistTabs() {
  await chrome.storage.session.set({
    sharedTabs: [...state.sharedTabs],
    ownedTabs: [...state.ownedTabs],
  });
}

function socketUrl() {
  const base = new URL(state.gatewayUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${SOCKET_PATH}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function send(message) {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify(message));
}

async function tabSummary(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      tabId,
      url: tab.url ?? "",
      title: tab.title ?? "",
      shared: state.sharedTabs.has(tabId),
    };
  } catch {
    return null;
  }
}

async function sharedTabSummaries() {
  const summaries = await Promise.all([...state.sharedTabs].map((tabId) => tabSummary(tabId)));
  return summaries.filter(Boolean);
}

function setStatus(status, error = "") {
  state.status = status;
  state.error = error;
  chrome.runtime.sendMessage({ type: "state-changed" }).catch(() => undefined);
}

function clearTimers() {
  if (state.pingTimer) clearInterval(state.pingTimer);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.pingTimer = null;
  state.reconnectTimer = null;
}

async function detachAll() {
  const tabs = [...state.attachedTabs];
  state.attachedTabs.clear();
  await Promise.all(tabs.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => undefined)));
}

function scheduleReconnect() {
  if (!state.token || state.reconnectTimer) return;
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect() {
  await ensureReady();
  if (state.socket && state.socket.readyState <= WebSocket.OPEN) return;
  clearTimers();
  if (!state.token) {
    setStatus("needs-token", "Paste the pairing token from Cybara → Settings → Browser.");
    return;
  }
  let url;
  try {
    url = socketUrl();
  } catch {
    setStatus("error", "The Cybara address is not a valid URL.");
    return;
  }
  setStatus("connecting");
  const socket = new WebSocket(url, [PROTOCOL, `token.${state.token}`]);
  state.socket = socket;
  socket.onopen = async () => {
    if (state.socket !== socket) return;
    state.reconnectDelay = 1_000;
    send({
      type: "hello",
      version: chrome.runtime.getManifest().version,
      product: chromeProduct(),
      userAgent: navigator.userAgent,
      tabs: await sharedTabSummaries(),
    });
    state.pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
    setStatus("connected");
  };
  socket.onmessage = (event) => {
    if (state.socket !== socket) return;
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return;
    }
    if (message?.type === "request") void answer(message);
  };
  socket.onclose = (event) => {
    if (state.socket !== socket) return;
    state.socket = null;
    clearTimers();
    void detachAll();
    const reason =
      event.code === 1006
        ? "Cybara is not reachable. Is the app running?"
        : event.reason || `Disconnected (${event.code})`;
    setStatus("disconnected", reason);
    if (event.code === 4001) return;
    scheduleReconnect();
  };
}

function disconnect(reason) {
  const socket = state.socket;
  state.socket = null;
  clearTimers();
  void detachAll();
  if (socket) socket.close(1000, reason);
  setStatus("disconnected", reason);
}

function assertAllowedTab(tabId) {
  if (typeof tabId !== "number") throw new Error("A tab id is required.");
  if (!state.sharedTabs.has(tabId) && !state.ownedTabs.has(tabId)) {
    throw new Error("That tab has not been shared with Cybara.");
  }
}

async function cybaraGroup(windowId, tabId) {
  try {
    if (state.groupId !== null) {
      const group = await chrome.tabGroups.get(state.groupId).catch(() => null);
      if (group && group.windowId === windowId) {
        await chrome.tabs.group({ groupId: state.groupId, tabIds: [tabId] });
        return;
      }
    }
    state.groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await chrome.tabGroups.update(state.groupId, { title: GROUP_TITLE, color: "yellow" });
  } catch {
    state.groupId = null;
  }
}

async function attachTab(tabId) {
  assertAllowedTab(tabId);
  if (!state.attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      if (!String(error?.message ?? error).includes("already attached")) throw error;
    }
    state.attachedTabs.add(tabId);
  }
  const { targetInfo } = await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo");
  return { targetInfo };
}

const handlers = {
  async "tabs.create"(params) {
    const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = await chrome.tabs.create({
      url: typeof params.url === "string" && params.url ? params.url : "about:blank",
      active: true,
      windowId: current?.windowId,
    });
    state.ownedTabs.add(tab.id);
    await persistTabs();
    await cybaraGroup(tab.windowId, tab.id);
    return { tabId: tab.id };
  },
  async "tabs.remove"(params) {
    assertAllowedTab(params.tabId);
    if (!state.ownedTabs.has(params.tabId)) throw new Error("Cybara only closes tabs it opened.");
    await chrome.tabs.remove(params.tabId);
    return {};
  },
  async "tabs.activate"(params) {
    assertAllowedTab(params.tabId);
    const tab = await chrome.tabs.update(params.tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return {};
  },
  async "tabs.list"() {
    return { tabs: await sharedTabSummaries() };
  },
  async "debugger.attach"(params) {
    return await attachTab(params.tabId);
  },
  async "debugger.detach"(params) {
    if (typeof params.tabId !== "number") return {};
    state.attachedTabs.delete(params.tabId);
    await chrome.debugger.detach({ tabId: params.tabId }).catch(() => undefined);
    return {};
  },
  async "debugger.send"(params) {
    assertAllowedTab(params.tabId);
    if (!state.attachedTabs.has(params.tabId)) throw new Error("The tab is not attached.");
    const target = { tabId: params.tabId };
    if (typeof params.sessionId === "string" && params.sessionId) target.sessionId = params.sessionId;
    return (await chrome.debugger.sendCommand(target, params.method, params.params ?? {})) ?? {};
  },
};

async function answer(message) {
  const handler = handlers[message.method];
  try {
    if (!handler) throw new Error(`Unsupported request ${message.method}`);
    const result = await handler(message.params ?? {});
    send({ type: "response", id: message.id, result });
  } catch (error) {
    send({ type: "response", id: message.id, error: String(error?.message ?? error) });
  }
}

async function setBadge(tabId) {
  const shared = state.sharedTabs.has(tabId) || state.ownedTabs.has(tabId);
  await chrome.action.setBadgeText({ tabId, text: shared ? "ON" : "" }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#F4B400" }).catch(() => undefined);
}

async function shareTab(tabId) {
  state.sharedTabs.add(tabId);
  await persistTabs();
  await setBadge(tabId);
  const summary = await tabSummary(tabId);
  if (summary) send({ type: "event", event: "tab.updated", tab: summary });
}

async function unshareTab(tabId) {
  state.sharedTabs.delete(tabId);
  await persistTabs();
  await setBadge(tabId);
  if (!state.ownedTabs.has(tabId) && state.attachedTabs.has(tabId)) {
    state.attachedTabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    send({ type: "event", event: "debugger.detach", tabId, reason: "unshared" });
  }
  const summary = await tabSummary(tabId);
  if (summary) send({ type: "event", event: "tab.updated", tab: summary });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !state.attachedTabs.has(source.tabId)) return;
  send({
    type: "event",
    event: "debugger.event",
    tabId: source.tabId,
    sessionId: source.sessionId,
    method,
    params,
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  state.attachedTabs.delete(source.tabId);
  send({ type: "event", event: "debugger.detach", tabId: source.tabId, reason });
  if (reason === "canceled_by_user") {
    state.sharedTabs.delete(source.tabId);
    state.ownedTabs.delete(source.tabId);
    void persistTabs();
    void setBadge(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const known = state.sharedTabs.has(tabId) || state.ownedTabs.has(tabId);
  state.sharedTabs.delete(tabId);
  state.ownedTabs.delete(tabId);
  state.attachedTabs.delete(tabId);
  if (!known) return;
  void persistTabs();
  send({ type: "event", event: "tab.removed", tabId });
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!state.sharedTabs.has(tabId) && !state.ownedTabs.has(tabId)) return;
  if (change.status === "loading") void setBadge(tabId);
  if (!state.sharedTabs.has(tabId) || (change.title === undefined && change.url === undefined)) return;
  void tabSummary(tabId).then((summary) => {
    if (summary) send({ type: "event", event: "tab.updated", tab: summary });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  void (async () => {
    await ensureReady();
    switch (message?.type) {
      case "get-state": {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        respond({
          status: state.status,
          error: state.error,
          gatewayUrl: state.gatewayUrl,
          hasToken: Boolean(state.token),
          activeTab: active
            ? {
                tabId: active.id,
                title: active.title ?? "",
                url: active.url ?? "",
                shared: state.sharedTabs.has(active.id),
                owned: state.ownedTabs.has(active.id),
                shareable: /^(https?|file):/.test(active.url ?? ""),
              }
            : null,
          sharedTabs: await sharedTabSummaries(),
        });
        return;
      }
      case "save-settings": {
        state.gatewayUrl = String(message.gatewayUrl || DEFAULT_GATEWAY_URL).trim();
        if (typeof message.token === "string" && message.token.trim()) state.token = message.token.trim();
        await chrome.storage.local.set({ gatewayUrl: state.gatewayUrl, token: state.token });
        disconnect("Reconnecting with new settings");
        state.reconnectDelay = 1_000;
        await connect();
        respond({ ok: true });
        return;
      }
      case "forget-token": {
        state.token = "";
        await chrome.storage.local.remove("token");
        disconnect("Pairing removed");
        setStatus("needs-token", "Paste the pairing token from Cybara → Settings → Browser.");
        respond({ ok: true });
        return;
      }
      case "toggle-share": {
        if (typeof message.tabId !== "number") {
          respond({ ok: false });
          return;
        }
        if (state.sharedTabs.has(message.tabId)) await unshareTab(message.tabId);
        else await shareTab(message.tabId);
        respond({ ok: true });
        return;
      }
      case "reconnect": {
        state.reconnectDelay = 1_000;
        await connect();
        respond({ ok: true });
        return;
      }
      default:
        respond({ ok: false });
    }
  })();
  return true;
});

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());

void connect();
