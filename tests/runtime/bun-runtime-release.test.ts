import { describe, expect, test } from "bun:test";
import { verifyBunRuntimeChecksums } from "../../scripts/verify-bun-runtime-release";
import { CYBARA_BUN_RUNTIME_VERSION } from "../../src/core/bun-runtime";

const officialChecksums = [
  "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510  bun-darwin-aarch64.zip",
  "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e  bun-darwin-x64.zip",
  "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e  bun-linux-aarch64.zip",
  "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c  bun-linux-x64.zip",
  "2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09  bun-windows-aarch64.zip",
  "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5  bun-windows-x64.zip",
];

const workflows = [".github/workflows/ci.yml", ".github/workflows/release.yml"];

describe("packaged Bun release verification", () => {
  test("matches all six runtime archives to the official Bun 1.4.4 release", () => {
    expect(CYBARA_BUN_RUNTIME_VERSION).toBe("1.4.4");
    expect(verifyBunRuntimeChecksums(officialChecksums.join("\n"))).toEqual(
      officialChecksums.map((line) => line.split("  ")[1])
    );
  });

  test("accepts CRLF, binary checksum markers, and unrelated release assets", () => {
    const checksums = officialChecksums.map((line) => line.replace("  ", " *"));
    checksums.push(`${"1".repeat(64)}  bun-linux-x64-profile.zip`);
    expect(verifyBunRuntimeChecksums(`\r\n${checksums.join("\r\n")}\r\n`)).toHaveLength(6);
  });

  for (const [index, entry] of officialChecksums.entries()) {
    test(`rejects a stale checksum for ${entry.split("  ")[1]}`, () => {
      const checksums = [...officialChecksums];
      checksums[index] = `${"0".repeat(64)}${entry.slice(64)}`;
      expect(() => verifyBunRuntimeChecksums(checksums.join("\n"))).toThrow("checksum mismatch");
    });
  }

  test("fails closed on absent, duplicated, or malformed checksum data", () => {
    expect(() => verifyBunRuntimeChecksums("")).toThrow("Missing Bun release checksum");
    expect(() => verifyBunRuntimeChecksums(officialChecksums.slice(1).join("\n"))).toThrow(
      "Missing Bun release checksum"
    );
    expect(() =>
      verifyBunRuntimeChecksums([...officialChecksums, officialChecksums[0]].join("\n"))
    ).toThrow("Duplicate Bun release checksum");
    expect(() => verifyBunRuntimeChecksums("not a checksum file")).toThrow("Malformed");
  });

  test("verifies official checksums in CI and release gates before packaging", async () => {
    for (const workflow of workflows) {
      const content = await Bun.file(new URL(`../../${workflow}`, import.meta.url)).text();
      const verification = content.indexOf("run: bun run scripts/verify-bun-runtime-release.ts");
      expect(verification).toBeGreaterThan(-1);
      expect(verification).toBeLessThan(content.indexOf("run: bun run check:ci"));
    }
  });
});
