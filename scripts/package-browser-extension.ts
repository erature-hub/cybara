import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { replaceJsonVersion } from "../src/core/versioning";
import {
  BROWSER_EXTENSION_DIR,
  browserExtensionPolicyViolations,
} from "./browser-extension-policy";

const ROOT = join(import.meta.dirname, "..");
const OUTPUT_DIR = join(ROOT, "release", "browser-extension");

export function browserExtensionArchiveName(version: string): string {
  return `cybara-browser-extension-v${version}.zip`;
}

function packageVersion(): string {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version?: string;
  };
  if (!version) throw new Error("package.json has no version");
  return version;
}

function main(): void {
  const version = process.argv[2]?.replace(/^v/, "") || packageVersion();
  const staging = join(OUTPUT_DIR, "staging");
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  cpSync(BROWSER_EXTENSION_DIR, staging, { recursive: true });

  const manifestPath = join(staging, "manifest.json");
  writeFileSync(manifestPath, replaceJsonVersion(readFileSync(manifestPath, "utf8"), version));

  const violations = browserExtensionPolicyViolations(staging);
  if (violations.length > 0) {
    throw new Error(`Browser extension policy check failed:\n${violations.join("\n")}`);
  }

  const archive = join(OUTPUT_DIR, browserExtensionArchiveName(version));
  const zip = Bun.spawnSync(["zip", "-r", "-X", "-q", archive, "."], { cwd: staging });
  if (zip.exitCode !== 0 || !existsSync(archive)) {
    throw new Error(`zip failed: ${zip.stderr.toString().trim() || `exit ${zip.exitCode}`}`);
  }
  rmSync(staging, { recursive: true, force: true });
  console.log(archive);
}

if (import.meta.main) main();
