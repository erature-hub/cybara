import { describe, expect, test } from "bun:test";
import {
  estimateAnthropicRequestInputTokens,
  resolveAnthropicRequestTokenLimit,
} from "../../src/core/llm/anthropic-context";

describe("Anthropic output budget preflight", () => {
  test("makes room for a useful response when conservative calibration exhausts the estimate", () => {
    const messages = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "x".repeat(1_900_785) },
      { role: "user", content: "Please finish the task." },
    ];
    const request = { model: "model", messages };
    const originalInput = estimateAnthropicRequestInputTokens(request, 1.5);
    expect(originalInput).toBeGreaterThan(1_000_000);
    expect(Math.max(1, Math.min(128_000, 1_000_000 - originalInput - 10_000))).toBe(1);

    const output = resolveAnthropicRequestTokenLimit(request, 128_000, 1_000_000, 1.5);

    expect(output).toBeGreaterThanOrEqual(4_096);
    expect(estimateAnthropicRequestInputTokens(request, 1.5) + output + 10_000).toBeLessThanOrEqual(
      1_000_000
    );
    expect(request.messages).toBe(messages);
    expect(messages.at(-1)?.content).toBe("Please finish the task.");
    expect(messages[0]?.role).toBe("user");
    expect(messages.length).toBe(1);
  });

  test("compacts an oversized system before sending rather than returning one output token", () => {
    const request = {
      system: "s".repeat(400_000),
      messages: [{ role: "user", content: "Answer the question." }],
    };
    const output = resolveAnthropicRequestTokenLimit(request, 16_000, 100_000, 3);
    expect(output).toBeGreaterThanOrEqual(4_096);
    expect(estimateAnthropicRequestInputTokens(request, 3) + output + 1_000).toBeLessThanOrEqual(
      100_000
    );
    expect(request.messages[0]?.content).toBe("Answer the question.");
  });

  test("rejects unshrinkable current input instead of silently sending max_tokens one", () => {
    const request = { messages: [{ role: "user", content: "x".repeat(400_000) }] };
    expect(() => resolveAnthropicRequestTokenLimit(request, 16_000, 100_000, 3)).toThrow(
      "Insufficient Anthropic context for a useful response"
    );
  });

  test("rejects oversized fixed tool schemas without dropping tools", () => {
    const tools = [{ name: "tool", description: "x".repeat(400_000) }];
    const request = { tools, messages: [{ role: "user", content: "Run the tool." }] };
    expect(() => resolveAnthropicRequestTokenLimit(request, 16_000, 100_000, 3)).toThrow(
      "Insufficient Anthropic context for a useful response"
    );
    expect(request.tools).toBe(tools);
  });

  test("preserves small explicit output limits and unchanged requests with enough room", () => {
    const request = { messages: [{ role: "user", content: "Hi" }] };
    const original = structuredClone(request);
    expect(resolveAnthropicRequestTokenLimit(request, 32, 100_000, 3)).toBe(32);
    expect(request).toEqual(original);
  });
});
