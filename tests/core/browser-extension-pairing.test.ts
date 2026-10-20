import { describe, expect, test } from "bun:test";
import type { ExtensionSocket } from "../../src/core/browser/extension-bridge";
import {
  BrowserExtensionPairing,
  browserLabelFromUserAgent,
} from "../../src/core/browser/extension-pairing";
import { authorizeBrowserExtensionUpgrade } from "../../src/api/browser-extension-socket";

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const closed: number[] = [];
  const socket: ExtensionSocket = {
    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: (code) => closed.push(code ?? 0),
  };
  return { socket, sent, closed };
}

const chromeAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";

describe("browser extension pairing", () => {
  test("shows a code and delivers the token only after approval", () => {
    const pairing = new BrowserExtensionPairing(() => "cbx_test-token");
    const { socket, sent, closed } = fakeSocket();
    const request = pairing.open(socket, chromeAgent);
    expect(request?.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(request?.browser).toBe("Chrome 149");
    expect(sent[0]).toMatchObject({ type: "pairing", code: request?.code });
    expect(sent.some((message) => "token" in message)).toBe(false);
    expect(pairing.list()).toHaveLength(1);

    expect(pairing.approve(request?.id ?? "")).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "paired", token: "cbx_test-token" });
    expect(closed).toEqual([1000]);
    expect(pairing.list()).toHaveLength(0);
    expect(pairing.approve(request?.id ?? "")).toBe(false);
  });

  test("declines, expires, and forgets requests whose socket closes", async () => {
    const pairing = new BrowserExtensionPairing(() => "cbx_test-token", 50);
    const declined = fakeSocket();
    const declinedRequest = pairing.open(declined.socket, chromeAgent);
    pairing.deny(declinedRequest?.id ?? "");
    expect(declined.sent.at(-1)).toEqual({ type: "pairing-denied" });

    const expiring = fakeSocket();
    pairing.open(expiring.socket, chromeAgent);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(expiring.sent.at(-1)).toEqual({ type: "pairing-expired" });

    const abandoned = fakeSocket();
    pairing.open(abandoned.socket, chromeAgent);
    pairing.cancel(abandoned.socket);
    expect(pairing.list()).toHaveLength(0);
  });

  test("caps simultaneous requests so a local process cannot flood the prompt", () => {
    const pairing = new BrowserExtensionPairing(() => "cbx_test-token");
    for (let index = 0; index < 3; index += 1) pairing.open(fakeSocket().socket, chromeAgent);
    const extra = fakeSocket();
    expect(pairing.open(extra.socket, chromeAgent)).toBeNull();
    expect(extra.closed).toEqual([4029]);
  });

  test("labels common Chromium browsers", () => {
    expect(browserLabelFromUserAgent(`${chromeAgent} Edg/149.0.1`)).toBe("Microsoft Edge 149");
    expect(browserLabelFromUserAgent(undefined)).toBe("Chromium browser");
  });

  test("pairing sockets need no token but keep the loopback and origin checks", () => {
    const headers = {
      origin: "chrome-extension://abcdefghijklmnop",
      "sec-websocket-protocol": "cybara-browser-extension.v1, pair",
    };
    expect(authorizeBrowserExtensionUpgrade(headers, "127.0.0.1")).toEqual({
      ok: true,
      mode: "pairing",
    });
    expect(authorizeBrowserExtensionUpgrade(headers, "192.168.1.20").ok).toBe(false);
    expect(
      authorizeBrowserExtensionUpgrade({ ...headers, origin: "https://evil.example" }, "127.0.0.1")
        .ok
    ).toBe(false);
  });
});
