// FILE: check-brand-identity.ts
// Purpose: Prevents retired first-party identities from returning to tracked files.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const retiredShortName = characters(116, 51);
const retiredFirstName = `${retiredShortName}${characters(99, 111, 100, 101)}`;
const retiredCompanyName = `${retiredShortName}${characters(116, 111, 111, 108, 115)}`;
const retiredSecondName = characters(100, 112, 99, 111, 100, 101);
const retiredPredecessorName = characters(99, 111, 100, 101, 116, 104, 105, 110, 103);
const retiredPapiLabName = characters(112, 97, 112, 105, 108, 97, 98);
const incorrectBundleDomain = characters(99, 111, 109, 46, 115, 121, 110, 97, 114, 97);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const joinedWithOptionalSeparator = (left: string, right: string): string =>
  `${escapeRegExp(left)}[\\s._/@:-]*${escapeRegExp(right)}`;

const forbiddenPatterns = [
  new RegExp(
    joinedWithOptionalSeparator(retiredShortName, retiredFirstName.slice(retiredShortName.length)),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(
      retiredShortName,
      retiredCompanyName.slice(retiredShortName.length),
    ),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(retiredSecondName.slice(0, 2), retiredSecondName.slice(2)),
    "i",
  ),
  new RegExp(escapeRegExp(retiredPredecessorName), "i"),
  new RegExp(escapeRegExp(retiredPapiLabName), "i"),
  new RegExp(`@${escapeRegExp(retiredCompanyName)}`, "i"),
  new RegExp(
    `(?:^|[\\s"'\\x60./:@_-])${escapeRegExp(retiredShortName)}(?:$|[\\s"'\\x60./:@_-])`,
    "i",
  ),
  new RegExp(escapeRegExp(incorrectBundleDomain), "i"),
] as const;

// There is no currently approved product screenshot. New raster screenshots
// must be added here only after a visual identity review.
const approvedVisualAssetDigests = new Map<string, string>();
const retiredPublicVisualAssetPaths = new Set([
  "apps/marketing/public/screenshot.jpeg",
  "assets/prod/readme-screenshot.jpeg",
]);

export interface BrandIdentityFile {
  readonly path: string;
  readonly contents: string;
}

export interface BrandIdentityViolation {
  readonly path: string;
  readonly line: number | null;
  readonly text: string;
}

export interface BrandIdentityBinaryFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

const requiredScientIdentityText = new Map<string, readonly string[]>([
  [
    "README.md",
    [
      "# Scient Desktop",
      "ScientFactory/scient-desktop",
      "No public Scient Desktop release is available yet.",
      "[SECURITY.md](./SECURITY.md)",
    ],
  ],
  [
    "SECURITY.md",
    [
      "# Security policy",
      "https://github.com/ScientFactory/scient-desktop/security/advisories/new",
    ],
  ],
  ["KEYBINDINGS.md", ["# Scient Keybindings", "~/.scient/userdata/keybindings.json"]],
  ["apps/desktop/package.json", ['"productName": "Scient"']],
  [
    "apps/server/package.json",
    [
      '"name": "@scientfactory/cli"',
      '"url": "https://github.com/ScientFactory/scient-desktop"',
      '"scient": "./dist/index.mjs"',
    ],
  ],
  [
    "packages/shared/src/desktopIdentity.ts",
    [
      'SCIENT_APP_NAME = "Scient"',
      'SCIENT_DESKTOP_SCHEME = "scient"',
      'SCIENT_PRODUCTION_BUNDLE_ID = "com.scientfactory.scient"',
      "SCIENT_DESKTOP_UPDATES_ENABLED = true",
    ],
  ],
  ["apps/web/src/branding.ts", ['APP_BASE_NAME = "Scient"']],
  [
    "apps/server/src/terminal/Layers/BunPTY.ts",
    [
      "Build the Scient CLI, then run it with Node.js (for example, `node apps/server/dist/index.mjs`).",
    ],
  ],
  [
    "scripts/build-desktop-artifact.ts",
    ['name: "scient-desktop"', 'description: "Scient desktop build"', 'author: "Yaacov Corcos"'],
  ],
  [
    "apps/desktop/native/appsnap/WindowCapture.swift",
    ['message: "Scient cannot capture its own window."'],
  ],
  [
    "scripts/lib/desktop-platform-build-config.ts",
    [
      '"Scient needs microphone access so you can record voice notes and transcribe them into the chat composer."',
    ],
  ],
  ["scripts/release-smoke.ts", ["Scient-9.9.9-smoke.0-arm64.zip"]],
  ["scripts/release-update-policy.json", ['"channel": "scient"']],
  [
    ".github/workflows/release.yml",
    [
      "SCIENT_DESKTOP_RELEASES_ENABLED",
      "SCIENT_DESKTOP_UPDATE_REPOSITORY",
      "name: Scient v${{ needs.preflight.outputs.version }}",
    ],
  ],
  [
    "apps/web/src/whatsNew/entries.ts",
    ["export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [];"],
  ],
  [".gitignore", ["/.scient/electron-dev", "/.scient-*/"]],
]);

