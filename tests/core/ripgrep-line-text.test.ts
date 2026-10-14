import { describe, expect, test } from "bun:test";
import { ripgrepLineText } from "../../src/core/tools/handlers/file";

describe("ripgrep match text", () => {
  test("strips the LF terminator ripgrep keeps inside lines.text", () => {
    const event = JSON.parse(
      '{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"needle\\n"},"line_number":3}}'
    ) as { data: { lines: { text: string } } };
    expect(ripgrepLineText(event.data.lines.text)).toBe("needle");
  });

  test("strips a CRLF terminator from Windows line endings", () => {
    expect(ripgrepLineText("const value = 1;\r\n")).toBe("const value = 1;");
  });

  test("preserves a final line that has no terminator", () => {
    expect(ripgrepLineText("last line without newline")).toBe("last line without newline");
  });

  test("removes only one trailing terminator and keeps interior whitespace", () => {
    expect(ripgrepLineText("  indented\t\n")).toBe("  indented\t");
    expect(ripgrepLineText("blank-follows\n\n")).toBe("blank-follows\n");
  });

  test("an isolated carriage return inside the line is content, not a terminator", () => {
    expect(ripgrepLineText("a\rb\n")).toBe("a\rb");
  });

  test("non-string payloads become empty text instead of throwing", () => {
    expect(ripgrepLineText(undefined)).toBe("");
    expect(ripgrepLineText(null)).toBe("");
    expect(ripgrepLineText({ bytes: "bmVlZGxl" })).toBe("");
  });
});
