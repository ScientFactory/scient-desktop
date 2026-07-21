// FILE: providerVersions.test.ts
// Purpose: Covers shared provider semantic-version comparison and stable-channel validation.
// Layer: Shared runtime utility tests

import { describe, expect, it } from "vitest";

import { compareSemverVersions, isStableSemver } from "./providerVersions";

describe("providerVersions", () => {
  it("orders stable and prerelease provider versions", () => {
    expect(compareSemverVersions("1.1.5", "1.1.4")).toBeGreaterThan(0);
    expect(compareSemverVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareSemverVersions("2.0.0", "2.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareSemverVersions("2.0.0-beta.2", "2.0.0-beta.10")).toBeLessThan(0);
  });

  it("accepts only complete stable semantic versions for trusted latest channels", () => {
    expect(isStableSemver("1.1.5")).toBe(true);
    expect(isStableSemver("v1.1.5")).toBe(false);
    expect(isStableSemver("1.1")).toBe(false);
    expect(isStableSemver("1.1.5-beta.1")).toBe(false);
  });
});
