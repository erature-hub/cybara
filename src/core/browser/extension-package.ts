import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isCompiledRuntime } from "../runtime/runtime-mode";

const EXTENSION_DIRECTORY_NAME = "browser-extension";

export function browserExtensionDirectory(): string | null {
  const candidates = isCompiledRuntime()
    ? [
        join(dirname(process.execPath), EXTENSION_DIRECTORY_NAME),
        resolve(dirname(process.execPath), "..", EXTENSION_DIRECTORY_NAME),
        resolve(
          dirname(process.execPath),
          "..",
          "..",
          "Resources",
          "sidecar",
          EXTENSION_DIRECTORY_NAME
        ),
        resolve(dirname(process.execPath), "..", "Resources", EXTENSION_DIRECTORY_NAME),
      ]
    : [resolve(import.meta.dirname, "..", "..", "..", "apps", EXTENSION_DIRECTORY_NAME)];
  return candidates.find((candidate) => existsSync(join(candidate, "manifest.json"))) ?? null;
}
