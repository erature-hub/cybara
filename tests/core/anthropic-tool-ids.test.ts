import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizeAnthropicToolIds } from "../../src/core/llm/anthropic-tool-ids";
import { postAnthropicStreamableMessages } from "../../src/core/llm/anthropic-streaming";

function history(ids: string[]): unknown[] {
  return [
    {
      role: "assistant",
      content: ids.map((id) => ({ type: "tool_use", id, name: "read", input: {} })),
    },
    {
      role: "user",
      content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "done" })),
    },
  ];
}

function ids(messages: unknown[]): string[][] {
  return messages.map((raw) => {
    const message = raw as { content: Array<{ id?: string; tool_use_id?: string }> };
    return message.content.map((block) => block.id ?? block.tool_use_id ?? "");
  });
}

describe("Anthropic tool identifiers", () => {
  test("repairs cross-provider punctuation consistently without mutating history", () => {
    const original = history(["call.part:0", "call/part", "toolu_good", "", "工具"]);
    const before = structuredClone(original);
    const fixed = normalizeAnthropicToolIds(original);
    const [calls, results] = ids(fixed);
    expect(calls).toEqual(results);
    expect(calls?.every((id) => /^[a-zA-Z0-9_-]+$/.test(id))).toBe(true);
    expect(new Set(calls).size).toBe(5);
    expect(calls?.[2]).toBe("toolu_good");
    expect(original).toEqual(before);
    expect(normalizeAnthropicToolIds(fixed)).toBe(fixed);
  });

  test("does not collide with valid IDs or conflate different invalid IDs", () => {
    const invalid = "a.b";
    const collision = `toolu_${createHash("sha256").update(invalid).digest("hex")}`;
    const [calls, results] = ids(normalizeAnthropicToolIds(history([invalid, collision, "a:b"])));
    expect(calls).toEqual(results);
    expect(new Set(calls).size).toBe(3);
    expect(calls?.[1]).toBe(collision);
  });

  test("leaves valid histories and unrelated malformed content unchanged", () => {
    const valid = history(["call_123-ABC"]);
    expect(normalizeAnthropicToolIds(valid)).toBe(valid);
    const other = [null, { content: "text" }, { content: [null, { type: "text", text: "x" }] }];
    expect(normalizeAnthropicToolIds(other)).toBe(other);
  });

  test("the actual request sends paired valid IDs", async () => {
    const messages = history(["provider.call.1"]);
    let received: unknown[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
      received = body.messages;
      return Response.json({ content: [{ type: "text", text: "done" }] });
    }) as typeof fetch;
    const response = await postAnthropicStreamableMessages(
      "https://compatible.example/v1",
      "/messages",
      { model: "claude-opus-5-5", messages },
      { headers: {} },
      fetchImpl
    );
    expect(response.status).toBe(200);
    const [calls, results] = ids(received);
    expect(calls).toEqual(results);
    expect(calls?.[0]).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(ids(messages)[0]?.[0]).toBe("provider.call.1");
  });
});
