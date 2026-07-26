import { describe, expect, it } from "vitest";

import { isVerifierOwnedPackagedStartupSmoke } from "./packagedStartupSmokeAuthority";

describe("isVerifierOwnedPackagedStartupSmoke", () => {
  const authority = {
    SCIENT_HOME: "/isolated/scient-home",
    SCIENT_PACKAGED_STARTUP_SENTINEL_PID: "4321",
    SCIENT_PACKAGED_STARTUP_SMOKE: "1",
  };

  it("accepts only a packaged child whose live parent matches the sentinel", () => {
    expect(isVerifierOwnedPackagedStartupSmoke(authority, 4321, true)).toBe(true);
  });

  it("does not let an inherited smoke flag disable normal containment", () => {
    expect(
      isVerifierOwnedPackagedStartupSmoke(
        { SCIENT_HOME: authority.SCIENT_HOME, SCIENT_PACKAGED_STARTUP_SMOKE: "1" },
        4321,
        true,
      ),
    ).toBe(false);
    expect(isVerifierOwnedPackagedStartupSmoke(authority, 9876, true)).toBe(false);
    expect(isVerifierOwnedPackagedStartupSmoke(authority, 4321, false)).toBe(false);
  });
});
