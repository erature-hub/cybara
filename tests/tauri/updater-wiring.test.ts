import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  isValidTauriUpdaterPublicKey,
  TAURI_DEVELOPMENT_UPDATER_PUBLIC_KEY,
} from "../../src/core/versioning";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("desktop updater wiring", () => {
  test("desktop settings page exposes updater controls and release link support", () => {
    const settingsPath = join(ROOT_DIR, "ui", "src", "pages", "Settings.tsx");
    const settingsTsx = readFileSync(settingsPath, "utf8");
    const updateSettingsPath = join(
      ROOT_DIR,
      "ui",
      "src",
      "pages",
      "settings",
      "DesktopUpdateSettings.tsx"
    );
    const updateSettingsTsx = readFileSync(updateSettingsPath, "utf8");

    expect(settingsTsx).toContain("DesktopUpdateSettings");
    expect(updateSettingsTsx).toContain("Updates");
    expect(updateSettingsTsx).toContain("checkForUpdate");
    expect(updateSettingsTsx).toContain("startUpdateInstall");
    expect(updateSettingsTsx).toContain("useDesktopUpdate");
    expect(updateSettingsTsx).toContain("releaseRepositoryUrl");
  });

  test("tauri runtime enables updater/process plugins and permissions", () => {
    const cargoToml = readFileSync(join(ROOT_DIR, "src-tauri", "Cargo.toml"), "utf8");
    const mainRs = readFileSync(join(ROOT_DIR, "src-tauri", "src", "main.rs"), "utf8");
    const capabilityJson = readFileSync(
      join(ROOT_DIR, "src-tauri", "capabilities", "default.json"),
      "utf8"
    );
    const tauriConfig = readFileSync(join(ROOT_DIR, "src-tauri", "tauri.conf.json"), "utf8");
    const infoPlist = readFileSync(join(ROOT_DIR, "src-tauri", "Info.plist"), "utf8");
    const entitlements = readFileSync(join(ROOT_DIR, "src-tauri", "entitlements.plist"), "utf8");

    expect(cargoToml).toContain('tauri-plugin-updater = "2"');
    expect(cargoToml).toContain('tauri-plugin-process = "2"');
    expect(cargoToml).toContain('tauri-plugin-log = "2"');
    expect(cargoToml).toContain('tauri-plugin-window-state = "2"');
    expect(mainRs).toContain("tauri_plugin_updater::Builder::new().build()");
    expect(mainRs).toContain("tauri_plugin_process::init()");
    expect(mainRs).toContain("tauri_plugin_log::Builder::new()");
    expect(mainRs).toContain('target: "cybara::browser"');
    expect(mainRs).toContain("tauri_plugin_window_state::Builder::default().build()");
    expect(capabilityJson).toContain('"updater:default"');
    expect(capabilityJson).toContain('"process:default"');
    expect(tauriConfig).toContain('"updater"');
    expect(tauriConfig).toContain('"endpoints": []');
    expect(tauriConfig).not.toContain("placeholder");
    expect(tauriConfig).toContain(TAURI_DEVELOPMENT_UPDATER_PUBLIC_KEY);
    expect(isValidTauriUpdaterPublicKey(TAURI_DEVELOPMENT_UPDATER_PUBLIC_KEY)).toBe(true);
    expect(infoPlist).toContain("NSMicrophoneUsageDescription");
    expect(entitlements).toContain("com.apple.security.device.audio-input");
  });

  test("tray and frontend share the Rust-owned updater state machine", () => {
    const trayRs = readFileSync(join(ROOT_DIR, "src-tauri", "src", "tray.rs"), "utf8");
    const mainRs = readFileSync(join(ROOT_DIR, "src-tauri", "src", "main.rs"), "utf8");
    const updaterRs = readFileSync(join(ROOT_DIR, "src-tauri", "src", "desktop_update.rs"), "utf8");
    const authGateTsx = readFileSync(
      join(ROOT_DIR, "ui", "src", "components", "GatewayAuthGate.tsx"),
      "utf8"
    );
    const updateStore = readFileSync(join(ROOT_DIR, "ui", "src", "lib", "updateStore.ts"), "utf8");

    expect(trayRs).toContain("crate::desktop_update::spawn_install(app.clone())");
    expect(trayRs).toContain('"Checking for updates…"');
    expect(trayRs).toContain('"Update failed · Retry"');
    expect(updaterRs).toContain('app.emit("cybara://update-state", &snapshot)');
    expect(updaterRs).toContain("download_and_install(");
    expect(updaterRs).toContain('snapshot.phase = "downloading".to_string()');
    expect(updaterRs).toContain('snapshot.phase = "installing".to_string()');
    expect(updaterRs).toContain('snapshot.phase = "available".to_string()');
    expect(authGateTsx).toContain("ensureUpdatePolling()");
    expect(updateStore).toContain("listenForDesktopUpdateState");
    expect(updateStore).toContain("Click to install and restart Cybara");
    expect(updateStore).toContain("notification.onclick = () =>");
    expect(updateStore).toContain("void startUpdateInstall()");
    expect(mainRs).toContain("desktop_update::install_desktop_update");
    expect(mainRs).toContain("DesktopUpdateManager::default()");
    expect(trayRs).toContain("macos_template_icon");
  });

  test("release workflow ships no Tauri updater artifacts in this CLI-only fork", () => {
    const workflowPath = join(ROOT_DIR, ".github", "workflows", "release.yml");
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).not.toContain("bun run tauri:prepare-release");
    expect(workflow).not.toContain("includeUpdaterJson: false");
    expect(workflow).not.toContain("bun run scripts/publish-tauri-updater-manifest.ts");
    expect(workflow).not.toContain(
      "bun run scripts/verify-tauri-updater-manifest.ts release-check/latest.json"
    );
    expect(workflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
    expect(workflow).not.toContain("CYBARA_TAURI_UPDATER_PUBKEY");
    expect(workflow).not.toContain("src-tauri/tauri.release.conf.json");
  });

  test("release workflow does not build Tauri desktop apps in this CLI-only fork", () => {
    const workflowPath = join(ROOT_DIR, ".github", "workflows", "release.yml");
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).not.toContain("build-tauri:");
    expect(workflow).not.toContain("tauri-apps/tauri-action@");
    expect(workflow).not.toContain("aarch64-apple-darwin");
    expect(workflow).not.toContain("x86_64-pc-windows-msvc");
    expect(workflow).not.toContain("x86_64-unknown-linux-gnu");
    expect(workflow).not.toContain("universal-apple-darwin");
  });
});
