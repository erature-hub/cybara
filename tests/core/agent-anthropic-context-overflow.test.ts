import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentManager, type AgentMessage } from "../../src/core/agent";
import { providerManager } from "../../src/core/providers";

const createdAgentIds: string[] = [];
const createdProviderIds: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const agentId of createdAgentIds.splice(0)) agentManager.delete(agentId);
  for (const providerId of createdProviderIds.splice(0)) providerManager.delete(providerId);
});

const WINDOW = 1_000_000;
const MEASURED_CHARS_PER_TOKEN = 2.15;
const MAX_TOOL_ROUNDS = 60;
const fixtureDir = mkdtempSync(join(tmpdir(), "cybara-anthropic-overflow-"));
const denseFile = join(fixtureDir, "dense-output.json");

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

interface AnthropicRequest {
  system?: unknown;
  messages?: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string }>;
  max_tokens?: number;
}

interface FakeAnthropic {
  requests: Array<{ inputTokens: number; maxTokens: number; status: number }>;
}

function denseText(seed: number, length: number): string {
  let out = "";
  let value = seed * 2654435761;
  while (out.length < length) {
    value = (value * 1103515245 + 12345) >>> 0;
    out += `{"k${value % 997}":"${value.toString(36)}",`;
  }
  return out.slice(0, length);
}

function requestTokens(body: AnthropicRequest): number {
  const chars = JSON.stringify([body.system ?? "", body.messages ?? [], body.tools ?? []]).length;
  return Math.ceil(chars / MEASURED_CHARS_PER_TOKEN);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toolResultCount(messages: AnthropicRequest["messages"]): number {
  return (messages ?? []).reduce(
    (count, message) =>
      count +
      (Array.isArray(message.content)
        ? message.content.filter(
            (block) =>
              !!block &&
              typeof block === "object" &&
              (block as { type?: string }).type === "tool_result"
          ).length
        : 0),
    0
  );
}

function installFakeAnthropic(serverLimitTokens: number = WINDOW): FakeAnthropic {
  const fake: FakeAnthropic = { requests: [] };
  writeFileSync(denseFile, (denseText(97, 600_000).match(/.{1,150}/g) ?? []).join("\n"));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/messages")) return originalFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as AnthropicRequest;
    const inputTokens = requestTokens(body);
    const maxTokens = body.max_tokens ?? 0;
    if (inputTokens > serverLimitTokens) {
      fake.requests.push({ inputTokens, maxTokens, status: 400 });
      return jsonResponse(400, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `prompt is too long: ${inputTokens} tokens > ${serverLimitTokens} maximum`,
        },
      });
    }
    fake.requests.push({ inputTokens, maxTokens, status: 200 });
    const rounds = toolResultCount(body.messages);
    const hasReadTool = (body.tools ?? []).some((tool) => tool.name === "read");
    const done = rounds >= MAX_TOOL_ROUNDS || !hasReadTool;
    const content = done
      ? [{ type: "text", text: "finished after the tool call" }]
      : [
          {
            type: "tool_use",
            id: `toolu_overflow_${rounds + 1}`,
            name: "read",
            input: { path: denseFile, offset: rounds * 40 + 1, limit: 40 },
          },
        ];
    const answeredTool = done;
    return jsonResponse(200, {
      id: `msg_${fake.requests.length}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content,
      stop_reason: answeredTool ? "end_turn" : "tool_use",
      usage: { input_tokens: inputTokens, output_tokens: 20 },
    });
  }) as typeof fetch;
  return fake;
}

function longDenseHistory(turns: number, charsPerMessage: number): AgentMessage[] {
  const history: AgentMessage[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    history.push({
      role: "user",
      content: `turn ${turn}: ${denseText(turn * 2 + 1, charsPerMessage)}`,
    });
    history.push({
      role: "assistant",
      content: `answer ${turn}: ${denseText(turn * 2 + 2, charsPerMessage)}`,
    });
  }
  history.push({ role: "user", content: "Run one tool and then tell me you are finished." });
  return history;
}

function createOpusAgent(): string {
  const provider = providerManager.create({
    provider: "anthropic",
    name: "Anthropic overflow fixture",
    api_key: "sk-ant-test-overflow",
  });
  createdProviderIds.push(provider.id);
  const agent = agentManager.create({
    name: "Opus overflow fixture",
    type: "main",
    provider_id: provider.id,
    model: "claude-opus-5-5",
    memory_enabled: false,
  });
  createdAgentIds.push(agent.id);
  return agent.id;
}

describe("Anthropic agent loop near a 1M-token window with dense content", () => {
  test("tool output that grows a near-full prompt is compacted in time instead of failing", async () => {
    const agentId = createOpusAgent();
    const fake = installFakeAnthropic();
    const history = longDenseHistory(40, 19_000);

    const result = await agentManager.execute(agentId, history, { useTools: true });

    expect(result.content).not.toContain("temporary API error");
    expect(result.content).not.toContain("no longer fits");
    expect(result.content).toContain("finished after the tool call");
    expect(fake.requests.length).toBe(MAX_TOOL_ROUNDS + 1);
    expect(fake.requests.every((request) => request.status === 200)).toBe(true);
  }, 120_000);

  test("an overflow the estimate missed is recovered by trimming history and retrying", async () => {
    const agentId = createOpusAgent();
    const fake = installFakeAnthropic(900_000);
    const history = longDenseHistory(40, 19_000);

    const result = await agentManager.execute(agentId, history, { useTools: true });

    expect(fake.requests.some((request) => request.status === 400)).toBe(true);
    expect(result.content).not.toContain("temporary API error");
    expect(result.content).toContain("finished after the tool call");
    expect(fake.requests.at(-1)?.status).toBe(200);
  }, 120_000);

  test("after the first response, later requests leave room for output inside the window", async () => {
    const agentId = createOpusAgent();
    const fake = installFakeAnthropic();
    const history = longDenseHistory(40, 19_000);

    await agentManager.execute(agentId, history, { useTools: true });

    const loopRequests = fake.requests.slice(1).filter((request) => request.status === 200);
    expect(loopRequests.length).toBeGreaterThan(0);
    for (const request of loopRequests) {
      expect(request.inputTokens + request.maxTokens).toBeLessThanOrEqual(WINDOW);
    }
  }, 120_000);
});
