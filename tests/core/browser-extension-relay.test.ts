import { describe, expect, test } from "bun:test";
import {
  BrowserExtensionBridge,
  type ExtensionSocket,
  isExtensionOrigin,
} from "../../src/core/browser/extension-bridge";
import { type CdpOutbound, ExtensionCdpRelay } from "../../src/core/browser/extension-cdp-relay";
import { profileNameForSession } from "../../src/core/browser/profiles";

interface FakeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function connectFakeExtension(sharedTabIds: number[] = []) {
  const bridge = new BrowserExtensionBridge(2_000);
  const requests: FakeRequest[] = [];
  const removedTabs: number[] = [];
  let nextTabId = 500;
  const socket: ExtensionSocket = {
    send(data) {
      const message = JSON.parse(data) as { type: string } & FakeRequest;
      if (message.type !== "request") return;
      requests.push(message);
      queueMicrotask(() => {
        const respond = (result: unknown) =>
          bridge.handleMessage(
            socket,
            JSON.stringify({ type: "response", id: message.id, result })
          );
        switch (message.method) {
          case "tabs.create":
            respond({ tabId: nextTabId++ });
            return;
          case "tabs.remove":
            removedTabs.push(message.params.tabId as number);
            respond({});
            bridge.handleMessage(
              socket,
              JSON.stringify({ type: "event", event: "tab.removed", tabId: message.params.tabId })
            );
            return;
          case "debugger.attach":
            respond({
              targetInfo: {
                targetId: `target-${message.params.tabId}`,
                type: "page",
                title: "Shared",
                url: "https://example.com/",
              },
            });
            return;
          case "debugger.send":
            respond({ echoed: message.params.method, sessionId: message.params.sessionId ?? null });
            return;
          default:
            respond({});
        }
      });
    },
    close() {},
  };
  bridge.attach(socket);
  bridge.handleMessage(
    socket,
    JSON.stringify({
      type: "hello",
      version: "1.0.0",
      product: "Chrome/149.0.0.0",
      userAgent: "Mozilla/5.0 Chrome/149.0.0.0",
      tabs: sharedTabIds.map((tabId) => ({
        tabId,
        url: "https://example.com/",
        title: "Shared",
        shared: true,
      })),
    })
  );
  const outbound: CdpOutbound[] = [];
  const relay = new ExtensionCdpRelay(bridge, (message) => outbound.push(message));
  return { bridge, socket, relay, requests, outbound, removedTabs };
}

function resultFor(outbound: CdpOutbound[], id: number): unknown {
  const entry = outbound.find((message) => "id" in message && message.id === id);
  if (!entry) throw new Error(`No response for ${id}`);
  if ("error" in entry) throw new Error(entry.error.message);
  return "result" in entry ? entry.result : undefined;
}

