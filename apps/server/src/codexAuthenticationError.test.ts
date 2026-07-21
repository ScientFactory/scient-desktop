import { describe, expect, it } from "vitest";

import { isCodexAuthenticationError } from "./codexAuthenticationError";

describe("isCodexAuthenticationError", () => {
  it("uses Codex's structured unauthorized error as the authoritative signal", () => {
    expect(
      isCodexAuthenticationError({
        message: "Request failed",
        detail: { error: { codexErrorInfo: "unauthorized" } },
        requiresProviderAccount: true,
      }),
    ).toBe(true);
  });

  it.each([
    "Authentication required",
    "You are no longer logged in. Please log in again.",
    "Not signed in. Run `codex login`.",
    "invalid_grant",
    "Refresh token was rejected because it is revoked",
    "Unauthorized",
    "Usage limit exceeded",
    "Request failed with status 401 while contacting a custom proxy",
    "Permission denied while reading a file",
    "Response stream disconnected",
  ])("does not infer account state from provider text: %s", (message) => {
    expect(isCodexAuthenticationError({ message, requiresProviderAccount: true })).toBe(false);
  });

  it("fails closed when account ownership is omitted at runtime", () => {
    expect(
      isCodexAuthenticationError({
        message: "Request failed",
        detail: { error: { codexErrorInfo: "unauthorized" } },
      } as Parameters<typeof isCodexAuthenticationError>[0]),
    ).toBe(false);
  });

  it("does not reinterpret structured upstream authorization failures for custom providers", () => {
    expect(
      isCodexAuthenticationError({
        message: "Request failed",
        detail: { error: { codexErrorInfo: "unauthorized" } },
        requiresProviderAccount: false,
      }),
    ).toBe(false);
  });

  it("does not treat a non-auth structured Codex error as authentication loss", () => {
    expect(
      isCodexAuthenticationError({
        message: "Server is busy",
        detail: { error: { codexErrorInfo: "serverOverloaded" } },
        requiresProviderAccount: true,
      }),
    ).toBe(false);
  });
});
