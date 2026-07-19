// FILE: release-smoke.ts
// Purpose: Smoke-tests release version alignment and merged macOS updater manifests.
// Layer: Release verification script
// Depends on: update-release-package-versions.ts and merge-mac-update-manifests.ts.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCIENT_DESKTOP_UPDATES_ENABLED,
  SCIENT_DESKTOP_UPDATE_CHANNEL,
  SCIENT_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

import { createDesktopPlatformBuildConfig } from "./lib/desktop-platform-build-config.ts";
import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";
import {
  readReleaseUpdatePolicyConfig,
  resolveReleaseUpdatePolicy,
} from "./lib/release-update-policy.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
  cpSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), resolve(targetRoot, RELEASE_LOCKFILE_PATH));
  cpSync(resolve(repoRoot, RELEASE_PATCHES_PATH), resolve(targetRoot, RELEASE_PATCHES_PATH), {
    recursive: true,
  });
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "latest-mac.yml");
  const x64Path = resolve(assetDirectory, "latest-mac-x64.yml");

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Scient-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: Scient-9.9.9-smoke.0-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: Scient-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Scient-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
  - url: Scient-9.9.9-smoke.0-x64.dmg
    sha512: x64dmg
    size: 138148807
path: Scient-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertNotContains(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    throw new Error(message);
  }
}

function verifyCanonicalIdentity(): void {
  const serverPackage = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/server/package.json"), "utf8"),
  ) as { name?: string; bin?: Record<string, string> };
  if (serverPackage.name !== "@scientfactory/cli") {
    throw new Error(
      `Expected CLI package @scientfactory/cli, got ${serverPackage.name ?? "<missing>"}.`,
    );
  }
  if (
    Object.keys(serverPackage.bin ?? {}).length !== 1 ||
    serverPackage.bin?.scient !== "./dist/index.mjs"
  ) {
    throw new Error("Expected the CLI to expose only the scient binary.");
  }
  if (SCIENT_PRODUCTION_BUNDLE_ID !== "com.scientfactory.scient") {
    throw new Error(`Unexpected production bundle ID: ${SCIENT_PRODUCTION_BUNDLE_ID}.`);
  }
  if (SCIENT_DESKTOP_UPDATE_CHANNEL !== "scient") {
    throw new Error(`Unexpected desktop update channel: ${SCIENT_DESKTOP_UPDATE_CHANNEL}.`);
  }
  if (!SCIENT_DESKTOP_UPDATES_ENABLED) {
    throw new Error("Expected packaged Scient clients to use the approved update channel.");
  }

  const linux = createDesktopPlatformBuildConfig({ platform: "linux", target: "AppImage" }).linux;
  if (!linux || linux.executableName !== "scient") {
    throw new Error("Expected Linux desktop releases to install the scient executable.");
  }
  const startupWmClass = (linux.desktop as { entry?: { StartupWMClass?: unknown } } | undefined)
    ?.entry?.StartupWMClass;
  if (startupWmClass !== "scient") {
    throw new Error("Expected Linux desktop releases to use the Scient StartupWMClass.");
  }
  if (linux.syncDesktopName !== true) {
    throw new Error("Expected Linux desktop releases to synchronize the desktop entry name.");
  }

  const releasePolicy = readReleaseUpdatePolicyConfig(repoRoot);
  const resolvedPolicy = resolveReleaseUpdatePolicy("9.9.9", releasePolicy);
  if (
    resolvedPolicy.lane !== "clean" ||
    !resolvedPolicy.makeLatest ||
    resolvedPolicy.mirrorToStableChannel
  ) {
    throw new Error("Expected stable clean Scient releases to publish on GitHub Latest.");
  }
}

