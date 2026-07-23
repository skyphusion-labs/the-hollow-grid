import { describe, expect, it } from "vitest";
import { sanitizePlayerText } from "../../shared/sanitize-player-text";

describe("sanitizePlayerText", () => {
  it("strips ANSI escape sequences", () => {
    expect(sanitizePlayerText("\x1b[31mRed\x1b[0m")).toBe("Red");
  });

  it("collapses newlines to spaces", () => {
    expect(sanitizePlayerText("line1\nline2")).toBe("line1 line2");
  });

  it("enforces max length", () => {
    expect(sanitizePlayerText("a".repeat(100), 40)).toHaveLength(40);
  });

  it("strips bidi and zero-width format chars", () => {
    expect(sanitizePlayerText("\u202eMara\u202c")).toBe("Mara");
    expect(sanitizePlayerText("M\u200ba\u200bra")).toBe("Mara");
    expect(sanitizePlayerText("\uFEFFtest")).toBe("test");
  });
});
