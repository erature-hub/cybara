import { afterEach, describe, expect, test } from "bun:test";
import {
  deleteSession,
  getSessionMessages,
  handleChat,
  listPendingChatMessages,
  steerPendingChatMessage,
  stopActiveChatTurn,
} from "../../src/api/chat";
import { buildChatExecutionMessagesForAgent } from "../../src/api/chat-execution-messages";
import { placeRecoveredRunMessages } from "../../src/api/chat-run-recovery";
import {
  cacheChatSession,
  chatSessions,
  chatTurnMutex,
  getResidentChatSession,
  pendingChatQueues,
} from "../../src/api/chat-runtime-state";
import { revertSessionToMessage } from "../../src/api/chat-session-api";
import type { ChatMessage } from "../../src/api/chat-types";
import { agentManager } from "../../src/core/agent";
import db from "../../src/core/database";
import { logSessionMessage } from "../../src/core/logging";
import { providerManager } from "../../src/core/providers";
import {
  loadPersistedSession,
  upsertPersistedSessionMessage,
} from "../../src/core/session-context";

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

interface ExecuteOptions {
  abortSignal?: AbortSignal;
}

interface ExecutedMessage {
  role: string;
  content: string;
}

function fixtureAgent(): string {
  const provider = providerManager.create({
    provider: "openai",
    name: "Stop ordering fixture provider",
    api_key: "fixture",
    base_url: "https://api.openai.com/v1",
  });
  providers.push(provider.id);
  const agent = agentManager.create({
    name: "Stop ordering fixture agent",
    model: "model-a",
    provider_id: provider.id,
    memory_enabled: false,
  });
  agents.push(agent.id);
  return agent.id;
}

const visible = (messages: ChatMessage[]): string[] =>
  messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) =>
      message.role === "assistant" && message.interrupted && !message.content.trim()
        ? `assistant:<${message.stopped ? "stopped" : "interrupted"}>`
        : `${message.role}:${message.content}`
    );

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

describe("stopping a turn that has a queued follow-up", () => {
  test("records a stopped boundary before the follow-up and tells the model the request was cancelled", async () => {
    const agentId = fixtureAgent();
    const sessionId = `stop-order-${crypto.randomUUID()}`;
    sessions.push(sessionId);
    const followUpPrompts: ExecutedMessage[][] = [];
    let calls = 0;
    agentManager.execute = (async (...args: unknown[]) => {
      calls += 1;
      const options = args[2] as ExecuteOptions | undefined;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          if (options?.abortSignal?.aborted) resolve();
          options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("Chat turn stopped by user", "AbortError");
      }
      followUpPrompts.push(args[1] as ExecutedMessage[]);
      return { content: "follow-up answered", tool_calls: [] };
    }) as typeof agentManager.execute;

    const first = handleChat({ agentId, sessionId, message: "long task", tools: true });
    await waitUntil(() => chatTurnMutex.isLocked(sessionId) && calls === 1);
    await handleChat({
      agentId,
      sessionId,
      message: "quick follow-up",
      tools: true,
      queueMode: "queue",
    });
    await stopActiveChatTurn(sessionId);
    await first;
    await waitUntil(
      () =>
        followUpPrompts.length === 1 &&
        !chatTurnMutex.isLocked(sessionId) &&
        listPendingChatMessages(sessionId).length === 0
    );

    const expected = [
      "user:long task",
      "assistant:<stopped>",
      "user:quick follow-up",
      "assistant:follow-up answered",
    ];
    expect(visible(getResidentChatSession(sessionId)?.messages ?? [])).toEqual(expected);
    expect(visible((await loadPersistedSession(sessionId))?.messages ?? [])).toEqual(expected);
    expect(visible(await getSessionMessages(sessionId))).toEqual(expected);
    expect(visible(await getSessionMessages(sessionId, { deferHistoricalMetadata: true }))).toEqual(
      expected
    );

    const prompt = (followUpPrompts[0] ?? []).filter((m) => m.role !== "system");
    const stoppedIndex = prompt.findIndex(
      (m) => m.role === "assistant" && m.content.includes("stopped this response")
    );
    const taskIndex = prompt.findIndex((m) => m.role === "user" && m.content.includes("long task"));
    const followUpIndex = prompt.findIndex(
      (m) => m.role === "user" && m.content.includes("quick follow-up")
    );
    expect(taskIndex).toBeGreaterThanOrEqual(0);
    expect(stoppedIndex).toBeGreaterThan(taskIndex);
    expect(followUpIndex).toBeGreaterThan(stoppedIndex);
  }, 30_000);
});

