import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBundledBrowserExecutable, findSystemBrowserExecutable } from "./browser-executable";
import { getChromium } from "./playwright-loader";
import {
  browserDownloadsAccepted,
  getBrowserSupervisionSettings,
  onBrowserSupervisionSettingsChanged,
} from "./supervision";

const CDP_PORT_RANGE_START = 18800;
const CDP_PORT_RANGE_END = 18900;
const SAFE_PROFILE_NAME = /^[A-Za-z0-9._-]+$/;
const MAX_PROFILE_NAME_LENGTH = 64;

export interface BrowserProfile {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  color: string;
  userDataDir: string;
  running: boolean;
  lastTargetId: string | null;
}

export interface BrowserProfileConfig {
  name: string;
  cdpPort?: number;
  color?: string;
}

interface BrowserInstance {
  process: ChildProcess;
  browser: Browser;
}

const browsers = new Map<string, BrowserInstance>();
const browserStarts = new Map<string, Promise<Browser>>();
const pages = new Map<string, Page>();
const profiles = new Map<string, BrowserProfile>();
const usedPorts = new Set<number>();

function isSafeProfileName(profileName: string): boolean {
  return (
    profileName.length > 0 &&
    profileName.length <= MAX_PROFILE_NAME_LENGTH &&
    profileName !== "." &&
    profileName !== ".." &&
    SAFE_PROFILE_NAME.test(profileName)
  );
}

export function profileNameForSession(sessionId: string): string {
  if (isSafeProfileName(sessionId)) return sessionId;
  const readable = sessionId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|-+$/g, "")
    .slice(0, 40);
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `${readable || "session"}-${digest}`;
}

function profilePageIds(profileName: string): string[] {
  const prefix = `${profileName}-`;
  return Array.from(pages.keys()).filter(
    (id) => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))
  );
}

function forgetBrowser(profileName: string, instance: BrowserInstance): void {
  if (browsers.get(profileName) !== instance) return;
  browsers.delete(profileName);
  for (const pageId of profilePageIds(profileName)) pages.delete(pageId);
  const profile = profiles.get(profileName);
  if (profile) {
    profile.running = false;
    profile.lastTargetId = null;
  }
  if (instance.process.exitCode === null && instance.process.signalCode === null) {
    instance.process.kill();
  }
}

