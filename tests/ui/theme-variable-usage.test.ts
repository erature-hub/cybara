import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const UI_SRC = join(import.meta.dir, "..", "..", "ui", "src");
const CHANNEL_TRIPLET = /^\d{1,3}\s*,?\s*\d{1,3}\s*,?\s*\d{1,3}$/;

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

function definedThemeVariables(): Map<string, string[]> {
  const values = new Map<string, string[]>();
  const declaration = /(--[\w-]+)["']?\s*:\s*([^;}\n]+)/g;
  for (const file of files(UI_SRC, /\.(css|tsx?)$/)) {
    for (const match of readFileSync(file, "utf8").matchAll(declaration)) {
      const name = match[1] ?? "";
      const list = values.get(name) ?? [];
      list.push((match[2] ?? "").trim().replace(/,$/, "").trim());
      values.set(name, list);
    }
  }
  return values;
}

interface Usage {
  at: string;
  name: string;
}

function usages(pattern: RegExp): Usage[] {
  const found: Usage[] = [];
  for (const file of files(UI_SRC, /\.tsx?$/)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      found.push({ at: `${relative(UI_SRC, file)}:${line}`, name: match[1] ?? "" });
    }
  }
  return found;
}

describe("theme variables used in class names", () => {
  const defined = definedThemeVariables();

  test("rgb(var(--x)) only wraps variables defined as r, g, b channel triplets", () => {
    const broken = usages(/rgba?\(var\((--[\w-]+)\)/g).filter(({ name }) => {
      const values = defined.get(name);
      return !values || !values.every((value) => CHANNEL_TRIPLET.test(value));
    });
    expect(broken).toEqual([]);
  });

  test("arbitrary var(--x) values refer to variables that exist", () => {
    const broken = usages(/\[[^\]\s]*?var\((--[\w-]+)\)[^\]\s]*\]/g).filter(
      ({ name }) => !defined.has(name)
    );
    expect(broken).toEqual([]);
  });

  test("the checks recognise the shapes they guard", () => {
    expect(CHANNEL_TRIPLET.test("99, 102, 241")).toBe(true);
    expect(CHANNEL_TRIPLET.test("99 102 241")).toBe(true);
    expect(CHANNEL_TRIPLET.test("#d4d4d4")).toBe(false);
    expect(defined.get("--accent-primary")?.every((v) => CHANNEL_TRIPLET.test(v))).toBe(true);
    expect(defined.get("--text-secondary")?.some((v) => CHANNEL_TRIPLET.test(v))).toBe(false);
  });
});
