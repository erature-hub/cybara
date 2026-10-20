import {
  browserExtensionBridge,
  browserExtensionTokenMatches,
  type ExtensionSocket,
  isExtensionOrigin,
} from "../core/browser/extension-bridge";
import { forwardedClientIp, isLoopbackIp } from "./client-ip";

export const BROWSER_EXTENSION_SOCKET_PATH = "/api/browser-extension/ws";
export const BROWSER_EXTENSION_PROTOCOL = "cybara-browser-extension.v1";
const TOKEN_PROTOCOL_PREFIX = "token.";
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface BrowserExtensionSocketData {
  kind: "extension";
  socket?: ExtensionSocket;
}

interface SocketLike {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  data: unknown;
}

function offeredProtocols(headers: Record<string, string>): string[] {
  const raw = headers["sec-websocket-protocol"] ?? headers["Sec-WebSocket-Protocol"] ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function authorizeBrowserExtensionUpgrade(
  headers: Record<string, string>,
  clientIp: string | undefined
): { ok: true } | { ok: false; status: number; error: string } {
  const forwarded = forwardedClientIp(headers);
  if (!isLoopbackIp(clientIp) || (forwarded && !isLoopbackIp(forwarded))) {
    return {
      ok: false,
      status: 403,
      error: "The browser extension may connect only from this device.",
    };
  }
  if (!isExtensionOrigin(headers.origin ?? headers.Origin)) {
    return { ok: false, status: 403, error: "Only the Cybara browser extension may connect here." };
  }
  const protocols = offeredProtocols(headers);
  if (!protocols.includes(BROWSER_EXTENSION_PROTOCOL)) {
    return { ok: false, status: 400, error: "Unsupported browser extension protocol." };
  }
  const token = protocols
    .find((value) => value.startsWith(TOKEN_PROTOCOL_PREFIX))
    ?.slice(TOKEN_PROTOCOL_PREFIX.length);
  if (!browserExtensionTokenMatches(token)) {
    return { ok: false, status: 401, error: "The browser extension pairing token is not valid." };
  }
  return { ok: true };
}

function extensionSocketFor(ws: SocketLike): ExtensionSocket {
  return {
    send: (data) => {
      ws.send(data);
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

export function openBrowserExtensionSocket(ws: SocketLike): void {
  const data = ws.data as BrowserExtensionSocketData;
  data.socket = extensionSocketFor(ws);
  browserExtensionBridge.attach(data.socket);
}

export function messageBrowserExtensionSocket(ws: SocketLike, message: string | Buffer): void {
  const data = ws.data as BrowserExtensionSocketData;
  if (!data.socket) return;
  const text = typeof message === "string" ? message : message.toString("utf8");
  if (text.length > MAX_MESSAGE_BYTES) return;
  browserExtensionBridge.handleMessage(data.socket, text);
}

export function closeBrowserExtensionSocket(ws: SocketLike): void {
  const data = ws.data as BrowserExtensionSocketData;
  if (data.socket) browserExtensionBridge.detach(data.socket);
}
