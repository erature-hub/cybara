# Cybara Browser Extension

The Cybara Browser Bridge lets agents work in your everyday Chrome, Edge, Brave or other
Chromium browser, using the tabs and signed-in sessions you already have. It complements the
embedded browser, which stays isolated from your profile.

Chrome 136 and later ignore `--remote-debugging-port` for the default profile, so an extension
is the supported way to give an agent access to the profile you actually use.

## Install

1. Get the extension. Each [GitHub release](https://github.com/metaspartan/cybara/releases/latest)
   includes `cybara-browser-extension-v<version>.zip` with a `.sha256` checksum, also linked from
   the download page on the website. Unzip it into a folder you will keep. Desktop installs also
   ship the same folder in the app resources, and Settings → Browser → Browser extension shows its
   path with a **Show folder** button. In a source checkout it is `apps/browser-extension`.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select
   the folder.
3. The extension opens a setup page and looks for Cybara on this computer (the saved address, then
   ports 4269 to 4279). It shows a short code such as `EL7-XBS`.
4. Cybara shows a **Connect browser?** prompt with the same code, on any screen of the app and
   under Settings → Safety → Browser extension. Check the code and click **Approve**. The setup page
   switches to "You're connected" with tips for pinning the extension and sharing a tab.

You can start pairing again any time from the toolbar popup with **Connect to Cybara**. If
discovery cannot reach Cybara (for example a remote or non-default address), open **Connect
manually** in the popup and paste the address plus the pairing token from Settings → Safety →
Browser extension → **Connect manually with a pairing token**.

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

- The extension has no third-party dependencies and loads no remote code. CI runs
  `bun run check:browser-extension` in the OSV workflow and in `check:ci`. It fails if the manifest
  gains permissions beyond `alarms`, `debugger`, `storage`, `tabGroups` and `tabs`, declares host
  access or content scripts, overrides the default content security policy, or adds a
  dependency manifest or lockfile that OSV scanning would not cover.

- The extension connects only to Cybara on this computer. The gateway accepts extension sockets
  only from loopback and only from an extension origin. A pairing request carries no credentials:
  it receives the token only after you approve its code in the authenticated Cybara app, at most
  three requests can wait at once, and each expires after five minutes. Rotating the token in
  Settings disconnects the current extension, which then asks to pair again.
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
