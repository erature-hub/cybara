import { randomUUID } from "node:crypto";
import type { BrowserExtensionBridge, ExtensionDebuggerEvent } from "./extension-bridge";

const BROWSER_TARGET_ID = "cybara-extension-browser";
const REFUSED_METHODS = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.exposeDevToolsProtocol",
]);
const ACKNOWLEDGED_METHODS = new Set([
  "Browser.setDownloadBehavior",
  "Target.setDiscoverTargets",
  "Target.setRemoteLocations",
]);

interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener?: boolean;
  browserContextId?: string;
}

interface TabSession {
  tabId: number;
  sessionId: string;
  targetInfo: CdpTargetInfo;
  childSessions: Set<string>;
}

export interface CdpClientMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export type CdpOutbound =
  | { id: number; result: unknown; sessionId?: string }
  | { id: number; error: { code: number; message: string }; sessionId?: string }
  | { method: string; params: unknown; sessionId?: string };

function targetInfoFrom(value: unknown, fallbackId: string): CdpTargetInfo {
  const info = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    targetId: typeof info.targetId === "string" ? info.targetId : fallbackId,
    type: typeof info.type === "string" ? info.type : "page",
    title: typeof info.title === "string" ? info.title : "",
    url: typeof info.url === "string" ? info.url : "",
    attached: true,
    canAccessOpener: false,
    browserContextId: typeof info.browserContextId === "string" ? info.browserContextId : undefined,
  };
}

