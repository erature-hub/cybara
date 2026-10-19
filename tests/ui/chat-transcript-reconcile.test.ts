import { describe, expect, test } from "bun:test";
import { interruptedTurnNotice } from "../../ui/src/pages/chat/interruptedTurn";
import { appendNewMessages, enrichReloadedMessages } from "../../ui/src/pages/chat/messageCache";
import type { ChatMessage } from "../../ui/src/types";

const toolCall = (id: string) => ({ id, name: "read", args: {}, status: "completed" as const });

describe("reloaded transcript enrichment", () => {
  test("does not graft another reply's tool calls onto a message that shifted position", () => {
    const reference: ChatMessage[] = [
      { role: "user", content: "q1", timestamp: "t1" },
      {
        role: "assistant",
        content: "first reply",
        timestamp: "t2",
        message_id: "a1",
        tool_calls: [toolCall("first-tool")],
      },
    ];
    const reloaded: ChatMessage[] = [
      { role: "user", content: "q1", timestamp: "t1" },
      { role: "assistant", content: "", timestamp: "t1.5", interrupted: true, stopped: true },
      { role: "assistant", content: "first reply", timestamp: "t2", message_id: "a1" },
    ];
    const enriched = enrichReloadedMessages(reference, reloaded);
    expect(enriched[1]?.tool_calls).toBeUndefined();
    expect(enriched[2]?.tool_calls?.[0]?.id).toBe("first-tool");
  });

  test("still restores deferred metadata when the same message is at the same position", () => {
    const reference: ChatMessage[] = [
      { role: "assistant", content: "same", tool_calls: [toolCall("kept")] },
    ];
    const enriched = enrichReloadedMessages(reference, [{ role: "assistant", content: "same" }]);
    expect(enriched[0]?.tool_calls?.[0]?.id).toBe("kept");
  });
});

describe("appending a completed reply", () => {
  test("skips a reply that a live reload already added", () => {
    const reply: ChatMessage = {
      role: "assistant",
      content: "done",
      timestamp: "t3",
      message_id: "a3",
    };
    const existing: ChatMessage[] = [{ role: "user", content: "q", timestamp: "t1" }, reply];
    expect(appendNewMessages(existing, [{ ...reply }])).toBe(existing);
  });

  test("appends genuinely new replies in order", () => {
    const existing: ChatMessage[] = [{ role: "user", content: "q", timestamp: "t1" }];
    const next = appendNewMessages(existing, [
      { role: "assistant", content: "one", timestamp: "t2" },
      { role: "assistant", content: "two", timestamp: "t3" },
    ]);
    expect(next.map((message) => message.content)).toEqual(["q", "one", "two"]);
  });

  test("keeps messages that have no identity at all", () => {
    const existing: ChatMessage[] = [{ role: "assistant", content: "same" }];
    expect(appendNewMessages(existing, [{ role: "assistant", content: "same" }])).toHaveLength(2);
  });
});

describe("interrupted turn notice", () => {
  test("labels an empty stopped reply instead of rendering an empty bubble", () => {
    expect(
      interruptedTurnNotice({ role: "assistant", content: "", interrupted: true, stopped: true })
    ).toBe("Stopped before finishing");
    expect(interruptedTurnNotice({ role: "assistant", content: " ", interrupted: true })).toBe(
      "Interrupted before finishing"
    );
  });

  test("stays hidden for replies with text, normal replies and user messages", () => {
    expect(
      interruptedTurnNotice({ role: "assistant", content: "partial", interrupted: true })
    ).toBeNull();
    expect(interruptedTurnNotice({ role: "assistant", content: "" })).toBeNull();
    expect(interruptedTurnNotice({ role: "user", content: "", interrupted: true })).toBeNull();
  });
});
