import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "../../ui/node_modules/react-dom/server";
import type { ChatMessage } from "../../ui/src/types";
import { ChatMessageTimeline } from "../../ui/src/pages/chat/ChatMessageTimeline";

function renderTimeline(messages: ChatMessage[]): string {
  return renderToStaticMarkup(
    <ChatMessageTimeline
      copiedMessageIndex={null}
      entries={messages.map((message, originalIndex) => ({ message, originalIndex }))}
      forkingMessageIndex={null}
      goldenTurnsEnabled={false}
      liveActivities={[]}
      liveCurrentStep={null}
      liveStatus="idle"
      messageProcessMap={{}}
      savingGoldenMessageIndex={null}
      sessionId="session-alignment"
      showAuthorAttribution={false}
      conversationStyle={false}
      showWorkingTimeline={false}
      speakingMessageIndex={null}
      workspaceDir={null}
      onCopyMessage={() => {}}
      onForkSession={() => {}}
      onOpenArtifact={() => {}}
      onOpenImage={() => {}}
      onOpenLink={() => false}
      onReadAloud={() => {}}
      onRevert={() => {}}
      onSaveGolden={() => {}}
    />
  );
}

function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

test("user message text is left-aligned while the bubble stays on the right", () => {
  const html = renderTimeline([userMessage("Hello there"), { role: "assistant", content: "Hi!" }]);
  expect(html).toContain("flex-row-reverse");
  expect(html).toContain("text-left");
  expect(html).not.toContain("text-right");
  expect(html).toContain("Hello there");
  expect(html).toContain("Hi!");
});

test("deferred (virtualized) user messages are also left-aligned", () => {
  const messages: ChatMessage[] = [
    ...Array.from({ length: 52 }, (_, index) => ({
      role: "assistant" as const,
      content: `filler ${index}`,
    })),
    userMessage("Deferred user message"),
    ...Array.from({ length: 8 }, (_, index) => ({
      role: "assistant" as const,
      content: `tail ${index}`,
    })),
  ];
  const html = renderTimeline(messages);
  expect(html).toContain("data-deferred-rich-content");
  expect(html).toContain("text-left");
  expect(html).not.toContain("text-right");
  expect(html).toContain("Deferred user message");
});

test("assistant messages keep full-width layout without user bubble classes", () => {
  const html = renderTimeline([{ role: "assistant", content: "Assistant reply" }]);
  expect(html).not.toContain("flex-row-reverse");
  expect(html).not.toContain("text-left");
  expect(html).not.toContain("text-right");
  expect(html).toContain("Assistant reply");
});