describe("execution history", () => {
  test("an empty stopped reply is replayed as a cancellation note, not dropped", () => {
    const executed = buildChatExecutionMessagesForAgent([
      { role: "user", content: "long task" },
      { role: "assistant", content: "", interrupted: true, stopped: true },
      { role: "user", content: "next" },
    ]);
    const assistant = executed.find((message) => message.role === "assistant");
    expect(assistant?.content).toContain("stopped this response");
    expect(executed.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });

  test("an empty interrupted reply that was not stopped gets a neutral note", () => {
    const executed = buildChatExecutionMessagesForAgent([
      { role: "user", content: "task" },
      { role: "assistant", content: "", interrupted: true },
      { role: "user", content: "next" },
    ]);
    expect(executed[1]?.content).toBe("[This response was interrupted before it finished.]");
  });

  test("a stopped reply that has text keeps that text", () => {
    const executed = buildChatExecutionMessagesForAgent([
      { role: "user", content: "task" },
      { role: "assistant", content: "partial answer", interrupted: true, stopped: true },
    ]);
    expect(executed[1]?.content).toBe("partial answer");
  });
});

describe("recovered run placement", () => {
  const at = (ms: number): string => new Date(1_800_000_000_000 + ms).toISOString();
  const transcript: ChatMessage[] = [
    { role: "user", content: "q1", timestamp: at(1000) },
    { role: "assistant", content: "a1", timestamp: at(1500), run_id: "run-1" },
    { role: "user", content: "q2", timestamp: at(2000) },
    { role: "user", content: "steer during q2", timestamp: at(2600) },
    { role: "user", content: "queued q3", timestamp: at(2700) },
    { role: "assistant", content: "a3", timestamp: at(4000), run_id: "run-3" },
  ];
  const starts = new Map([
    ["run-1", Date.parse(at(1100))],
    ["run-2", Date.parse(at(2100))],
    ["run-3", Date.parse(at(3500))],
  ]);
  const marker: ChatMessage = {
    role: "assistant",
    content: "Response interrupted before completion.",
    timestamp: at(3000),
    run_id: "run-2",
    interrupted: true,
  };

  test("places a recovered reply after its own turn and before the next turn's message", () => {
    const placed = placeRecoveredRunMessages(
      transcript,
      [{ message: marker, runId: "run-2" }],
      starts
    );
    expect(placed.map((message) => message.content)).toEqual([
      "q1",
      "a1",
      "q2",
      "steer during q2",
      "Response interrupted before completion.",
      "queued q3",
      "a3",
    ]);
  });

  test("never reorders the stored transcript around it", () => {
    const shuffled: ChatMessage[] = [
      { role: "user", content: "later timestamp first", timestamp: at(9000) },
      { role: "assistant", content: "reply", timestamp: at(100) },
      ...transcript,
    ];
    const placed = placeRecoveredRunMessages(
      shuffled,
      [{ message: marker, runId: "run-2" }],
      starts
    );
    expect(placed.filter((message) => message !== marker)).toEqual(shuffled);
  });

  test("appends a recovered reply whose run has no recorded start", () => {
    const placed = placeRecoveredRunMessages(
      transcript,
      [{ message: marker, runId: "unknown" }],
      starts
    );
    expect(placed.at(-1)).toBe(marker);
  });
});

describe("revert on a compacted session", () => {
  test("keeps the history that compaction removed from memory", async () => {
    const agentId = fixtureAgent();
    const sessionId = `revert-compacted-${crypto.randomUUID()}`;
    sessions.push(sessionId);
    const history: ChatMessage[] = [];
    for (let index = 0; index < 40; index += 1) {
      const message: ChatMessage = {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `m${index}`,
        timestamp: new Date(1_800_000_000_000 + index * 1000).toISOString(),
      };
      history.push(message);
      await upsertPersistedSessionMessage(sessionId, agentId, message, { stableKey: `h${index}` });
    }
    chatSessions.delete(sessionId);
    cacheChatSession({
      id: sessionId,
      agentId,
      useModelRouter: false,
      title: "Compacted",
      messages: [
        { role: "system", content: "## Context Summary\nearlier work" },
        ...history.slice(-6).map((message) => ({ ...message })),
      ],
      createdAt: history[0]?.timestamp ?? new Date().toISOString(),
      updatedAt: history.at(-1)?.timestamp ?? new Date().toISOString(),
      persisted: true,
      compactionCount: 1,
    });

    const target = history[36];
    if (!target) throw new Error("fixture target missing");
    const result = await revertSessionToMessage(sessionId, {
      messageIndex: 36,
      messageRole: "user",
      messageContent: target.content,
      messageTimestamp: target.timestamp,
    });

    expect(result.keptCount).toBe(36);
    expect(result.removedCount).toBe(4);
    chatSessions.delete(sessionId);
    const reloaded = (await loadPersistedSession(sessionId))?.messages ?? [];
    expect(reloaded.map((message) => message.content)).toEqual(
      history.slice(0, 36).map((message) => message.content)
    );
  });
});

describe("steering a queued message that is already running", () => {
  test("is refused instead of feeding the running turn its own message again", async () => {
    const agentId = fixtureAgent();
    const sessionId = `steer-running-${crypto.randomUUID()}`;
    sessions.push(sessionId);
    cacheChatSession({
      id: sessionId,
      agentId,
      useModelRouter: false,
      title: "Running queued",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      persisted: true,
    });
    const now = Date.now();
    pendingChatQueues.set(sessionId, [
      {
        id: "pending_running",
        sessionId,
        request: { sessionId, message: "already running", queueMode: "queue" },
        content: "already running",
        createdAt: now,
        updatedAt: now,
        mode: "queued",
        materialized: true,
        sequence: 1,
      },
    ]);
    try {
      const result = await steerPendingChatMessage(sessionId, "pending_running");
      expect(result.success).toBe(false);
      expect(pendingChatQueues.get(sessionId)?.[0]?.mode).toBe("queued");
    } finally {
      pendingChatQueues.delete(sessionId);
    }
  });
});

describe("messages logged without an explicit ordinal", () => {
  test("take the next ordinal so they never fall back to a global row id", async () => {
    const sessionId = `logged-ordinal-${crypto.randomUUID()}`;
    sessions.push(sessionId);
    const first: ChatMessage = {
      role: "user",
      content: "first",
      timestamp: new Date().toISOString(),
    };
    await upsertPersistedSessionMessage(sessionId, "agent-ordinal", first, { stableKey: "first" });
    await logSessionMessage(sessionId, "assistant", "second", { agentId: "agent-ordinal" });
    await logSessionMessage(sessionId, "user", "third", { agentId: "agent-ordinal" });
    const rows = db
      .query(
        "SELECT content, ordinal FROM session_messages WHERE session_id = ? ORDER BY COALESCE(ordinal, rowid), rowid"
      )
      .all(sessionId) as Array<{ content: string; ordinal: number | null }>;
    expect(rows.map((row) => row.content)).toEqual(["first", "second", "third"]);
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2, 3]);
  });
});
