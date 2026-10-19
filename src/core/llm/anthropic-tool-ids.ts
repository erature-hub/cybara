import { createHash } from "node:crypto";

export function normalizeAnthropicToolIds(messages: unknown[]): unknown[] {
  const identifiers = new Set<string>();
  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || !("content" in raw) || !Array.isArray(raw.content))
      continue;
    for (const block of raw.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use" && typeof block.id === "string") identifiers.add(block.id);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string")
        identifiers.add(block.tool_use_id);
    }
  }
  const used = new Set([...identifiers].filter((id) => /^[a-zA-Z0-9_-]+$/.test(id)));
  const replacements = new Map<string, string>();
  for (const id of identifiers) {
    if (/^[a-zA-Z0-9_-]+$/.test(id)) continue;
    const base = `toolu_${createHash("sha256").update(id).digest("hex")}`;
    let next = base;
    let suffix = 0;
    while (used.has(next)) next = `${base}_${++suffix}`;
    used.add(next);
    replacements.set(id, next);
  }
  if (!replacements.size) return messages;
  return messages.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || !("content" in raw) || !Array.isArray(raw.content))
      return raw;
    return {
      ...raw,
      content: raw.content.map((block: unknown) => {
        if (!block || typeof block !== "object") return block;
        if (
          "type" in block &&
          block.type === "tool_use" &&
          "id" in block &&
          typeof block.id === "string"
        ) {
          return replacements.has(block.id) ? { ...block, id: replacements.get(block.id) } : block;
        }
        if (
          "type" in block &&
          block.type === "tool_result" &&
          "tool_use_id" in block &&
          typeof block.tool_use_id === "string"
        ) {
          return replacements.has(block.tool_use_id)
            ? { ...block, tool_use_id: replacements.get(block.tool_use_id) }
            : block;
        }
        return block;
      }),
    };
  });
}
