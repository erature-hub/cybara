import { describe, expect, test } from "bun:test";
import { compactAnthropicLoopMessagesForContext } from "../../src/core/agent-context-guard";
import { recoverAnthropicRequestForContext } from "../../src/core/llm/anthropic-context";
import { parseAnthropicEventStream } from "../../src/core/llm/anthropic-streaming";
import {
  recoverAnthropicThinkingSignature,
  stripAnthropicThinkingBlocks,
} from "../../src/core/llm/anthropic-thinking-binding";

type WireMessage = Record<string, unknown>;

function history(): WireMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "Read output" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first", signature: "signed-first" },
        { type: "tool_use", id: "read_first", name: "read", input: { path: "old" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "read_first", content: "x".repeat(18000) }],
    },
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "signed-hidden" },
        { type: "text", text: "more output needed" },
        { type: "tool_use", id: "read_second", name: "read", input: { path: "new" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "read_second", content: "latest output" }],
    },
  ];
}

function types(messages: WireMessage[]): string[] {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .flatMap((block: unknown) =>
      block !== null &&
      typeof block === "object" &&
      "type" in block &&
      typeof block.type === "string"
        ? [block.type]
        : []
    );
}

describe("thinking bound to a compacted prefix", () => {
  test("unchanged history retains all signed and redacted blocks", () => {
    const messages = history();
    const before = structuredClone(messages);
    expect(compactAnthropicLoopMessagesForContext(messages, 100000)).toBe(false);
    expect(messages).toEqual(before);
  });

  test("actually compacting tool output removes invalidated thinking, not text or tool pairs", () => {
    const messages = history();
    expect(compactAnthropicLoopMessagesForContext(messages, 4096, true)).toBe(true);
    expect(types(messages)).not.toContain("thinking");
    expect(types(messages)).not.toContain("redacted_thinking");
    expect(types(messages).filter((type) => type === "tool_use")).toHaveLength(2);
    expect(types(messages).filter((type) => type === "tool_result")).toHaveLength(2);
    expect(JSON.stringify(messages)).toContain("more output needed");
    expect(JSON.stringify(messages)).toContain("latest output");
  });

  test("overflow trimming does not retain thinking from the removed prefix", () => {
    const body = { system: "s".repeat(10000), messages: history(), max_tokens: 4000 };
    expect(recoverAnthropicRequestForContext(body, 6000, 0)).toBe(true);
    expect(types(body.messages)).not.toContain("thinking");
    expect(types(body.messages)).not.toContain("redacted_thinking");
  });

  test("strip is idempotent and discards thinking-only turns without empty wire content", () => {
    const messages = [
      ...history(),
      { role: "assistant", content: [{ type: "thinking", signature: "only-thinking" }] },
    ];
    expect(stripAnthropicThinkingBlocks(messages)).toBe(3);
    expect(stripAnthropicThinkingBlocks(messages)).toBe(0);
    expect(messages).toHaveLength(5);
  });

  test("signature repair is a no-op for malformed or unrelated input", () => {
    expect(
      recoverAnthropicThinkingSignature({}, "Invalid signature in thinking block")
    ).toBeUndefined();
    expect(
      recoverAnthropicThinkingSignature(
        { messages: [null, { role: "user", content: "x" }] },
        "Invalid signature in thinking block"
      )
    ).toBeUndefined();
    expect(
      recoverAnthropicThinkingSignature({ messages: history() }, "invalid x-api-key")
    ).toBeUndefined();
  });
});

describe("provider thinking transformations", () => {
  test("stream parsing retains drop notices so the runtime can avoid replaying dropped blocks", () => {
    const transformation = {
      type: "thinking_dropped",
      path: "messages.1.content.0",
      reason: "prefix_binding_mismatch",
    };
    const stream = [
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_drop", model: "claude-opus-5-5", role: "assistant", usage: { input_tokens: 1, output_tokens: 1 }, input_transformations: [transformation] } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } })}\n\n`,
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    expect(parseAnthropicEventStream(stream, 0).message.input_transformations).toEqual([
      transformation,
    ]);
  });
});
