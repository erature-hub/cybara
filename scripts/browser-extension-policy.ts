import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { extname, join, relative } from "path";

export const BROWSER_EXTENSION_DIR = join(import.meta.dirname, "..", "apps", "browser-extension");

const ALLOWED_PERMISSIONS = ["alarms", "debugger", "storage", "tabGroups", "tabs"];
const FORBIDDEN_MANIFEST_KEYS = [
  "host_permissions",
  "optional_host_permissions",
  "optional_permissions",
  "content_scripts",
  "externally_connectable",
  "web_accessible_resources",
  "update_url",
  "key",
];
const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "node_modules",
]);
const SHIPPED_EXTENSIONS = new Set([".js", ".json", ".html", ".css", ".png", ".md"]);
const REMOTE_CODE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /<script[^>]+src=["']?(?:https?:)?\/\//i, reason: "loads a remote script" },
  { pattern: /<link[^>]+href=["']?(?:https?:)?\/\//i, reason: "loads a remote stylesheet" },
  { pattern: /\bimport\s*\(\s*["'`]https?:/i, reason: "imports remote code" },
  { pattern: /\bimport\s+[^;]*from\s+["']https?:/i, reason: "imports remote code" },
  { pattern: /\beval\s*\(/, reason: "uses eval" },
  { pattern: /\bnew\s+Function\s*\(/, reason: "uses new Function" },
  { pattern: /\binnerHTML\s*=/, reason: "assigns innerHTML" },
];

interface ExtensionManifest {
  manifest_version?: unknown;
  version?: unknown;
  permissions?: unknown;
  background?: { service_worker?: unknown };
  action?: { default_popup?: unknown; default_icon?: Record<string, unknown> };
  icons?: Record<string, unknown>;
  content_security_policy?: unknown;
  [key: string]: unknown;
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(path, ...listFiles(path));
    else files.push(path);
  }
  return files;
}

export function readExtensionManifest(directory = BROWSER_EXTENSION_DIR): ExtensionManifest {
  return JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as ExtensionManifest;
}

export function browserExtensionPolicyViolations(directory = BROWSER_EXTENSION_DIR): string[] {
  const violations: string[] = [];
  const manifest = readExtensionManifest(directory);

  if (manifest.manifest_version !== 3) violations.push("manifest_version must be 3");
  if (
    typeof manifest.version !== "string" ||
    !/^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(manifest.version) ||
    manifest.version.split(".").some((part) => Number(part) > 65_535)
  ) {
    violations.push(`version ${String(manifest.version)} is not a valid Chrome extension version`);
  }

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const unexpected = permissions.filter(
    (permission) => typeof permission !== "string" || !ALLOWED_PERMISSIONS.includes(permission)
  );
  if (unexpected.length > 0) {
    violations.push(`permissions outside the reviewed allowlist: ${unexpected.join(", ")}`);
  }
  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (key in manifest) violations.push(`manifest must not declare ${key}`);
  }
  if (manifest.content_security_policy !== undefined) {
    violations.push("manifest must keep Chrome's default extension content security policy");
  }

  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {}),
  ].filter((value): value is string => typeof value === "string");
  for (const file of referenced) {
    if (!existsSync(join(directory, file))) violations.push(`manifest references missing ${file}`);
  }

  for (const path of listFiles(directory)) {
    const name = relative(directory, path);
    const base = name.split(/[\\/]/).at(-1) ?? name;
    if (DEPENDENCY_FILES.has(base)) {
      violations.push(
        `${name} adds third-party dependencies; keep the extension dependency-free or add its lockfile to OSV scanning`
      );
      continue;
    }
    if (statSync(path).isDirectory()) continue;
    if (!SHIPPED_EXTENSIONS.has(extname(path))) {
      violations.push(`${name} is not an expected extension asset type`);
      continue;
    }
    if (![".js", ".html"].includes(extname(path))) continue;
    const source = readFileSync(path, "utf8");
    for (const { pattern, reason } of REMOTE_CODE_PATTERNS) {
      if (pattern.test(source)) violations.push(`${name} ${reason}`);
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = browserExtensionPolicyViolations();
  if (violations.length > 0) {
    console.error("Browser extension policy check failed:");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log("Browser extension policy check passed.");
}