function portIsFree(port: number): boolean {
  try {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

function profileDownloadBehavior(): { policy: "allow"; downloadPath: string } | { policy: "deny" } {
  const supervision = getBrowserSupervisionSettings({ redact: false });
  if (!browserDownloadsAccepted(supervision.downloadPolicy)) return { policy: "deny" };
  const downloadPath = path.join(getConfigDir(), "downloads");
  fs.mkdirSync(downloadPath, { recursive: true, mode: 0o700 });
  return { policy: "allow", downloadPath };
}

onBrowserSupervisionSettingsChanged(() => {
  const downloadBehavior = profileDownloadBehavior();
  for (const { browser } of browsers.values()) {
    void browser
      .target()
      .createCDPSession()
      .then(async (session) => {
        try {
          await session.send("Browser.setDownloadBehavior", {
            behavior: downloadBehavior.policy,
            downloadPath:
              downloadBehavior.policy === "allow" ? downloadBehavior.downloadPath : undefined,
          });
        } finally {
          await session.detach();
        }
      })
      .catch(() => undefined);
  }
});

function getConfigDir(): string {
  const configDir = process.env.CONFIG_DIR || path.join(os.homedir(), ".cybara");
  return path.join(configDir, "browser");
}

function assertSafeProfileName(profileName: string): void {
  if (typeof profileName !== "string" || !isSafeProfileName(profileName)) {
    throw new Error(
      `Invalid browser profile name: profile names may only contain letters, numbers, '.', '_', and '-'`
    );
  }
}

export function resolveUserDataDir(profileName: string): string {
  assertSafeProfileName(profileName);
  const configDir = getConfigDir();
  const resolved = path.resolve(configDir, profileName, "user-data");
  const base = path.resolve(configDir);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Invalid browser profile name: resolves outside the profile directory`);
  }
  return resolved;
}

function findAvailablePort(): number {
  for (let port = CDP_PORT_RANGE_START; port < CDP_PORT_RANGE_END; port++) {
    if (!usedPorts.has(port) && portIsFree(port)) {
      return port;
    }
  }
  throw new Error("No available CDP ports");
}

export async function createProfile(config: BrowserProfileConfig): Promise<BrowserProfile> {
  const name = config.name;
  const cdpPort = config.cdpPort || findAvailablePort();
  const color = config.color || "#F4B400";
  const userDataDir = resolveUserDataDir(name);

  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const defaultDir = path.join(userDataDir, "Default");
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }

  const prefsPath = path.join(defaultDir, "Preferences");
  if (!fs.existsSync(prefsPath)) {
    const prefs = {
      profile: {
        name: `Cybara Agent - ${name}`,
        avatar_index: 26,
        managed_user_id: "",
        is_using_default_name: false,
        is_using_default_avatar: false,
      },
      autogenerated_theme_color: 16041984,
      browser: {
        theme: {
          follows_system_colors: false,
          color_variant: 0,
          user_color: 16041984,
        },
      },
      ntp: {
        custom_background_dict: {},
      },
    };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
    console.log(`[Browser] Created profile with Cybara gold theme: ${name}`);
  }

  const profile: BrowserProfile = {
    name,
    cdpPort,
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
    color,
    userDataDir,
    running: false,
    lastTargetId: null,
  };

  profiles.set(name, profile);
  usedPorts.add(cdpPort);

  return profile;
}

export function getProfile(name: string): BrowserProfile | undefined {
  return profiles.get(name);
}

export function listProfiles(): BrowserProfile[] {
  return Array.from(profiles.values());
}

export async function deleteProfile(name: string): Promise<void> {
  const profile = profiles.get(name);
  if (!profile) return;

  if (profile.running) {
    await stopBrowser(name);
  }

  profiles.delete(name);
  usedPorts.delete(profile.cdpPort);
}

async function findChromeExecutable(): Promise<string | null> {
  const systemExecutable = findSystemBrowserExecutable();
  if (systemExecutable) return systemExecutable;
  try {
    return findBundledBrowserExecutable(await getChromium());
  } catch {
    return null;
  }
}

export async function startBrowser(profileName: string): Promise<Browser> {
  const running = browsers.get(profileName);
  if (running?.browser.connected) return running.browser;
  if (running) forgetBrowser(profileName, running);
  const inFlight = browserStarts.get(profileName);
  if (inFlight) return inFlight;
  const start = launchProfileBrowser(profileName).finally(() => {
    browserStarts.delete(profileName);
  });
  browserStarts.set(profileName, start);
  return start;
}

function reassignPortIfTaken(profile: BrowserProfile): void {
  if (portIsFree(profile.cdpPort)) return;
  usedPorts.delete(profile.cdpPort);
  const replacement = findAvailablePort();
  usedPorts.add(replacement);
  profile.cdpPort = replacement;
  profile.cdpUrl = `http://127.0.0.1:${replacement}`;
}

async function launchProfileBrowser(profileName: string): Promise<Browser> {
  let profile = profiles.get(profileName);
  if (!profile) {
    profile = await createProfile({ name: profileName });
  }
  const activeProfile = profile;
  reassignPortIfTaken(activeProfile);

  const executablePath = await findChromeExecutable();
  if (!executablePath) {
    throw new Error(
      "Chrome/Chromium not found. Install Playwright browsers: bunx playwright install chromium"
    );
  }

  const chromeArgs = [
    `--remote-debugging-port=${profile.cdpPort}`,
    `--remote-debugging-address=127.0.0.1`,
    `--user-data-dir=${profile.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--disable-translate",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-features=TranslateUI",
    "--window-size=1920,1080",
    "--window-position=0,0",
  ];

  const platform = process.platform;
  if (platform === "linux") {
    if (process.env.CI || process.env.DOCKER) {
      chromeArgs.push("--no-sandbox");
    }
    chromeArgs.push("--disable-dev-shm-usage");
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(executablePath, chromeArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let settled = false;
    let connecting = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (startupTimer) clearTimeout(startupTimer);
      proc.kill();
      activeProfile.running = false;
      reject(error);
    };

    proc.on("error", (err) => {
      fail(new Error(`Failed to start Chrome: ${err.message}`));
    });

    proc.on("exit", (code, signal) => {
      const instance = browsers.get(profileName);
      if (instance?.process === proc) forgetBrowser(profileName, instance);
      if (!settled) {
        fail(
          new Error(
            `Chrome exited before CDP connected${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`
          )
        );
      }
    });

    const cdpUrl = activeProfile.cdpUrl;
    const maxAttempts = 30;
    let attempts = 0;

    const checkCDP = async () => {
      if (settled || connecting) return;

      attempts++;
      try {
        const response = await fetch(`${cdpUrl}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok && !settled) {
          const versionData = (await response.json()) as { webSocketDebuggerUrl?: string };
          const wsUrl = versionData.webSocketDebuggerUrl;

          if (!wsUrl) {
            throw new Error("CDP response did not include a WebSocket URL");
          }

          connecting = true;
          console.log(`[Browser] CDP ready after ${attempts * 500}ms, connecting via ${wsUrl}...`);
          try {
            const browser = await puppeteer.connect({
              browserWSEndpoint: wsUrl,
              defaultViewport: null,
              downloadBehavior: profileDownloadBehavior(),
            });

            if (settled) {
              await browser.close().catch(() => {});
              return;
            }

            settled = true;
            if (pollTimer) clearTimeout(pollTimer);
            if (startupTimer) clearTimeout(startupTimer);
            const instance: BrowserInstance = { process: proc, browser };
            browsers.set(profileName, instance);
            browser.on("disconnected", () => forgetBrowser(profileName, instance));
            activeProfile.running = true;
            console.log(`[Browser] Connected to Chrome via CDP WebSocket (Puppeteer)`);
            resolve(browser);
            return;
          } finally {
            connecting = false;
          }
        }
      } catch {
        void 0;
      }

      if (settled) return;

      if (attempts >= maxAttempts) {
        fail(new Error(`Chrome CDP not available at ${cdpUrl} after ${maxAttempts * 500}ms`));
        return;
      }

      pollTimer = setTimeout(checkCDP, 500);
    };

    startupTimer = setTimeout(
      () => fail(new Error(`Chrome CDP connection timed out at ${cdpUrl}`)),
      maxAttempts * 500 + 2000
    );
    pollTimer = setTimeout(checkCDP, 500);
  });
}

