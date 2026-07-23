import { describe, expect, it } from "vitest";
import { verifyAdminToken } from "./passphrase";

describe("verifyAdminToken", () => {
  it("accepts a matching token", () => {
    expect(verifyAdminToken("keeper-secret", "keeper-secret")).toBe(true);
  });

  it("rejects a wrong token (not a truthy Promise)", () => {
    expect(verifyAdminToken("wrong", "keeper-secret")).toBe(false);
  });

  it("rejects when expected secret is empty", () => {
    expect(verifyAdminToken("anything", "")).toBe(false);
  });
});
