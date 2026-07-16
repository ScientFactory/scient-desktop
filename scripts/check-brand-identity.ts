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
  new RegExp(`@${escapeRegExp(retiredCompanyName)}`, "i"),
  new RegExp(
    `(?:^|[\\s"'\\x60./:@_-])${escapeRegExp(retiredShortName)}(?:$|[\\s"'\\x60./:@_-])`,
    "i",
  ),
  new RegExp(escapeRegExp(incorrectBundleDomain), "i"),
] as const;

// Raster images cannot be searched for embedded text. Keep the user-facing
// screenshots behind reviewed digests so changing either one requires another
// explicit visual identity audit instead of silently bypassing this guard.
const approvedVisualAssetDigests = new Map<string, string>([
  [
    "apps/marketing/public/screenshot.jpeg",
    "0b4be139f13dd08885a1aac26fc1f7c623697db157777d16360e985c93d47bcf",
  ],
  [
    "assets/prod/readme-screenshot.jpeg",
    "0b4be139f13dd08885a1aac26fc1f7c623697db157777d16360e985c93d47bcf",
  ],
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

const requiredPapiLabIdentityText = new Map<string, readonly string[]>([
  ["README.md", ["# PapiLab Desktop", "yaacovcorcos/papilab-desktop"]],
  ["KEYBINDINGS.md", ["# PapiLab Keybindings", "~/.papilab/userdata/keybindings.json"]],
  ["apps/desktop/package.json", ['"productName": "PapiLab"']],
  [
    "packages/shared/src/desktopIdentity.ts",
    [
      'PAPILAB_APP_NAME = "PapiLab"',
      'PAPILAB_DESKTOP_SCHEME = "papilab"',
      'PAPILAB_PRODUCTION_BUNDLE_ID = "com.yaacovcorcos.papilab"',
      "PAPILAB_DESKTOP_UPDATES_ENABLED = false",
    ],
  ],
  ["apps/web/src/branding.ts", ['APP_BASE_NAME = "PapiLab"']],
  [
    "scripts/build-desktop-artifact.ts",
    ['name: "papilab-desktop"', 'description: "PapiLab desktop build"', 'author: "Yaacov Corcos"'],
  ],
  [
    "apps/web/src/whatsNew/entries.ts",
    ["export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [];"],
  ],
  [
    "apps/marketing/src/lib/releases.ts",
    ["yaacovcorcos/papilab-desktop", '"papilab-latest-release"'],
  ],
  ["apps/marketing/src/pages/index.astro", ["PapiLab is a scientific workspace"]],
  ["apps/marketing/src/pages/download.astro", ["Download — PapiLab"]],
  ["apps/marketing/src/layouts/Layout.astro", ["PapiLab — A local-first scientific workspace"]],
]);

// These files render, export, or transmit PapiLab-owned product copy. Internal
// Synara package/type names remain intentionally outside this list so the fork
// can preserve upstream structure without leaking predecessor branding to users.
const papiLabOnlySurfacePaths = new Set([
  "README.md",
  "CONTRIBUTING.md",
  "KEYBINDINGS.md",
  "REMOTE.md",
  "apps/marketing/src/layouts/Layout.astro",
  "apps/marketing/src/lib/releases.ts",
  "apps/marketing/src/pages/download.astro",
  "apps/marketing/src/pages/index.astro",
  "apps/desktop/scripts/dev-electron.mjs",
  "apps/desktop/src/appSnapManager.ts",
  "apps/desktop/src/browserUsePipeServer.ts",
  "apps/desktop/src/voiceTranscription.ts",
  "apps/server/src/checkpointing/Layers/CheckpointStore.ts",
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
  "apps/web/src/components/AppSnapCoordinator.tsx",
  "apps/web/src/components/AppSnapWelcomeDialog.tsx",
  "apps/web/src/components/BranchToolbarBranchSelector.tsx",
  "apps/web/src/components/ChatView.logic.ts",
  "apps/web/src/components/ChatView.tsx",
  "apps/web/src/components/Sidebar.tsx",
  "apps/web/src/components/chat/ComposerCommandMenu.tsx",
  "apps/web/src/components/desktopUpdate.logic.ts",
  "apps/web/src/components/profile/ShareCard.tsx",
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
]);

export function findPapiLabSurfaceIdentityViolations(
  files: readonly BrandIdentityFile[],
  surfacePaths: ReadonlySet<string> = papiLabOnlySurfacePaths,
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

export function findBrandIdentityViolations(
  files: readonly BrandIdentityFile[],
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  for (const file of files) {
    if (containsForbiddenIdentity(file.path)) {
      violations.push({ path: file.path, line: null, text: file.path });
    }
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      if (!containsForbiddenIdentity(line)) continue;
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

export function findPapiLabIdentityViolations(
  files: readonly BrandIdentityFile[],
  requirements: ReadonlyMap<string, readonly string[]> = requiredPapiLabIdentityText,
): BrandIdentityViolation[] {
  const filesByPath = new Map(files.map((file) => [file.path, file.contents]));
  const violations: BrandIdentityViolation[] = [];
  for (const [path, requiredText] of requirements) {
    const contents = filesByPath.get(path);
    if (contents === undefined) {
      violations.push({ path, line: null, text: "Required PapiLab identity source is missing." });
      continue;
    }
    for (const text of requiredText) {
      if (!contents.includes(text)) {
        violations.push({
          path,
          line: null,
          text: `Required PapiLab identity is missing: ${text}`,
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
    ...findPapiLabIdentityViolations(searchableFiles),
    ...findPapiLabSurfaceIdentityViolations(searchableFiles),
    ...findVisualBrandAssetViolations(trackedFiles),
  ];
  if (violations.length === 0) {
    console.log("PapiLab identity check passed.");
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
