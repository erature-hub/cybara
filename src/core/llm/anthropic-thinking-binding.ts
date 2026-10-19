export const ANTHROPIC_THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

const IMPLICIT_ADAPTIVE_MODEL = /^claude-(?:opus-5-5|sonnet-5-5|haiku-5-5|fable-5-1)(?:-|$)/;
const SIGNATURE_ERROR = /invalid\s+[`"']?signature[`"']?|bound to a different conversation/i;
const THINKING_ERROR = /\b(?:thinking|redacted_thinking)\b/i;

interface AnthropicThinkingRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstPartyAnthropic(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

export function prepareAnthropicThinkingRequest(
  baseUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): AnthropicThinkingRequest {
  if (!firstPartyAnthropic(baseUrl)) return { body, headers };
  const configured = record(body.thinking);
  const implicit =
    body.thinking === undefined &&
    typeof body.model === "string" &&
    IMPLICIT_ADAPTIVE_MODEL.test(body.model);
  const thinking = configured ?? (implicit ? { type: "adaptive" } : undefined);
  if (thinking?.type !== "adaptive" && thinking?.type !== "enabled") return { body, headers };

  const betaKey = Object.keys(headers).find((key) => key.toLowerCase() === "anthropic-beta");
  const betas = (headers[betaKey ?? "anthropic-beta"] ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  const beta = [...new Set([...betas, ANTHROPIC_THINKING_BINDING_BETA])].join(",");
  return {
    body: {
      ...body,
      thinking: {
        ...thinking,
        block_binding: {
          ...record(thinking.block_binding),
          prefix_mismatch_behavior: "drop_block",
        },
      },
    },
    headers: { ...headers, [betaKey ?? "anthropic-beta"]: beta },
  };
}

export function stripAnthropicThinkingBlocks(messages: unknown[]): number {
  let removed = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const content = message.content.filter((block: unknown) => {
      const type = record(block)?.type;
      if (type !== "thinking" && type !== "redacted_thinking") return true;
      removed += 1;
      return false;
    });
    if (content.length === message.content.length) continue;
    if (content.length === 0) messages.splice(index, 1);
    else messages[index] = { ...message, content };
  }
  return removed;
}

export function recoverAnthropicThinkingSignature(
  body: Record<string, unknown>,
  errorText: string
): Record<string, unknown> | undefined {
  if (!SIGNATURE_ERROR.test(errorText) || !THINKING_ERROR.test(errorText)) return undefined;
  if (!Array.isArray(body.messages)) return undefined;
  const messages: unknown[] = [...body.messages];
  return stripAnthropicThinkingBlocks(messages) > 0 ? { ...body, messages } : undefined;
}
