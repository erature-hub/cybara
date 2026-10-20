import { randomBytes, timingSafeEqual } from "node:crypto";
import { tables } from "../database";
import { openSecret, sealSecret } from "../secret-storage";

const TOKEN_CONFIG_KEY = "browser_extension_token";
const TOKEN_SECRET_CONTEXT = "config:browser_extension_token";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 2_048;

export interface ExtensionSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ExtensionTab {
  tabId: number;
  url: string;
  title: string;
  shared: boolean;
}

export interface ExtensionClientInfo {
  extensionVersion: string;
  product: string;
  userAgent: string;
}

export interface BrowserExtensionStatus {
  connected: boolean;
  client: ExtensionClientInfo | null;
  tabs: ExtensionTab[];
  connectedAt: string | null;
}

export interface ExtensionDebuggerEvent {
  tabId: number;
  sessionId?: string;
  method: string;
  params?: unknown;
}

type ExtensionListener =
  | { kind: "debugger"; event: ExtensionDebuggerEvent }
  | { kind: "detached"; tabId: number; reason: string }
  | { kind: "tab"; tab: ExtensionTab }
  | { kind: "disconnected"; reason: string };

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function text(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
}

function tabFromPayload(value: unknown): ExtensionTab | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const tabId = candidate.tabId ?? candidate.id;
  if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) return null;
  return {
    tabId,
    url: text(candidate.url),
    title: text(candidate.title),
    shared: candidate.shared === true,
  };
}

export class BrowserExtensionBridge {
  private socket: ExtensionSocket | null = null;
  private client: ExtensionClientInfo | null = null;
  private connectedAt: Date | null = null;
  private readonly tabs = new Map<number, ExtensionTab>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(event: ExtensionListener) => void>();
  private nextRequestId = 1;

  constructor(private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS) {}

  isConnected(): boolean {
    return this.socket !== null && this.client !== null;
  }

  clientInfo(): ExtensionClientInfo | null {
    return this.client;
  }

  status(): BrowserExtensionStatus {
    return {
      connected: this.isConnected(),
      client: this.client,
      tabs: this.listTabs(),
      connectedAt: this.connectedAt?.toISOString() ?? null,
    };
  }

  listTabs(): ExtensionTab[] {
    return Array.from(this.tabs.values());
  }

  sharedTabs(): ExtensionTab[] {
    return this.listTabs().filter((tab) => tab.shared);
  }

  subscribe(listener: (event: ExtensionListener) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(socket: ExtensionSocket): void {
    if (this.socket && this.socket !== socket) {
      const previous = this.socket;
      this.drop(previous, "Replaced by a newer extension connection");
      try {
        previous.close(4000, "Replaced by a newer extension connection");
      } catch {
        void 0;
      }
    }
    this.socket = socket;
    this.client = null;
    this.connectedAt = new Date();
  }

  detach(socket: ExtensionSocket, reason = "Extension disconnected"): void {
    this.drop(socket, reason);
  }

  disconnect(reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    this.drop(socket, reason);
    try {
      socket.close(4001, reason);
    } catch {
      void 0;
    }
  }

  private drop(socket: ExtensionSocket, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.client = null;
    this.connectedAt = null;
    this.tabs.clear();
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
      this.pending.delete(id);
    }
    this.emit({ kind: "disconnected", reason });
  }

  handleMessage(socket: ExtensionSocket, raw: string): void {
    if (this.socket !== socket) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case "hello":
        this.client = {
          extensionVersion: text(message.version, "unknown"),
          product: text(message.product, "Chrome"),
          userAgent: text(message.userAgent),
        };
        this.tabs.clear();
        if (Array.isArray(message.tabs)) {
          for (const entry of message.tabs) {
            const tab = tabFromPayload(entry);
            if (tab) this.tabs.set(tab.tabId, tab);
          }
        }
        return;
      case "ping":
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      case "response":
        this.settle(message);
        return;
      case "event":
        this.handleEvent(message);
        return;
    }
  }

  private settle(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "number") return;
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (message.error !== undefined && message.error !== null) {
      request.reject(new Error(text(message.error, "The extension reported an error")));
      return;
    }
    request.resolve(message.result);
  }

  private handleEvent(message: Record<string, unknown>): void {
    const event = message.event;
    if (event === "debugger.event") {
      const tabId = message.tabId;
      const method = message.method;
      if (typeof tabId !== "number" || typeof method !== "string") return;
      this.emit({
        kind: "debugger",
        event: {
          tabId,
          sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
          method,
          params: message.params,
        },
      });
      return;
    }
    if (event === "debugger.detach") {
      const tabId = message.tabId;
      if (typeof tabId !== "number") return;
      this.emit({ kind: "detached", tabId, reason: text(message.reason, "detached") });
      return;
    }
    if (event === "tab.updated") {
      const tab = tabFromPayload(message.tab);
      if (!tab) return;
      this.tabs.set(tab.tabId, tab);
      this.emit({ kind: "tab", tab });
      return;
    }
    if (event === "tab.removed") {
      const tabId = message.tabId;
      if (typeof tabId !== "number") return;
      this.tabs.delete(tabId);
      this.emit({ kind: "detached", tabId, reason: "tab closed" });
    }
  }

  private emit(event: ExtensionListener): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[BrowserExtension] Listener failed:", error);
      }
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.client) {
      return Promise.reject(new Error("The Cybara browser extension is not connected."));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser extension did not answer ${method} in time.`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify({ type: "request", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

export const browserExtensionBridge = new BrowserExtensionBridge();

export function browserExtensionToken(): string {
  const stored = tables.config.get(TOKEN_CONFIG_KEY)?.value;
  if (stored) {
    try {
      const token = openSecret(stored, TOKEN_SECRET_CONTEXT);
      if (token) return token;
    } catch {
      void 0;
    }
  }
  return rotateBrowserExtensionToken();
}

export function rotateBrowserExtensionToken(): string {
  const token = `cbx_${randomBytes(24).toString("base64url")}`;
  tables.config.set(TOKEN_CONFIG_KEY, sealSecret(token, TOKEN_SECRET_CONTEXT));
  return token;
}

export function browserExtensionTokenMatches(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(browserExtensionToken());
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isExtensionOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  return /^(chrome|moz)-extension:\/\/[a-z0-9-]+\/?$/i.test(origin);
}
