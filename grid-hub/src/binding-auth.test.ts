import { describe, expect, it, beforeEach } from "vitest";
import { requireBindingWorldAuth } from "./binding-auth";
import { assertWorldAuth, resetWorldAuthCache, worldAuthRequired } from "./world-auth";
import type { Env } from "./types";

describe("requireBindingWorldAuth", () => {
  beforeEach(() => resetWorldAuthCache());

  it("no-ops when GRID_WORLD_KEYS and GRID_RPC_TOKEN are unset", () => {
    expect(() => requireBindingWorldAuth({} as Env, undefined, undefined)).not.toThrow();
  });

  it("requires world when keys are configured", () => {
    const env = { GRID_WORLD_KEYS: JSON.stringify({ Dustfall: "dust-key" }) } as Env;
    expect(() => requireBindingWorldAuth(env, "", "dust-key")).toThrow(/world required/);
  });

  it("denies wrong world key on binding path", () => {
    const env = { GRID_RPC_TOKEN: "shared", GRID_WORLD_KEYS: JSON.stringify({ Dustfall: "dust-key" }) } as Env;
    expect(() => requireBindingWorldAuth(env, "Dustfall", "wrong")).toThrow(/world auth denied/);
  });

  it("requires GRID_WORLD_KEYS when GRID_RPC_TOKEN is set", () => {
    const env = { GRID_RPC_TOKEN: "shared-rpc" } as Env;
    expect(worldAuthRequired(env)).toBe(true);
    expect(() => assertWorldAuth(env, "Dustfall", "any")).toThrow(/GRID_WORLD_KEYS required/);
  });

  it("requires world key on binding read path when keys configured", () => {
    const env = { GRID_WORLD_KEYS: JSON.stringify({ Dustfall: "dust-key" }) } as Env;
    expect(() => requireBindingWorldAuth(env, "Dustfall", "wrong")).toThrow(/world auth denied/);
    expect(() => requireBindingWorldAuth(env, "Dustfall", "dust-key")).not.toThrow();
  });
});
