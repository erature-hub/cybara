import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { makeSiblingsInert, TOP_OVERLAY_Z_INDEX } from "../../ui/src/lib/overlayLayers";

const UI_SRC = join(import.meta.dir, "..", "..", "ui", "src");
const LIGHTBOX = join(UI_SRC, "pages", "chat", "ChatImageLightbox.tsx");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

function zIndexDeclarations(): Array<{ at: string; value: number }> {
  const found: Array<{ at: string; value: number }> = [];
  const pattern = /\bz-\[(\d+)\]|\bzIndex:\s*(\d+)|\bz-index:\s*(\d+)/g;
  for (const file of sourceFiles(UI_SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1] ?? match[2] ?? match[3]);
      const line = text.slice(0, match.index).split("\n").length;
      found.push({ at: `${relative(UI_SRC, file)}:${line}`, value });
    }
  }
  return found;
}

describe("image lightbox stacking", () => {
  test("is the highest layer in the app, above every panel, menu and tooltip", () => {
    const declarations = zIndexDeclarations();
    expect(declarations.length).toBeGreaterThan(0);
    const above = declarations.filter(({ value }) => value >= TOP_OVERLAY_Z_INDEX);
    expect(above).toEqual([]);
  });

  test("uses the top layer instead of a hard-coded low z-index", () => {
    const source = readFileSync(LIGHTBOX, "utf8");
    expect(source).toContain("zIndex: TOP_OVERLAY_Z_INDEX");
    expect(source).not.toMatch(/fixed inset-0 z-\[\d+\]/);
  });

  test("the top layer is the largest z-index a browser accepts", () => {
    expect(TOP_OVERLAY_Z_INDEX).toBe(2 ** 31 - 1);
  });
});

describe("inert background while the lightbox is open", () => {
  test("disables every other top-level surface and restores them on close", () => {
    const app = { inert: false };
    const panel = { inert: false };
    const lightbox = { inert: false };
    const restore = makeSiblingsInert([app, panel, lightbox], lightbox);
    expect([app.inert, panel.inert, lightbox.inert]).toEqual([true, true, false]);
    restore();
    expect([app.inert, panel.inert, lightbox.inert]).toEqual([false, false, false]);
  });

  test("leaves surfaces that were already inert untouched on restore", () => {
    const alreadyInert = { inert: true };
    const app = { inert: false };
    const lightbox = { inert: false };
    const restore = makeSiblingsInert([alreadyInert, app, lightbox], lightbox);
    restore();
    expect(alreadyInert.inert).toBe(true);
    expect(app.inert).toBe(false);
  });

  test("an empty page is a no-op", () => {
    const lightbox = { inert: false };
    const restore = makeSiblingsInert([], lightbox);
    restore();
    expect(lightbox.inert).toBe(false);
  });
});
