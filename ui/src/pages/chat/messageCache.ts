import type { ChatMessage } from "@/types";

const MESSAGE_CACHE_STALE_MS = 15 * 60 * 1000;
const sessionMessageCache = new Map<string, { messages: ChatMessage[]; updatedAt: number }>();

function normalizeSessionId(sessionId?: string | null): string | null {
  const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
  return trimmed || null;
}

export function readCachedSessionMessages(sessionId?: string | null): ChatMessage[] | null {
  const key = normalizeSessionId(sessionId);
  if (!key) return null;
  const cached = sessionMessageCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.updatedAt > MESSAGE_CACHE_STALE_MS) {
    sessionMessageCache.delete(key);
    return null;
  }
  return cached.messages;
}

export function writeCachedSessionMessages(
  sessionId: string | null | undefined,
  messages: ChatMessage[]
): void {
  const key = normalizeSessionId(sessionId);
  if (!key || !Array.isArray(messages) || messages.length === 0) return;
  sessionMessageCache.set(key, { messages, updatedAt: Date.now() });
}

export function clearCachedSessionMessages(sessionId?: string | null): void {
  const key = normalizeSessionId(sessionId);
  if (key) sessionMessageCache.delete(key);
}

const hasItems = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

function matchesTranscriptPosition(left: ChatMessage, right: ChatMessage): boolean {
  return left.role === right.role && left.content === right.content;
}

function messageIdentityKeys(message: ChatMessage): string[] {
  const keys: string[] = [];
  if (message.message_id) keys.push(`id\u0000${message.message_id}`);
  if (message.timestamp) keys.push(`ts\u0000${message.role}\u0000${message.timestamp}`);
  return keys;
}

export function appendNewMessages(
  existing: ChatMessage[],
  additions: ChatMessage[]
): ChatMessage[] {
  const seen = new Set(existing.flatMap(messageIdentityKeys));
  const fresh: ChatMessage[] = [];
  for (const message of additions) {
    const keys = messageIdentityKeys(message);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    fresh.push(message);
  }
  return fresh.length === 0 ? existing : [...existing, ...fresh];
}

function isMatchingTranscriptPrefix(reference: ChatMessage[], reloaded: ChatMessage[]): boolean {
  return (
    reloaded.length < reference.length &&
    reloaded.every((message, index) => matchesTranscriptPosition(reference[index], message))
  );
}

export function enrichReloadedMessages(
  reference: ChatMessage[],
  reloaded: ChatMessage[],
  options: { preserveReferenceTail?: boolean } = {}
): ChatMessage[] {
  if (!hasItems(reference)) return reloaded;
  const byKey = new Map<string, ChatMessage>();
  for (const message of reference) {
    for (const key of messageIdentityKeys(message)) {
      if (!byKey.has(key)) byKey.set(key, message);
    }
  }

  const enriched = reloaded.map((message, index) => {
    const positional = reference[index];
    const existing =
      messageIdentityKeys(message)
        .map((key) => byKey.get(key))
        .find((candidate) => candidate !== undefined) ??
      (positional && matchesTranscriptPosition(positional, message) ? positional : undefined);
    if (!existing || existing.role !== message.role) return message;
    const merged = { ...message } as Record<string, unknown>;
    const prior = existing as unknown as Record<string, unknown>;
    for (const field of ["tool_calls", "process_activities", "images", "subagent_calls"]) {
      if (!hasItems(merged[field]) && hasItems(prior[field])) merged[field] = prior[field];
    }
    if (!merged.thinking && typeof prior.thinking === "string") merged.thinking = prior.thinking;
    return merged as unknown as ChatMessage;
  });

  if (options.preserveReferenceTail && isMatchingTranscriptPrefix(reference, reloaded)) {
    return [...enriched, ...reference.slice(reloaded.length)];
  }

  return enriched;
}
