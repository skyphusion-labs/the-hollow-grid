import { describe, expect, it } from "vitest";
import { hashPassphrase, verifyAdminToken } from "./passphrase";

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

  it("does not short-circuit on length mismatch", () => {
    expect(verifyAdminToken("a", "keeper-secret")).toBe(false);
    expect(verifyAdminToken("keeper-secret-extra", "keeper-secret")).toBe(false);
  });

  it("rejects passphrases longer than bcrypt 72-byte limit", async () => {
    const long = "x".repeat(80);
    await expect(hashPassphrase(long)).rejects.toThrow(/bcrypt/);
  });
});
