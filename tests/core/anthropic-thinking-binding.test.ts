import { describe, expect, test } from "bun:test";
import { postAnthropicStreamableMessages } from "../../src/core/llm/anthropic-streaming";

const BETA = "thinking-binding-controls-2026-08-01";
const BINDING = { prefix_mismatch_behavior: "drop_block" };
const ERROR = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".',
  },
};

interface RecordedRequest {
  headers: Headers;
  body: Record<string, unknown>;
}

function conversation(): Record<string, unknown> {
  return {
    model: "claude-opus-5-5",
    max_tokens: 4096,
    system: [{ type: "text", text: "Updated system instructions" }],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    messages: [
      { role: "user", content: [{ type: "text", text: "Earlier tool output was compacted" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Visible reasoning", signature: "signed-prefix-fixture" },
          { type: "redacted_thinking", data: "redacted-prefix-fixture" },
          { type: "text", text: "I will read the file." },
          { type: "tool_use", id: "toolu_1", name: "read", input: { path: "package.json" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "already completed" }],
      },
    ],
  };
}

function recorder(respond: (request: RecordedRequest, index: number) => Response): {
  requests: RecordedRequest[];
  fetchImpl: typeof fetch;
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = {
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    requests.push(request);
    return respond(request, requests.length);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

function success(): Response {
  return Response.json({ content: [{ type: "text", text: "continued" }], stop_reason: "end_turn" });
}

async function send(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  baseUrl = "https://api.anthropic.com/v1",
  headers: Record<string, string> = { "x-api-key": "sk-ant-fixture" },
  signal?: AbortSignal
): Promise<Response> {
  return await postAnthropicStreamableMessages(
    baseUrl,
    "/messages",
    body,
    { headers, signal },
    fetchImpl
  );
}

describe("Anthropic thinking binding on serialized requests", () => {
  for (const type of ["adaptive", "enabled"]) {
    test(`keeps thinking but opts into safe prefix mismatch handling (${type})`, async () => {
      const original = conversation();
      original.thinking = type === "enabled" ? { type, budget_tokens: 1024 } : original.thinking;
      const before = structuredClone(original);
      const { requests, fetchImpl } = recorder(() => success());
      const response = await send(original, fetchImpl, undefined, {
        "x-api-key": "sk-ant-fixture",
        "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07",
      });
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("anthropic-beta")?.split(",")).toEqual([
        "oauth-2025-04-20",
        "context-1m-2025-08-07",
        BETA,
      ]);
      expect(requests[0]?.body.thinking).toEqual({
        ...(before.thinking as Record<string, unknown>),
        block_binding: BINDING,
      });
      expect(requests[0]?.body.messages).toEqual(before.messages);
      expect(requests[0]?.body.output_config).toEqual(before.output_config);
      expect(original).toEqual(before);
    });
  }

  test("does not add unsupported options to compatible third-party APIs", async () => {
    const original = conversation();
    const { requests, fetchImpl } = recorder(() => success());
    await send(original, fetchImpl, "https://compatible.example/anthropic/v1");
    expect(requests[0]?.headers.get("anthropic-beta")).toBeNull();
    expect(requests[0]?.body.thinking).toEqual(original.thinking);
  });

  for (const type of ["disabled", "between_tools"]) {
    test(`does not combine binding controls with ${type} thinking`, async () => {
      const { requests, fetchImpl } = recorder(() => success());
      const body = { ...conversation(), thinking: { type } };
      await send(body, fetchImpl);
      expect(requests[0]?.body.thinking).toEqual({ type });
      expect(requests[0]?.headers.get("anthropic-beta")).toBeNull();
    });
  }

  test("configures the implicit adaptive default on current Opus before a tool replay", async () => {
    const body = conversation();
    delete body.thinking;
    const { requests, fetchImpl } = recorder(() => success());
    await send(body, fetchImpl);
    expect(requests[0]?.body.thinking).toEqual({ type: "adaptive", block_binding: BINDING });
  });
});

describe("thinking signature rejection recovery", () => {
  test("retries the provider once without invalid reasoning, preserving tool results and text", async () => {
    const body = conversation();
    const before = structuredClone(body);
    const { requests, fetchImpl } = recorder((_request, index) =>
      index === 1 ? Response.json(ERROR, { status: 400 }) : success()
    );
    const response = await send(body, fetchImpl, "https://compatible.example/v1");
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    const expected = structuredClone(before.messages) as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    const assistant = expected[1];
    if (!assistant) throw new Error("fixture assistant missing");
    assistant.content = assistant.content.filter(
      (block) => block.type !== "thinking" && block.type !== "redacted_thinking"
    );
    expect(requests[1]?.body.messages).toEqual(expected);
    expect(requests[1]?.body.thinking).toEqual(before.thinking);
    expect(body).toEqual(before);
  });

  test("a repeated rejection stops after one repair attempt", async () => {
    const { requests, fetchImpl } = recorder(() => Response.json(ERROR, { status: 400 }));
    const response = await send(conversation(), fetchImpl);
    expect(response.status).toBe(400);
    expect(requests).toHaveLength(2);
    expect(await response.json()).toEqual(ERROR);
  });

  test("does not retry an unrelated invalid-request error", async () => {
    const unrelated = {
      error: { type: "invalid_request_error", message: "tool_use ids must be unique" },
    };
    const { requests, fetchImpl } = recorder(() => Response.json(unrelated, { status: 400 }));
    const response = await send(conversation(), fetchImpl);
    expect(response.status).toBe(400);
    expect(requests).toHaveLength(1);
    expect(await response.json()).toEqual(unrelated);
  });

  test("does not retry when there are no thinking blocks to repair", async () => {
    const body = { ...conversation(), messages: [{ role: "user", content: "a question" }] };
    const { requests, fetchImpl } = recorder(() => Response.json(ERROR, { status: 400 }));
    expect((await send(body, fetchImpl)).status).toBe(400);
    expect(requests).toHaveLength(1);
  });

  test("a stream-unsupported response does not start a fallback after cancellation", async () => {
    const controller = new AbortController();
    const { requests, fetchImpl } = recorder(() => {
      controller.abort();
      return Response.json({ error: { message: "streaming is not supported" } }, { status: 400 });
    });
    const response = await send(
      conversation(),
      fetchImpl,
      "https://compatible.example/v1",
      undefined,
      controller.signal
    );
    expect(response.status).toBe(400);
    expect(requests).toHaveLength(1);
    expect(await response.json()).toEqual({ error: { message: "streaming is not supported" } });
  });

  test("the streaming fallback retains binding controls", async () => {
    const { requests, fetchImpl } = recorder((_request, index) =>
      index === 1
        ? Response.json({ error: { message: "streaming is not supported" } }, { status: 400 })
        : success()
    );
    expect((await send(conversation(), fetchImpl)).status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.stream).toBe(true);
    expect(requests[1]?.body.stream).toBeUndefined();
    for (const request of requests) {
      expect(request.headers.get("anthropic-beta")).toContain(BETA);
      expect(request.body.thinking).toMatchObject({ block_binding: BINDING });
    }
  });

  test("does not start another request if the turn was cancelled", async () => {
    const controller = new AbortController();
    const { requests, fetchImpl } = recorder(() => {
      controller.abort();
      return Response.json(ERROR, { status: 400 });
    });
    expect(
      (
        await send(
          conversation(),
          fetchImpl,
          "https://compatible.example/v1",
          undefined,
          controller.signal
        )
      ).status
    ).toBe(400);
    expect(requests).toHaveLength(1);
  });
});
