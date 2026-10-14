import type { ChatMessage } from "./chat";

export interface SessionTranscriptMergeOptions {
  preservePersistedMetadata?: boolean;
}

function messageIdentity(message: ChatMessage): string {
  return `${message.role}\u0000${message.run_id || ""}\u0000${message.content}`;
}

function removeSupersededInterruptedMessages(
  persistedMessages: ChatMessage[],
  activeMessages: ChatMessage[]
): { persisted: ChatMessage[]; active: ChatMessage[] } {
  const completedRunIds = new Set(
    [...persistedMessages, ...activeMessages]
      .filter(
        (message) =>
          message.role === "assistant" &&
          message.interrupted !== true &&
          typeof message.run_id === "string" &&
          message.run_id.trim().length > 0
      )
      .map((message) => message.run_id?.trim())
      .filter((runId): runId is string => !!runId)
  );
  const keep = (message: ChatMessage): boolean =>
    !(
      message.role === "assistant" &&
      message.interrupted === true &&
      typeof message.run_id === "string" &&
      completedRunIds.has(message.run_id.trim())
    );
  return {
    persisted: persistedMessages.filter(keep),
    active: activeMessages.filter(keep),
  };
}

export function mergeSessionTranscriptMessages(
  persistedMessages: ChatMessage[],
  activeMessages: ChatMessage[],
  options: SessionTranscriptMergeOptions = {}
): ChatMessage[] {
  const reconciled = removeSupersededInterruptedMessages(persistedMessages, activeMessages);
  if (reconciled.persisted.length === 0) return reconciled.active;

  const compacted = reconciled.active.some(
    (message) => message.role === "system" && message.content.includes("Context Summary")
  );
  if (compacted || options.preservePersistedMetadata) {
    return mergePersistedFirst(
      reconciled.persisted,
      reconciled.active,
      options.preservePersistedMetadata === true
    );
  }

  return mergeActiveFirst(reconciled.persisted, reconciled.active);
}

function mergePersistedFirst(
  persistedMessages: ChatMessage[],
  activeMessages: ChatMessage[],
  preservePersistedMetadata = false
): ChatMessage[] {
  const conversational = activeMessages.filter(
    (message) => message.role === "user" || message.role === "assistant"
  );
  const activeByIdentity = new Map<string, ChatMessage[]>();
  for (const message of conversational) {
    const identity = messageIdentity(message);
    const matches = activeByIdentity.get(identity) || [];
    matches.push(message);
    activeByIdentity.set(identity, matches);
  }

  const mergedIndexByActive = new Map<ChatMessage, number>();
  const merged = persistedMessages.map((persisted, index) => {
    const matches = activeByIdentity.get(messageIdentity(persisted));
    const active = matches?.shift();
    if (!active) return persisted;
    mergedIndexByActive.set(active, index);
    if (preservePersistedMetadata) {
      const merged = {
        ...active,
        ...persisted,
        content: persisted.content,
        timestamp: persisted.timestamp || active.timestamp,
      };
      if (persisted.metadata_deferred) {
        delete merged.thinking;
        delete merged.tool_calls;
        delete merged.process_activities;
      }
      return merged;
    }
    return {
      ...persisted,
      ...active,
      content: persisted.content,
      timestamp: persisted.timestamp || active.timestamp,
    };
  });

  return placeUnmatchedActiveMessages(merged, conversational, mergedIndexByActive);
}

function placeUnmatchedActiveMessages(
  merged: ChatMessage[],
  conversational: ChatMessage[],
  mergedIndexByActive: Map<ChatMessage, number>
): ChatMessage[] {
  const insertionsAfter = new Map<number, ChatMessage[]>();
  let anchor = -1;
  for (const message of conversational) {
    const matchedIndex = mergedIndexByActive.get(message);
    if (matchedIndex !== undefined) {
      anchor = Math.max(anchor, matchedIndex);
      continue;
    }
    const pending = insertionsAfter.get(anchor) || [];
    pending.push(message);
    insertionsAfter.set(anchor, pending);
  }
  if (insertionsAfter.size === 0) return merged;

  const placed: ChatMessage[] = [...(insertionsAfter.get(-1) || [])];
  merged.forEach((message, index) => {
    placed.push(message, ...(insertionsAfter.get(index) || []));
  });
  return placed;
}

function messageTimestamp(message: ChatMessage): number | null {
  if (!message.timestamp) return null;
  const parsed = Date.parse(
    message.timestamp.replace(" ", "T") + (message.timestamp.endsWith("Z") ? "" : "Z")
  );
  return Number.isFinite(parsed) ? parsed : null;
}

function mergeActiveFirst(
  persistedMessages: ChatMessage[],
  activeMessages: ChatMessage[]
): ChatMessage[] {
  const persistedByIdentity = new Map<string, ChatMessage[]>();
  for (const message of persistedMessages) {
    const matches = persistedByIdentity.get(messageIdentity(message)) || [];
    matches.push(message);
    persistedByIdentity.set(messageIdentity(message), matches);
  }

  const merged = activeMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((active) => {
      const persisted = persistedByIdentity.get(messageIdentity(active))?.shift();
      if (!persisted) return active;
      return {
        ...persisted,
        ...active,
        content: active.content,
        timestamp: persisted.timestamp || active.timestamp,
      };
    });
  const persistedOnly = [...persistedByIdentity.values()].flat();
  if (persistedOnly.length === 0) return merged;

  return [...merged, ...persistedOnly]
    .map((message, index) => ({
      message,
      index,
      timestamp: messageTimestamp(message),
    }))
    .sort((left, right) => {
      if (
        left.timestamp === null ||
        right.timestamp === null ||
        left.timestamp === right.timestamp
      ) {
        return left.index - right.index;
      }
      return left.timestamp - right.timestamp;
    })
    .map((entry) => entry.message);
}
