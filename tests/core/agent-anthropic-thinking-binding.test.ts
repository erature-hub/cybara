import { afterEach, describe, expect, test } from "bun:test";
import { agentManager } from "../../src/core/agent";
import { providerManager } from "../../src/core/providers";

const realFetch = globalThis.fetch;
const agents: string[] = [];
const providers: string[] = [];

interface ContentBlock {
  type: string;
  signature?: string;
  tool_use_id?: string;
  text?: string;
}

interface RequestBody {
  thinking?: { type: string; block_binding?: { prefix_mismatch_behavior?: string } };
  messages: Array<{ role: string; content: ContentBlock[] }>;
  tools?: unknown[];
  system?: unknown;
}

interface WireCall {
  signatures: string[];
  toolResults: number;
  bindingEnabled: boolean;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const id of agents.splice(0)) agentManager.delete(id);
  for (const id of providers.splice(0)) providerManager.delete(id);
});

function fixtureAgent(baseUrl = "https://api.anthropic.com/v1", maxIterations = 5): string {
  const provider = providerManager.create({
    provider: "anthropic",
    name: "Thinking binding fixture provider",
    api_key: "sk-ant-fixture",
    base_url: baseUrl,
  });
  providers.push(provider.id);
  const agent = agentManager.create({
    name: "Thinking binding fixture agent",
    model: "claude-opus-5-5",
    provider_id: provider.id,
    memory_enabled: false,
    config: { max_tool_iterations: maxIterations },
  });
  agents.push(agent.id);
  return agent.id;
}

function message(signature: string, toolId?: string, transformations: unknown[] = []): Response {
  const content = toolId
    ? [
        { type: "thinking", thinking: "Plan the next harmless lookup", signature },
        { type: "tool_use", id: toolId, name: "read", input: { path: "package.json", limit: 1 } },
      ]
    : [{ type: "text", text: "BINDING_LOOP_OK" }];
  return Response.json({
    id: signature,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: toolId ? "tool_use" : "end_turn",
    usage: { input_tokens: 12000, output_tokens: 20 },
    input_transformations: transformations,
  });
}

function installProvider(rejectOnce: boolean, dropOnce = false): WireCall[] {
  const calls: WireCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/messages")) return await realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as RequestBody;
    const blocks = body.messages.flatMap((entry) => entry.content);
    const signatures = blocks.flatMap((block) => (block.signature ? [block.signature] : []));
    const toolResults = blocks.filter((block) => block.type === "tool_result").length;
    const bindingEnabled =
      body.thinking?.block_binding?.prefix_mismatch_behavior === "drop_block" &&
      (new Headers(init?.headers).get("anthropic-beta") ?? "").includes(
        "thinking-binding-controls-2026-08-01"
      );
    calls.push({ signatures, toolResults, bindingEnabled });
    if (rejectOnce && calls.length === 2) {
      return Response.json(
        {
          error: {
            type: "invalid_request_error",
            message:
              "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
          },
        },
        { status: 400 }
      );
    }
    if (toolResults === 0) return message("signed-first", "toolu_first");
    if (toolResults === 1) {
      return message(
        "signed-second",
        "toolu_second",
        dropOnce ? [{ type: "thinking_dropped" }] : []
      );
    }
    return message("done");
  }) as typeof fetch;
  return calls;
}

async function execute(id: string): Promise<string> {
  const result = await agentManager.execute(
    id,
    [{ role: "user", content: "Read package.json twice in two separate calls, then finish." }],
    {
      useTools: true,
      allowedToolNames: ["read"],
      useMemory: false,
      workspaceDir: process.cwd(),
      modelParamsOverride: { reasoning_effort: "high" },
      maxOutputTokens: 2048,
    }
  );
  return result.content;
}

describe("Anthropic agent thinking repair lifecycle", () => {
  test("one request-only repair does not rerun tools or resurrect the removed thinking", async () => {
    const id = fixtureAgent("https://compatible.example/v1");
    const calls = installProvider(true);
    expect(await execute(id)).toBe("BINDING_LOOP_OK");
    expect(calls.map((call) => call.toolResults)).toEqual([0, 1, 1, 2]);
    expect(calls[1]?.signatures).toContain("signed-first");
    expect(calls[2]?.signatures).toEqual([]);
    expect(calls[3]?.signatures).toEqual(["signed-second"]);
  });

  test("unchanged prefixes keep both old and new signed thinking", async () => {
    const id = fixtureAgent();
    const calls = installProvider(false);
    expect(await execute(id)).toBe("BINDING_LOOP_OK");
    expect(calls.map((call) => call.toolResults)).toEqual([0, 1, 2]);
    expect(calls[2]?.signatures).toEqual(["signed-first", "signed-second"]);
    expect(calls.every((call) => call.bindingEnabled)).toBe(true);
  });

  test("a provider-reported drop stays removed in the next iteration", async () => {
    const id = fixtureAgent();
    const calls = installProvider(false, true);
    expect(await execute(id)).toBe("BINDING_LOOP_OK");
    expect(calls.map((call) => call.toolResults)).toEqual([0, 1, 2]);
    expect(calls[1]?.signatures).toEqual(["signed-first"]);
    expect(calls[2]?.signatures).toEqual(["signed-second"]);
  });

  test("the closing request removes invalidated thinking when it removes the tools", async () => {
    const id = fixtureAgent(undefined, 1);
    const calls = installProvider(false);
    const result = await execute(id);
    expect(result).not.toContain("Invalid");
    expect(calls.at(-1)?.signatures).toEqual([]);
    expect(calls.at(-1)?.bindingEnabled).toBe(true);
  });
});
