import { afterEach, describe, expect, test } from "bun:test";
import { deleteSession, getSessionMessages, handleChat } from "../../src/api/chat";
import { getResidentChatSession } from "../../src/api/chat-runtime-state";
import { mergeSessionTranscriptMessages } from "../../src/api/session-transcript";
import type { ChatMessage } from "../../src/api/chat-types";
import { agentManager } from "../../src/core/agent";
import { providerManager } from "../../src/core/providers";
import { loadPersistedSession } from "../../src/core/session-context";

const execute = agentManager.execute.bind(agentManager);
const agents: string[] = [];
const providers: string[] = [];
const sessions: string[] = [];

afterEach(async () => {
  agentManager.execute = execute;
  for (const id of sessions.splice(0)) await deleteSession(id);
  for (const id of agents.splice(0)) agentManager.delete(id);
  for (const id of providers.splice(0)) providerManager.delete(id);
});

interface SteeringCapableOptions {
  consumeSteeringMessages?: () => Array<{ id: string; content: string }>;
}

function fixtureAgent(): string {
  const provider = providerManager.create({
    provider: "openai",
    name: "Steering tail fixture provider",
    api_key: "fixture",
    base_url: "https://api.openai.com/v1",
  });
  providers.push(provider.id);
  const agent = agentManager.create({
    name: "Steering tail fixture agent",
    model: "model-a",
    provider_id: provider.id,
    memory_enabled: false,
  });
  agents.push(agent.id);
  return agent.id;
}

function visible(messages: ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role}:${message.content}`);
}

async function runTurnAbsorbingSteering(agentId: string, sessionId: string, turn: number) {
  const steered = Promise.withResolvers<void>();
  agentManager.execute = (async (...args: unknown[]) => {
    const options = args[2] as SteeringCapableOptions | undefined;
    const steering = handleChat({
      agentId,
      sessionId,
      message: `steer ${turn}`,
      tools: true,
      queueMode: "steer",
    });
    await steering;
    const absorbed = options?.consumeSteeringMessages?.() ?? [];
    steered.resolve();
    return {
      content: `reply ${turn} after absorbing ${absorbed.length}`,
      tool_calls: [],
    };
  }) as typeof agentManager.execute;
  const response = await handleChat({
    agentId,
    sessionId,
    message: `question ${turn}`,
    tools: true,
  });
  await steered.promise;
  return response;
}

describe("a steering message absorbed mid-turn", () => {
  test("is persisted before the reply, so no transcript view ends on the user message", async () => {
    const agentId = fixtureAgent();
    const sessionId = `steer-tail-${crypto.randomUUID()}`;
    sessions.push(sessionId);

    for (let turn = 1; turn <= 3; turn += 1)
      await runTurnAbsorbingSteering(agentId, sessionId, turn);

    const expected = [1, 2, 3].flatMap((turn) => [
      `user:question ${turn}`,
      `user:steer ${turn}`,
      `assistant:reply ${turn} after absorbing 1`,
    ]);

    const resident = getResidentChatSession(sessionId);
    expect(visible(resident?.messages ?? [])).toEqual(expected);

    const reloaded = await loadPersistedSession(sessionId);
    expect(visible(reloaded?.messages ?? [])).toEqual(expected);

    for (const deferHistoricalMetadata of [false, true]) {
      const served = await getSessionMessages(sessionId, { deferHistoricalMetadata });
      expect(visible(served)).toEqual(expected);
      expect(visible(served).at(-1)).toBe("assistant:reply 3 after absorbing 1");
    }
  }, 30_000);
});

describe("transcript merge", () => {
  const persisted: ChatMessage[] = [
    { role: "user", content: "question", timestamp: "2026-10-14T00:00:00.000Z" },
    { role: "assistant", content: "answer", timestamp: "2026-10-14T00:00:03.000Z" },
  ];
  const active: ChatMessage[] = [
    { role: "system", content: "## Context Summary\nearlier work" },
    { role: "user", content: "question", timestamp: "2026-10-14T00:00:00.000Z" },
    { role: "user", content: "unsaved steering", timestamp: "2026-10-14T00:00:01.000Z" },
    { role: "assistant", content: "answer", timestamp: "2026-10-14T00:00:03.000Z" },
  ];

  for (const preservePersistedMetadata of [false, true]) {
    test(`keeps an unpersisted live message in its live position (preserveMetadata=${preservePersistedMetadata})`, () => {
      const merged = mergeSessionTranscriptMessages(persisted, active, {
        preservePersistedMetadata,
      });
      expect(visible(merged)).toEqual([
        "user:question",
        "user:unsaved steering",
        "assistant:answer",
      ]);
    });
  }

  test("still appends genuinely newer live messages after the persisted ones", () => {
    const merged = mergeSessionTranscriptMessages(
      persisted,
      [
        ...active.filter((m) => m.content !== "unsaved steering"),
        { role: "user", content: "next" },
      ],
      { preservePersistedMetadata: true }
    );
    expect(visible(merged)).toEqual(["user:question", "assistant:answer", "user:next"]);
  });

  test("a live message with no matched predecessor stays ahead of the first match", () => {
    const merged = mergeSessionTranscriptMessages(
      persisted,
      [
        { role: "system", content: "## Context Summary\nearlier work" },
        { role: "user", content: "opening unsaved" },
        ...active.slice(1).filter((m) => m.content !== "unsaved steering"),
      ],
      { preservePersistedMetadata: true }
    );
    expect(visible(merged)).toEqual(["user:opening unsaved", "user:question", "assistant:answer"]);
  });
});
