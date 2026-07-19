import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createReleaseInstallManifest,
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("release workspace manifests", () => {
  it("removes development-only dependencies from staged install manifests", () => {
    const manifest = JSON.parse(
      createReleaseInstallManifest(
        JSON.stringify({
          name: "fixture",
          dependencies: { runtime: "1.0.0" },
          devDependencies: { compiler: "2.0.0" },
        }),
      ),
    );

    expect(manifest).toEqual({
      name: "fixture",
      dependencies: { runtime: "1.0.0" },
    });
  });

  it("includes every Scient workspace needed by the desktop release stage", () => {
    expect(RELEASE_WORKSPACE_MANIFEST_PATHS).toEqual([
      "package.json",
      "apps/server/package.json",
      "apps/desktop/package.json",
      "apps/web/package.json",
      "apps/marketing/package.json",
      "packages/contracts/package.json",
      "packages/effect-acp/package.json",
      "packages/scient-project-init/package.json",
      "packages/shared/package.json",
      "scripts/package.json",
    ]);
  });

  it("points only to tracked release inputs that exist", () => {
    for (const relativePath of [
      ...RELEASE_WORKSPACE_MANIFEST_PATHS,
      RELEASE_LOCKFILE_PATH,
      RELEASE_PATCHES_PATH,
    ]) {
      expect(existsSync(join(repoRoot, relativePath)), relativePath).toBe(true);
    }
  });
});
