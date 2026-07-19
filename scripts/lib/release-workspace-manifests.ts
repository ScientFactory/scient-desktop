// FILE: release-workspace-manifests.ts
// Purpose: Single source for workspace manifests copied into release staging roots.
// Layer: Release/build helper

export const RELEASE_WORKSPACE_MANIFEST_PATHS = [
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
] as const;

export const RELEASE_LOCKFILE_PATH = "bun.lock";
export const RELEASE_PATCHES_PATH = "patches";

export function createReleaseInstallManifest(contents: string): string {
  const parsed = JSON.parse(contents) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a package manifest JSON object.");
  }

  const manifest: Record<string, unknown> = { ...parsed };
  delete manifest.devDependencies;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
