import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BROWSER_EXTENSION_DIR,
  browserExtensionPolicyViolations,
} from "../../scripts/browser-extension-policy";
import { browserExtensionArchiveName } from "../../scripts/package-browser-extension";

const copies: string[] = [];

function copyExtension(): string {
  const directory = join(mkdtempSync(join(tmpdir(), "cybara-extension-")), "extension");
  cpSync(BROWSER_EXTENSION_DIR, directory, { recursive: true });
  copies.push(directory);
  return directory;
}

function editManifest(directory: string, edit: (manifest: Record<string, unknown>) => void): void {
  const path = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}

afterEach(() => {
  for (const directory of copies.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("browser extension supply-chain policy", () => {
  test("the shipped extension passes", () => {
    expect(browserExtensionPolicyViolations()).toEqual([]);
  });

  test("rejects new permissions, host access and remote code", () => {
    const directory = copyExtension();
    editManifest(directory, (manifest) => {
      manifest.permissions = [...(manifest.permissions as string[]), "cookies"];
      manifest.host_permissions = ["<all_urls>"];
    });
    writeFileSync(
      join(directory, "popup.html"),
      '<script src="https://cdn.example.com/x.js"></script>'
    );
    const violations = browserExtensionPolicyViolations(directory).join("\n");
    expect(violations).toContain("cookies");
    expect(violations).toContain("host_permissions");
    expect(violations).toContain("remote script");
  });

  test("rejects third-party dependencies that OSV scanning would not cover", () => {
    const directory = copyExtension();
    writeFileSync(join(directory, "package.json"), "{}");
    expect(browserExtensionPolicyViolations(directory).join("\n")).toContain("OSV scanning");
  });

  test("names release archives so the website can match them", () => {
    expect(browserExtensionArchiveName("1.0.2459")).toBe("cybara-browser-extension-v1.0.2459.zip");
    expect(browserExtensionArchiveName("1.0.2459")).toMatch(
      /cybara-browser-extension-v[\d.]+\.zip$/i
    );
  });
});
