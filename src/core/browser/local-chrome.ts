import { getBrowserSupervisionSettings, getBrowserSupervisionStatus } from "./supervision";

export const DEFAULT_LOCAL_CHROME_CDP_PORT = 9222;
const MIN_CDP_PORT = 1024;
const MAX_CDP_PORT = 65_535;
const PROBE_TIMEOUT_MS = 2_500;
const MAX_TARGET_URL_LENGTH = 2_048;

interface ChromeListEntry {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
}

interface ChromeVersionPayload {
  Browser?: unknown;
  webSocketDebuggerUrl?: unknown;
}

export interface LocalChromeTarget {
  id: string;
  title: string;
  url: string;
}

export interface LocalChromeStatus {
  supported: boolean;
  attached: boolean;
  reachable: boolean;
  product: string | null;
  port: number;
  targets: LocalChromeTarget[];
  reason?: string;
}

export function normalizeLocalChromePort(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LOCAL_CHROME_CDP_PORT;
  const port = Math.floor(numeric);
  if (port < MIN_CDP_PORT || port > MAX_CDP_PORT) return DEFAULT_LOCAL_CHROME_CDP_PORT;
  return port;
}

export function localChromeLaunchHint(port: number): string {
  return `Start Chrome with --remote-debugging-port=${port} --user-data-dir=<a separate folder> (Chrome ignores the port for your default profile), open http://localhost:${port}/json/version to confirm it is listening, then connect. To use your everyday profile, install the Cybara browser extension instead.`;
}

function supervisionAllowsAttach(): string | null {
  const supervision = getBrowserSupervisionSettings({ redact: false });
  const status = getBrowserSupervisionStatus();
  if (supervision.remoteRoutingEnabled) {
    return "Remote browser routing is enabled, so Cybara will not attach to a local Chrome.";
  }
  if (status.owner === "remote") {
    return "The active browser session is remote, so Cybara will not attach to a local Chrome.";
  }
  return null;
}

export async function probeLocalChrome(
  port: number = DEFAULT_LOCAL_CHROME_CDP_PORT
): Promise<{ reachable: boolean; product: string | null; reason?: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { reachable: false, product: null, reason: `debug port returned ${response.status}` };
    }
    const payload = (await response.json()) as ChromeVersionPayload;
    const product = typeof payload.Browser === "string" ? payload.Browser : null;
    const endpoint =
      typeof payload.webSocketDebuggerUrl === "string" ? payload.webSocketDebuggerUrl : null;
    if (!endpoint) {
      return { reachable: false, product, reason: "no debugger endpoint was advertised" };
    }
    return { reachable: true, product };
  } catch (error) {
    return {
      reachable: false,
      product: null,
      reason: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
    };
  }
}

let attachedPort: number | null = null;
const changeListeners = new Set<(port: number | null) => void>();

export function getAttachedLocalChromePort(): number | null {
  return attachedPort;
}

export function onLocalChromeChange(listener: (port: number | null) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function setAttachedPort(port: number | null): void {
  if (attachedPort === port) return;
  attachedPort = port;
  for (const listener of changeListeners) {
    try {
      listener(port);
    } catch (error) {
      console.error("[Browser] Local Chrome listener failed:", error);
    }
  }
}

export async function localChromeStatus(): Promise<LocalChromeStatus> {
  const port = attachedPort ?? DEFAULT_LOCAL_CHROME_CDP_PORT;
  const denial = supervisionAllowsAttach();
  const probe = await probeLocalChrome(port);
  if (attachedPort !== null && !probe.reachable) setAttachedPort(null);
  const status: LocalChromeStatus = {
    supported: true,
    attached: attachedPort !== null,
    reachable: probe.reachable,
    product: probe.product,
    port,
    targets: attachedPort !== null ? await listTargets(port) : [],
  };
  if (denial) status.reason = denial;
  else if (!probe.reachable)
    status.reason = `${probe.reason ?? "no debugger answered"}. ${localChromeLaunchHint(port)}`;
  return status;
}

async function listTargets(port: number): Promise<LocalChromeTarget[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const entries = (await response.json()) as unknown;
    if (!Array.isArray(entries)) return [];
    return (entries as ChromeListEntry[])
      .filter((entry) => entry.type === "page")
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : "",
        title: truncate(typeof entry.title === "string" ? entry.title : "", 200),
        url: truncate(typeof entry.url === "string" ? entry.url : "", MAX_TARGET_URL_LENGTH),
      }));
  } catch {
    return [];
  }
}

function truncate(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}

export async function attachToLocalChrome(
  options: { port?: unknown } = {}
): Promise<LocalChromeStatus> {
  const denial = supervisionAllowsAttach();
  if (denial) throw new Error(denial);
  const port = normalizeLocalChromePort(options.port);
  const probe = await probeLocalChrome(port);
  if (!probe.reachable) {
    throw new Error(
      `No Chrome debugger is listening on 127.0.0.1:${port}. ${localChromeLaunchHint(port)}`
    );
  }
  setAttachedPort(port);
  return localChromeStatus();
}

export async function detachFromLocalChrome(): Promise<LocalChromeStatus> {
  setAttachedPort(null);
  return localChromeStatus();
}