describe("browser extension CDP relay", () => {
  test("reports the user's real Chrome version so Playwright treats it as headful", async () => {
    const { relay, outbound } = connectFakeExtension();
    await relay.handle({ id: 1, method: "Browser.getVersion" });
    expect(resultFor(outbound, 1)).toMatchObject({
      product: "Chrome/149.0.0.0",
      userAgent: "Mozilla/5.0 Chrome/149.0.0.0",
    });
  });

  test("auto-attach exposes only the tabs the user shared", async () => {
    const { relay, outbound, requests } = connectFakeExtension([7]);
    await relay.handle({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    const attached = outbound.filter(
      (message) => "method" in message && message.method === "Target.attachedToTarget"
    );
    expect(attached).toHaveLength(1);
    expect(requests.filter((request) => request.method === "debugger.attach")).toEqual([
      expect.objectContaining({ params: { tabId: 7 } }),
    ]);
  });

  test("routes tab and child-session commands to the owning tab", async () => {
    const { bridge, socket, relay, outbound, requests } = connectFakeExtension([7]);
    await relay.handle({ id: 1, method: "Target.setAutoAttach", params: {} });
    const attached = outbound.find(
      (message) => "method" in message && message.method === "Target.attachedToTarget"
    ) as { params: { sessionId: string } };
    const tabSession = attached.params.sessionId;

    await relay.handle({
      id: 2,
      method: "Page.navigate",
      params: { url: "https://a.test" },
      sessionId: tabSession,
    });
    expect(resultFor(outbound, 2)).toEqual({ echoed: "Page.navigate", sessionId: null });

    bridge.handleMessage(
      socket,
      JSON.stringify({
        type: "event",
        event: "debugger.event",
        tabId: 7,
        method: "Target.attachedToTarget",
        params: { sessionId: "child-1", targetInfo: { type: "iframe" } },
      })
    );
    await relay.handle({ id: 3, method: "Runtime.enable", sessionId: "child-1" });
    expect(resultFor(outbound, 3)).toEqual({ echoed: "Runtime.enable", sessionId: "child-1" });
    expect(requests.at(-1)?.params).toMatchObject({ tabId: 7, sessionId: "child-1" });
  });

  test("supports separate CDP sessions so the chat preview can screencast a shared tab", async () => {
    const { bridge, socket, relay, outbound, requests } = connectFakeExtension([7]);
    await relay.handle({ id: 1, method: "Target.setAutoAttach", params: {} });
    await relay.handle({ id: 2, method: "Target.attachToBrowserTarget" });
    const { sessionId: browserSession } = resultFor(outbound, 2) as { sessionId: string };
    await relay.handle({
      id: 3,
      method: "Target.attachToTarget",
      params: { targetId: "target-7", flatten: true },
      sessionId: browserSession,
    });
    const { sessionId: pageSession } = resultFor(outbound, 3) as { sessionId: string };

    await relay.handle({ id: 4, method: "Page.startScreencast", sessionId: pageSession });
    expect(resultFor(outbound, 4)).toEqual({ echoed: "Page.startScreencast", sessionId: null });
    expect(requests.at(-1)?.params).toMatchObject({ tabId: 7 });

    bridge.handleMessage(
      socket,
      JSON.stringify({
        type: "event",
        event: "debugger.event",
        tabId: 7,
        method: "Page.screencastFrame",
        params: { data: "AAAA", sessionId: 1 },
      })
    );
    expect(
      outbound.some(
        (message) =>
          "method" in message &&
          message.method === "Page.screencastFrame" &&
          message.sessionId === pageSession
      )
    ).toBe(true);
  });

  test("never lets the agent close or crash the user's browser", async () => {
    const { relay, outbound, requests } = connectFakeExtension([7]);
    await relay.handle({ id: 1, method: "Browser.close" });
    await relay.handle({ id: 2, method: "Target.createBrowserContext" });
    for (const id of [1, 2]) {
      const response = outbound.find((message) => "id" in message && message.id === id);
      expect(response && "error" in response).toBe(true);
    }
    expect(requests.some((request) => request.method === "debugger.send")).toBe(false);
  });

  test("closing a shared tab detaches instead of closing it, while agent tabs are removed", async () => {
    const { relay, outbound, requests, removedTabs } = connectFakeExtension([7]);
    await relay.handle({ id: 1, method: "Target.setAutoAttach", params: {} });
    await relay.handle({ id: 2, method: "Target.closeTarget", params: { targetId: "target-7" } });
    expect(resultFor(outbound, 2)).toEqual({ success: true });
    expect(removedTabs).toEqual([]);
    expect(requests.some((request) => request.method === "debugger.detach")).toBe(true);

    await relay.handle({ id: 3, method: "Target.createTarget", params: { url: "https://b.test" } });
    const created = resultFor(outbound, 3) as { targetId: string };
    expect(created.targetId).toBe("target-500");
    await relay.handle({
      id: 4,
      method: "Target.closeTarget",
      params: { targetId: created.targetId },
    });
    expect(removedTabs).toEqual([500]);
    expect(
      outbound.some(
        (message) =>
          "method" in message &&
          message.method === "Target.detachedFromTarget" &&
          (message.params as { targetId?: string }).targetId === "target-500"
      )
    ).toBe(true);
  });

  test("drops a tab when the user stops sharing it", async () => {
    const { bridge, socket, relay, outbound } = connectFakeExtension([7]);
    await relay.handle({ id: 1, method: "Target.setAutoAttach", params: {} });
    bridge.handleMessage(
      socket,
      JSON.stringify({
        type: "event",
        event: "tab.updated",
        tab: { tabId: 7, url: "https://example.com/", title: "Shared", shared: false },
      })
    );
    expect(
      outbound.some(
        (message) => "method" in message && message.method === "Target.detachedFromTarget"
      )
    ).toBe(true);
  });

  test("fails pending requests when the extension disconnects", async () => {
    const bridge = new BrowserExtensionBridge(2_000);
    const socket: ExtensionSocket = { send() {}, close() {} };
    bridge.attach(socket);
    bridge.handleMessage(
      socket,
      JSON.stringify({ type: "hello", version: "1", product: "Chrome/1" })
    );
    const pending = bridge.request("tabs.list");
    bridge.detach(socket, "gone");
    await expect(pending).rejects.toThrow("gone");
    expect(bridge.isConnected()).toBe(false);
  });
});

describe("browser extension trust boundary", () => {
  test("accepts only extension origins", () => {
    expect(isExtensionOrigin("chrome-extension://efomidikdeieadpblfjcpgfaonoehcgd")).toBe(true);
    expect(isExtensionOrigin("https://evil.example")).toBe(false);
    expect(isExtensionOrigin("chrome-extension://abc/../x")).toBe(false);
    expect(isExtensionOrigin(undefined)).toBe(false);
  });
});

describe("visible browser profile names", () => {
  test("keeps safe session ids and maps bot, room and channel ids to valid unique names", () => {
    expect(profileNameForSession("5f1c2a7e-0000-4000-8000-000000000001")).toBe(
      "5f1c2a7e-0000-4000-8000-000000000001"
    );
    const bot = profileNameForSession("bot:5f1c2a7e-0000-4000-8000-000000000001");
    const room = profileNameForSession("room:5f1c2a7e-0000-4000-8000-000000000001");
    for (const name of [
      bot,
      room,
      profileNameForSession("telegram:-100:42"),
      profileNameForSession("x".repeat(90)),
    ]) {
      expect(name).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    }
    expect(bot).not.toBe(room);
    expect(profileNameForSession("bot:5f1c2a7e-0000-4000-8000-000000000001")).toBe(bot);
  });
});
