import { randomUUID } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import type { Browser as PlaywrightBrowser, Page as PlaywrightPage } from "playwright";
import { wrapPlaywrightPage } from "./automation-driver";
import { browserExtensionBridge } from "./extension-bridge";
import { type CdpClientMessage, ExtensionCdpRelay } from "./extension-cdp-relay";
import { getAttachedLocalChromePort, onLocalChromeChange } from "./local-chrome";
import { getChromium } from "./playwright-loader";
import { closePage, registerExternalPage } from "./pw-manager";

const CONNECT_TIMEOUT_MS = 20_000;

export type UserChromeSource = "extension" | "cdp";

export interface UserChromeAvailability {
  available: boolean;
  source: UserChromeSource | null;
  reason?: string;
  sharedTabs: number;
}

interface RelayHost {
  server: Server<undefined>;
  relays: Set<ExtensionCdpRelay>;
}

interface UserChromeConnection {
  source: UserChromeSource;
  key: string;
  browser: PlaywrightBrowser;
  relayHost?: RelayHost;
}

let connection: UserChromeConnection | null = null;
let connecting: Promise<UserChromeConnection> | null = null;
const registeredPages = new WeakMap<PlaywrightPage, { pageId: string; owned: boolean }>();

export const USER_CHROME_UNAVAILABLE_MESSAGE =
  "Cybara cannot reach your Chrome. Install the Cybara browser extension and connect it from its toolbar popup (Settings → Browser shows the pairing token), or attach a Chrome started with --remote-debugging-port in Settings → Browser.";

export function userChromeAvailability(): UserChromeAvailability {
  if (browserExtensionBridge.isConnected()) {
    return {
      available: true,
      source: "extension",
      sharedTabs: browserExtensionBridge.sharedTabs().length,
    };
  }
  if (getAttachedLocalChromePort() !== null) {
    return { available: true, source: "cdp", sharedTabs: 0 };
  }
  return {
    available: false,
    source: null,
    reason: USER_CHROME_UNAVAILABLE_MESSAGE,
    sharedTabs: 0,
  };
}

export function userChromeSharedTabs(): Array<{ url: string; title: string }> {
  return browserExtensionBridge.sharedTabs().map((tab) => ({ url: tab.url, title: tab.title }));
}

export const USER_CHROME_USAGE_HINT =
  "Browser actions in this session run in the user's Chrome. snapshot and screenshot read the tab the user shared most recently, so no URL is needed; open or navigate with a url loads a page in that tab, or in a new Cybara tab when nothing is shared.";

function sourceKey(): { source: UserChromeSource; key: string } {
  if (browserExtensionBridge.isConnected()) {
    const connectedAt = browserExtensionBridge.status().connectedAt ?? "";
    return { source: "extension", key: `extension:${connectedAt}` };
  }
  const port = getAttachedLocalChromePort();
  if (port !== null) return { source: "cdp", key: `cdp:${port}` };
  throw new Error(USER_CHROME_UNAVAILABLE_MESSAGE);
}

function startRelayHost(): { host: RelayHost; endpoint: string } {
  const path = `/cdp/${randomUUID()}`;
  const relays = new Set<ExtensionCdpRelay>();
  const sockets = new WeakMap<ServerWebSocket<undefined>, ExtensionCdpRelay>();
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      if (new URL(request.url).pathname !== path) {
        return new Response("Not found", { status: 404 });
      }
      if (bunServer.upgrade(request, { data: undefined })) return undefined;
      return new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        const relay = new ExtensionCdpRelay(
          browserExtensionBridge,
          (message) => {
            try {
              socket.send(JSON.stringify(message));
            } catch {
              void 0;
            }
          },
          (reason) => {
            try {
              socket.close(1000, reason.slice(0, 120));
            } catch {
              void 0;
            }
          }
        );
        relays.add(relay);
        sockets.set(socket, relay);
      },
      message(socket, data) {
        const relay = sockets.get(socket);
        if (!relay) return;
        let message: CdpClientMessage;
        try {
          message = JSON.parse(
            typeof data === "string" ? data : data.toString()
          ) as CdpClientMessage;
        } catch {
          return;
        }
        if (typeof message?.id !== "number" || typeof message.method !== "string") return;
        void relay.handle(message);
      },
      close(socket) {
        const relay = sockets.get(socket);
        if (!relay) return;
        relays.delete(relay);
        relay.close("Playwright disconnected");
      },
    },
  });
  return {
    host: { server, relays },
    endpoint: `ws://127.0.0.1:${server.port}${path}`,
  };
}

function stopRelayHost(host: RelayHost | undefined): void {
  if (!host) return;
  for (const relay of host.relays) relay.close("User Chrome connection closed");
  host.relays.clear();
  void host.server.stop(true);
}

async function connect(): Promise<UserChromeConnection> {
  const { source, key } = sourceKey();
  if (connection && connection.key === key && connection.browser.isConnected()) {
    return connection;
  }
  if (connecting) return connecting;
  const previous = connection;
  connection = null;
  if (previous) await closeConnection(previous);

  connecting = (async () => {
    const chromium = await getChromium();
    let relayHost: RelayHost | undefined;
    let endpoint: string;
    if (source === "extension") {
      const started = startRelayHost();
      relayHost = started.host;
      endpoint = started.endpoint;
    } else {
      endpoint = `http://127.0.0.1:${getAttachedLocalChromePort()}`;
    }
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
      const established: UserChromeConnection = { source, key, browser, relayHost };
      browser.on("disconnected", () => {
        if (connection === established) connection = null;
        stopRelayHost(relayHost);
      });
      connection = established;
      return established;
    } catch (error) {
      stopRelayHost(relayHost);
      throw error;
    }
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function closeConnection(target: UserChromeConnection): Promise<void> {
  try {
    await target.browser.close();
  } catch {
    void 0;
  }
  stopRelayHost(target.relayHost);
}

export async function disconnectUserChrome(source?: UserChromeSource): Promise<void> {
  const current = connection;
  if (!current || (source && current.source !== source)) return;
  connection = null;
  await closeConnection(current);
}

export interface UserChromePage {
  pageId: string;
  source: UserChromeSource;
  adoptedSharedTab: boolean;
}

export async function openUserChromePage(
  options: { allowTakeover?: boolean } = {}
): Promise<UserChromePage> {
  const active = await connect();
  const context = active.browser.contexts()[0];
  if (!context) throw new Error("Your Chrome did not expose a browsing context to Cybara.");

  const sharedPages =
    active.source === "extension"
      ? context
          .pages()
          .filter((page) => !page.isClosed() && registeredPages.get(page)?.owned !== true)
      : [];
  const shared =
    sharedPages.filter((page) => !registeredPages.has(page)).at(-1) ??
    (options.allowTakeover ? sharedPages.at(-1) : undefined);
  const previousOwner = shared ? registeredPages.get(shared) : undefined;
  if (previousOwner) await closePage(previousOwner.pageId);
  const page = shared ?? (await context.newPage());
  const owned = !shared;
  const pageId = registerExternalPage(wrapPlaywrightPage(page), async () => {
    if (registeredPages.get(page)?.pageId === pageId) registeredPages.delete(page);
    if (owned && !page.isClosed()) await page.close().catch(() => undefined);
  });
  registeredPages.set(page, { pageId, owned });
  page.once("close", () => registeredPages.delete(page));
  return { pageId, source: active.source, adoptedSharedTab: !owned };
}

browserExtensionBridge.subscribe((event) => {
  if (event.kind === "disconnected") void disconnectUserChrome("extension");
});

onLocalChromeChange((port) => {
  if (port === null) void disconnectUserChrome("cdp");
});
