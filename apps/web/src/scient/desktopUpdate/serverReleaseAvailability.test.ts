import { describe, expect, it } from "vite-plus/test";
import { scientServerAssetName, scientServerPackageSpec } from "@t3tools/shared/scientRelease";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  hasScientServerReleaseArtifact,
  isCurrentScientServerReleasePublished,
} from "./serverReleaseAvailability";

describe("Scient bulk-update artifact authority", () => {
  it("withdraws admission on refresh or failure even when the atom retains prior success", () => {
    const previous = AsyncResult.success(true);
    expect(isCurrentScientServerReleasePublished(previous)).toBe(true);
    expect(isCurrentScientServerReleasePublished(AsyncResult.waiting(previous))).toBe(false);
    const failed = AsyncResult.failureWithPrevious(Cause.fail("403"), {
      previous: Option.some(previous),
    });
    expect(AsyncResult.getOrElse(failed, () => false)).toBe(true);
    expect(isCurrentScientServerReleasePublished(failed)).toBe(false);
    expect(isCurrentScientServerReleasePublished(AsyncResult.initial())).toBe(false);
    expect(isCurrentScientServerReleasePublished(AsyncResult.success(false))).toBe(false);
  });
  it.each(["0.6.0", "0.7.0-beta.20261013.1"])(
    "admits only the exact owned artifact for %s",
    (version) => {
      const asset = {
        name: scientServerAssetName(version),
        browser_download_url: scientServerPackageSpec(version),
      };
      const release = { tag_name: `v${version}`, draft: false, assets: [asset] };
      expect(hasScientServerReleaseArtifact(version, release)).toBe(true);
      expect(hasScientServerReleaseArtifact(version, { ...release, draft: true })).toBe(false);
      expect(hasScientServerReleaseArtifact(version, { ...release, tag_name: "v0.1.0" })).toBe(
        false,
      );
      expect(hasScientServerReleaseArtifact(version, { ...release, assets: [] })).toBe(false);
      expect(
        hasScientServerReleaseArtifact(version, {
          ...release,
          assets: [{ ...asset, browser_download_url: "https://registry.npmjs.org/t3/-/t3.tgz" }],
        }),
      ).toBe(false);
      expect(
        hasScientServerReleaseArtifact(version, {
          ...release,
          assets: [{ ...asset, name: "another-runtime.tgz" }],
        }),
      ).toBe(false);
    },
  );
});
