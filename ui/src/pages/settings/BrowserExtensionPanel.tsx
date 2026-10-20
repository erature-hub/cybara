import { useCallback, useEffect, useState } from "react";
import { Copy, Eye, EyeOff, FolderOpen, Loader2, Puzzle, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/auth";

interface ExtensionTab {
  tabId: number;
  url: string;
  title: string;
  shared: boolean;
}

interface BrowserExtensionStatus {
  connected: boolean;
  client: { extensionVersion: string; product: string; userAgent: string } | null;
  tabs: ExtensionTab[];
  connectedAt: string | null;
}

interface BrowserExtensionResponse {
  success: boolean;
  error?: string;
  status?: BrowserExtensionStatus;
  pairing?: { token: string; socketPath: string };
  extensionDirectory?: string | null;
}

const POLL_INTERVAL_MS = 3_000;
const buttonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--surface-border)] px-2 py-1 text-xs font-medium hover:bg-[var(--surface-hover)] disabled:opacity-50";

export function BrowserExtensionPanel(): React.JSX.Element {
  const [data, setData] = useState<BrowserExtensionResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealToken, setRevealToken] = useState(false);
  const [copied, setCopied] = useState<"token" | "path" | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await apiFetch("/api/browser/extension");
      const payload = (await response.json()) as BrowserExtensionResponse;
      if (!payload.success) {
        setError(payload.error ?? "The browser extension bridge is unavailable");
        return;
      }
      setError("");
      setData(payload);
    } catch {
      setError("Could not reach the local browser service");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const copy = useCallback(async (value: string, kind: "token" | "path"): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      setError("Copy failed; select the text and copy it manually");
    }
  }, []);

  const rotate = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await apiFetch("/api/browser/extension/token/rotate", { method: "POST" });
      const payload = (await response.json()) as BrowserExtensionResponse;
      if (!payload.success) setError(payload.error ?? "Could not create a new token");
      else setData(payload);
    } catch {
      setError("The local browser service did not respond");
    } finally {
      setBusy(false);
    }
  }, []);

  const revealFolder = useCallback(async (path: string): Promise<void> => {
    try {
      await apiFetch("/api/ide/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
    } catch {
      setError("Could not open the extension folder");
    }
  }, []);

  const status = data?.status;
  const token = data?.pairing?.token ?? "";
  const directory = data?.extensionDirectory ?? null;
  const sharedTabs = status?.tabs.filter((tab) => tab.shared) ?? [];

  return (
    <section className="space-y-2 rounded-md border border-[var(--surface-border)] p-3">
      <header className="flex items-center gap-2">
        <Puzzle size={16} aria-hidden />
        <h3 className="text-sm font-medium">Browser extension</h3>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium ${
            status?.connected
              ? "bg-emerald-500/15 text-emerald-500"
              : "bg-[var(--surface-hover)] text-[var(--text-muted)]"
          }`}
        >
          {status?.connected ? "Connected" : "Not connected"}
        </span>
      </header>
      <p className="text-xs text-[var(--text-secondary)]">
        Let agents work in the Chrome, Edge or Brave tabs you share, with your own signed-in
        sessions. Ask an agent to use “my Chrome”, or share a tab from the extension’s toolbar
        button.
      </p>

      {status?.connected ? (
        <div className="space-y-1 text-xs">
          <p>
            {status.client?.product ?? "Chrome"} · extension {status.client?.extensionVersion}
          </p>
          {sharedTabs.length > 0 ? (
            <ul className="max-h-32 space-y-1 overflow-y-auto text-[var(--text-secondary)]">
              {sharedTabs.map((tab) => (
                <li key={tab.tabId} className="truncate">
                  {tab.title || tab.url}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[var(--text-muted)]">
              No tabs shared yet. Agents will open their own tab in your Chrome when asked.
            </p>
          )}
        </div>
      ) : (
        <ol className="list-decimal space-y-1 pl-4 text-xs text-[var(--text-secondary)]">
          <li>
            Open <code>chrome://extensions</code> and turn on Developer mode.
          </li>
          <li>
            Choose Load unpacked and select the extension folder
            {directory ? (
              <>
                : <code className="break-all">{directory}</code>
              </>
            ) : null}
            .
          </li>
          <li>
            Click the Cybara toolbar icon, paste the pairing token below, then Save and connect.
          </li>
        </ol>
      )}

      {directory && !status?.connected ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass}
            onClick={() => void copy(directory, "path")}
          >
            <Copy size={13} />
            {copied === "path" ? "Copied" : "Copy folder path"}
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={() => void revealFolder(directory)}
          >
            <FolderOpen size={13} />
            Show folder
          </button>
        </div>
      ) : null}

      <div className="space-y-1">
        <p className="text-xs font-medium">Pairing token</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded border border-[var(--surface-border)] px-2 py-1 text-xs">
            {token ? (revealToken ? token : "•".repeat(Math.min(token.length, 32))) : "…"}
          </code>
          <button
            type="button"
            className={buttonClass}
            aria-label={revealToken ? "Hide token" : "Show token"}
            onClick={() => setRevealToken((value) => !value)}
          >
            {revealToken ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!token}
            onClick={() => void copy(token, "token")}
          >
            <Copy size={13} />
            {copied === "token" ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            title="Create a new token and disconnect the current extension"
            onClick={() => void rotate()}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            New
          </button>
        </div>
      </div>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </section>
  );
}