export async function stopBrowser(profileName: string): Promise<void> {
  const instance = browsers.get(profileName);
  if (!instance) return;

  for (const pageId of profilePageIds(profileName)) {
    await pages
      .get(pageId)
      ?.close()
      .catch(() => {});
    pages.delete(pageId);
  }

  await instance.browser.close().catch(() => {});
  forgetBrowser(profileName, instance);
}

export async function getBrowser(profileName: string): Promise<Browser> {
  return await startBrowser(profileName);
}

export async function createPage(profileName: string, url?: string): Promise<Page> {
  const browser = await getBrowser(profileName);

  const existingPages = await browser.pages();
  let page: Page;

  if (existingPages.length > 0 && !existingPages[0].url().includes("about:blank") === false) {
    page = existingPages[0];
    console.log(`[Browser] Using existing page for profile: ${profileName}`);
  } else {
    page = await browser.newPage();
    console.log(`[Browser] Created new page for profile: ${profileName}`);
  }

  const pageId = `${profileName}-${Date.now()}`;
  pages.set(pageId, page);

  page.on("close", () => {
    pages.delete(pageId);
  });

  const targetUrl = url?.trim() || "";
  if (targetUrl && targetUrl !== "about:blank") {
    console.log(`[Browser] Navigating to ${targetUrl}...`);
    try {
      await page.goto(targetUrl, { timeout: 30000, waitUntil: "domcontentloaded" });
      console.log(`[Browser] Successfully navigated to ${targetUrl}`);
    } catch (err) {
      console.log(`[Browser] Navigation error (page still created): ${(err as Error).message}`);
    }
  }

  const profile = profiles.get(profileName);
  if (profile) {
    profile.lastTargetId = pageId;
  }

  return page;
}

export function getPage(profileName: string, pageId: string): Page | undefined {
  return pages.get(`${profileName}-${pageId}`) || pages.get(pageId);
}

export async function getActivePage(profileName: string): Promise<Page> {
  const instance = browsers.get(profileName);

  if (instance?.browser.connected) {
    const browserPages = await instance.browser.pages();
    if (browserPages.length > 0) {
      return browserPages[browserPages.length - 1];
    }
  }

  return await createPage(profileName);
}

export async function getProfilePages(
  profileName: string
): Promise<Array<{ id: string; url: string; title: string }>> {
  const entries = profilePageIds(profileName).flatMap((id) => {
    const page = pages.get(id);
    return page ? [[id, page] as const] : [];
  });

  const result: Array<{ id: string; url: string; title: string }> = [];
  for (const [id, page] of entries) {
    result.push({
      id: id.replace(`${profileName}-`, ""),
      url: page.url(),
      title: await page.title(),
    });
  }
  return result;
}

export async function closePage(profileName: string, pageId: string): Promise<boolean> {
  const fullId = `${profileName}-${pageId}`;
  const page = pages.get(fullId) || pages.get(pageId);
  if (!page) return false;

  await page.close();
  pages.delete(fullId);
  pages.delete(pageId);
  return true;
}

export async function closeAllPages(profileName: string): Promise<void> {
  for (const id of profilePageIds(profileName)) {
    await pages
      .get(id)
      ?.close()
      .catch(() => {});
    pages.delete(id);
  }
}

export async function getStatus(): Promise<{
  running: boolean;
  profiles: BrowserProfile[];
  totalPages: number;
}> {
  return {
    running: browsers.size > 0,
    profiles: listProfiles(),
    totalPages: pages.size,
  };
}

export async function shutdownAll(): Promise<void> {
  for (const [name] of browsers) {
    await stopBrowser(name);
  }
}

export function getPagesMap(): Map<string, Page> {
  return pages;
}

export function getBrowsersMap(): Map<string, BrowserInstance> {
  return browsers;
}