// These files render, export, or transmit Scient-owned product copy. Internal
// Synara package/type names remain intentionally outside this list so inherited
// source structure can stay stable without leaking predecessor branding to users.
const scientOnlySurfacePaths = new Set([
  ".claude/skills/verify/SKILL.md",
  ".docs/architecture.md",
  ".docs/codex-prerequisites.md",
  ".docs/encyclopedia.md",
  ".docs/quick-start.md",
  ".docs/runtime-modes.md",
  ".docs/scripts.md",
  ".docs/workspace-layout.md",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "KEYBINDINGS.md",
  "REMOTE.md",
  "SECURITY.md",
  "apps/desktop/scripts/dev-electron.mjs",
  "apps/desktop/src/appSnapManager.ts",
  "apps/desktop/src/browserUsePipeServer.ts",
  "apps/desktop/src/voiceTranscription.ts",
  "apps/server/src/checkpointing/Layers/CheckpointStore.ts",
  "apps/server/scripts/cli.ts",
  "apps/server/src/codexAppServerManager.ts",
  "apps/server/src/environment/Layers/ServerEnvironmentLabel.ts",
  "apps/server/src/git/Layers/OpenCodeTextGeneration.ts",
  "apps/server/src/git/textGenerationShared.ts",
  "apps/server/src/localServerMonitor.ts",
  "apps/server/src/main.ts",
  "apps/server/src/orchestration/exportThreadArchive.ts",
  "apps/server/src/orchestration/handoff.ts",
  "apps/server/src/persistence/Errors.ts",
  "apps/server/src/provider/Layers/ClaudeAdapter.ts",
  "apps/server/src/provider/Layers/CursorAdapter.ts",
  "apps/server/src/provider/Layers/DroidAdapter.ts",
  "apps/server/src/provider/Layers/GeminiAdapter.ts",
  "apps/server/src/provider/Layers/GrokAdapter.ts",
  "apps/server/src/provider/Layers/OpenCodeAdapter.ts",
  "apps/server/src/provider/Layers/PiAdapter.ts",
  "apps/server/src/provider/Layers/ProviderDiscoveryService.ts",
  "apps/server/src/provider/Layers/ProviderHealth.ts",
  "apps/server/src/provider/codexCliVersion.ts",
  "apps/server/src/provider/geminiAcpProbe.ts",
  "apps/server/src/provider/planMode.ts",
  "apps/server/src/providerUsage/providers/codex.ts",
  "apps/server/src/studioWorkspaceScaffold.ts",
  "apps/server/src/terminal/managedTerminalWrappers.ts",
  "apps/server/src/terminal/Layers/BunPTY.ts",
  "apps/web/src/components/AppSnapCoordinator.tsx",
  "apps/web/src/components/AppSnapWelcomeDialog.tsx",
  "apps/web/src/components/BranchToolbarBranchSelector.tsx",
  "apps/web/src/components/ThreadWorktreeHandoffDialog.tsx",
  "apps/web/src/components/ChatView.logic.ts",
  "apps/web/src/components/ChatView.tsx",
  "apps/web/src/components/Sidebar.tsx",
  "apps/web/src/components/chat/ComposerCommandMenu.tsx",
  "apps/web/src/components/desktopUpdate.logic.ts",
  "apps/web/src/components/profile/ShareCard.tsx",
  "apps/web/src/components/profile/ShareDialog.tsx",
  "apps/web/src/components/profile/shareCardExport.ts",
  "apps/web/src/components/pullRequest/PullRequestsUnavailableState.tsx",
  "apps/web/src/components/settings/ProfileSettingsPanel.tsx",
  "apps/web/src/components/settings/SkillsSettingsPanel.tsx",
  "apps/web/src/composerSlashCommands.ts",
  "apps/web/src/lib/automationDraft.ts",
  "apps/web/src/lib/projectCreation.ts",
  "apps/web/src/routes/-automations.shared.tsx",
  "apps/web/src/routes/_chat.settings.tsx",
  "apps/web/src/settingsSearchIndex.ts",
  "scripts/lib/release-update-policy.ts",
]);

