import { assert, describe, it } from "@effect/vitest";

import {
  assertScientReleaseChannelVersion,
  assertScientBetaTargetAheadOfStable,
  scientDesktopUpdateFeed,
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
      "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.0/scient-server-0.6.0.tgz",
    );
    assert.equal(
      scientServerNpxCommand("0.6.0"),
      "npx --yes --allow-scripts=node-pty@1.1.0,msgpackr-extract@3.0.4 --package=https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.0/scient-server-0.6.0.tgz t3",
    );
  });

  it("routes Beta server packages and updater metadata to the isolated repository", () => {
    const version = "0.6.23-beta.20261010.1";
    assert.include(scientServerPackageSpec(version), "/scient-desktop-beta/releases/download/");
    assert.deepEqual(scientDesktopUpdateFeed("latest"), {
      provider: "github",
      owner: "ScientFactory",
      repo: "scient-desktop",
    });
    assert.deepEqual(scientDesktopUpdateFeed("beta"), {
      provider: "github",
      owner: "ScientFactory",
      repo: "scient-desktop-beta",
    });
    assert.doesNotThrow(() => assertScientReleaseChannelVersion(version, "beta"));
    assert.throws(() => assertScientReleaseChannelVersion(version), "Stable releases require");
    assert.throws(
      () => assertScientReleaseChannelVersion("0.6.23", "beta"),
      "Beta releases require",
    );
    assert.throws(() => assertScientReleaseChannelVersion("0.6.23-nightly.20261010.1", "beta"));
  });

  it("rejects Beta candidates behind or equal to current Stable", () => {
    assert.doesNotThrow(() =>
      assertScientBetaTargetAheadOfStable("0.6.23-beta.20261010.1", "0.6.22"),
    );
    assert.throws(() => assertScientBetaTargetAheadOfStable("0.0.46-beta.20261010.1", "0.6.22"));
    assert.throws(() => assertScientBetaTargetAheadOfStable("0.6.22-beta.20261010.1", "0.6.22"));
  });

  it("rejects channel names and shell-like values", () => {
    assert.isFalse(isExactScientReleaseVersion("latest"));
    assert.isFalse(isExactScientReleaseVersion("00.6.0"));
    assert.isFalse(isExactScientReleaseVersion("0.6.0; touch /tmp/no"));
    assert.throws(() => scientServerAssetName("latest"));
  });
});
