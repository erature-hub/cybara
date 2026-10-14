import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  applyBedrockPromptCache,
  supportsBedrockPromptCache,
} from "../../src/core/llm/bedrock-prompt-cache";

const CLAUDE = "us.anthropic.claude-sonnet-5-5-v1:0";

function payload(overrides: Partial<ConverseCommandInput> = {}): ConverseCommandInput {
  return {
    modelId: CLAUDE,
    system: [{ text: "You are a careful assistant." }],
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: "read",
            description: "read a file",
            inputSchema: { json: { type: "object", properties: {} } },
          },
        },
      ],
    },
    messages: [
      { role: "user", content: [{ text: "first" }] },
      { role: "assistant", content: [{ text: "reply one" }] },
      { role: "user", content: [{ text: "second" }] },
      { role: "assistant", content: [{ text: "reply two" }] },
      { role: "user", content: [{ text: "third" }] },
    ],
    ...overrides,
  };
}

function cachePointCount(input: ConverseCommandInput): number {
  const inSystem = (input.system ?? []).filter((b) => "cachePoint" in b).length;
  const inTools = (input.toolConfig?.tools ?? []).filter((t) => "cachePoint" in t).length;
  const inMessages = (input.messages ?? []).reduce(
    (sum, m) => sum + (m.content ?? []).filter((b) => "cachePoint" in b).length,
    0
  );
  return inSystem + inTools + inMessages;
}

function endsWithCachePoint(blocks: ReadonlyArray<object> | undefined): boolean {
  const last = blocks?.at(-1);
  return !!last && "cachePoint" in last;
}

describe("bedrock prompt caching", () => {
  test("recognises Claude and Nova model ids, including inference profiles and ARNs", () => {
    expect(supportsBedrockPromptCache("anthropic.claude-opus-5-5-v1:0")).toBe(true);
    expect(supportsBedrockPromptCache(CLAUDE)).toBe(true);
    expect(
      supportsBedrockPromptCache(
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-5-5-v1:0"
      )
    ).toBe(true);
    expect(supportsBedrockPromptCache("amazon.nova-pro-v1:0")).toBe(true);
    expect(supportsBedrockPromptCache("meta.llama4-maverick-17b-instruct-v1:0")).toBe(false);
    expect(supportsBedrockPromptCache("")).toBe(false);
  });

  test("marks the system prompt and the two most recent user turns", () => {
    const cached = applyBedrockPromptCache(payload());
    expect(endsWithCachePoint(cached.system)).toBe(true);
    const roles = (cached.messages ?? []).map((m) => endsWithCachePoint(m.content));
    expect(roles).toEqual([false, false, true, false, true]);
    expect(cachePointCount(cached)).toBe(3);
  });

  test("falls back to caching the tool list when there is no system prompt", () => {
    const cached = applyBedrockPromptCache(payload({ system: undefined }));
    expect(cached.system).toBeUndefined();
    expect(endsWithCachePoint(cached.toolConfig?.tools)).toBe(true);
    expect(cachePointCount(cached)).toBe(3);
  });

  test("never exceeds the four cache point limit and stays idempotent across loop iterations", () => {
    const once = applyBedrockPromptCache(payload());
    const twice = applyBedrockPromptCache(once);
    const thrice = applyBedrockPromptCache(twice);
    expect(cachePointCount(thrice)).toBe(3);
    expect(cachePointCount(thrice)).toBeLessThanOrEqual(4);
    expect(thrice).toEqual(once);
  });

  test("does not mutate the conversation the agent loop keeps appending to", () => {
    const input = payload();
    const snapshot = JSON.stringify(input);
    applyBedrockPromptCache(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("leaves models without prompt caching untouched", () => {
    const input = payload({ modelId: "meta.llama4-maverick-17b-instruct-v1:0" });
    expect(applyBedrockPromptCache(input)).toBe(input);
  });

  test("skips empty messages instead of emitting a cache point with no content", () => {
    const cached = applyBedrockPromptCache(payload({ messages: [{ role: "user", content: [] }] }));
    expect(cached.messages?.[0]?.content).toEqual([]);
  });
});

describe("bedrock prompt caching on the wire", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const bodies: Array<Record<string, unknown>> = [];

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push((await request.json()) as Record<string, unknown>);
        return Response.json({
          output: { message: { role: "assistant", content: [{ text: "OK" }] } },
          stopReason: "end_turn",
          usage: {
            inputTokens: 4,
            outputTokens: 1,
            totalTokens: 5,
            cacheReadInputTokens: 9000,
            cacheWriteInputTokens: 12,
          },
          metrics: { latencyMs: 1 },
        });
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
  });

  test("the serialized Converse request carries the cache points to Bedrock", async () => {
    const client = new BedrockRuntimeClient({
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${server?.port}`,
      credentials: { accessKeyId: "AKIDFIXTURE", secretAccessKey: "fixture-secret" },
      requestHandler: new NodeHttpHandler(),
    });
    const response = await client.send(new ConverseCommand(applyBedrockPromptCache(payload())));
    expect(response.usage?.cacheReadInputTokens).toBe(9000);

    const body = bodies.at(-1) ?? {};
    const system = body.system as Array<Record<string, unknown>>;
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(system.at(-1)).toEqual({ cachePoint: { type: "default" } });
    expect(messages.at(-1)?.content.at(-1)).toEqual({ cachePoint: { type: "default" } });
    expect(messages[0]?.content.some((block) => "cachePoint" in block)).toBe(false);
  });
});
