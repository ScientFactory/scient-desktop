import { assert, describe, it } from "@effect/vitest";

import { shouldBundleCliDependency } from "./cli-external-packages.ts";
import { resolveParcelWatcherNativeDependencies } from "./scient-parcel-watcher-build.ts";

describe("Compute project watch packaging", () => {
  it("ships each target's native watch package as a stage root", () => {
    assert.deepStrictEqual(resolveParcelWatcherNativeDependencies("mac", "universal", "2.6.0"), {
      "@parcel/watcher-darwin-arm64": "2.6.0",
      "@parcel/watcher-darwin-x64": "2.6.0",
    });
    assert.deepStrictEqual(resolveParcelWatcherNativeDependencies("win", "arm64", "2.6.0"), {
      "@parcel/watcher-win32-arm64": "2.6.0",
    });
    assert.deepStrictEqual(resolveParcelWatcherNativeDependencies("linux", "x64", "2.6.0"), {
      "@parcel/watcher-linux-x64-glibc": "2.6.0",
      "@parcel/watcher-linux-x64-musl": "2.6.0",
    });
    assert.deepStrictEqual(resolveParcelWatcherNativeDependencies("mac", "arm64", undefined), {});
  });

  it("keeps the watch and what it loads at runtime outside the server bundle", () => {
    for (const id of ["@parcel/watcher", "@parcel/watcher-linux-x64-glibc", "picomatch"]) {
      assert.strictEqual(shouldBundleCliDependency(id), false, id);
    }
  });
});
