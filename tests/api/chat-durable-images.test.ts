import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteSession, getSessionMessages, handleChat } from "../../src/api/chat";
import { agentManager } from "../../src/core/agent";
import { providerManager } from "../../src/core/providers";
import { cacheChatSession, chatSessions } from "../../src/api/chat-runtime-state";
import type { ChatMessage } from "../../src/api/chat-types";
import db from "../../src/core/database";
import { resolveMediaFile } from "../../src/core/runtime/media-files";
import { upsertPersistedSessionMessage } from "../../src/core/session-context";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const sessions: string[] = [];
const dirs: string[] = [];

const execute = agentManager.execute.bind(agentManager);
const agents: string[] = [];
const providers: string[] = [];

afterEach(async () => {
  agentManager.execute = execute;
  for (const id of agents.splice(0)) agentManager.delete(id);
  for (const id of providers.splice(0)) providerManager.delete(id);
  for (const id of sessions.splice(0)) await deleteSession(id);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function imageLinks(content: string): string[] {
  return [...content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1] ?? "");
}

async function seedChatWithWorkspaceImage(resident: boolean) {
  const workspace = mkdtempSync(join(tmpdir(), "cybara-durable-chat-"));
  dirs.push(workspace);
  const image = join(workspace, "before.png");
  writeFileSync(image, PNG);
  const sessionId = `durable-images-${crypto.randomUUID()}`;
  sessions.push(sessionId);
  const messages: ChatMessage[] = [
    { role: "user", content: "show me", timestamp: "2026-10-18T05:00:00.000Z" },
    {
      role: "assistant",
      content: `Here it is:\n\n![before](${pathToFileURL(image).href})`,
      timestamp: "2026-10-18T05:00:05.000Z",
    },
  ];
  for (const [index, message] of messages.entries()) {
    await upsertPersistedSessionMessage(sessionId, "agent-images", message, {
      stableKey: `m${index}`,
    });
  }
  chatSessions.delete(sessionId);
  if (resident) {
    cacheChatSession({
      id: sessionId,
      agentId: "agent-images",
      useModelRouter: false,
      title: "Images",
      messages: messages.map((message) => ({ ...message })),
      createdAt: messages[0]?.timestamp ?? "",
      updatedAt: messages[1]?.timestamp ?? "",
      persisted: true,
    });
  }
  return { sessionId, image };
}

describe("a new reply that links a workspace image", () => {
  test("reaches the client and the database already pointing at the durable copy", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cybara-durable-reply-"));
    dirs.push(workspace);
    const image = join(workspace, "after.png");
    writeFileSync(image, PNG);
    const provider = providerManager.create({
      provider: "openai",
      name: "Durable image fixture provider",
      api_key: "fixture",
      base_url: "https://api.openai.com/v1",
    });
    providers.push(provider.id);
    const agent = agentManager.create({
      name: "Durable image fixture agent",
      model: "model-a",
      provider_id: provider.id,
      memory_enabled: false,
    });
    agents.push(agent.id);
    agentManager.execute = (async () => ({
      content: `Screenshot:\n\n![after](${pathToFileURL(image).href})`,
      tool_calls: [],
    })) as typeof agentManager.execute;
    const sessionId = `durable-reply-${crypto.randomUUID()}`;
    sessions.push(sessionId);

    const response = await handleChat({
      agentId: agent.id,
      sessionId,
      message: "shot",
      tools: true,
    });
    const [link] = imageLinks(response.message?.content ?? "");
    expect(link).toMatch(/^\/api\/media\?path=media%2Fchat%2F[0-9a-f]{32}\.png$/);

    const stored = db
      .query("SELECT content FROM session_messages WHERE session_id = ? AND role = 'assistant'")
      .all(sessionId) as Array<{ content: string }>;
    expect(stored.flatMap((row) => imageLinks(row.content))).toEqual([link ?? ""]);
  });
});

describe("an existing chat that linked a workspace image", () => {
  for (const resident of [false, true]) {
    test(`is healed on load, stored durably, and still served after the file is gone (resident=${resident})`, async () => {
      const { sessionId, image } = await seedChatWithWorkspaceImage(resident);

      const served = await getSessionMessages(sessionId);
      const visible = served.filter((m) => m.role === "user" || m.role === "assistant");
      expect(visible.map((m) => m.role)).toEqual(["user", "assistant"]);
      const [link] = imageLinks(visible[1]?.content ?? "");
      expect(link).toMatch(/^\/api\/media\?path=media%2Fchat%2F[0-9a-f]{32}\.png$/);

      const stored = db
        .query("SELECT content FROM session_messages WHERE session_id = ? AND role = 'assistant'")
        .get(sessionId) as { content: string };
      expect(imageLinks(stored.content)).toEqual([link ?? ""]);

      rmSync(image);
      const media = resolveMediaFile(decodeURIComponent((link ?? "").split("path=")[1] ?? ""));
      expect(media.status).toBe(200);
      expect(media.bytes?.equals(PNG)).toBe(true);

      const reloaded = await getSessionMessages(sessionId, { deferHistoricalMetadata: true });
      expect(reloaded.filter((m) => m.role === "assistant")).toHaveLength(1);
      expect(imageLinks(reloaded.find((m) => m.role === "assistant")?.content ?? "")).toEqual([
        link ?? "",
      ]);
    });
  }
});
