import { assert, describe, it } from "@effect/vitest";

import { resolveNextScientStableVersion } from "./resolve-next-scient-stable-version.ts";

describe("resolveNextScientStableVersion", () => {
  it("increments only the patch component of the latest stable release", () => {
    assert.deepStrictEqual(resolveNextScientStableVersion("v0.6.2"), {
      currentVersion: "0.6.2",
      version: "0.6.3",
      tag: "v0.6.3",
    });
    assert.deepStrictEqual(resolveNextScientStableVersion("v2.19.99"), {
      currentVersion: "2.19.99",
      version: "2.19.100",
      tag: "v2.19.100",
    });
  });

  it("rejects prereleases, build metadata, and non-SemVer release identities", () => {
    for (const tag of ["0.6.2", "v0.6.3-rc.1", "v0.6.2+build.1", "v0.6.2.1", "v00.6.2"]) {
      assert.throws(() => resolveNextScientStableVersion(tag), "exact stable");
    }
  });
});
