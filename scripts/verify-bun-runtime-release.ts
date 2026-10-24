import runtimeRelease from "../src/core/bun-runtime-release.json";

export function verifyBunRuntimeChecksums(checksums: string): string[] {
  const hashes = new Map<string, string>();
  for (const line of checksums.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(\S+)$/);
    const digest = match?.[1];
    const asset = match?.[2];
    if (!digest || !asset) throw new Error("Malformed Bun release checksum entry");
    if (hashes.has(asset)) throw new Error(`Duplicate Bun release checksum for ${asset}`);
    hashes.set(asset, digest);
  }

  const verified: string[] = [];
  for (const release of Object.values(runtimeRelease.targets)) {
    const digest = hashes.get(release.asset);
    if (!digest) throw new Error(`Missing Bun release checksum for ${release.asset}`);
    if (digest !== release.sha256) {
      throw new Error(`Bun ${runtimeRelease.version} checksum mismatch for ${release.asset}`);
    }
    verified.push(release.asset);
  }
  return verified;
}

if (import.meta.main) {
  try {
    const response = await fetch(
      `https://github.com/oven-sh/bun/releases/download/bun-v${runtimeRelease.version}/SHASUMS256.txt`,
      { redirect: "follow", signal: AbortSignal.timeout(30_000) }
    );
    if (!response.ok) throw new Error(`Bun release checksums returned HTTP ${response.status}`);
    const assets = verifyBunRuntimeChecksums(await response.text());
    console.log(
      `Verified Bun ${runtimeRelease.version} checksums for ${assets.length} runtime assets`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
