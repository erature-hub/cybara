import { createHash } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { extname, isAbsolute, join, resolve, sep } from "path";
import { isImagePath } from "../../shared/image-formats";
import { cybaraDir } from "./paths";
import { assertReadablePath } from "./tools/path-policy";

const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\s*\)/g;
const LOCAL_REFERENCE_HINT = /!\[[^\]\n]*\]\(\s*<?(?:file:|[A-Za-z]:[\\/]|\/(?!api\/))/i;
const MAX_DURABLE_IMAGE_BYTES = 25 * 1024 * 1024;
const DURABLE_SUBDIR = ["media", "chat"] as const;
const durableByFingerprint = new Map<string, string>();

function durableRoot(): string {
  return join(cybaraDir, ...DURABLE_SUBDIR);
}

function stripAngleBrackets(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

export function localImagePathFromReference(reference: string): string | null {
  const target = stripAngleBrackets(reference.trim());
  if (!target || target.startsWith("/api/")) return null;
  if (/^file:/i.test(target)) {
    try {
      const pathname = decodeURIComponent(new URL(target).pathname);
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(target) || (target.startsWith("/") && isAbsolute(target))) {
    return target;
  }
  return null;
}

function isDurableCopy(path: string): boolean {
  return path.startsWith(durableRoot() + sep);
}

function durableMediaReference(fileName: string): string {
  return `/api/media?path=${encodeURIComponent(`${DURABLE_SUBDIR.join("/")}/${fileName}`)}`;
}

export function durableChatImageReference(path: string): string | null {
  const resolved = resolve(path);
  if (!isImagePath(resolved)) return null;
  if (isDurableCopy(resolved)) {
    return existsSync(resolved)
      ? durableMediaReference(resolved.slice(durableRoot().length + 1))
      : null;
  }
  try {
    assertReadablePath(resolved);
  } catch {
    return null;
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_DURABLE_IMAGE_BYTES) return null;
  const fingerprint = `${resolved}:${Math.floor(stats.mtimeMs)}:${stats.size}`;
  const known = durableByFingerprint.get(fingerprint);
  if (known && existsSync(join(durableRoot(), known))) return durableMediaReference(known);
  try {
    const bytes = readFileSync(resolved);
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    const fileName = `${digest}${extname(resolved).toLowerCase()}`;
    const target = join(durableRoot(), fileName);
    if (!existsSync(target)) {
      mkdirSync(durableRoot(), { recursive: true });
      copyFileSync(resolved, target);
    }
    durableByFingerprint.set(fingerprint, fileName);
    return durableMediaReference(fileName);
  } catch {
    return null;
  }
}

export function hasLocalImageReference(content: string): boolean {
  return LOCAL_REFERENCE_HINT.test(content);
}

export function persistChatImageReferences(content: string): string {
  if (!hasLocalImageReference(content)) return content;
  return content.replace(
    MARKDOWN_IMAGE,
    (whole: string, alt: string, target: string, title: string | undefined) => {
      const localPath = localImagePathFromReference(target);
      if (!localPath) return whole;
      const durable = durableChatImageReference(localPath);
      return durable ? `![${alt}](${durable}${title ?? ""})` : whole;
    }
  );
}
