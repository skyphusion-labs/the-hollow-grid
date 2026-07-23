import { describe, expect, it, beforeEach } from "vitest";
import { requireBindingWorldAuth } from "./binding-auth";
import { resetWorldAuthCache } from "./world-auth";
import type { Env } from "./types";

describe("requireBindingWorldAuth", () => {
  beforeEach(() => resetWorldAuthCache());

  it("no-ops when GRID_WORLD_KEYS is unset", () => {
    expect(() => requireBindingWorldAuth({} as Env, undefined, undefined)).not.toThrow();
  });

  it("requires world when keys are configured", () => {
    const env = { GRID_WORLD_KEYS: JSON.stringify({ Dustfall: "dust-key" }) } as Env;
    expect(() => requireBindingWorldAuth(env, "", "dust-key")).toThrow(/world required/);
  });

  it("denies wrong world key on binding path", () => {
    const env = { GRID_WORLD_KEYS: JSON.stringify({ Dustfall: "dust-key" }) } as Env;
    expect(() => requireBindingWorldAuth(env, "Dustfall", "wrong")).toThrow(/world auth denied/);
  });
});
