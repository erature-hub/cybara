import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CYBARA_BUN_RUNTIME_VERSION,
  bunRuntimeCandidates,
  bunRuntimeExecutableName,
  findBunRuntime,
  getBunRuntimeTarget,
  installBunRuntimeAt,
} from "../../src/core/bun-runtime";

describe("portable Bun runtime", () => {
  test("pins packaged runtimes and build environments to Bun 1.4.4", async () => {
    expect(CYBARA_BUN_RUNTIME_VERSION).toBe("1.4.4");
    const root = new URL("../../", import.meta.url);
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/workflows/main-version-tag.yml",
      ".github/workflows/osv-scanner.yml",
      ".github/workflows/release.yml",
    ]) {
      expect(await Bun.file(new URL(path, root)).text()).toMatch(
        /(?:BUN_VERSION|bun-version): "1\.4\.4"/
      );
    }
    const dockerfile = await Bun.file(new URL("Dockerfile", root)).text();
    expect(dockerfile.match(/FROM oven\/bun:1\.4\.4 AS /g)).toHaveLength(2);
  });

  test("maps every supported desktop architecture", () => {
    expect(getBunRuntimeTarget("darwin", "arm64")).toBe("bun-darwin-arm64");
    expect(getBunRuntimeTarget("darwin", "x64")).toBe("bun-darwin-x64");
    expect(getBunRuntimeTarget("linux", "arm64")).toBe("bun-linux-arm64");
    expect(getBunRuntimeTarget("linux", "x64")).toBe("bun-linux-x64");
    expect(getBunRuntimeTarget("win32", "arm64")).toBe("bun-windows-arm64");
    expect(getBunRuntimeTarget("win32", "x64")).toBe("bun-windows-x64");
    expect(getBunRuntimeTarget("freebsd", "x64")).toBeNull();
  });

  test("prefers explicit and packaged Windows runtimes without PATH", () => {
    const candidates = bunRuntimeCandidates(
      "win32",
      {
        CYBARA_BUN_PATH: "C:\\Portable\\bun.exe",
        CYBARA_RESOURCE_DIR: "C:\\Program Files\\Cybara\\resources",
        USERPROFILE: "C:\\Users\\Carsen",
        LOCALAPPDATA: "C:\\Users\\Carsen\\AppData\\Local",
      },
      "C:\\Program Files\\Cybara\\cybara.exe",
      "C:\\Program Files\\Cybara",
      "C:\\Users\\Carsen",
      null
    );

    expect(candidates[0]).toBe("C:\\Portable\\bun.exe");
    expect(candidates).toContain("C:\\Program Files\\Cybara\\resources\\runtime\\bun.exe");
    expect(candidates).toContain("C:\\Users\\Carsen\\.bun\\bin\\bun.exe");
    expect(candidates).toContain(
      "C:\\Users\\Carsen\\AppData\\Local\\Microsoft\\WinGet\\Links\\bun.exe"
    );
  });

  test("selects the first runtime that exists", () => {
    expect(findBunRuntime(["missing", "packaged", "path"], (value) => value === "packaged")).toBe(
      "packaged"
    );
    expect(findBunRuntime(["missing"], () => false)).toBeNull();
  });

  test("uses the correct executable filename", () => {
    expect(bunRuntimeExecutableName("bun-windows-x64")).toBe("bun.exe");
    expect(bunRuntimeExecutableName("bun-linux-x64")).toBe("bun");
  });

  test("rejects a runtime archive whose checksum does not match", async () => {
    const destination = mkdtempSync(join(tmpdir(), "cybara-bun-runtime-test-"));
    try {
      await expect(
        installBunRuntimeAt(destination, "bun-windows-x64", async () => {
          return new Response("not the signed release", { status: 200 });
        })
      ).rejects.toThrow("checksum verification failed");
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});
