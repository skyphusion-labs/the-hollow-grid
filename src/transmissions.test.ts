import { describe, expect, it } from "vitest";
import { personalize } from "./transmissions";

describe("personalize", () => {
  it("substitutes sanitized player name", () => {
    expect(personalize("hello {name}", "Ada")).toBe("hello Ada");
  });

  it("strips ANSI from substituted name", () => {
    expect(personalize(">> {name} <<", "\x1b[2J\x1b[Hghost")).toBe(">> ghost <<");
  });

  it("replaces every placeholder", () => {
    expect(personalize("{name} and {name}", "x")).toBe("x and x");
  });
});
