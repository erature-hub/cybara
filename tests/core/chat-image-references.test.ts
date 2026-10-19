import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  durableChatImageReference,
  localImagePathFromReference,
  persistChatImageReferences,
} from "../../src/core/chat-image-references";
import { cybaraDir } from "../../src/core/paths";
import { resolveMediaFile } from "../../src/core/runtime/media-files";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const workspace = mkdtempSync(join(tmpdir(), "cybara-chat-images-"));
const created: string[] = [];

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  for (const file of created) rmSync(file, { force: true });
});

function mediaPathOf(reference: string): string {
  return decodeURIComponent(reference.slice("/api/media?path=".length));
}

function writeImage(name: string, bytes: Buffer = PNG): string {
  const path = join(workspace, name);
  writeFileSync(path, bytes);
  return path;
}

function servedBytes(reference: string): Buffer | undefined {
  const served = resolveMediaFile(mediaPathOf(reference));
  if (served.path) created.push(served.path);
  return served.status === 200 ? served.bytes : undefined;
}

describe("local image references", () => {
  test("parse file URLs, Windows drive paths and POSIX paths, but not web or media links", () => {
    expect(localImagePathFromReference("file:///C:/work/shot%201.png")).toBe("C:/work/shot 1.png");
    expect(localImagePathFromReference("file://C:\\work\\shot.png")).toBe("C:/work/shot.png");
    expect(localImagePathFromReference("C:\\work\\shot.png")).toBe("C:\\work\\shot.png");
    expect(localImagePathFromReference("<C:/work/with space.png>")).toBe("C:/work/with space.png");
    expect(localImagePathFromReference("https://example.test/a.png")).toBeNull();
    expect(localImagePathFromReference("data:image/png;base64,AAAA")).toBeNull();
    expect(localImagePathFromReference("/api/media?path=screenshots%2Fa.png")).toBeNull();
    expect(localImagePathFromReference("relative/a.png")).toBeNull();
  });
});

describe("durable chat images", () => {
  test("a workspace image becomes a media link that the media route actually serves", () => {
    const source = writeImage("workspace-shot.png");
    const reference = durableChatImageReference(source);
    expect(reference).toStartWith("/api/media?path=media%2Fchat%2F");
    if (!reference) throw new Error("no durable reference");
    expect(servedBytes(reference)?.equals(PNG)).toBe(true);
  });

  test("the copy survives the original being deleted", () => {
    const source = writeImage("deleted-later.png", Buffer.concat([PNG, Buffer.from("x")]));
    const reference = durableChatImageReference(source);
    rmSync(source);
    if (!reference) throw new Error("no durable reference");
    expect(servedBytes(reference)).toBeDefined();
  });

  test("identical images share one copy and rewriting is idempotent", () => {
    const first = writeImage("same-a.png");
    const second = writeImage("same-b.png");
    expect(durableChatImageReference(first)).toBe(durableChatImageReference(second));
    const content = `![a](${pathToFileURL(first).href})`;
    const once = persistChatImageReferences(content);
    expect(persistChatImageReferences(once)).toBe(once);
  });

  test("rewrites every local markdown image and leaves everything else untouched", () => {
    const source = writeImage("mixed.png");
    const content = [
      "Before:",
      `![before](${pathToFileURL(source).href})`,
      `![raw](${source})`,
      "![web](https://example.test/a.png)",
      "[not an image](C:/work/notes.txt)",
      "![missing](file:///C:/definitely/not/here.png)",
    ].join("\n");
    const rewritten = persistChatImageReferences(content);
    const lines = rewritten.split("\n");
    expect(lines[1]).toMatch(
      /^!\[before\]\(\/api\/media\?path=media%2Fchat%2F[0-9a-f]{32}\.png\)$/
    );
    expect(lines[2]).toMatch(/^!\[raw\]\(\/api\/media\?path=media%2Fchat%2F[0-9a-f]{32}\.png\)$/);
    expect(lines.slice(3)).toEqual(content.split("\n").slice(3));
  });

  test("refuses non-image files even when linked as an image", () => {
    const secret = join(workspace, "notes.txt");
    writeFileSync(secret, "not an image");
    const content = `![x](${pathToFileURL(secret).href})`;
    expect(persistChatImageReferences(content)).toBe(content);
  });

  test("refuses sensitive files blocked by the read policy, even with an image extension", () => {
    const disguised = join(cybaraDir, `api_key-probe-${process.pid}.png`);
    writeFileSync(disguised, PNG);
    created.push(disguised);
    expect(durableChatImageReference(disguised)).toBeNull();
    const content = `![x](${pathToFileURL(disguised).href})`;
    expect(persistChatImageReferences(content)).toBe(content);
  });

  test("leaves text with no local image untouched without touching the disk", () => {
    const content = "No images here, just [a link](https://example.test).";
    expect(persistChatImageReferences(content)).toBe(content);
  });

  test("the stored copy is byte-identical to the source", () => {
    const bytes = Buffer.concat([PNG, Buffer.from("unique-bytes")]);
    const source = writeImage("exact.png", bytes);
    const reference = durableChatImageReference(source);
    if (!reference) throw new Error("no durable reference");
    const stored = join(cybaraDir, mediaPathOf(reference));
    created.push(stored);
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).equals(bytes)).toBe(true);
  });
});
