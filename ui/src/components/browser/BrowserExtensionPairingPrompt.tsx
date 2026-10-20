import { useCallback, useEffect, useState } from "react";
import { Loader2, Puzzle, X } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { useUIStore } from "@/stores/uiStore";

export interface BrowserExtensionPairingRequest {
  id: string;
  code: string;
  browser: string;
  createdAt: string;
  expiresAt: string;
}

const POLL_INTERVAL_MS = 3_000;

export async function resolveBrowserExtensionPairing(
  id: string,
  decision: "approve" | "deny"
): Promise<{ success: boolean; error?: string }> {
  const response = await apiFetch(
    `/api/browser/extension/pairing/${encodeURIComponent(id)}/${decision}`,
    { method: "POST" }
  );
  return (await response.json()) as { success: boolean; error?: string };
}

export function BrowserExtensionPairingPrompt(): React.JSX.Element | null {
  const [requests, setRequests] = useState<BrowserExtensionPairingRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const addToast = useUIStore((state) => state.addToast);

  useEffect(() => {
    let active = true;
    const poll = async (): Promise<void> => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await apiFetch("/api/browser/extension/pairing");
        const data = (await response.json()) as {
          success?: boolean;
          requests?: BrowserExtensionPairingRequest[];
        };
        if (active) setRequests(data.success && Array.isArray(data.requests) ? data.requests : []);
      } catch {
        void 0;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const resolve = useCallback(
    async (request: BrowserExtensionPairingRequest, decision: "approve" | "deny") => {
      setBusyId(request.id);
      try {
        const result = await resolveBrowserExtensionPairing(request.id, decision);
        setRequests((current) => current.filter((entry) => entry.id !== request.id));
        if (decision === "approve") {
          addToast(
            result.success ? "success" : "error",
            result.success
              ? `${request.browser} is connected to Cybara`
              : (result.error ?? "Could not connect")
          );
        }
      } catch {
        addToast("error", "Cybara could not reach the browser extension service");
      } finally {
        setBusyId(null);
      }
    },
    [addToast]
  );

  const request = requests[0];
  if (!request) return null;
  const [left, right] = request.code.split("-");

  return (
    <div
      role="dialog"
      aria-labelledby="browser-pairing-title"
      className="fixed right-4 bottom-4 z-[60] w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--surface-border)] bg-[var(--surface-panel)] p-4 shadow-2xl"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[rgba(var(--accent-primary),0.16)] text-[rgb(var(--accent-primary))]">
          <Puzzle size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="browser-pairing-title" className="text-sm font-semibold">
            Connect browser?
          </h2>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {request.browser} wants to connect as Cybara Browser Bridge. Approve only if this code
            matches the one in your browser.
          </p>
        </div>
        <button
          type="button"
          aria-label="Decline"
          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
          disabled={busyId === request.id}
          onClick={() => void resolve(request, "deny")}
        >
          <X size={14} />
        </button>
      </div>
      <div className="my-3 flex justify-center gap-1.5 font-mono text-2xl font-bold tracking-[0.12em]">
        {[left, right].filter(Boolean).map((part) => (
          <span
            key={part}
            className="rounded-lg border border-[rgba(var(--accent-primary),0.4)] bg-[rgba(var(--accent-primary),0.12)] px-3 py-1"
          >
            {part}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="flex-1 rounded-lg border border-[var(--surface-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--surface-hover)] disabled:opacity-50"
          disabled={busyId === request.id}
          onClick={() => void resolve(request, "deny")}
        >
          Decline
        </button>
        <button
          type="button"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: "var(--accent-gradient)" }}
          disabled={busyId === request.id}
          onClick={() => void resolve(request, "approve")}
        >
          {busyId === request.id ? <Loader2 size={14} className="animate-spin" /> : null}
          Approve
        </button>
      </div>
    </div>
  );
}
