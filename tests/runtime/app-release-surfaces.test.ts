import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT_DIR, rel), "utf8");
}

describe("app release surface wiring", () => {
  test("CI gates every pull request, merge queue, and release branch", () => {
    const ciWorkflow = read(".github/workflows/ci.yml");

    expect(ciWorkflow).toContain("workflow_dispatch: {}");
    expect(ciWorkflow).toContain("pull_request: {}");
    expect(ciWorkflow).toContain("merge_group: {}");
    expect(ciWorkflow).toContain(
      "group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}"
    );
    expect(ciWorkflow).toMatch(/branches:\s+\- main\s+\- master\s+\- dev/);
    expect(ciWorkflow).toContain("bun run check:ci");
    expect(ciWorkflow).toContain("bun run audit:ci");
    expect(ciWorkflow).toContain("bun run build:all");
    expect(ciWorkflow).toContain("cd site && bun run build");
    expect(ciWorkflow).toContain("bunx expo export --platform ios");
    expect(ciWorkflow).toContain("bunx expo export --platform android");
  });

  test("artifact workflows use pinned Node 24 action releases", () => {
    const workflows = `${read(".github/workflows/ci.yml")}\n${read(".github/workflows/release.yml")}`;

    expect(workflows).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(workflows).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
    );
    expect(workflows).not.toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"
    );
    expect(workflows).not.toContain(
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"
    );
  });

  test("CI quality gates sync mobile release metadata before checks", () => {
    const ciWorkflow = read(".github/workflows/ci.yml");
    const releaseWorkflow = read(".github/workflows/release.yml");
    const versionWorkflow = read(".github/workflows/main-version-tag.yml");

    expect(ciWorkflow).toContain('CYBARA_RELEASE_VERSION="$VERSION" bun run version:sync');
    expect(ciWorkflow.indexOf("name: Sync version metadata")).toBeLessThan(
      ciWorkflow.indexOf("name: Run CI checks")
    );
    expect(releaseWorkflow.indexOf("name: Sync version metadata")).toBeLessThan(
      releaseWorkflow.indexOf("name: Run CI checks")
    );
    expect(releaseWorkflow.slice(0, releaseWorkflow.indexOf("build-cli:"))).toContain(
      "fetch-depth: 2"
    );
    expect(versionWorkflow).toContain("apps/mobile/app.json");
    expect(versionWorkflow).toContain("nix/release.nix");
    expect(versionWorkflow).toContain(
      "git add package.json ui/package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json apps/mobile/app.json nix/release.nix apps/browser-extension/manifest.json"
    );
  });

  test("the version tag workflow commits every file version:sync rewrites", () => {
    const versionScript = read("scripts/version.ts");
    const versionWorkflow = read(".github/workflows/main-version-tag.yml");
    const syncedFiles = [...versionScript.matchAll(/changed\.push\("([^"]+)"\)/g)].map(
      (match) => match[1]
    );
    const stageLine = versionWorkflow
      .split("\n")
      .find((line) => line.trim().startsWith("git add "));
    const diffLine = versionWorkflow
      .split("\n")
      .find((line) => line.includes("git diff --quiet --"));

    expect(syncedFiles).toContain("apps/browser-extension/manifest.json");
    for (const file of syncedFiles) {
      expect(stageLine).toContain(file);
      expect(diffLine).toContain(file);
    }
  });

  test("release workflow does not build mobile bundles in this CLI-only fork", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).not.toContain("build-mobile:");
    expect(workflow).not.toContain("cybara-mobile-expo");
    expect(workflow).not.toContain("mobile:expo-check");
    expect(workflow).not.toContain("FIREBASE_GOOGLE_SERVICES_JSON_BASE64");
  });

  test("release workflow does not build native iOS or Android artifacts in this CLI-only fork", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).not.toContain("build-android:");
    expect(workflow).not.toContain("build-ios:");
    expect(workflow).not.toContain("android-actions/setup-android@");
    expect(workflow).not.toContain("expo prebuild --platform");
    expect(workflow).not.toContain("upload-ios-testflight.ts");
    expect(workflow).not.toContain("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
  });

  test("release workflow publishes CLI assets only after every target is built", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).toContain("draft: true");
    expect(workflow).toContain("publish-release:");
    expect(workflow).toContain("needs: [build-cli, smoke-cli-darwin-x64]");
    expect(workflow).toContain('gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft=false');
    expect(workflow).not.toContain("releaseDraft: false");
    expect(workflow).not.toContain("publish-tauri-updater-manifest.ts");
    expect(workflow).not.toContain("includeUpdaterJson: false");
  });

  test("release workflow synchronizes Nix hashes before publishing the release", () => {
    const releaseWorkflow = read(".github/workflows/release.yml");

    expect(releaseWorkflow).toContain("name: Sync Nix release hashes");
    expect(releaseWorkflow).toContain('bun run scripts/sync-nix-release.ts "$VERSION"');
    expect(releaseWorkflow.indexOf("name: Sync Nix release hashes")).toBeLessThan(
      releaseWorkflow.indexOf("name: Publish draft release")
    );
    expect(releaseWorkflow).not.toContain("publish-packages.yml");
  });

  test("release workflow does not build Tauri desktop apps in this CLI-only fork", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).not.toContain("build-tauri:");
    expect(workflow).not.toContain("tauri-action@");
    expect(workflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).not.toContain("Build Sidecar binary");
    expect(workflow).not.toContain("build-native-macos:");
  });

  test("CLI release binaries embed the UI for every supported OS and architecture", () => {
    const workflow = read(".github/workflows/release.yml");
    const standaloneBuilder = read("scripts/build-standalone-cli.ts");

    expect(workflow).toContain(
      "bun run scripts/build-standalone-cli.ts bun-${{ matrix.target }} ${{ matrix.artifact }}"
    );
    expect(workflow.indexOf("- name: Build UI")).toBeLessThan(
      workflow.indexOf("- name: Cross-compile CLI binary")
    );
    for (const [target, artifact] of [
      ["linux-x64", "cybara-linux-x64"],
      ["linux-arm64", "cybara-linux-arm64"],
      ["darwin-x64", "cybara-darwin-x64"],
      ["darwin-arm64", "cybara-darwin-arm64"],
      ["windows-x64", "cybara-windows-x64.exe"],
      ["windows-arm64", "cybara-windows-arm64.exe"],
    ]) {
      expect(workflow).toContain(`target: ${target}`);
      expect(workflow).toContain(`artifact: ${artifact}`);
    }
    expect(standaloneBuilder).toContain('with { type: "file" }');
    expect(standaloneBuilder).toContain("__CYBARA_EMBEDDED_UI__");
  });

  test("Darwin x64 release artifact is smoke-tested on a macOS runner", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).toContain("smoke-cli-darwin-x64:");
    expect(workflow).toContain("name: cybara-darwin-x64");
    expect(workflow).toContain("bash scripts/smoke-standalone-cli.sh ./cybara-darwin-x64");
    expect(workflow).toContain("needs: [build-cli, smoke-cli-darwin-x64]");
  });

  test("release workflow does not package the browser extension in this CLI-only fork", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).not.toContain("build-browser-extension:");
    expect(workflow).not.toContain("package:browser-extension");
    expect(workflow).not.toContain("cybara-browser-extension");
  });

  test("release workflow does not package the native macOS app in this CLI-only fork", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).not.toContain("package-native-macos.ts");
    expect(workflow).not.toContain("release/native-macos/");
  });

  test("mobile app identity is shared across iOS, Android, and Expo metadata", () => {
    const appJson = JSON.parse(read("apps/mobile/app.json")) as {
      expo?: {
        name?: string;
        slug?: string;
        scheme?: string;
        version?: string;
        newArchEnabled?: boolean;
        ios?: {
          bundleIdentifier?: string;
          buildNumber?: string;
          infoPlist?: {
            NSLocalNetworkUsageDescription?: string;
            NSAppTransportSecurity?: { NSAllowsLocalNetworking?: boolean };
          };
        };
        android?: {
          package?: string;
          softwareKeyboardLayoutMode?: string;
          versionCode?: number;
        };
        plugins?: Array<string | [string, Record<string, unknown>]>;
        extra?: { gatewayContract?: string };
      };
    };
    const rootPkg = JSON.parse(read("package.json")) as { version?: string };
    const mobilePkg = JSON.parse(read("apps/mobile/package.json")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const versionParts = (rootPkg.version || "")
      .split(".")
      .map((part) => Number(part))
      .filter((part) => Number.isFinite(part));
    expect(versionParts).toHaveLength(3);
    const expectedVersionCode =
      versionParts[0] * 1_000_000 + versionParts[1] * 10_000 + versionParts[2];

    expect(appJson.expo?.name).toBe("Cybara");
    expect(appJson.expo?.slug).toBe("cybara-mobile");
    expect(appJson.expo?.version).toBe(rootPkg.version);
    expect(appJson.expo?.scheme).toBe("cybara");
    expect(appJson.expo?.newArchEnabled).toBe(true);
    expect(appJson.expo?.ios?.bundleIdentifier).toBe("com.ck.cybara");
    expect(appJson.expo?.ios?.buildNumber).toBe(String(expectedVersionCode));
    expect(appJson.expo?.ios?.infoPlist?.NSLocalNetworkUsageDescription).toContain(
      "Cybara gateway"
    );
    expect(appJson.expo?.ios?.infoPlist?.NSAppTransportSecurity?.NSAllowsLocalNetworking).toBe(
      true
    );
    expect(appJson.expo?.android?.package).toBe("com.ck.cybara");
    expect(appJson.expo?.android?.softwareKeyboardLayoutMode).toBe("resize");
    expect(appJson.expo?.android?.versionCode).toBe(expectedVersionCode);
    expect(appJson.expo?.plugins).toContain("./plugins/with-android-lan-cleartext");
    expect(read("apps/mobile/plugins/with-android-lan-cleartext.js")).toContain(
      'application.$["android:usesCleartextTraffic"] = "true"'
    );
    expect(read("apps/mobile/plugins/with-android-lan-cleartext.js")).toContain(
      "android.permission.NEARBY_WIFI_DEVICES"
    );
    expect(read("apps/mobile/plugins/with-android-lan-cleartext.js")).toContain(
      "android.permission.ACCESS_LOCAL_NETWORK"
    );
    expect(appJson.expo?.extra?.gatewayContract).toBe("cybara-mobile-connect-v1");

    expect(mobilePkg.scripts?.ios).toBe("bunx expo start --ios");
    expect(mobilePkg.scripts?.android).toBe("bunx expo start --android");
    expect(mobilePkg.scripts?.typecheck).toBe(
      "bun ./node_modules/@typescript/native/bin/tsc --noEmit"
    );
    expect(mobilePkg.dependencies?.["expo-glass-effect"]).toBeDefined();
    expect(mobilePkg.dependencies?.["expo-secure-store"]).toBeDefined();
  });

  test("Android app strategy remains the shared React Native companion, not a Bun runtime shell", () => {
    const readme = read("apps/android/README.md");

    expect(readme).toContain("React Native / Expo app shared with iOS");
    expect(readme).toContain("connect to a local or remote Cybara gateway");
    expect(readme).toContain("Android cannot reliably reuse the current Bun binary/runtime stack");
    expect(readme).toContain("API parity first");
  });
});
