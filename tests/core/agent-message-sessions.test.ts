import { afterEach, describe, expect, test } from "bun:test";
import { agentManager, getBuiltinTools } from "../../src/core/agent";
import { providerManager } from "../../src/core/providers";

type CapturedCall = {
  messages: Array<{ role: string; content: string }>;
  toolNames: string[];
};

type CallLLMShape = (
  provider: unknown,
  model: string | undefined,
  messages: Array<{ role: string; content: string }>,
  tools: Array<{ name: string }>
) => Promise<{ content: string }>;

const createdAgentIds: string[] = [];
const createdProviderIds: string[] = [];
const originalCallLLM = agentManager.callLLM;

afterEach(() => {
  (agentManager as unknown as { callLLM: unknown }).callLLM = originalCallLLM;
  for (const agentId of createdAgentIds.splice(0)) agentManager.delete(agentId);
  for (const providerId of createdProviderIds.splice(0)) providerManager.delete(providerId);
});

function builtinTools(names: string[]) {
  return getBuiltinTools().filter((tool) => names.includes(tool.name));
}

function setUpAgent(toolNames: string[]): { agentId: string; calls: CapturedCall[] } {
  const provider = providerManager.create({
    provider: "openai",
    name: "Session Message Provider",
    api_key: "test-key",
  });
  createdProviderIds.push(provider.id);
  const agent = agentManager.create({
    name: "Session Message Agent",
    provider_id: provider.id,
    model: "gpt-4o",
    tools: builtinTools(toolNames),
    type: "main",
  });
  createdAgentIds.push(agent.id);
  const calls: CapturedCall[] = [];
  (agentManager as unknown as { callLLM: CallLLMShape }).callLLM = async (
    _provider,
    _model,
    messages,
    toolDefinitions
  ) => {
    calls.push({
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      toolNames: toolDefinitions.map((tool) => tool.name),
    });
    return { content: `reply ${calls.length}` };
  };
  return { agentId: agent.id, calls };
}

function userContents(call: CapturedCall | undefined): string[] {
  return (call?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => message.content);
}

describe("agent manager messages", () => {
  test("keeps separate histories for separate sessions", async () => {
    const { agentId, calls } = setUpAgent(["read"]);
    await agentManager.message(agentId, "first job prompt", {
      sessionId: "cron-job-a",
      useMemory: false,
    });
    await agentManager.message(agentId, "second job prompt", {
      sessionId: "cron-job-b",
      useMemory: false,
    });
    await agentManager.message(agentId, "first job follow-up", {
      sessionId: "cron-job-a",
      useMemory: false,
    });

    expect(userContents(calls[1]).join("\n")).not.toContain("first job prompt");
    expect(userContents(calls[2]).join("\n")).toContain("first job prompt");
    expect(userContents(calls[2]).join("\n")).not.toContain("second job prompt");
  });

  test("uses the agent's current tools after the agent is edited while running", async () => {
    const { agentId, calls } = setUpAgent(["read"]);
    await agentManager.message(agentId, "before edit", {
      sessionId: "edit-check",
      useMemory: false,
    });
    expect(calls[0]?.toolNames).not.toContain("browser");

    agentManager.update(agentId, { tools: builtinTools(["read", "browser"]) });
    await agentManager.message(agentId, "after edit", {
      sessionId: "edit-check",
      useMemory: false,
    });

    expect(calls[1]?.toolNames).toContain("browser");
    const systemPrompt = calls[1]?.messages.find((message) => message.role === "system")?.content;
    expect(systemPrompt).toContain("browser");
  });
});
