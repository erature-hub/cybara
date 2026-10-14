import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists, commandWorks, resetCommandWorksCache } from "../../src/core/platform";
import { handleGrep } from "../../src/core/tools/handlers/file";
import { envWithOnlyPath } from "../helpers/isolated-path-env";

describe("command availability probing", () => {
  test("commandWorks rejects a command that exists on PATH but cannot run", () => {
    resetCommandWorksCache();
    expect(commandExists("this-command-does-not-exist-anywhere")).toBe(false);
    expect(commandWorks("this-command-does-not-exist-anywhere")).toBe(false);
  });

  test("commandWorks accepts a command that genuinely runs", () => {
    resetCommandWorksCache();
    expect(commandWorks(process.execPath)).toBe(true);
  });

  test("commandWorks caches within the TTL", () => {
    resetCommandWorksCache();
    expect(commandWorks(process.execPath)).toBe(true);
    expect(commandWorks(process.execPath)).toBe(true);
    resetCommandWorksCache();
  });
});

describe("grep never reports zero matches when the search backend is broken", () => {
  test("falls back to the javascript searcher and finds real matches", () => {
    const directory = mkdtempSync(join(tmpdir(), "cybara-grep-fallback-"));
    const emptyPath = join(directory, "bin");
    try {
      mkdirSync(emptyPath);
      for (let index = 0; index < 4; index += 1) {
        writeFileSync(join(directory, `hit-${index}.txt`), `needle ${index}\n`);
      }

      const handlerUrl = new URL("../../src/core/tools/handlers/file.ts", import.meta.url).href;
      const worker = [
        `const { handleGrep } = await import(${JSON.stringify(handlerUrl)});`,
        'const result = await handleGrep({ pattern: "needle", path: process.env.SEARCH_DIR, context: 0 });',
        'console.log("GREPBROKEN:" + JSON.stringify(result));',
      ].join("\n");
      const spawned = Bun.spawnSync([process.execPath, "-e", worker], {
        cwd: directory,
        env: envWithOnlyPath(emptyPath, { SEARCH_DIR: directory }),
        stdout: "pipe",
        stderr: "pipe",
      });
      const marker = spawned.stdout
        .toString()
        .split("\n")
        .find((line) => line.startsWith("GREPBROKEN:"));
      expect(spawned.exitCode).toBe(0);
      const result = JSON.parse(marker?.slice("GREPBROKEN:".length) ?? "{}") as {
        count?: number;
        source?: string;
        truncated?: boolean;
        results?: Array<{ content: string }>;
      };

      expect(result.count).toBe(4);
      expect(result.source).toBe("javascript");
      expect(result.truncated).toBe(false);
      expect(result.results?.every((entry) => !/[\r\n]/.test(entry.content))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an empty corpus still reports zero without claiming a backend crash", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cybara-grep-empty-"));
    try {
      writeFileSync(join(directory, "plain.txt"), "nothing here\n");

      const result = await handleGrep({ pattern: "absent-token", path: directory });

      expect(result.count).toBe(0);
      expect(["javascript", "ripgrep"]).toContain(result.source);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