export class ExtensionCdpRelay {
  private readonly tabSessions = new Map<number, TabSession>();
  private readonly attaching = new Map<number, Promise<TabSession>>();
  private readonly ownedTabs = new Set<number>();
  private readonly browserSessions = new Set<string>();
  private readonly pageSessions = new Map<string, number>();
  private autoAttach = false;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly bridge: BrowserExtensionBridge,
    private readonly send: (message: CdpOutbound) => void,
    private readonly onClosed: (reason: string) => void = () => undefined
  ) {
    this.unsubscribe = bridge.subscribe((event) => {
      if (event.kind === "debugger") this.forwardEvent(event.event);
      else if (event.kind === "detached") this.dropTab(event.tabId);
      else if (event.kind === "tab") {
        if (event.tab.shared && this.autoAttach) {
          void this.attachTab(event.tab.tabId).catch(() => undefined);
        } else if (!event.tab.shared && !this.ownedTabs.has(event.tab.tabId)) {
          this.dropTab(event.tab.tabId);
        }
      } else if (event.kind === "disconnected") this.close(event.reason);
    });
  }

  tabIdForTarget(targetId: string): number | null {
    for (const session of this.tabSessions.values()) {
      if (session.targetInfo.targetId === targetId) return session.tabId;
    }
    return null;
  }

  isOwnedTab(tabId: number): boolean {
    return this.ownedTabs.has(tabId);
  }

  close(reason = "Relay closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    const tabs = Array.from(this.tabSessions.keys());
    this.tabSessions.clear();
    this.browserSessions.clear();
    this.pageSessions.clear();
    for (const tabId of tabs) {
      void this.bridge.request("debugger.detach", { tabId }).catch(() => undefined);
    }
    this.onClosed(reason);
  }

  async handle(message: CdpClientMessage): Promise<void> {
    const { id, sessionId } = message;
    try {
      const result = await this.dispatch(message);
      this.send(sessionId ? { id, result: result ?? {}, sessionId } : { id, result: result ?? {} });
    } catch (error) {
      const failure = {
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      };
      this.send(sessionId ? { ...failure, sessionId } : failure);
    }
  }

  private async dispatch(message: CdpClientMessage): Promise<unknown> {
    const { method, sessionId } = message;
    const params = message.params ?? {};
    if (this.closed) throw new Error("The browser extension relay is closed.");
    if (REFUSED_METHODS.has(method)) {
      throw new Error(`${method} is not available when Cybara drives your own Chrome.`);
    }
    if (!sessionId || this.browserSessions.has(sessionId)) {
      if (ACKNOWLEDGED_METHODS.has(method)) return {};
      switch (method) {
        case "Target.attachToBrowserTarget": {
          const browserSession = `cybara-browser-${randomUUID()}`;
          this.browserSessions.add(browserSession);
          return { sessionId: browserSession };
        }
        case "Target.attachToTarget":
          return this.attachPageSession(typeof params.targetId === "string" ? params.targetId : "");
        case "Target.detachFromTarget":
          if (typeof params.sessionId === "string") this.pageSessions.delete(params.sessionId);
          return {};
        case "Browser.getVersion":
          return this.browserVersion();
        case "Target.setAutoAttach":
          this.autoAttach = true;
          await Promise.all(
            this.bridge.sharedTabs().map((tab) => this.attachTab(tab.tabId).catch(() => undefined))
          );
          return {};
        case "Target.getTargetInfo":
          return typeof params.targetId === "string"
            ? { targetInfo: this.targetInfoById(params.targetId) }
            : { targetInfo: this.browserTargetInfo() };
        case "Target.getTargets":
          return {
            targetInfos: Array.from(this.tabSessions.values()).map((tab) => tab.targetInfo),
          };
        case "Target.createTarget":
          return await this.createTarget(typeof params.url === "string" ? params.url : "");
        case "Target.closeTarget":
          return await this.closeTarget(typeof params.targetId === "string" ? params.targetId : "");
        case "Target.activateTarget":
          return await this.activateTarget(
            typeof params.targetId === "string" ? params.targetId : ""
          );
        case "Browser.getWindowForTarget":
          return { windowId: 0, bounds: { windowState: "normal" } };
      }
      return await this.sendBrowserCommand(method, params);
    }
    const pageSessionTab = this.pageSessions.get(sessionId);
    if (pageSessionTab !== undefined) {
      return await this.bridge.request("debugger.send", { tabId: pageSessionTab, method, params });
    }
    const tabSession = this.findBySession(sessionId);
    if (tabSession && method === "Target.getTargetInfo" && !params.targetId) {
      return { targetInfo: tabSession.targetInfo };
    }
    const owner = tabSession ?? this.findByChildSession(sessionId);
    if (!owner) throw new Error(`No shared tab is attached for session ${sessionId}.`);
    return await this.bridge.request("debugger.send", {
      tabId: owner.tabId,
      sessionId: tabSession ? undefined : sessionId,
      method,
      params,
    });
  }

  private attachPageSession(targetId: string): { sessionId: string } {
    const tabId = this.tabIdForTarget(targetId);
    if (tabId === null) throw new Error(`No shared tab with target id ${targetId}.`);
    const sessionId = `cybara-page-${randomUUID()}`;
    this.pageSessions.set(sessionId, tabId);
    return { sessionId };
  }

  private browserVersion(): Record<string, string> {
    const client = this.bridge.clientInfo();
    const product = client?.product && client.product.includes("/") ? client.product : "Chrome/0";
    return {
      protocolVersion: "1.3",
      product,
      revision: "",
      userAgent: client?.userAgent ?? "Mozilla/5.0 Chrome",
      jsVersion: "",
    };
  }

  private browserTargetInfo(): CdpTargetInfo {
    return {
      targetId: BROWSER_TARGET_ID,
      type: "browser",
      title: "",
      url: "",
      attached: true,
      canAccessOpener: false,
    };
  }

  private targetInfoById(targetId: string): CdpTargetInfo {
    for (const session of this.tabSessions.values()) {
      if (session.targetInfo.targetId === targetId) return session.targetInfo;
    }
    if (targetId === BROWSER_TARGET_ID) return this.browserTargetInfo();
    throw new Error(`No target with id ${targetId}.`);
  }

  private async sendBrowserCommand(method: string, params: Record<string, unknown>) {
    const first = this.tabSessions.values().next().value as TabSession | undefined;
    if (!first) throw new Error(`${method} needs at least one shared tab.`);
    return await this.bridge.request("debugger.send", { tabId: first.tabId, method, params });
  }

  private async createTarget(url: string): Promise<{ targetId: string }> {
    const created = await this.bridge.request<{ tabId?: unknown }>("tabs.create", {
      url: url || "about:blank",
    });
    if (typeof created?.tabId !== "number") throw new Error("Chrome did not open a new tab.");
    this.ownedTabs.add(created.tabId);
    const session = await this.attachTab(created.tabId);
    return { targetId: session.targetInfo.targetId };
  }

  private async closeTarget(targetId: string): Promise<{ success: boolean }> {
    const tabId = this.tabIdForTarget(targetId);
    if (tabId === null) return { success: false };
    if (this.ownedTabs.has(tabId)) {
      await this.bridge.request("tabs.remove", { tabId });
    } else {
      await this.bridge.request("debugger.detach", { tabId });
      this.dropTab(tabId);
    }
    return { success: true };
  }

  private async activateTarget(targetId: string): Promise<Record<string, never>> {
    const tabId = this.tabIdForTarget(targetId);
    if (tabId !== null) await this.bridge.request("tabs.activate", { tabId });
    return {};
  }

  private findBySession(sessionId: string): TabSession | undefined {
    for (const session of this.tabSessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  private findByChildSession(sessionId: string): TabSession | undefined {
    for (const session of this.tabSessions.values()) {
      if (session.childSessions.has(sessionId)) return session;
    }
    return undefined;
  }

  private attachTab(tabId: number): Promise<TabSession> {
    const existing = this.tabSessions.get(tabId);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.attaching.get(tabId);
    if (inFlight) return inFlight;
    const attach = (async () => {
      const attached = await this.bridge.request<{ targetInfo?: unknown }>("debugger.attach", {
        tabId,
      });
      const session: TabSession = {
        tabId,
        sessionId: `cybara-tab-${randomUUID()}`,
        targetInfo: targetInfoFrom(attached?.targetInfo, `cybara-tab-${tabId}`),
        childSessions: new Set(),
      };
      if (this.closed) {
        await this.bridge.request("debugger.detach", { tabId }).catch(() => undefined);
        throw new Error("The browser extension relay is closed.");
      }
      this.tabSessions.set(tabId, session);
      this.send({
        method: "Target.attachedToTarget",
        params: {
          sessionId: session.sessionId,
          targetInfo: session.targetInfo,
          waitingForDebugger: false,
        },
      });
      return session;
    })().finally(() => this.attaching.delete(tabId));
    this.attaching.set(tabId, attach);
    return attach;
  }

  private dropTab(tabId: number): void {
    const session = this.tabSessions.get(tabId);
    this.ownedTabs.delete(tabId);
    if (!session) return;
    this.tabSessions.delete(tabId);
    for (const [pageSession, pageTabId] of this.pageSessions) {
      if (pageTabId !== tabId) continue;
      this.pageSessions.delete(pageSession);
      this.send({
        method: "Target.detachedFromTarget",
        params: { sessionId: pageSession, targetId: session.targetInfo.targetId },
      });
    }
    this.send({
      method: "Target.detachedFromTarget",
      params: { sessionId: session.sessionId, targetId: session.targetInfo.targetId },
    });
  }

  private forwardEvent(event: ExtensionDebuggerEvent): void {
    const session = this.tabSessions.get(event.tabId);
    if (!session) return;
    const params = (event.params ?? {}) as Record<string, unknown>;
    const childSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (event.method === "Target.attachedToTarget" && childSessionId) {
      session.childSessions.add(childSessionId);
    } else if (event.method === "Target.detachedFromTarget" && childSessionId) {
      session.childSessions.delete(childSessionId);
    } else if (event.method === "Target.targetInfoChanged" && !event.sessionId) {
      const info = params.targetInfo as Record<string, unknown> | undefined;
      if (info?.targetId === session.targetInfo.targetId) {
        session.targetInfo = targetInfoFrom(info, session.targetInfo.targetId);
      }
    }
    this.send({
      method: event.method,
      params: event.params ?? {},
      sessionId: event.sessionId ?? session.sessionId,
    });
    if (event.sessionId) return;
    for (const [pageSession, pageTabId] of this.pageSessions) {
      if (pageTabId === event.tabId) {
        this.send({ method: event.method, params: event.params ?? {}, sessionId: pageSession });
      }
    }
  }
}
