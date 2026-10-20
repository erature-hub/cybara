import { describe, expect, test } from "bun:test";
import {
  buildChatExecutionMessagesForAgent,
  replayedToolOutcome,
  TRANSIENT_TOOL_FAILURE_NOTE,
} from "../../src/api/chat-execution-messages";
import { INTERRUPTED_RESPONSE } from "../../src/api/chat-interruption";
import type { ChatMessage } from "../../src/api/chat-types";
import { TOOL_RESULT_PROMPT_MAX_CHARS } from "../../src/core/chat-token-optimization";
import { toAnthropicHistory } from "../../src/core/llm/provider-history";

describe("chat execution tool history", () => {
  test("keeps synthetic interrupted responses out of the next provider request", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "First attempt" },
      {
        role: "assistant",
        content: INTERRUPTED_RESPONSE,
        interrupted: true,
      },
      { role: "user", content: "Retry" },
    ];

    expect(buildChatExecutionMessagesForAgent(messages)).toEqual([
      { role: "user", content: "First attempt" },
      { role: "user", content: "Retry" },
    ]);
  });

  test("reconstructs persisted tool calls before their final assistant response", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Inspect the manifest." },
      {
        role: "assistant",
        content: "The package is Cybara 1.2.3.",
        tool_calls: [
          {
            id: "call_read",
            name: "read",
            args: { path: "package.json" },
            status: "completed",
            result: { name: "cybara", version: "1.2.3" },
          },
          {
            id: "call_git",
            name: "git",
            args: { command: "status" },
            status: "failed",
            error: "not a repository",
          },
        ],
      },
      { role: "user", content: "What did you find?" },
    ];

    expect(buildChatExecutionMessagesForAgent(messages)).toEqual([
      { role: "user", content: "Inspect the manifest." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_read",
            name: "read",
            arguments: { path: "package.json" },
          },
          {
            id: "call_git",
            name: "git",
            arguments: { command: "status" },
          },
        ],
      },
      {
        role: "tool",
        content: '{"name":"cybara","version":"1.2.3"}',
        tool_call_id: "call_read",
      },
      {
        role: "tool",
        content: '{"error":"not a repository"}',
        tool_call_id: "call_git",
      },
      { role: "assistant", content: "The package is Cybara 1.2.3." },
      { role: "user", content: "What did you find?" },
    ]);
  });

  test("bounds historical tool results before sending them to another provider", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Done.",
        tool_calls: [
          {
            id: "call_large",
            name: "exec",
            args: { command: "print output" },
            status: "completed",
            result: "x".repeat(20_000),
          },
        ],
      },
    ];

    const execution = buildChatExecutionMessagesForAgent(messages);
    expect(execution[1]?.role).toBe("tool");
    expect(execution[1]?.content.length).toBeLessThan(TOOL_RESULT_PROMPT_MAX_CHARS + 360);
    expect(execution[1]?.content).toContain("truncated");
    expect(execution[2]).toEqual({ role: "assistant", content: "Done." });
  });

  test("does not invent tool output for interrupted activity-only calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Inspect the workspace." },
      {
        role: "assistant",
        content: "",
        interrupted: true,
        tool_calls: [
          {
            id: "call_completed_without_output",
            name: "read",
            args: {},
            status: "completed",
          },
          {
            id: "call_interrupted_without_output",
            name: "exec",
            args: {},
            status: "executing",
          },
        ],
      },
      { role: "user", content: "What did you find?" },
    ];

    expect(buildChatExecutionMessagesForAgent(messages)).toEqual([
      { role: "user", content: "Inspect the workspace." },
      { role: "user", content: "What did you find?" },
    ]);
  });

  test("retains interrupted tool failures with recorded errors", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        interrupted: true,
        tool_calls: [
          {
            id: "call_failed",
            name: "exec",
            args: {},
            status: "failed",
            error: "Process stopped",
          },
        ],
      },
    ];

    expect(buildChatExecutionMessagesForAgent(messages)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_failed", name: "exec", arguments: {} }],
      },
      {
        role: "tool",
        content: '{"error":"Process stopped"}',
        tool_call_id: "call_failed",
      },
    ]);
  });

  test("preserves reconstructed tool history through provider serialization", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Read the package name." },
      {
        role: "assistant",
        content: "The package is Cybara.",
        tool_calls: [
          {
            id: "call_read",
            name: "read",
            args: { path: "package.json" },
            status: "completed",
            result: { name: "cybara" },
          },
        ],
      },
      { role: "user", content: "What did you find?" },
    ];

    const execution = buildChatExecutionMessagesForAgent(messages);
    expect(toAnthropicHistory(execution)).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Read the package name." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_read",
            name: "read",
            input: { path: "package.json" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read",
            content: '{"name":"cybara"}',
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The package is Cybara." }],
      },
      { role: "user", content: [{ type: "text", text: "What did you find?" }] },
    ]);
  });
});

test("server transition metadata survives execution mapping without resurrecting an old transfer", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "Baseline" },
    { role: "user", content: "Question A" },
    { role: "assistant", content: "Answer A" },
    {
      role: "system",
      content: "Agent B",
      instructionUpdate: {
        kind: "agent-transition",
        agentId: "b",
        historyOffset: 2,
      },
    },
    { role: "user", content: "Question B" },
    {
      role: "system",
      content: "Agent A",
      instructionUpdate: {
        kind: "agent-transition",
        agentId: "a",
        historyOffset: 3,
      },
    },
  ];
  const before = buildChatExecutionMessagesForAgent(messages.slice(0, 3));
  const after = buildChatExecutionMessagesForAgent(messages);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(
    after
      .filter((message) => message.instructionUpdate)
      .map((message) => message.instructionUpdate?.agentId)
  ).toEqual(["b", "a"]);
  expect(after.at(-1)?.content).toBe("Agent A");
});

test("marks earlier availability and approval failures as retryable", () => {
  for (const error of [
    "Tool not enabled for this agent: browser",
    "Tool 'computer_use' was denied by the operator. It needs approval, but no Cybara app is connected to approve it.",
    "User switched to Notes while Cybara was working in Finder. Stop the conversation to let Cybara resume.",
    "Cybara cannot reach your Chrome. Install the Cybara browser extension and connect it.",
  ]) {
    expect(replayedToolOutcome({ error })).toEqual({ error, note: TRANSIENT_TOOL_FAILURE_NOTE });
  }
  expect(replayedToolOutcome({ error: "not a repository" })).toEqual({ error: "not a repository" });
  expect(replayedToolOutcome({ result: { ok: true }, error: "ignored" })).toEqual({ ok: true });

  const replayed = buildChatExecutionMessagesForAgent([
    { role: "user", content: "Open the site", timestamp: "2026-10-19T10:00:00.000Z" },
    {
      role: "assistant",
      content: "I could not use the browser.",
      timestamp: "2026-10-19T10:00:05.000Z",
      tool_calls: [
        {
          id: "call-denied",
          name: "browser",
          args: { action: "open" },
          error: "Tool 'browser' was denied by the operator.",
          status: "failed",
        },
      ],
    },
    { role: "user", content: "Try again", timestamp: "2026-10-19T10:01:00.000Z" },
  ] as ChatMessage[]);
  const toolResult = replayed.find((message) => message.role === "tool");
  expect(toolResult?.content).toContain("checked again on every turn");
});
