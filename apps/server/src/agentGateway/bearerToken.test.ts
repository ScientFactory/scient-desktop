import { describe, expect, it } from "vitest";

import { extractBearerToken } from "./bearerToken.ts";

describe("extractBearerToken", () => {
  it("extracts the token from a standard Bearer header", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("BEARER abc")).toBe("abc");
  });

  it("trims leading/trailing whitespace around the header and token", () => {
    expect(extractBearerToken("  Bearer abc  ")).toBe("abc");
    expect(extractBearerToken("Bearer   abc  ")).toBe("abc");
  });

  it("returns null for undefined, null, or empty header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null when the header lacks the Bearer scheme", () => {
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("abc")).toBeNull();
  });

  it("returns null for a Bearer header with an empty value", () => {
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("Bearer    ")).toBeNull();
  });

  it("preserves internal content of the token", () => {
    expect(extractBearerToken("Bearer abc.def-ghi_123")).toBe("abc.def-ghi_123");
    expect(extractBearerToken("Bearer token with spaces")).toBe("token with spaces");
  });
});
