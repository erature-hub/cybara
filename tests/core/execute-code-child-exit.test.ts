import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleExecuteCode } from "../../src/core/tools/handlers/execute-code";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function childPidFrom(code: string, timeoutMs?: number): Promise<number> {
  const marker = join(mkdtempSync(join(tmpdir(), "cybara-exec-pid-")), "pid.txt");
  const result = await handleExecuteCode({
    code: `await Bun.write(${JSON.stringify(marker)}, String(process.pid));\n${code}`,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const pid = Number(await Bun.file(marker).text());
  rmSync(join(marker, ".."), { recursive: true, force: true });
  expect(Number.isInteger(pid) && pid > 0 && pid !== process.pid).toBe(true);
  expect(result).toBeDefined();
  return pid;
}

describe("execute_code child process lifetime", () => {
  test("the child has exited by the time a successful run returns", async () => {
    const pid = await childPidFrom("return 1;");
    expect(isAlive(pid)).toBe(false);
  });

  test("the child has exited by the time a failing run returns", async () => {
    const pid = await childPidFrom("throw new Error('boom');");
    expect(isAlive(pid)).toBe(false);
  });

  test("a timed-out child is killed and gone before the run returns", async () => {
    const pid = await childPidFrom("await new Promise(() => {});", 1000);
    expect(isAlive(pid)).toBe(false);
  }, 15_000);

  test("its working directory can be deleted immediately after the run", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cybara-exec-cwd-"));
    const result = await handleExecuteCode(
      { code: "return process.cwd();" },
      { workspaceDir: workspace, confineToWorkspace: true, allowedToolNames: ["execute_code"] }
    );
    expect(result.ok).toBe(true);
    expect(() => rmSync(workspace, { recursive: true, force: true })).not.toThrow();
  });
});
