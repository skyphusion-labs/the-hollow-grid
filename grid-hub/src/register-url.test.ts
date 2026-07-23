import { describe, expect, it } from "vitest";
import { assertRegisterUrl } from "./register-url";

describe("assertRegisterUrl", () => {
  it("allows wss travel URLs", () => {
    expect(() => assertRegisterUrl("wss://hollow.skyphusion.org/ws")).not.toThrow();
  });

  it("allows ws for local dev", () => {
    expect(() => assertRegisterUrl("ws://localhost:8787/ws")).not.toThrow();
  });

  it("allows empty url as withdrawal", () => {
    expect(() => assertRegisterUrl("")).not.toThrow();
  });

  it("rejects javascript scheme poisoning", () => {
    expect(() => assertRegisterUrl("javascript:alert(1)")).toThrow(/ws: or wss:/);
  });

  it("rejects https handoff URLs", () => {
    expect(() => assertRegisterUrl("https://evil.example/ws")).toThrow(/ws: or wss:/);
  });
});
