import { bindPairing, request } from "./pairing-view.js";

const STATUS_TEXT = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Offline",
  "needs-token": "Not connected",
  error: "Error",
};

const $ = (id) => document.getElementById(id);
const elements = {
  pill: $("status-pill"),
  statusText: $("status-text"),
  connectView: $("connect-view"),
  connectedView: $("connected-view"),
  offlineNotice: $("offline-notice"),
  tabCard: $("tab-card"),
  tabTitle: $("tab-title"),
  tabUrl: $("tab-url"),
  shareSwitch: $("share-switch"),
  shareHint: $("share-hint"),
  sharedSection: $("shared-section"),
  sharedList: $("shared-list"),
  gatewayLabel: $("gateway-label"),
  disconnectButton: $("disconnect-button"),
  form: $("settings-form"),
  gatewayUrl: $("gateway-url"),
  token: $("token"),
  error: $("error"),
};

let activeTabId = null;
const renderPairing = bindPairing($("pairing"), () => void refresh());

function renderSharedTabs(tabs) {
  elements.sharedList.replaceChildren();
  elements.sharedSection.hidden = tabs.length === 0;
  for (const tab of tabs) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = tab.title || tab.url;
    label.title = tab.url;
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "btn";
    stop.textContent = "Stop";
    stop.addEventListener("click", async () => {
      await request({ type: "toggle-share", tabId: tab.tabId });
      await refresh();
    });
    item.append(label, stop);
    elements.sharedList.append(item);
  }
}

function renderTab(tab) {
  activeTabId = tab?.tabId ?? null;
  elements.tabCard.hidden = !tab;
  if (!tab) return;
  const shared = tab.shared || tab.owned;
  elements.tabTitle.textContent = tab.title || "Untitled tab";
  elements.tabUrl.textContent = tab.url;
  elements.shareSwitch.setAttribute("aria-checked", String(shared));
  elements.shareSwitch.disabled = tab.owned || (!tab.shared && !tab.shareable);
  elements.shareHint.textContent = tab.owned
    ? "Cybara opened this tab for an agent."
    : tab.shared
      ? "Shared. Agents can read and act in this tab with your signed-in session, and Chrome shows a banner while they do."
      : tab.shareable
        ? "Turn on to let Cybara agents work in this tab."
        : "Browser pages like this one can't be shared. Open a website to share it.";
}

function render(state) {
  const paired = state.hasToken;
  elements.pill.dataset.state = paired ? state.status : "idle";
  elements.statusText.textContent = paired
    ? (STATUS_TEXT[state.status] ?? state.status)
    : "Not connected";
  elements.connectView.hidden = paired;
  elements.connectedView.hidden = !paired;

  if (!paired) {
    renderPairing(state.pairing);
    if (document.activeElement !== elements.gatewayUrl) elements.gatewayUrl.value = state.gatewayUrl;
    const showError = Boolean(state.error) && state.pairing?.phase === "idle";
    elements.error.hidden = !showError;
    elements.error.textContent = showError ? state.error : "";
    return;
  }

  elements.error.hidden = true;
  const offline = state.status === "disconnected" || state.status === "error";
  elements.offlineNotice.hidden = !offline;
  elements.offlineNotice.textContent = offline ? state.error || "Cybara isn't reachable." : "";
  elements.gatewayLabel.textContent = state.gatewayUrl.replace(/^https?:\/\//, "");
  renderTab(state.activeTab);
  renderSharedTabs((state.sharedTabs ?? []).filter((tab) => tab.tabId !== activeTabId));
}

async function refresh() {
  render(await request({ type: "get-state" }));
}

elements.shareSwitch.addEventListener("click", async () => {
  if (activeTabId === null) return;
  await request({ type: "toggle-share", tabId: activeTabId });
  await refresh();
});

elements.disconnectButton.addEventListener("click", async () => {
  await request({ type: "forget-token" });
  await refresh();
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await request({
    type: "save-settings",
    gatewayUrl: elements.gatewayUrl.value,
    token: elements.token.value,
  });
  elements.token.value = "";
  await refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "state-changed") void refresh();
});

void request({ type: "reconnect" }).finally(refresh);
