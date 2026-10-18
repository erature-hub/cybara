import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { extractZipArchive } from "./archive";

export const CYBARA_BUN_RUNTIME_VERSION = "1.4.3";

export type BunRuntimeTarget =
  | "bun-darwin-arm64"
  | "bun-darwin-x64"
  | "bun-linux-arm64"
  | "bun-linux-x64"
  | "bun-windows-arm64"
  | "bun-windows-x64";

interface BunRuntimeRelease {
  asset: string;
  sha256: string;
}

const BUN_RUNTIME_RELEASES: Record<BunRuntimeTarget, BunRuntimeRelease> = {
  "bun-darwin-arm64": {
    asset: "bun-darwin-aarch64.zip",
    sha256: "80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403",
  },
  "bun-darwin-x64": {
    asset: "bun-darwin-x64.zip",
    sha256: "62660e6438eb872278877acca77e1152d5d031324df368d4a81b428211489d2d",
  },
  "bun-linux-arm64": {
    asset: "bun-linux-aarch64.zip",
    sha256: "efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21",
  },
  "bun-linux-x64": {
    asset: "bun-linux-x64.zip",
    sha256: "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18",
  },
  "bun-windows-arm64": {
    asset: "bun-windows-aarch64.zip",
    sha256: "5e8f142ef722cbc9f67dc068a166e46ee72be8307b38cac7186589d2face668f",
  },
  "bun-windows-x64": {
    asset: "bun-windows-x64.zip",
    sha256: "0bf84e808552beea67bf1202a287a35c6c825d837b287b3f8e9dd513dba35d3d",
  },
};

export function getBunRuntimeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): BunRuntimeTarget | null {
  if (platform === "darwin" && arch === "arm64") return "bun-darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "bun-darwin-x64";
  if (platform === "linux" && arch === "arm64") return "bun-linux-arm64";
  if (platform === "linux" && arch === "x64") return "bun-linux-x64";
  if (platform === "win32" && arch === "arm64") return "bun-windows-arm64";
  if (platform === "win32" && arch === "x64") return "bun-windows-x64";
  return null;
}

export function bunRuntimeExecutableName(target: BunRuntimeTarget): string {
  return target.startsWith("bun-windows-") ? "bun.exe" : "bun";
}

export function bunRuntimeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
  cwd = process.cwd(),
  home = homedir(),
  pathRuntime = Bun.which("bun")
): string[] {
  const executableName = platform === "win32" ? "bun.exe" : "bun";
  const pathJoin = platform === "win32" ? win32.join : join;
  const pathDirname = platform === "win32" ? win32.dirname : dirname;
  const resourceDir = env.CYBARA_RESOURCE_DIR?.trim();
  const explicit = env.CYBARA_BUN_PATH?.trim();
  const candidates: Array<string | undefined> = [
    explicit,
    resourceDir && pathJoin(resourceDir, "runtime", executableName),
    pathJoin(pathDirname(executablePath), "runtime", executableName),
    pathJoin(cwd, "runtime", executableName),
    pathJoin(home, ".cybara", "runtime", CYBARA_BUN_RUNTIME_VERSION, executableName),
    pathJoin(home, ".bun", "bin", executableName),
    pathRuntime || undefined,
  ];
  if (platform === "win32") {
    const userProfile = env.USERPROFILE || home;
    const localAppData = env.LOCALAPPDATA;
    const programData = env.ProgramData || env.PROGRAMDATA;
    candidates.push(
      win32.join(userProfile, "scoop", "apps", "bun", "current", "bun.exe"),
      localAppData && win32.join(localAppData, "Microsoft", "WinGet", "Links", "bun.exe"),
      programData && win32.join(programData, "chocolatey", "bin", "bun.exe")
    );
  }
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is string => {
    if (!candidate) return false;
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findBunRuntime(
  candidates: string[] = bunRuntimeCandidates(),
  fileExists: (path: string) => boolean = existsSync
): string | null {
  return candidates.find((candidate) => fileExists(candidate)) ?? null;
}

function findExtractedRuntime(root: string, executableName: string): string | null {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.toLowerCase() === executableName.toLowerCase()) return path;
    }
  }
  return null;
}

export async function installBunRuntimeAt(
  destinationDir: string,
  target: BunRuntimeTarget,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const release = BUN_RUNTIME_RELEASES[target];
  const executableName = bunRuntimeExecutableName(target);
  const destination = join(destinationDir, executableName);
  const versionPath = join(destinationDir, ".version");
  if (
    existsSync(destination) &&
    existsSync(versionPath) &&
    readFileSync(versionPath, "utf8").trim() === CYBARA_BUN_RUNTIME_VERSION
  ) {
    return destination;
  }

  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${CYBARA_BUN_RUNTIME_VERSION}/${release.asset}`;
  const response = await fetcher(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Bun runtime download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
  if (digest !== release.sha256) throw new Error("Bun runtime checksum verification failed");

  const temporaryDir = mkdtempSync(join(tmpdir(), "cybara-bun-runtime-"));
  try {
    const archivePath = join(temporaryDir, basename(release.asset));
    const extractDir = join(temporaryDir, "extract");
    writeFileSync(archivePath, archive);
    mkdirSync(extractDir, { recursive: true });
    extractZipArchive(archivePath, extractDir);
    const extracted = findExtractedRuntime(extractDir, executableName);
    if (!extracted) throw new Error(`Bun runtime archive did not contain ${executableName}`);
    rmSync(destinationDir, { recursive: true, force: true });
    mkdirSync(destinationDir, { recursive: true });
    copyFileSync(extracted, destination);
    if (!target.startsWith("bun-windows-")) chmodSync(destination, 0o755);
    writeFileSync(versionPath, `${CYBARA_BUN_RUNTIME_VERSION}\n`);
    return destination;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

export async function ensureBunRuntime(): Promise<string> {
  const existing = findBunRuntime();
  if (existing) return existing;
  const target = getBunRuntimeTarget();
  if (!target)
    throw new Error(`No portable Bun runtime is available for ${process.platform}/${process.arch}`);
  return await installBunRuntimeAt(
    join(homedir(), ".cybara", "runtime", CYBARA_BUN_RUNTIME_VERSION),
    target
  );
}
