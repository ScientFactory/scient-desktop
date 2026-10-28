import { assert, describe, it } from "@effect/vitest";

import { shouldBundleCliDependency } from "./cli-external-packages.ts";

describe("Scient CLI bundle boundary", () => {
  // Cursor's zod 4 ships on disk as a staged peer; bundled importers keep their own locked zod.
  it("keeps zod bundled so the Droid SDK resolves its own zod v3", () => {
    for (const id of ["zod", "zod/v3", "zod/v4"]) {
      assert.strictEqual(shouldBundleCliDependency(id), true, id);
    }
  });

  it("leaves Scient's disk-loaded packages external", () => {
    for (const id of ["@napi-rs/canvas", "@napi-rs/canvas-win32-arm64-msvc", "@1password/sdk"]) {
      assert.strictEqual(shouldBundleCliDependency(id), false, id);
    }
  });

  // regression: 7e01d33f0e perf(build): stop unpacking node_modules wholesale from the Windows asar (#5877)
  it("never bundles node: builtins", () => {
    assert.strictEqual(shouldBundleCliDependency("node:fs"), false);
  });
});
