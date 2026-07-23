import { describe, expect, it } from "vitest";
import { timingSafeEqual, verifyRpcBearer } from "./world-auth";

describe("timingSafeEqual", () => {
  it("matches equal strings", () => {
    expect(timingSafeEqual("secret-token", "secret-token")).toBe(true);
  });

  it("rejects mismatched values without length short-circuit", () => {
    expect(timingSafeEqual("short", "much-longer-value")).toBe(false);
    expect(timingSafeEqual("same-length-aaaa", "same-length-bbbb")).toBe(false);
  });
});

describe("verifyRpcBearer", () => {
  it("accepts valid bearer", () => {
    expect(verifyRpcBearer("Bearer abc123", "abc123")).toBe(true);
  });

  it("rejects wrong-length bearer without early return leak", () => {
    expect(verifyRpcBearer("Bearer x", "longer-token")).toBe(false);
  });
});
