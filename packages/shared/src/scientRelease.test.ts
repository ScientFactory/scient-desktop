import { assert, describe, it } from "@effect/vitest";

import {
  isExactScientReleaseVersion,
  scientServerNpxCommand,
  scientServerAssetName,
  scientServerPackageSpec,
} from "./scientRelease.ts";

describe("Scient release distribution", () => {
  it("resolves an immutable GitHub asset for an exact release", () => {
    assert.isTrue(isExactScientReleaseVersion("0.6.0"));
    assert.equal(scientServerAssetName("0.6.0"), "scient-server-0.6.0.tgz");
    assert.equal(
      scientServerPackageSpec("0.6.0"),
      "https://github.com/ScientFactory/scient-desktop-next/releases/download/v0.6.0/scient-server-0.6.0.tgz",
    );
    assert.equal(
      scientServerNpxCommand("0.6.0"),
      "npx --yes --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 --package=https://github.com/ScientFactory/scient-desktop-next/releases/download/v0.6.0/scient-server-0.6.0.tgz t3",
    );
  });

  it("rejects channel names and shell-like values", () => {
    assert.isFalse(isExactScientReleaseVersion("latest"));
    assert.isFalse(isExactScientReleaseVersion("0.6.0; touch /tmp/no"));
    assert.throws(() => scientServerAssetName("latest"));
  });
});