function verifyReleaseWorkflowSafety(): void {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
  assertContains(
    workflow,
    "if: ${{ vars.SCIENT_DESKTOP_RELEASES_ENABLED == 'true' }}",
    "Expected desktop release jobs to remain gated until Scient releases are explicitly enabled.",
  );
  assertContains(
    workflow,
    "UPDATE_REPOSITORY: ${{ vars.SCIENT_DESKTOP_UPDATE_REPOSITORY }}",
    "Expected release preflight to require the owned updater repository.",
  );
  assertContains(
    workflow,
    "SCIENT_DESKTOP_UPDATE_REPOSITORY: ${{ needs.preflight.outputs.update_repository }}",
    "Expected artifact builds to receive the verified owned updater repository.",
  );
  assertContains(
    workflow,
    "publish_release:\n        description:",
    "Expected a manual publication opt-in input.",
  );
  assertContains(
    workflow,
    "default: false\n        type: boolean",
    "Expected manual release runs to default to build-only mode.",
  );
  assertContains(
    workflow,
    "publish_release: ${{ steps.release_mode.outputs.publish_release }}",
    "Expected preflight to expose the resolved publication mode.",
  );
  assertContains(
    workflow,
    "if: ${{ needs.preflight.outputs.publish_release == 'true' }}",
    "Expected GitHub publication to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "needs.preflight.outputs.publish_release == 'true' && vars.SCIENT_PUBLISH_CLI == '1'",
    "Expected CLI publication to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "needs.preflight.outputs.publish_release == 'true' && vars.SCIENT_FINALIZE_RELEASE == '1'",
    "Expected release finalization to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "RELEASE_BRANCH: release/stable",
    "Expected public releases to use the protected stable branch.",
  );
  assertContains(
    workflow,
    'if [[ "$GITHUB_SHA" != "$release_branch_sha" ]]',
    "Expected publication to require the exact release/stable head.",
  );
  assertContains(
    workflow,
    "Public macOS releases require all Apple signing and notarization secrets.",
    "Expected public macOS releases to fail closed without signing and notarization.",
  );
  assertContains(
    workflow,
    "Public Windows releases require all Azure Trusted Signing secrets.",
    "Expected public Windows releases to fail closed without signing.",
  );
  assertContains(
    workflow,
    'node scripts/update-release-package-versions.ts "${{ needs.preflight.outputs.version }}"\n          bun install --lockfile-only --ignore-scripts',
    "Expected every native builder to refresh the lock after release version alignment.",
  );
  assertContains(
    workflow,
    "Verify public download contract",
    "Expected the release workflow to validate every public platform download.",
  );
  assertContains(
    workflow,
    '"Scient-${RELEASE_VERSION}-x86_64.AppImage"',
    "Expected the public contract to validate the Linux AppImage filename.",
  );
  assertContains(
    workflow,
    "release-assets/SHA256SUMS.txt",
    "Expected releases to publish a SHA-256 checksum manifest.",
  );
}

function verifyDesktopStageLockAuthority(): void {
  const buildScript = readFileSync(resolve(repoRoot, "scripts/build-desktop-artifact.ts"), "utf8");
  assertContains(
    buildScript,
    "bun install --production --frozen-lockfile --ignore-scripts --linker hoisted --filter @scientfactory/cli --filter @synara/desktop",
    "Expected desktop staging to install only from the repository's frozen workspace lockfile.",
  );
  assertNotContains(
    buildScript,
    ")`bun install --production`,",
    "Desktop staging must not retain the fresh production install path.",
  );
  assertContains(
    buildScript,
    '"scripts",\n    "node_modules",\n    ".bin",',
    "Expected packaging to use the pinned scripts-workspace electron-builder executable.",
  );
  assertContains(
    buildScript,
    "prepareStagedLinuxNodePty",
    "Expected Linux release staging to rebuild only the pinned node-pty native dependency.",
  );
  assertContains(
    buildScript,
    '"node-gyp",\n    "bin",\n    "node-gyp.js",',
    "Expected Linux node-pty staging to use the scripts-workspace node-gyp executable.",
  );
}

function readPackageVersion(root: string, relativePath: string): string {
  const packageJson = JSON.parse(readFileSync(resolve(root, relativePath), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`Expected ${relativePath} to declare a package version.`);
  }
  return packageJson.version;
}

function verifyFrozenDesktopStageInstall(targetRoot: string): void {
  execFileSync(
    "bun",
    [
      "install",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--linker",
      "hoisted",
      "--filter",
      "@scientfactory/cli",
      "--filter",
      "@synara/desktop",
    ],
    { cwd: targetRoot, stdio: "inherit" },
  );

  const packagePairs = [
    ["node_modules/electron/package.json", "apps/desktop/node_modules/electron/package.json"],
    ["node_modules/ws/package.json", "apps/server/node_modules/ws/package.json"],
    ["node_modules/@pierre/diffs/package.json", "apps/web/node_modules/@pierre/diffs/package.json"],
  ] as const;
  for (const [stagedPath, workspacePath] of packagePairs) {
    const stagedVersion = readPackageVersion(targetRoot, stagedPath);
    const workspaceVersion = readPackageVersion(repoRoot, workspacePath);
    if (stagedVersion !== workspaceVersion) {
      throw new Error(
        `Frozen stage resolved ${stagedPath} at ${stagedVersion}; expected locked workspace version ${workspaceVersion}.`,
      );
    }
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "scient-release-smoke-"));

try {
  verifyCanonicalIdentity();
  verifyReleaseWorkflowSafety();
  verifyDesktopStageLockAuthority();
  copyWorkspaceManifestFixture(tempRoot);
  verifyFrozenDesktopStageInstall(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });
  verifyFrozenDesktopStageInstall(tempRoot);

  const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
  assertContains(
    lockfile,
    `"version": "9.9.9-smoke.0"`,
    "Expected bun.lock to contain the smoke version.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  execFileSync(
    process.execPath,
    [resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"), arm64Path, x64Path],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "Scient-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "Scient-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
