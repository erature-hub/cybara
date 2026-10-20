const STATUS_TEXT = {
  connected: "Connected to Cybara",
  connecting: "Connecting…",
  disconnected: "Not connected",
  "needs-token": "Needs a pairing token",
  error: "Connection error",
};

const elements = {
  dot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  shareSection: document.getElementById("share-section"),
  tabTitle: document.getElementById("tab-title"),
  tabUrl: document.getElementById("tab-url"),
  shareButton: document.getElementById("share-button"),
  shareHint: document.getElementById("share-hint"),
  sharedSection: document.getElementById("shared-section"),
  sharedList: document.getElementById("shared-list"),
  settings: document.getElementById("settings"),
  form: document.getElementById("settings-form"),
  gatewayUrl: document.getElementById("gateway-url"),
  token: document.getElementById("token"),
  forgetButton: document.getElementById("forget-button"),
  error: document.getElementById("error"),
};

let activeTabId = null;

function request(message) {
  return chrome.runtime.sendMessage(message);
}

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
    stop.textContent = "Stop sharing";
    stop.addEventListener("click", async () => {
      await request({ type: "toggle-share", tabId: tab.tabId });
      await refresh();
    });
    item.append(label, stop);
    elements.sharedList.append(item);
  }
}

function render(state) {
  elements.dot.dataset.state = state.status;
  elements.statusText.textContent = STATUS_TEXT[state.status] ?? state.status;
  elements.error.hidden = !state.error || state.status === "connected";
  elements.error.textContent = state.error ?? "";
  if (document.activeElement !== elements.gatewayUrl) elements.gatewayUrl.value = state.gatewayUrl;
  elements.token.placeholder = state.hasToken ? "Saved — paste to replace" : "Paste from Settings → Browser";
  elements.settings.open = !state.hasToken || state.status === "error";

  const tab = state.activeTab;
  activeTabId = tab?.tabId ?? null;
  elements.shareSection.hidden = !tab;
  if (tab) {
    elements.tabTitle.textContent = tab.title || "Untitled tab";
    elements.tabUrl.textContent = tab.url;
    elements.shareButton.dataset.shared = String(tab.shared);
    elements.shareButton.textContent = tab.owned
      ? "Opened by Cybara"
      : tab.shared
        ? "Stop sharing this tab"
        : "Share this tab with Cybara";
    elements.shareButton.disabled = tab.owned || (!tab.shared && !tab.shareable);
    elements.shareHint.textContent = tab.shareable
      ? "Agents can read and act in shared tabs using your signed-in session. Chrome shows a banner while a tab is being controlled."
      : "Only regular web pages can be shared.";
  }
  renderSharedTabs(state.sharedTabs ?? []);
}

async function refresh() {
  render(await request({ type: "get-state" }));
}

elements.shareButton.addEventListener("click", async () => {
  if (activeTabId === null) return;
  await request({ type: "toggle-share", tabId: activeTabId });
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

elements.forgetButton.addEventListener("click", async () => {
  await request({ type: "forget-token" });
  await refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "state-changed") void refresh();
});

void request({ type: "reconnect" }).finally(refresh);
