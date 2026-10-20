import { randomInt, randomUUID } from "node:crypto";
import { browserExtensionToken, type ExtensionSocket } from "./extension-bridge";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PENDING_REQUESTS = 3;
const MAX_LABEL_LENGTH = 120;

export interface BrowserExtensionPairingRequest {
  id: string;
  code: string;
  browser: string;
  createdAt: string;
  expiresAt: string;
}

interface PendingPairing {
  request: BrowserExtensionPairingRequest;
  socket: ExtensionSocket;
  timer: ReturnType<typeof setTimeout>;
}

function pairingCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export function browserLabelFromUserAgent(userAgent: string | undefined): string {
  const agent = userAgent ?? "";
  const brands: Array<[RegExp, string]> = [
    [/Edg\/([\d.]+)/, "Microsoft Edge"],
    [/OPR\/([\d.]+)/, "Opera"],
    [/Brave\/([\d.]+)/, "Brave"],
    [/Vivaldi\/([\d.]+)/, "Vivaldi"],
    [/Chrome\/([\d.]+)/, "Chrome"],
  ];
  for (const [pattern, name] of brands) {
    const match = pattern.exec(agent);
    if (match) return `${name} ${match[1]?.split(".")[0] ?? ""}`.trim().slice(0, MAX_LABEL_LENGTH);
  }
  return "Chromium browser";
}

export class BrowserExtensionPairing {
  private readonly pending = new Map<string, PendingPairing>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly issueToken: () => string = browserExtensionToken,
    private readonly ttlMs = PAIRING_TTL_MS
  ) {}

  list(): BrowserExtensionPairingRequest[] {
    return Array.from(this.pending.values()).map((entry) => entry.request);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(
    socket: ExtensionSocket,
    userAgent: string | undefined
  ): BrowserExtensionPairingRequest | null {
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      socket.send(
        JSON.stringify({
          type: "pairing-error",
          error: "Too many pending requests. Try again shortly.",
        })
      );
      socket.close(4029, "Too many pairing requests");
      return null;
    }
    const now = Date.now();
    const request: BrowserExtensionPairingRequest = {
      id: randomUUID(),
      code: pairingCode(),
      browser: browserLabelFromUserAgent(userAgent),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    const timer = setTimeout(
      () => this.finish(request.id, { type: "pairing-expired" }, 4008),
      this.ttlMs
    );
    timer.unref?.();
    this.pending.set(request.id, { request, socket, timer });
    socket.send(
      JSON.stringify({ type: "pairing", code: request.code, expiresAt: request.expiresAt })
    );
    this.notify();
    return request;
  }

  approve(id: string): boolean {
    if (!this.pending.has(id)) return false;
    return this.finish(id, { type: "paired", token: this.issueToken() }, 1000);
  }

  deny(id: string): boolean {
    return this.finish(id, { type: "pairing-denied" }, 4003);
  }

  cancel(socket: ExtensionSocket): void {
    for (const [id, entry] of this.pending) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      this.notify();
    }
  }

  private finish(id: string, message: Record<string, unknown>, code: number): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    try {
      entry.socket.send(JSON.stringify(message));
      entry.socket.close(code, String(message.type));
    } catch {
      void 0;
    }
    this.notify();
    return true;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[BrowserExtension] Pairing listener failed:", error);
      }
    }
  }
}

export const browserExtensionPairing = new BrowserExtensionPairing();
