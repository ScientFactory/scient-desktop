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

import { DESKTOP_STAGE_DEPENDENCY_OVERRIDES } from "./lib/desktop-stage-dependency-overrides.ts";
import { createDesktopPlatformBuildConfig } from "./lib/desktop-platform-build-config.ts";
import {
  readReleaseUpdatePolicyConfig,
  resolveReleaseUpdatePolicy,
} from "./lib/release-update-policy.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspaceFiles = [
  "package.json",
  "bun.lock",
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

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
  cpSync(resolve(repoRoot, "patches"), resolve(targetRoot, "patches"), { recursive: true });
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

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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
  if (SCIENT_DESKTOP_UPDATES_ENABLED) {
    throw new Error(
      "Release publication must not implicitly enable desktop clients; a reviewed code change is required.",
    );
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
    "Windows signing is optional; building an unsigned installer",
    "Expected Windows releases to support unsigned installers when signing is unavailable.",
  );
}

function verifyDesktopStageProductionInstall(targetRoot: string): void {
  const stageInstallRoot = resolve(targetRoot, "desktop-stage-install");
  mkdirSync(stageInstallRoot, { recursive: true });

  writeJsonFile(resolve(stageInstallRoot, "package.json"), {
    private: true,
    dependencies: {
      "@pierre/diffs": "^1.1.0-beta.16",
    },
    overrides: DESKTOP_STAGE_DEPENDENCY_OVERRIDES,
  });

  execFileSync("bun", ["install", "--production"], {
    cwd: stageInstallRoot,
    stdio: "inherit",
  });

  const diffsPackageJson = JSON.parse(
    readFileSync(resolve(stageInstallRoot, "node_modules/@pierre/diffs/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const themePackageJson = JSON.parse(
    readFileSync(resolve(stageInstallRoot, "node_modules/@pierre/theme/package.json"), "utf8"),
  ) as { version?: string };
  const expectedThemeVersion = diffsPackageJson.dependencies?.["@pierre/theme"];
  if (!expectedThemeVersion || themePackageJson.version !== expectedThemeVersion) {
    throw new Error(
      `Expected @pierre/theme ${expectedThemeVersion ?? "<missing>"} for @pierre/diffs, got ${themePackageJson.version ?? "<missing>"}.`,
    );
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "scient-release-smoke-"));

try {
  verifyCanonicalIdentity();
  verifyReleaseWorkflowSafety();
  copyWorkspaceManifestFixture(tempRoot);

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

  verifyDesktopStageProductionInstall(tempRoot);

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
