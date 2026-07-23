import { describe, expect, it } from "vitest";
import { assertAllowedWsOrigin } from "./ws-origin";

describe("assertAllowedWsOrigin", () => {
  it("allows missing Origin (CLI clients)", () => {
    expect(() =>
      assertAllowedWsOrigin(new Request("https://hollow.skyphusion.org/ws")),
    ).not.toThrow();
  });

  it("allows same-host Origin", () => {
    const req = new Request("https://hollow.skyphusion.org/ws", {
      headers: { Origin: "https://hollow.skyphusion.org" },
    });
    expect(() => assertAllowedWsOrigin(req)).not.toThrow();
  });

  it("rejects cross-site Origin", () => {
    const req = new Request("https://hollow.skyphusion.org/ws", {
      headers: { Origin: "https://evil.example" },
    });
    expect(() => assertAllowedWsOrigin(req)).toThrow(/Origin not allowed/);
  });

  it("rejects malformed Origin", () => {
    const req = new Request("https://hollow.skyphusion.org/ws", {
      headers: { Origin: "not-a-url" },
    });
    expect(() => assertAllowedWsOrigin(req)).toThrow(/invalid Origin/);
  });
});
