// FILE: release-smoke.ts
// Purpose: Smoke-tests release version alignment and merged macOS updater manifests.
// Layer: Release verification script
// Depends on: update-release-package-versions.ts and merge-mac-update-manifests.ts.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  SCIENT_DESKTOP_UPDATES_ENABLED,
  SCIENT_DESKTOP_UPDATE_CHANNEL,
  SCIENT_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

import { createDesktopPlatformBuildConfig } from "./lib/desktop-platform-build-config.ts";
import { resolvePinnedElectronBuilder } from "./lib/electron-builder-authority.ts";
import {
  createReleaseInstallManifest,
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
    writeFileSync(destinationPath, createReleaseInstallManifest(readFileSync(sourcePath, "utf8")));
  }
  cpSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), resolve(targetRoot, RELEASE_LOCKFILE_PATH));
  cpSync(resolve(repoRoot, RELEASE_PATCHES_PATH), resolve(targetRoot, RELEASE_PATCHES_PATH), {
    recursive: true,
  });
}

function writeMacManifestFixtures(targetRoot: string): {
  arm64Path: string;
  x64Path: string;
} {
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

function assertNotMatches(haystack: string, pattern: RegExp, message: string): void {
  if (pattern.test(haystack)) {
    throw new Error(message);
  }
}

function verifyReleaseRepositoryPolicy(): void {
  const lockfileAttributes = execFileSync(
    "git",
    ["check-attr", "text", "eol", "--", RELEASE_LOCKFILE_PATH],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  )
    .replaceAll("\r\n", "\n")
    .trim();
  const expectedAttributes = [
    `${RELEASE_LOCKFILE_PATH}: text: set`,
    `${RELEASE_LOCKFILE_PATH}: eol: lf`,
  ].join("\n");
  if (lockfileAttributes !== expectedAttributes) {
    throw new Error(
      `Expected Git to resolve ${RELEASE_LOCKFILE_PATH} as text with LF endings; got:\n${lockfileAttributes}`,
    );
  }
}

interface ReleaseWorkflowStep {
  readonly env?: Record<string, unknown>;
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

function assertScopedSigningEnvironment(
  step: ReleaseWorkflowStep,
  expectedNames: ReadonlyArray<string>,
  forbiddenNames: ReadonlyArray<string>,
): void {
  const environment = step.env ?? {};
  for (const name of expectedNames) {
    if (!(name in environment)) {
      throw new Error(`Expected ${step.name} to receive ${name}.`);
    }
  }
  for (const name of forbiddenNames) {
    if (name in environment) {
      throw new Error(`${step.name} must not receive ${name}.`);
    }
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

  const linux = createDesktopPlatformBuildConfig({
    platform: "linux",
    target: "AppImage",
  }).linux;
  if (!linux || linux.executableName !== "scient") {
    throw new Error("Expected Linux desktop releases to install the scient executable.");
  }
  if (!Array.isArray(linux.executableArgs) || linux.executableArgs.length !== 0) {
    throw new Error("Expected Linux desktop entries to preserve Electron's sandbox.");
  }
  const requireFromElectronBuilder = createRequire(
    realpathSync(resolve(repoRoot, "node_modules/electron-builder/package.json")),
  );
  const appImageLauncherGenerator = readFileSync(
    requireFromElectronBuilder.resolve("app-builder-lib/out/targets/appimage/appImageUtil.js"),
    "utf8",
  );
  assertNotContains(
    appImageLauncherGenerator,
    "--no-sandbox",
    "The installed AppImage launcher generator must not disable Electron's sandbox.",
  );
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
  const workflow = readFileSync(
    resolve(repoRoot, ".github/workflows/release.yml"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const ciWorkflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const releaseBuildScript = readFileSync(
    resolve(repoRoot, "scripts/build-release-desktop-artifact.sh"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const notarizationHelper = readFileSync(
    resolve(repoRoot, "scripts/lib/mac-notarization.cjs"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const parsedWorkflow = parseYaml(workflow) as {
    permissions?: Record<string, string>;
    jobs?: {
      build?: {
        permissions?: Record<string, string>;
        steps?: Array<ReleaseWorkflowStep>;
        strategy?: { matrix?: { include?: Array<Record<string, unknown>> } };
      };
      preflight?: { steps?: Array<ReleaseWorkflowStep> };
      publish_cli?: { permissions?: Record<string, string> };
      release?: { permissions?: Record<string, string> };
    };
  };
  const parsedCiWorkflow = parseYaml(ciWorkflow) as {
    jobs?: { windows_process?: { steps?: Array<ReleaseWorkflowStep> } };
  };
  const windowsProcessSteps = parsedCiWorkflow.jobs?.windows_process?.steps ?? [];
  const windowsLauncherTest = windowsProcessSteps.find(
    (step) => step.name === "Test packaged startup Windows launcher",
  );
  if (
    windowsLauncherTest?.run !== "bun x vitest run scripts/verify-packaged-desktop-startup.test.ts"
  ) {
    throw new Error(
      "Expected Windows CI to compile and exercise packaged-startup Job launcher authority and cancellation.",
    );
  }
  const buildSteps = parsedWorkflow.jobs?.build?.steps ?? [];
  const buildMatrix = parsedWorkflow.jobs?.build?.strategy?.matrix?.include ?? [];
  const preflightSteps = parsedWorkflow.jobs?.preflight?.steps ?? [];
  const buildPermissions = parsedWorkflow.jobs?.build?.permissions ?? {};
  const buildCheckout = buildSteps.find((step) => step.name === "Checkout");
  const requiredNativeBuildMatrix = [
    {
      label: "macOS arm64",
      runner: "macos-14",
      platform: "mac",
      target: "dmg",
      arch: "arm64",
      timeout_minutes: 120,
    },
    {
      label: "macOS x64",
      runner: "macos-15-intel",
      platform: "mac",
      target: "dmg",
      arch: "x64",
      timeout_minutes: 120,
    },
    {
      label: "Linux x64",
      runner: "ubuntu-24.04",
      platform: "linux",
      target: "AppImage",
      arch: "x64",
      timeout_minutes: 30,
    },
    {
      label: "Windows x64",
      runner: "windows-2022",
      platform: "win",
      target: "nsis",
      arch: "x64",
      timeout_minutes: 30,
    },
  ];
  if (
    parsedWorkflow.permissions?.contents !== "read" ||
    Object.keys(parsedWorkflow.permissions ?? {}).length !== 1 ||
    buildPermissions.contents !== "read" ||
    "id-token" in buildPermissions ||
    buildCheckout?.with?.["persist-credentials"] !== false ||
    parsedWorkflow.jobs?.publish_cli?.permissions?.["id-token"] !== "write" ||
    parsedWorkflow.jobs?.release?.permissions?.contents !== "write"
  ) {
    throw new Error(
      "Expected native payload execution to have read-only contents, no OIDC, and no persisted checkout credential.",
    );
  }
  if (JSON.stringify(buildMatrix) !== JSON.stringify(requiredNativeBuildMatrix)) {
    throw new Error(
      "Expected the exact macOS arm64, macOS x64, Linux x64, and Windows x64 native release matrix and runners.",
    );
  }
  const requireBuildStep = (name: string) => {
    const step = buildSteps.find((candidate) => candidate.name === name);
    if (!step) {
      throw new Error(`Expected release workflow build step: ${name}.`);
    }
    return step;
  };
  const macBuildStep = requireBuildStep("Build macOS desktop artifact");
  const linuxBuildStep = requireBuildStep("Build Linux desktop artifact");
  const windowsBuildStep = requireBuildStep("Build Windows desktop artifact");
  const releaseMetaIndex = preflightSteps.findIndex(
    (step) => step.name === "Resolve release policy",
  );
  const publicationSourceIndex = preflightSteps.findIndex(
    (step) => step.name === "Verify publication source",
  );
  const installDependenciesIndex = preflightSteps.findIndex(
    (step) => step.name === "Install dependencies",
  );
  const releaseNoteIndex = preflightSteps.findIndex(
    (step) => step.name === "Verify release-note catalog structure",
  );
  if (
    publicationSourceIndex < 0 ||
    installDependenciesIndex <= publicationSourceIndex ||
    installDependenciesIndex >= releaseMetaIndex
  ) {
    throw new Error(
      "Expected release dependencies to install only after publication-source verification and before release policy resolution.",
    );
  }
  if (releaseMetaIndex < 0 || releaseNoteIndex !== releaseMetaIndex + 1) {
    throw new Error(
      "Expected the structural release-note gate immediately after release policy resolution.",
    );
  }
  if (
    !preflightSteps[releaseNoteIndex]?.run?.includes(
      'scripts/verify-release-notes.ts "${{ steps.release_meta.outputs.version }}"',
    )
  ) {
    throw new Error("Expected the release-note gate to verify the exact resolved version.");
  }
  const collectAssetsIndex = buildSteps.findIndex((step) => step.name === "Collect release assets");
  const packagedStartupIndex = buildSteps.findIndex(
    (step) => step.name === "Smoke exact packaged desktop startup",
  );
  const uploadArtifactsIndex = buildSteps.findIndex(
    (step) => step.name === "Upload build artifacts",
  );
  const packagedStartupStep = buildSteps[packagedStartupIndex];
  if (
    collectAssetsIndex < 0 ||
    packagedStartupIndex <= collectAssetsIndex ||
    uploadArtifactsIndex <= packagedStartupIndex ||
    packagedStartupStep?.if !== "${{ matrix.platform != 'linux' }}" ||
    !packagedStartupStep.run?.includes("node scripts/verify-packaged-desktop-startup.ts") ||
    !packagedStartupStep.run.includes("--assets-dir release-publish") ||
    !packagedStartupStep.run.includes('--commit "${{ github.sha }}"') ||
    !packagedStartupStep.run.includes(
      "--allow-unsigned-windows \"${{ steps.build_windows.outputs.windows_signed != 'true' }}\"",
    ) ||
    !packagedStartupStep.run.includes(
      '--windows-publisher-subject "$SCIENT_WINDOWS_PUBLISHER_SUBJECT"',
    ) ||
    packagedStartupStep.env?.SCIENT_WINDOWS_PUBLISHER_SUBJECT !==
      "${{ vars.SCIENT_WINDOWS_PUBLISHER_SUBJECT }}" ||
    packagedStartupStep.run.includes("${{ vars.SCIENT_WINDOWS_PUBLISHER_SUBJECT }}")
  ) {
    throw new Error(
      "Expected exact macOS and Windows packaged-startup proof after collection and before upload.",
    );
  }
  const packagedDiagnosticsIndex = buildSteps.findIndex(
    (step) => step.name === "Upload packaged startup failure diagnostics",
  );
  const packagedDiagnosticsStep = buildSteps[packagedDiagnosticsIndex];
  if (
    packagedDiagnosticsIndex !== packagedStartupIndex + 1 ||
    packagedDiagnosticsStep?.if !== "${{ failure() && matrix.platform != 'linux' }}" ||
    packagedDiagnosticsStep.uses !==
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
    packagedDiagnosticsStep.with?.path !== "packaged-startup-diagnostics/*"
  ) {
    throw new Error(
      "Expected bounded packaged-startup failure diagnostics to upload from native runners.",
    );
  }
  const packagedStartupVerifier = readFileSync(
    resolve(repoRoot, "scripts/verify-packaged-desktop-startup.ts"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const posixStartupSentinel = readFileSync(
    resolve(repoRoot, "scripts/lib/packaged-startup-posix-sentinel.mjs"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const windowsStartupJobLauncher = readFileSync(
    resolve(repoRoot, "scripts/lib/packaged-startup-windows-job.ps1"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", 'import("./scripts/verify-packaged-desktop-startup.ts")'],
    { cwd: repoRoot, stdio: "pipe" },
  );
  const desktopMain = readFileSync(
    resolve(repoRoot, "apps/desktop/src/main.ts"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const webMain = readFileSync(resolve(repoRoot, "apps/web/src/main.tsx"), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const webRendererReadiness = readFileSync(
    resolve(repoRoot, "apps/web/src/lib/packagedStartupRendererReadiness.ts"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const webRootRoute = readFileSync(
    resolve(repoRoot, "apps/web/src/routes/__root.tsx"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const rendererReadiness = readFileSync(
    resolve(repoRoot, "apps/desktop/src/packagedStartupRendererReadiness.ts"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  assertContains(
    desktopMain,
    "const FULL_COMMIT_HASH_PATTERN = /^[0-9a-f]{40}$/i;",
    "Expected packaged startup identity to accept only a complete embedded commit.",
  );
  assertContains(
    desktopMain,
    "packaged identity name=${app.getName()} version=${app.getVersion()} commit=${commit}",
    "Expected the running packaged app to expose its exact embedded identity to the verifier.",
  );
  if (
    desktopMain.indexOf("configureAppIdentity();", desktopMain.indexOf("app.whenReady()")) < 0 ||
    desktopMain.indexOf("configureAppIdentity();", desktopMain.indexOf("app.whenReady()")) >
      desktopMain.indexOf(
        "writePackagedStartupSmokeIdentity();",
        desktopMain.indexOf("app.whenReady()"),
      )
  ) {
    throw new Error(
      "Expected Scient runtime identity to be configured before smoke identity proof.",
    );
  }
  assertContains(
    webRendererReadiness,
    "await input.hydrateShell();",
    "Expected packaged startup readiness to wait for authoritative shell hydration.",
  );
  assertContains(
    webRootRoute,
    "hydrateShellForPackagedStartupRenderer",
    "Expected the server-welcome router lifecycle to own packaged renderer readiness.",
  );
  assertContains(
    webRendererReadiness,
    "input.state.generation !== generation",
    "Expected renderer readiness to reject stale reconnect hydration generations.",
  );
  assertContains(
    webRootRoute,
    "disposePackagedStartupRendererReadiness(packagedStartupRendererReadiness)",
    "Expected router disposal to invalidate pending renderer readiness.",
  );
  assertNotContains(
    webMain,
    "scientRendererReady",
    "The renderer entrypoint must not certify readiness before its preload and server lifecycle complete.",
  );
  assertContains(
    rendererReadiness,
    "document.documentElement.dataset.scientRendererReady === 'true'",
    "Expected packaged startup proof to reject a renderer that never committed React.",
  );
  assertContains(
    packagedStartupVerifier,
    "SCIENT_HOME: scientHome",
    "Expected packaged startup verification to isolate Scient state.",
  );
  assertContains(
    packagedStartupVerifier,
    'SYNARA_TELEMETRY_ENABLED: "false"',
    "Expected packaged startup verification to disable production telemetry.",
  );
  assertContains(
    packagedStartupVerifier,
    'SCIENT_DISABLE_SHELL_ENV_SYNC: "1"',
    "Expected packaged startup verification to prevent host environment rehydration.",
  );
  assertContains(
    packagedStartupVerifier,
    "PACKAGED_SMOKE_INHERITED_ENVIRONMENT_ALLOWLIST",
    "Expected packaged startup verification to inherit only explicit host variables.",
  );
  assertContains(
    packagedStartupVerifier,
    "spawnContainedPackagedDesktop",
    "Expected native startup proof to launch inside verifier-owned OS containment.",
  );
  assertNotContains(
    packagedStartupVerifier,
    "taskkill",
    "Packaged startup cleanup must not restore numeric Windows process signaling authority.",
  );
  assertContains(
    windowsStartupJobLauncher,
    "Add-Type -Path $AssemblyPath",
    "Expected runtime Windows launch to load the assembly compiled during preparation.",
  );
  if (
    windowsStartupJobLauncher.indexOf("Add-Type -TypeDefinition $source") < 0 ||
    windowsStartupJobLauncher.indexOf("Add-Type -TypeDefinition $source") >
      windowsStartupJobLauncher.indexOf("exit 0") ||
    windowsStartupJobLauncher.indexOf("exit 0") >
      windowsStartupJobLauncher.indexOf("Add-Type -Path $AssemblyPath")
  ) {
    throw new Error(
      "Expected Windows launcher compilation to exit in preparation before runtime Job launch.",
    );
  }
  assertContains(
    posixStartupSentinel,
    'process.on("SIGTERM", () => beginSentinelOwnedShutdown(false))',
    "Expected the POSIX sentinel to own graceful process-group cleanup.",
  );
  assertContains(
    posixStartupSentinel,
    "process.ppid !== verifierParentPid",
    "Expected the POSIX sentinel to terminate its group when its verifier parent dies.",
  );
  assertContains(
    windowsStartupJobLauncher,
    "OpenProcess(SYNCHRONIZE, false, verifierProcessId)",
    "Expected Windows startup containment to retain a verifier process handle.",
  );
  if (
    windowsStartupJobLauncher.indexOf("OpenProcess(SYNCHRONIZE, false, verifierProcessId)") < 0 ||
    windowsStartupJobLauncher.indexOf("OpenProcess(SYNCHRONIZE, false, verifierProcessId)") >
      windowsStartupJobLauncher.indexOf("if (!CreateProcess(")
  ) {
    throw new Error("Expected Windows verifier liveness authority before payload creation.");
  }
  assertContains(
    windowsStartupJobLauncher,
    "WaitForMultipleObjects(2, livenessHandles, false, INFINITE)",
    "Expected Windows Job cleanup to observe verifier death as well as payload exit.",
  );
  assertContains(
    windowsStartupJobLauncher,
    "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
    "Expected Windows startup proof to use kill-on-close Job Object containment.",
  );
  assertContains(
    windowsStartupJobLauncher,
    "PROC_THREAD_ATTRIBUTE_JOB_LIST",
    "Expected Windows startup proof to assign the native process to its Job Object atomically at creation.",
  );
  assertNotContains(
    windowsStartupJobLauncher,
    "AssignProcessToJobObject",
    "Windows startup proof must not restore a pre-containment process-creation window.",
  );
  if (
    windowsStartupJobLauncher.indexOf("if (!UpdateProcThreadAttribute(") < 0 ||
    windowsStartupJobLauncher.indexOf("if (!UpdateProcThreadAttribute(") >
      windowsStartupJobLauncher.indexOf("if (!CreateProcess(") ||
    windowsStartupJobLauncher.indexOf("if (!CreateProcess(") >
      windowsStartupJobLauncher.indexOf("ResumeThread(child.hThread)")
  ) {
    throw new Error(
      "Expected Windows startup proof to create Electron atomically inside the Job Object before resume.",
    );
  }
  assertContains(
    packagedStartupVerifier,
    'log.includes("packaged main window visible")',
    "Expected packaged startup proof to require a visible native window.",
  );
  assertContains(
    packagedStartupVerifier,
    'log.includes("renderer main frame loaded")',
    "Expected packaged startup proof to require successful renderer loading.",
  );
  assertContains(
    packagedStartupVerifier,
    'log.includes("backend semantic ready generation=")',
    "Expected packaged startup proof to require semantic backend readiness.",
  );
  assertContains(
    packagedStartupVerifier,
    'log.includes("packaged responsiveness confirmed generation=")',
    "Expected packaged startup proof to require delayed active renderer and backend responsiveness.",
  );
  assertContains(
    packagedStartupVerifier,
    "packaged identity name=Scient version=${expected.version} commit=${expected.commit}",
    "Expected packaged startup proof to bind the running product, version, and commit.",
  );
  assertContains(
    packagedStartupVerifier,
    '!log.includes("renderer main window unresponsive")',
    "Expected packaged startup proof to reject an unresponsive renderer process.",
  );
  assertNotContains(
    packagedStartupVerifier,
    '"linux" | "mac" | "win"',
    "The extracted startup verifier must not absorb deferred Linux packaging policy.",
  );
  const appleSigningNames = [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ];
  const windowsSigningNames = [
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TRUSTED_SIGNING_ENDPOINT",
    "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
    "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
    "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
  ];
  if (macBuildStep.if !== "matrix.platform == 'mac'") {
    throw new Error("Expected macOS signing credentials to be gated to macOS builders.");
  }
  if (linuxBuildStep.if !== "matrix.platform == 'linux'") {
    throw new Error("Expected the unsigned Linux build to be gated to Linux builders.");
  }
  if (windowsBuildStep.if !== "matrix.platform == 'win'") {
    throw new Error("Expected Windows signing credentials to be gated to Windows builders.");
  }
  if (windowsBuildStep.id !== "build_windows") {
    throw new Error("Expected Windows packaging to expose its actual signing mode.");
  }
  assertScopedSigningEnvironment(macBuildStep, appleSigningNames, windowsSigningNames);
  assertScopedSigningEnvironment(windowsBuildStep, windowsSigningNames, appleSigningNames);
  assertScopedSigningEnvironment(
    linuxBuildStep,
    [],
    [...appleSigningNames, ...windowsSigningNames],
  );
  const expectedSigningStep = new Map<string, string>([
    ...appleSigningNames.map((name) => [name, macBuildStep.name ?? ""] as const),
    ...windowsSigningNames.map((name) => [name, windowsBuildStep.name ?? ""] as const),
  ]);
  for (const step of buildSteps) {
    for (const name of [...appleSigningNames, ...windowsSigningNames]) {
      if (name in (step.env ?? {}) && step.name !== expectedSigningStep.get(name)) {
        throw new Error(`${step.name ?? "Unnamed build step"} must not receive ${name}.`);
      }
    }
  }
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
    releaseBuildScript,
    "Public macOS releases require all Apple signing and notarization secrets.",
    "Expected public macOS releases to fail closed without signing and notarization.",
  );
  const macReleasePolicy = releaseBuildScript.slice(
    releaseBuildScript.indexOf('if [[ "$platform" == "mac" ]]'),
    releaseBuildScript.indexOf('elif [[ "$platform" == "win" ]]'),
  );
  assertNotContains(
    macReleasePolicy,
    "ALLOW_UNSIGNED_RELEASE",
    "Public macOS releases must not expose an unsigned publication bypass.",
  );
  assertContains(
    workflow,
    "timeout-minutes: ${{ matrix.timeout_minutes }}",
    "Expected platform-specific release timeouts.",
  );
  assertContains(
    workflow,
    "timeout_minutes: 120",
    "Expected macOS signing and notarization to tolerate bounded Apple service delays.",
  );
  assertContains(
    workflow,
    "name: Upload macOS notarization evidence",
    "Expected macOS builders to preserve notarization evidence even when packaging fails.",
  );
  assertContains(
    workflow,
    "path: release/notarization-*.json",
    "Expected macOS builders to upload Apple submission evidence and logs.",
  );
  assertContains(
    workflow,
    "verify_published_macos:",
    "Expected public macOS DMGs to be independently downloaded and verified.",
  );
  assertContains(
    workflow,
    'gh release download "$RELEASE_TAG"',
    "Expected post-publication checks to download the public release artifact.",
  );
  assertContains(
    workflow,
    "bun scripts/verify-mac-release-artifact.ts published-macos",
    "Expected post-publication checks to validate the delivered macOS identity.",
  );
  assertContains(
    notarizationHelper,
    '"--no-wait"',
    "Expected notarization to capture Apple's submission ID before polling.",
  );
  assertNotContains(
    notarizationHelper,
    '"--wait"',
    "Controlled notarization must not return to Apple's opaque wait mode.",
  );
  assertContains(
    notarizationHelper,
    "processingMs: 90 * 60 * 1000",
    "Expected Apple processing to have an inner deadline below the macOS job limit.",
  );
  assertContains(
    notarizationHelper,
    'args: ["notarytool", "info", submissionId',
    "Expected notarization to poll Apple explicitly.",
  );
  assertContains(
    notarizationHelper,
    'args: ["notarytool", "log", submissionId',
    "Expected notarization to preserve Apple's completed submission log.",
  );
  assertNotContains(
    releaseBuildScript,
    "max_attempts=3",
    "macOS release builds must not retry the whole notarization workflow.",
  );
  assertContains(
    releaseBuildScript,
    'chmod 600 "$apple_key_path"',
    "Expected the temporary Apple API key to have owner-only permissions.",
  );
  assertContains(
    releaseBuildScript,
    "trap cleanup_sensitive_files EXIT",
    "Expected the temporary Apple API key to be removed when the build exits.",
  );
  assertContains(
    workflow,
    "WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}",
    "Expected the release workflow to accept a standard Windows signing certificate.",
  );
  assertContains(
    releaseBuildScript,
    "Public Windows releases require a standard Authenticode certificate or Azure Trusted Signing.",
    "Expected public Windows releases to fail closed without signing.",
  );
  assertContains(
    releaseBuildScript,
    'printf \'windows_signed=%s\\n\' "$windows_signed" >> "$GITHUB_OUTPUT"',
    "Expected Windows packaging to report whether the produced artifact was signed.",
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
    "Verify Linux AppImage sandbox policy",
    "Expected the release workflow to inspect the packaged Linux launcher.",
  );
  assertContains(
    workflow,
    "grep -F -- '--no-sandbox' \"$launcher\"",
    "Expected the release workflow to reject AppImages that disable Electron's sandbox.",
  );
  assertContains(
    workflow,
    "release-assets/SHA256SUMS.txt",
    "Expected releases to publish a SHA-256 checksum manifest.",
  );
  assertContains(
    workflow,
    'node scripts/update-release-package-versions.ts "${{ needs.preflight.outputs.version }}"\n          bun install --lockfile-only --ignore-scripts',
    "Expected artifact builds to refresh lockfile metadata after aligning workspace versions.",
  );
}

function verifyDesktopStageLockAuthority(): void {
  const buildScript = readFileSync(
    resolve(repoRoot, "scripts/build-desktop-artifact.ts"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  assertContains(
    buildScript,
    'spawnSync("git", ["rev-parse", "HEAD"]',
    "Expected packaged release metadata to embed the complete source commit.",
  );
  assertContains(
    buildScript,
    "scientCommitHash: commitHash",
    "Expected the complete source commit to cross the desktop staging boundary.",
  );
  assertNotContains(
    buildScript,
    '"--short=12"',
    "Packaged release metadata must not truncate the commit required by exact-payload proof.",
  );
  assertContains(
    buildScript,
    "bun install --omit dev --ignore-scripts --linker hoisted --filter @scientfactory/cli --filter @synara/desktop",
    "Expected desktop staging to materialize its production workspace from the repository lockfile.",
  );
  assertContains(
    buildScript,
    "Bun 1.3.12 makes --production implicitly frozen.",
    "Expected desktop lock materialization to document why it uses the equivalent omit-dev scope.",
  );
  assertContains(
    buildScript,
    "bun install --production --frozen-lockfile --ignore-scripts --linker hoisted --filter @scientfactory/cli --filter @synara/desktop",
    "Expected desktop staging to install only from its repository-derived frozen lock projection.",
  );
  assertContains(
    buildScript,
    'path.join(stageAppDir, "node_modules", "node-pty")',
    "Expected desktop staging to run only the required node-pty native install lifecycle.",
  );
  assertNotContains(
    buildScript,
    ")`bun install --production`,",
    "Desktop staging must not retain the fresh production install path.",
  );
  assertContains(
    buildScript,
    "resolvePinnedElectronBuilder(repoRoot).cliPath",
    "Expected desktop packaging to resolve electron-builder through the authority guard.",
  );
  assertContains(
    buildScript,
    "`${process.execPath} ${electronBuilderCli}",
    "Expected desktop packaging to invoke electron-builder through Node.",
  );
  assertContains(
    buildScript,
    "Pinned electron-builder CLI could not be resolved within repository dependency authority.",
    "Expected desktop packaging to fail closed when electron-builder cannot be resolved.",
  );
  assertContains(
    buildScript,
    "Pinned electron-builder CLI was not found at ${electronBuilderCli}",
    "Expected desktop packaging to fail closed when the resolved CLI is absent.",
  );
  assertNotContains(
    buildScript,
    'path.join(repoRoot, "node_modules", "electron-builder", "cli.js")',
    "Desktop packaging must not assume electron-builder is hoisted to the root node_modules directory.",
  );
  assertNotContains(
    buildScript,
    "electron-builder.cmd",
    "Desktop packaging must not depend on a platform-specific Windows bin shim.",
  );
  assertNotMatches(
    buildScript,
    /const electronBuilder\w* = path\.join\([\s\S]{0,240}?["']\.bin["']/,
    "Desktop packaging must not depend on a hard-coded electron-builder bin directory.",
  );
  assertContains(
    buildScript,
    "prepareStagedNodePty",
    "Expected every release target to prepare the pinned node-pty native dependency.",
  );
  assertContains(
    buildScript,
    ")`bun run install`,",
    "Expected node-pty staging to run its pinned install and postinstall lifecycle.",
  );
  const signingIsolationIndex = buildScript.indexOf("isolateDesktopSigningEnvironment(");
  const firstBuildSubprocessIndex = buildScript.indexOf(")`bun run build:desktop`,");
  if (
    signingIsolationIndex === -1 ||
    firstBuildSubprocessIndex === -1 ||
    signingIsolationIndex > firstBuildSubprocessIndex
  ) {
    throw new Error(
      "Expected desktop signing credentials to be removed before the first build subprocess.",
    );
  }
  assertContains(
    buildScript,
    "...signingEnvironment",
    "Expected signing credentials to be restored only for the electron-builder environment.",
  );
  const rootPackage = readFileSync(resolve(repoRoot, "package.json"), "utf8");
  assertContains(
    rootPackage,
    '"node-gyp": "12.4.0"',
    "Expected native compiler tooling to be pinned.",
  );

  const rootPackageJson = JSON.parse(rootPackage) as {
    devDependencies?: Record<string, unknown>;
  };
  const scriptsPackageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "scripts/package.json"), "utf8"),
  ) as { devDependencies?: Record<string, unknown> };
  const rootElectronBuilderPin = rootPackageJson.devDependencies?.["electron-builder"];
  const scriptsElectronBuilderPin = scriptsPackageJson.devDependencies?.["electron-builder"];
  if (
    typeof scriptsElectronBuilderPin !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(scriptsElectronBuilderPin) ||
    rootElectronBuilderPin !== scriptsElectronBuilderPin
  ) {
    throw new Error(
      "Expected root and scripts workspaces to use the same exact electron-builder version pin.",
    );
  }

  const resolvedElectronBuilder = resolvePinnedElectronBuilder(repoRoot);
  if (resolvedElectronBuilder.version !== scriptsElectronBuilderPin) {
    throw new Error(
      `Expected scripts/package.json to resolve electron-builder ${scriptsElectronBuilderPin}, got ${resolvedElectronBuilder.version} from ${resolvedElectronBuilder.cliPath}.`,
    );
  }
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

function verifyFrozenDesktopStageInstall(targetRoot: string, verifyNative = false): void {
  execFileSync(
    "bun",
    [
      "install",
      "--omit",
      "dev",
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

  if (!verifyNative) return;

  const stagedNodePtyDir = resolve(targetRoot, "node_modules/node-pty");
  const nativeEnv = {
    ...process.env,
    PATH: `${resolve(repoRoot, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  execFileSync("bun", ["run", "install"], {
    cwd: stagedNodePtyDir,
    env: nativeEnv,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [resolve(repoRoot, "scripts/node-pty-smoke.mjs")], {
    cwd: targetRoot,
    env: {
      ...process.env,
      SYNARA_NODE_PTY_SMOKE_REQUIRE_ROOT: targetRoot,
    },
    stdio: "inherit",
  });
}

const tempRoot = mkdtempSync(join(tmpdir(), "scient-release-smoke-"));

try {
  verifyReleaseRepositoryPolicy();
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
  verifyFrozenDesktopStageInstall(tempRoot, true);

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
