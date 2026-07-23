import { describe, expect, it, beforeEach } from "vitest";
import { verifyRpcWorldAuth, worldFromRpcParams } from "./rpc-auth";
import { resetWorldAuthCache } from "./world-auth";
import type { Env } from "./types";

function env(keys?: string): Env {
  return { GRID_WORLD_KEYS: keys } as Env;
}

describe("worldFromRpcParams", () => {
  it("reads world from gridcast params", () => {
    expect(worldFromRpcParams("gridcast", ["Rust Choir", "Mara", "hi"], "")).toBe("Rust Choir");
  });

  it("reads world from X-Grid-World for shiftTide", () => {
    expect(worldFromRpcParams("shiftTide", [1], "Rust Choir")).toBe("Rust Choir");
  });
});

describe("verifyRpcWorldAuth", () => {
  beforeEach(() => resetWorldAuthCache());

  it("denies gridcast when world key is wrong", () => {
    const keys = JSON.stringify({ "Rust Choir": "good-key" });
    const res = verifyRpcWorldAuth(env(keys), "gridcast", ["Rust Choir", "Mara", "hi"], {
      world: "Rust Choir",
      worldKey: "bad-key",
    });
    expect(res?.status).toBe(403);
  });

  it("denies gridcast world spoof (param vs header)", () => {
    const keys = JSON.stringify({ Dustfall: "dust-key", "Rust Choir": "rust-key" });
    const res = verifyRpcWorldAuth(env(keys), "gridcast", ["Dustfall", "Mara", "hi"], {
      world: "Rust Choir",
      worldKey: "rust-key",
    });
    expect(res?.status).toBe(403);
  });

  it("allows shiftTide with matching header world key", () => {
    const keys = JSON.stringify({ "Rust Choir": "good-key" });
    const res = verifyRpcWorldAuth(env(keys), "shiftTide", [1], {
      world: "Rust Choir",
      worldKey: "good-key",
    });
    expect(res).toBeNull();
  });

  it("requires X-Grid-World for shiftTide when keys are configured", () => {
    const keys = JSON.stringify({ "Rust Choir": "good-key" });
    const res = verifyRpcWorldAuth(env(keys), "shiftTide", [1], { world: "", worldKey: undefined });
    expect(res?.status).toBe(400);
  });

  it("fail-closes when GRID_WORLD_KEYS JSON is invalid", () => {
    const res = verifyRpcWorldAuth(env("{not-json"), "shiftTide", [1], {
      world: "Rust Choir",
      worldKey: "anything",
    });
    expect(res?.status).toBe(403);
  });
});
