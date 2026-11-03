#!/usr/bin/env bun
/**
 * Block outbound-network tools when the installation is in offline mode.
 *
 * Reads the hook event on stdin. When the environment variable
 * CYBARA_OFFLINE_MODE is truthy and the requested tool can reach the network,
 * the guard returns a blocking decision. Otherwise it returns an empty
 * decision and the tool runs normally.
 */

const NETWORK_TOOLS = new Set([
  "http",
  "web_fetch",
  "webfetch",
  "fetch",
  "browser",
  "browser_action",
  "browse",
  "search",
  "web_search",
]);

const TRUTHY = new Set(["1", "true", "yes", "on"]);

interface ToolBeforeEvent {
  type: string;
  toolName: string;
  args: Record<string, unknown>;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk as Uint8Array);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

function isOfflineMode(): boolean {
  const raw = process.env.CYBARA_OFFLINE_MODE?.trim().toLowerCase();
  return raw !== undefined && TRUTHY.has(raw);
}

function isNetworkTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (NETWORK_TOOLS.has(normalized)) return true;
  return normalized.startsWith("plugin_") ? false : normalized.includes("http");
}

async function main(): Promise<void> {
  let event: ToolBeforeEvent | null = null;
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as ToolBeforeEvent;
      if (parsed && typeof parsed.toolName === "string") event = parsed;
    }
  } catch {
    event = null;
  }

  if (!event) {
    console.log(JSON.stringify({}));
    return;
  }

  if (!isOfflineMode() || !isNetworkTool(event.toolName)) {
    console.log(JSON.stringify({}));
    return;
  }

  console.log(
    JSON.stringify({
      block: true,
      reason:
        `Offline mode is enabled (CYBARA_OFFLINE_MODE). The tool "${event.toolName}" can reach the network, so it was blocked. Unset CYBARA_OFFLINE_MODE to allow outbound calls.`,
    })
  );
}

await main();
