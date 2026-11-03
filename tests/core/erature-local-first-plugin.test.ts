import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadPluginFromRoot, validatePluginAtPath } from "../../src/core/plugins";
import {
  activatePluginRuntime,
  deactivatePluginRuntime,
  listPluginCommands,
  listPluginProviderContributions,
} from "../../src/core/plugins/runtime";
import { executeTool, hasTool } from "../../src/core/tools/handlers";

const pluginRoot = join(process.cwd(), "plugins", "erature-local-first");

describe("Erature local-first plugin", () => {
  test("ships a valid bundled plugin with its skill set", () => {
    const validation = validatePluginAtPath(pluginRoot);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);

    const plugin = loadPluginFromRoot(pluginRoot, "bundled");
    expect(plugin).not.toBeNull();
    expect(plugin?.manifest.id).toBe("erature-local-first");
    expect(plugin?.skillNames).toEqual(["local-inference-audit"]);
  });

  test("contributes a tool, a command, a hook, and a local provider", () => {
    const plugin = loadPluginFromRoot(pluginRoot, "bundled");
    if (!plugin) throw new Error("Plugin failed to load");
    expect(plugin.contributionFiles.tools).toHaveLength(1);
    expect(plugin.contributionFiles.commands).toHaveLength(1);
    expect(plugin.contributionFiles.hooks).toHaveLength(1);
    expect(plugin.contributionFiles.providers).toHaveLength(1);
    expect(plugin.contributionFiles.mcpServers).toHaveLength(0);
    expect(plugin.contributionFiles.channels).toHaveLength(0);
  });

  test("activates the provider contribution for a loopback endpoint", () => {
    const plugin = loadPluginFromRoot(pluginRoot, "bundled");
    if (!plugin) throw new Error("Plugin failed to load");
    try {
      activatePluginRuntime({ ...plugin, enabled: true });

      const providers = listPluginProviderContributions();
      const contribution = providers.find(
        (provider) => provider.pluginId === "erature-local-first"
      );
      expect(contribution).toBeDefined();
      expect(contribution?.baseUrl).toBe("http://localhost:11434/v1");
      expect(contribution?.authType).toBe("none");
      expect(contribution?.allowPrivateEndpoint).toBe(true);

      const commands = listPluginCommands();
      expect(commands.some((command) => command.id === "local-first-check")).toBe(true);

      const toolName = "plugin_erature_local_first_local_provider_health";
      expect(hasTool(toolName)).toBe(true);
    } finally {
      deactivatePluginRuntime("erature-local-first");
    }
  });

  test("the health tool reports an unreachable runtime instead of throwing", async () => {
    const plugin = loadPluginFromRoot(pluginRoot, "bundled");
    if (!plugin) throw new Error("Plugin failed to load");
    try {
      activatePluginRuntime({ ...plugin, enabled: true });
      const toolName = "plugin_erature_local_first_local_provider_health";
      const result = (await executeTool(
        toolName,
        { runtimes: [{ id: "ollama", url: "http://127.0.0.1:1" }] },
        { agentId: "test", allowDangerousTools: true }
      )) as { ok?: boolean; reports?: Array<{ reachable?: boolean }> };

      expect(result.ok).toBe(false);
      expect(result.reports?.[0]?.reachable).toBe(false);
    } finally {
      deactivatePluginRuntime("erature-local-first");
    }
  });

  test("the offline guard blocks network tools only while offline mode is set", async () => {
    const guard = join(pluginRoot, "scripts", "offline-guard.ts");
    const original = process.env.CYBARA_OFFLINE_MODE;

    const run = async (toolName: string): Promise<{ block?: boolean }> => {
      const proc = Bun.spawn(["bun", "run", guard], {
        cwd: pluginRoot,
        stdin: new Blob([JSON.stringify({ type: "tool_before", toolName, args: {} })]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      return JSON.parse(output.trim()) as { block?: boolean };
    };

    try {
      delete process.env.CYBARA_OFFLINE_MODE;
      expect((await run("http")).block).toBeUndefined();

      process.env.CYBARA_OFFLINE_MODE = "1";
      expect((await run("http")).block).toBe(true);
      expect((await run("read_file")).block).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.CYBARA_OFFLINE_MODE;
      else process.env.CYBARA_OFFLINE_MODE = original;
    }
  });
});
