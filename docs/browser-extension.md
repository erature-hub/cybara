# Cybara Browser Extension

The Cybara Browser Bridge lets agents work in your everyday Chrome, Edge, Brave or other
Chromium browser, using the tabs and signed-in sessions you already have. It complements the
embedded browser, which stays isolated from your profile.

Chrome 136 and later ignore `--remote-debugging-port` for the default profile, so an extension
is the supported way to give an agent access to the profile you actually use.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the extension folder. Settings → Browser → Browser
   extension shows the path and a **Show folder** button. In a source checkout it is
   `apps/browser-extension`; desktop releases ship it in the app resources as `browser-extension`.
3. Click the Cybara toolbar icon, open **Connection**, paste the pairing token from Settings →
   Browser → Browser extension, and choose **Save and connect**.

The status pill in Settings turns to **Connected** once the extension is paired.

## Use

- Ask an agent to use "my Chrome", "my browser" or "my logged-in account". The agent calls the
  `browser` tool with `target: "chrome"`, and every later browser action in that chat runs in your
  Chrome until it switches back to `target: "embedded"`.
- To hand over a page you already have open, click the toolbar icon on that tab and choose
  **Share this tab with Cybara**. The next chat that uses your Chrome works in that tab. If a newer
  chat needs it, the tab moves to that chat, and the earlier chat gets its own tab.
- When nothing is shared, agents open their own tabs, grouped under a yellow **Cybara** tab group.
- Chrome shows a "Cybara Browser Bridge started debugging this browser" banner while a tab is
  controlled. Choosing **Cancel** on that banner, closing the tab, or **Stop sharing** in the popup
  revokes access immediately.

## Security model

- The extension connects only to the Cybara address you configure, by default
  `http://127.0.0.1:4269`. The gateway accepts the connection only from loopback, only from an
  extension origin, and only with the pairing token. Rotating the token in Settings disconnects the
  current extension.
- The extension debugs only tabs you shared or tabs Cybara opened. Requests for any other tab are
  refused inside the extension, so a compromised gateway cannot attach to the rest of your browser.
- Cybara never closes a tab you shared, and the relay refuses `Browser.close`, `Browser.crash` and
  browser-context creation, so an agent cannot shut down or reset your browser.
- Tool approvals still apply: in **Ask** mode each browser action needs approval like any other
  dangerous tool.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup says "Cybara is not reachable" | Make sure Cybara is running and the address matches the port shown in Settings → Gateway. |
| Popup says the token is not valid | Copy the current token from Settings → Browser → Browser extension; rotating it invalidates old copies. |
| Agent says it cannot reach your Chrome | Open the extension popup to confirm it is connected, or share a tab and retry. |
| A shared tab stops responding to the agent | Share it again from the popup; Chrome detaches debugging when DevTools opens on that tab or when you cancel the banner. |
