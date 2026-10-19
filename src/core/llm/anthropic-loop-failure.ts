import { isAnthropicInputAndOutputOverflow } from "./anthropic-token-calibration";
import { isContextOverflowError } from "./tool-transcript";

const MAX_DETAIL_CHARS = 300;

export type AnthropicLoopFailureKind = "context_overflow" | "rejected" | "transient";

export interface AnthropicLoopFailure {
  kind: AnthropicLoopFailureKind;
  message: string;
}

function providerErrorDetail(errorText: string): string {
  const trimmed = errorText.trim();
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    void 0;
  }
  return trimmed;
}

function truncateDetail(detail: string): string {
  const singleLine = detail.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_DETAIL_CHARS
    ? `${singleLine.slice(0, MAX_DETAIL_CHARS - 1)}…`
    : singleLine;
}

export function classifyAnthropicLoopFailure(
  status: number | undefined,
  errorText: string
): AnthropicLoopFailureKind {
  if (isContextOverflowError(errorText) || isAnthropicInputAndOutputOverflow(errorText)) {
    return "context_overflow";
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return "rejected";
  }
  return "transient";
}

export function describeAnthropicLoopFailure(
  status: number | undefined,
  errorText: string,
  hasPartialContent: boolean
): AnthropicLoopFailure {
  const kind = classifyAnthropicLoopFailure(status, errorText);
  if (kind === "context_overflow") {
    return {
      kind,
      message: hasPartialContent
        ? "\n\n---\n*Note: I had to stop early because this conversation no longer fits in the model's context window, even after compacting older tool output. Start a new chat to continue, or ask me to summarise the work so far.*"
        : "This conversation no longer fits in the model's context window, even after compacting older tool output. Start a new chat to continue, or ask me to summarise the work so far so it can be carried over.",
    };
  }
  if (kind === "rejected") {
    const detail = truncateDetail(providerErrorDetail(errorText));
    const reason = detail
      ? `The provider rejected the request (${status}): ${detail}`
      : `The provider rejected the request (${status}).`;
    return {
      kind,
      message: hasPartialContent
        ? `\n\n---\n*Note: I had to stop early. ${reason}*`
        : `I couldn't complete my response. ${reason}`,
    };
  }
  return {
    kind,
    message: hasPartialContent
      ? "\n\n---\n*Note: I encountered a temporary API error and had to stop early. The above represents partial progress.*"
      : "I encountered a temporary API error and couldn't complete my response. The work I've done so far has been preserved. Please try again.",
  };
}
