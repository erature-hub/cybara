import { describe, expect, test } from "bun:test";
import {
  anthropicContextBudgetChars,
  createAnthropicTokenCalibration,
  observeAnthropicInputTokens,
  observeAnthropicOverflow,
  parseAnthropicOverflowError,
} from "../../src/core/llm/anthropic-token-calibration";
import { describeAnthropicLoopFailure } from "../../src/core/llm/anthropic-loop-failure";
import {
  isAnthropicContextOverflowError,
  resolveAnthropicRequestTokenLimit,
} from "../../src/core/llm/anthropic-context";

const OVERFLOW_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "prompt is too long: 1,004,321 tokens > 1000000 maximum",
  },
});

describe("parsing Anthropic overflow errors", () => {
  test("reads the token counts from a prompt-too-long error, with or without separators", () => {
    expect(parseAnthropicOverflowError(OVERFLOW_BODY)).toEqual({
      inputTokens: 1_004_321,
      limitTokens: 1_000_000,
    });
    expect(
      parseAnthropicOverflowError("prompt is too long: 205000 tokens > 200000 maximum")
    ).toEqual({
      inputTokens: 205_000,
      limitTokens: 200_000,
    });
  });

  test("reads the input count from an input-plus-max_tokens error", () => {
    const text =
      "input length and `max_tokens` exceed context limit: 950000 + 128000 > 1000000, decrease input length or `max_tokens` and try again";
    expect(parseAnthropicOverflowError(text)).toEqual({
      inputTokens: 950_000,
      limitTokens: 1_000_000,
    });
    expect(isAnthropicContextOverflowError("anthropic", text, false)).toBe(true);
  });

  test("ignores unrelated errors", () => {
    expect(
      parseAnthropicOverflowError('{"error":{"message":"invalid x-api-key"}}')
    ).toBeUndefined();
    expect(parseAnthropicOverflowError("")).toBeUndefined();
  });
});

describe("calibrating chars per token from real usage", () => {
  test("dense tool output measured at 2.15 chars per token shrinks the context budget", () => {
    const calibration = createAnthropicTokenCalibration();
    expect(observeAnthropicInputTokens(calibration, 2_150_000, 1_000_000)).toBe(true);
    expect(calibration.charsPerToken).toBeCloseTo(2.15, 2);
    expect(anthropicContextBudgetChars(calibration, 1_000_000)).toBe(1_612_500);
  });

  test("clamps implausible ratios and ignores tiny requests", () => {
    const calibration = createAnthropicTokenCalibration();
    observeAnthropicInputTokens(calibration, 100_000, 1_000_000);
    expect(calibration.charsPerToken).toBe(1.5);
    observeAnthropicInputTokens(calibration, 10_000_000, 1_000);
    expect(calibration.charsPerToken).toBe(4);
    expect(observeAnthropicInputTokens(calibration, 500, 100)).toBe(false);
    expect(observeAnthropicInputTokens(calibration, 50_000, 0)).toBe(false);
    expect(calibration.charsPerToken).toBe(4);
  });

  test("an overflow error calibrates from the exact token count the provider reported", () => {
    const calibration = createAnthropicTokenCalibration();
    const body = { messages: [{ role: "user", content: "x".repeat(2_000_000) }] };
    expect(observeAnthropicOverflow(calibration, body, OVERFLOW_BODY)).toBe(true);
    expect(calibration.charsPerToken).toBeCloseTo(2_000_000 / 1_004_321, 1);
  });
});

describe("output budget near the window", () => {
  test("a calibrated ratio leaves room for output that the 4 chars per token guess would not", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(2_000_000) }] };
    const naive = resolveAnthropicRequestTokenLimit(body, 128_000, 1_000_000);
    const calibrated = resolveAnthropicRequestTokenLimit(body, 128_000, 1_000_000, 2.15);
    expect(naive).toBe(128_000);
    expect(Math.ceil(2_000_000 / 2.15) + calibrated).toBeLessThanOrEqual(1_000_000);
  });
});

describe("loop failure messages", () => {
  test("a context overflow says so instead of calling it temporary", () => {
    const failure = describeAnthropicLoopFailure(400, OVERFLOW_BODY, false);
    expect(failure.kind).toBe("context_overflow");
    expect(failure.message).toContain("context window");
    expect(failure.message).not.toContain("temporary");
  });

  test("another rejected request shows the provider's own reason", () => {
    const failure = describeAnthropicLoopFailure(
      400,
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.3: tool_use ids must be unique"}}',
      true
    );
    expect(failure.kind).toBe("rejected");
    expect(failure.message).toContain("(400): messages.3: tool_use ids must be unique");
    expect(failure.message.startsWith("\n\n---\n")).toBe(true);
  });

  test("rate limits, overload and network errors keep the retry-later wording", () => {
    for (const status of [429, 500, 529, undefined]) {
      expect(describeAnthropicLoopFailure(status, "overloaded", false).kind).toBe("transient");
    }
    expect(describeAnthropicLoopFailure(503, "", false).message).toContain("temporary API error");
  });

  test("very long provider errors are truncated", () => {
    const failure = describeAnthropicLoopFailure(
      400,
      `{"error":{"message":"${"z".repeat(2000)}"}}`,
      false
    );
    expect(failure.message.length).toBeLessThan(400);
  });
});
