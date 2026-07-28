import { describe, expect, it } from "vitest";

import { safeProviderConnectionFailureDetail } from "./providerConnectionFailureDetail";

describe("safeProviderConnectionFailureDetail", () => {
  it.each([
    ["Error: authorization code expired", "authorization request expired"],
    ["OAuth access_denied by user", "rejected or cancelled"],
    ["connect ECONNREFUSED auth.example.test", "could not reach"],
    ["failed to open browser", "could not open the sign-in page"],
    ["EACCES: permission denied, open '/private/auth.json'", "could not update"],
    ["HTTP 429: too many requests", "rate-limited"],
  ])("classifies %s without reflecting provider output", (output, expected) => {
    const detail = safeProviderConnectionFailureDetail(output);
    expect(detail).toContain(expected);
    expect(detail).not.toContain(output);
  });

  it("never returns unknown raw output or embedded secrets", () => {
    const secret = "sk-secret-value-1234567890";
    expect(
      safeProviderConnectionFailureDetail(
        `unexpected provider failure for user@example.com token=${secret} https://auth.test/callback?code=private`,
      ),
    ).toBeNull();
    const classified = safeProviderConnectionFailureDetail(
      `authentication failed token=${secret} for user@example.com`,
    );
    expect(classified).toContain("did not accept");
    expect(classified).not.toContain(secret);
    expect(classified).not.toContain("user@example.com");
  });

  it("strips terminal controls before classification", () => {
    expect(
      safeProviderConnectionFailureDetail("\u001b[31mError: access denied\u001b[0m"),
    ).toContain("rejected or cancelled");
  });

  it("returns null for empty or non-actionable output", () => {
    expect(safeProviderConnectionFailureDetail("")).toBeNull();
    expect(safeProviderConnectionFailureDetail("Opening browser... done")).toBeNull();
  });
});