// These paths contain inherited implementation identifiers that must remain
// stable for upstream intake. Only reject the old names in values that create
// new Scient-owned product state or define distributable identity.
const forbiddenScientOwnedOutputPatterns = new Map<string, readonly RegExp[]>([
  [".github/workflows/ci.yml", [/\bVerify Synara identity\b/i]],
  [
    "README.md",
    [
      /https:\/\/scientfactory\.com\/?/i,
      /https:\/\/github\.com\/ScientFactory\/scient-desktop\/releases/i,
    ],
  ],
  [
    "scripts/lib/desktop-platform-build-config.ts",
    [/executableName:\s*["']synara["']/i, /StartupWMClass:\s*["']synara["']/i],
  ],
  ["apps/web/src/components/profile/ShareDialog.tsx", [/synara-stats-/i]],
  ["apps/web/src/components/ThreadWorktreeHandoffDialog.tsx", [/placeholder=["']synara\//i]],
  ["apps/server/src/profileStats.ts", [/\|\|\s*["']SY["']/, /\|\|\s*["']synara["']/i]],
  [
    "apps/server/src/terminal/Layers/BunPTY.ts",
    [/npx\s+synara\b/i, /npx\s+--package\s+@scientfactory\/cli\s+scient\b/i],
  ],
  [
    "apps/server/src/git/Layers/GitCore.ts",
    [/AUTO_DETACHED_WORKTREE_DIRNAME\s*=\s*["']synara["']/i, /synara:\s+stash before switching/i],
  ],
  [
    "apps/server/src/git/Layers/GitManager.ts",
    [/synara\/pr-/i, /synara preserve local handoff/i, /synara handoff to (?:local|worktree)/i],
  ],
]);

export function findScientOwnedOutputIdentityViolations(
  files: readonly BrandIdentityFile[],
  patterns: ReadonlyMap<string, readonly RegExp[]> = forbiddenScientOwnedOutputPatterns,
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  for (const file of files) {
    const filePatterns = patterns.get(file.path);
    if (!filePatterns) continue;
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      if (!filePatterns.some((pattern) => pattern.test(line))) continue;
      violations.push({ path: file.path, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

export function findRetiredPublicVisualAssetViolations(
  files: readonly BrandIdentityBinaryFile[],
  retiredPaths: ReadonlySet<string> = retiredPublicVisualAssetPaths,
): BrandIdentityViolation[] {
  return files
    .filter((file) => retiredPaths.has(file.path))
    .map((file) => ({
      path: file.path,
      line: null,
      text: "Retired public screenshot must not be restored without a new visual review.",
    }));
}

export function findScientSurfaceIdentityViolations(
  files: readonly BrandIdentityFile[],
  surfacePaths: ReadonlySet<string> = scientOnlySurfacePaths,
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  for (const file of files) {
    if (!surfacePaths.has(file.path)) continue;
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      if (line.trimStart().startsWith("//")) continue;
      if (!/(?<![@-])\bSynara\b/i.test(line)) continue;
      violations.push({ path: file.path, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

function containsForbiddenIdentity(value: string): boolean {
  return forbiddenPatterns.some((pattern) => pattern.test(value));
}

const legacyPapiLabCompatibilityPaths = new Set([
  "apps/desktop/src/desktopStorageMigration.ts",
  "apps/desktop/src/desktopStorageMigration.test.ts",
  "apps/desktop/src/desktopScientDataDirectories.test.ts",
  "apps/desktop/src/desktopUserDataProfile.ts",
  "apps/desktop/src/desktopUserDataProfile.test.ts",
  "apps/desktop/src/legacyPapiLabHomeMigration.ts",
  "apps/desktop/src/legacyPapiLabHomeMigration.test.ts",
  "apps/web/src/storageOriginMigration.ts",
  "apps/web/src/storageOriginMigration.test.ts",
  "apps/web/src/components/ScientProjectInitializationDialog.tsx",
  "apps/web/src/components/chat/workspaceExplorer.tsx",
  "packages/contracts/src/scientProjectInitialization.ts",
  "packages/scient-project-init/src/apply.test.ts",
  "packages/scient-project-init/src/index.ts",
  "packages/scient-project-init/src/inspect.ts",
  "packages/scient-project-init/src/inspect.test.ts",
  "packages/scient-project-init/src/plan.ts",
  "packages/scient-project-init/src/plan.test.ts",
  "packages/scient-project-init/src/templates.ts",
  "packages/scient-project-init/src/types.ts",
  "packages/scient-project-init/src/validation.ts",
  "scripts/check-brand-identity.ts",
  "scripts/check-brand-identity.test.ts",
]);

function isAllowedLegacyPapiLabReference(path: string, value: string): boolean {
  if (!new RegExp(escapeRegExp(retiredPapiLabName), "i").test(value)) return false;
  if (
    path === "scripts/check-brand-identity.ts" ||
    path === "scripts/check-brand-identity.test.ts"
  ) {
    return true;
  }
  if (legacyPapiLabCompatibilityPaths.has(path) && value === path) return true;
  if (!legacyPapiLabCompatibilityPaths.has(path) && path !== "apps/desktop/src/main.ts") {
    return false;
  }
  return /(?:seedDesktopUserDataProfileFromPapiLab|seedScientHomeFromPapiLab|resolvePapiLabDesktopUserDataPath|exportLegacyPapiLabStorageSnapshot|configuredLegacyPapiLabHome|legacyPapiLab|migratingPapiLabProject|PAPILAB_[A-Z0-9_]+|PapiLab(?:Home|Desktop|Storage|Profile)|legacy-papilab-compatible|papilab[:./-]|\.papilab|["']papilab(?:-dev)?["']|\/papilab(?:-dev)?["']|PapiLab\s+(?:Baseline|browser state|home|identit(?:y|ies)|intact|key namespace|keys|managed|metadata|path|profile|project identity)|(?:legacy|migrat(?:e|es|ed|ing|ion)|previous|rollback|seed|source|upgrade|verified)[^\n]{0,100}PapiLab|PapiLab[^\n]{0,100}(?:legacy|migrat(?:e|es|ed|ing|ion)|rollback|seed|source|upgrade|without deleting|without overwriting))/i.test(
    value,
  );
}

export function findBrandIdentityViolations(
  files: readonly BrandIdentityFile[],
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  for (const file of files) {
    if (
      containsForbiddenIdentity(file.path) &&
      !isAllowedLegacyPapiLabReference(file.path, file.path)
    ) {
      violations.push({ path: file.path, line: null, text: file.path });
    }
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      if (!containsForbiddenIdentity(line)) continue;
      if (isAllowedLegacyPapiLabReference(file.path, line)) continue;
      violations.push({ path: file.path, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

export function findVisualBrandAssetViolations(
  files: readonly BrandIdentityBinaryFile[],
  approvedDigests: ReadonlyMap<string, string> = approvedVisualAssetDigests,
): BrandIdentityViolation[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const violations: BrandIdentityViolation[] = [];
  for (const [path, approvedDigest] of approvedDigests) {
    const file = filesByPath.get(path);
    if (!file) {
      violations.push({
        path,
        line: null,
        text: "Required visual brand asset is missing.",
      });
      continue;
    }
    const digest = createHash("sha256").update(file.contents).digest("hex");
    if (digest !== approvedDigest) {
      violations.push({
        path,
        line: null,
        text: "Visual brand asset changed; perform a visual identity review before approving it.",
      });
    }
  }
  return violations;
}

export function findScientIdentityViolations(
  files: readonly BrandIdentityFile[],
  requirements: ReadonlyMap<string, readonly string[]> = requiredScientIdentityText,
): BrandIdentityViolation[] {
  const filesByPath = new Map(files.map((file) => [file.path, file.contents]));
  const violations: BrandIdentityViolation[] = [];
  for (const [path, requiredText] of requirements) {
    const contents = filesByPath.get(path);
    if (contents === undefined) {
      violations.push({ path, line: null, text: "Required Scient identity source is missing." });
      continue;
    }
    for (const text of requiredText) {
      if (!contents.includes(text)) {
        violations.push({
          path,
          line: null,
          text: `Required Scient identity is missing: ${text}`,
        });
      }
    }
  }
  return violations;
}

function readTrackedFiles(): BrandIdentityBinaryFile[] {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  return paths.map((path) => ({ path, contents: readFileSync(path) }));
}

function main(): void {
  const trackedFiles = readTrackedFiles();
  const searchableFiles = trackedFiles.map((file) => ({
    path: file.path,
    contents: file.contents.includes(0) ? "" : Buffer.from(file.contents).toString("utf8"),
  }));
  const violations = [
    ...findBrandIdentityViolations(searchableFiles),
    ...findScientIdentityViolations(searchableFiles),
    ...findScientSurfaceIdentityViolations(searchableFiles),
    ...findScientOwnedOutputIdentityViolations(searchableFiles),
    ...findRetiredPublicVisualAssetViolations(trackedFiles),
    ...findVisualBrandAssetViolations(trackedFiles),
  ];
  if (violations.length === 0) {
    console.log("Scient identity check passed.");
    return;
  }

  console.error("Retired first-party identity found:");
  for (const violation of violations) {
    const location =
      violation.line === null ? violation.path : `${violation.path}:${violation.line}`;
    console.error(`- ${location}: ${violation.text}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
