#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Repository verification reads tracked source files and invokes Git before an Effect runtime exists.

// Brand verification is a repository maintenance boundary, not product runtime code.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

// The original guarded surfaces. The inherited-brand rule also covers these
// hand-picked donor files and release scripts.
const LEGACY_SURFACE_ROOTS = [
  "apps/desktop/",
  "apps/server/",
  "apps/web/",
  "packages/contracts/",
  "packages/ssh/",
] as const;

const LEGACY_SURFACE_FILES = new Set([
  "packages/shared/src/relayClient.ts",
  "packages/client-runtime/src/work-log/presentation.ts",
  "apps/mobile/src/lib/threadActivity.ts",
  "apps/mobile/src/features/threads/thread-work-log.tsx",
  "apps/mobile/src/Stack.tsx",
  "apps/mobile/src/components/BrandMark.tsx",
  "apps/mobile/src/components/CompactBrandTitle.tsx",
  "apps/mobile/src/lib/authClientMetadata.ts",
  "apps/mobile/src/lib/mobileTheme.ts",
  "apps/mobile/src/features/agent-awareness/remoteRegistration.ts",
  "apps/mobile/src/features/diagnostics/crash-log-model.ts",
  "apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx",
  "apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx",
  "apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx",
  "apps/mobile/src/features/settings/SettingsRouteScreen.tsx",
  "apps/mobile/src/features/threads/ThreadComposer.tsx",
  "scripts/build-desktop-artifact.ts",
  "scripts/canonical-main-sync.mjs",
  "scripts/local-dev-app.mjs",
  "scripts/notify-discord-release.ts",
  "scripts/resolve-nightly-release.ts",
]);

// Everything Scient ships to desktop, web, server and agent users, plus the
// public user documentation. The bare-T3, T3 Connect and command rules apply here.
const SHIPPED_SURFACE_ROOTS = [
  "apps/desktop/",
  "apps/server/",
  "apps/web/",
  "packages/",
  "native/",
  "docs/user/",
] as const;

// Unshipped clients and the upstream site stay out until Scient ships them.
const EXCLUDED_ROOTS = ["apps/mobile/", "apps/marketing/"] as const;
// Test harness packages, vendored third-party headers, and developer tooling
// are not product surfaces.
const NON_SHIPPED_PATH = /(?:^|\/)(?:scripts|tests?|__tests__|testkit|fixtures)\/|-testing\//u;
const NON_SHIPPED_ROOTS = ["native/libghostty-vt/"] as const;
const TEST_FILE = /\.(?:test|spec|testkit|integration)\.|(?:^|\/|_)tests?\.(?:c|rs)$/u;

const CODE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".c",
  ".rs",
  ".qml",
]);
const MARKDOWN_EXTENSION = ".md";

export type BrandRuleId = "inherited-brand" | "bare-t3" | "t3-connect" | "t3-command";

interface BrandRule {
  readonly id: BrandRuleId;
  readonly pattern: RegExp;
  readonly describe: string;
}

const BRAND_RULES: ReadonlyArray<BrandRule> = [
  {
    id: "inherited-brand",
    pattern:
      /\bT3 Code\b|\bT3 Tools\b|\bT3 threads?\b|\bT3 MCP\b|\bt3-code MCP\b|Tool\.make\(["']t3_|\bT3Wordmark\b|aria-label=["']T3["']|ScientFactory\/scient-desktop-next|github\.com\/(?:pingdotgg\/t3code|t3dotgg\/t3-code)\/releases\b/i,
    describe: "inherited public brand",
  },
  {
    // Case-sensitive, so `t3.json`, `@t3tools/`, `T3CODE_*`, `x-t3-*`, `t3_session`
    // and other retained identifiers never match. T3 Connect has its own rule.
    id: "bare-t3",
    pattern: /(?<![\w.\/@-])T3(?![\w-])(?! (?:Connect|Account)\b)/u,
    describe: "T3 used as the product name",
  },
  {
    id: "t3-connect",
    pattern: /\bT3 (?:Connect|Account)\b/u,
    describe: "T3 Connect outside its switched-off cloud surfaces",
  },
  {
    id: "t3-command",
    pattern:
      /(?:^|[\s`"'(>={])(?:sudo\s+)?t3(?:@[\w.${}-]+)?\s+(?:app|auth|browser|connect|help|pair|project|serve|service|start|theme|trace|triage|uninstall|update)\b|\bnpx\s+t3\b|\bt3@(?:latest|nightly|\$\{)/u,
    describe: "user instruction for the T3 command or package",
  },
];

/** A reviewed exemption from `scripts/scient-brand-allowlist.json`. */
export interface BrandAllowlistEntry {
  /** A tracked file, or a directory prefix ending in `/`. */
  readonly path: string;
  /** The exact trimmed line. Absent means every line under `path`. */
  readonly line?: string;
  readonly rules: ReadonlyArray<BrandRuleId>;
  readonly kind: string;
  readonly reason: string;
}

export interface BrandViolation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly rule: BrandRuleId;
}

export interface BrandCheckResult {
  readonly violations: ReadonlyArray<BrandViolation>;
  readonly staleEntries: ReadonlyArray<BrandAllowlistEntry>;
}

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot <= slash ? "" : path.slice(dot);
}

function underAny(path: string, roots: Iterable<string>): boolean {
  for (const root of roots) if (path.startsWith(root)) return true;
  return false;
}

function isTestOrTooling(path: string): boolean {
  return TEST_FILE.test(path) || NON_SHIPPED_PATH.test(path) || underAny(path, NON_SHIPPED_ROOTS);
}

function isLegacySurface(path: string): boolean {
  if (LEGACY_SURFACE_FILES.has(path)) return true;
  if (underAny(path, EXCLUDED_ROOTS)) return false;
  if (!underAny(path, LEGACY_SURFACE_ROOTS)) return false;
  return !TEST_FILE.test(path) && CODE_EXTENSIONS.has(extension(path));
}

function isShippedSurface(path: string): boolean {
  if (underAny(path, EXCLUDED_ROOTS) || isTestOrTooling(path)) return false;
  if (!underAny(path, SHIPPED_SURFACE_ROOTS)) return false;
  const ext = extension(path);
  if (path.startsWith("docs/user/")) return ext === MARKDOWN_EXTENSION;
  return CODE_EXTENSIONS.has(ext);
}

/** Which rules a tracked file is held to; empty when it is not a product surface. */
export function brandRulesFor(path: string): ReadonlyArray<BrandRuleId> {
  const rules: BrandRuleId[] = [];
  if (isLegacySurface(path) || isShippedSurface(path)) rules.push("inherited-brand");
  if (isShippedSurface(path)) rules.push("bare-t3", "t3-connect", "t3-command");
  return rules;
}

export function isProductSurface(path: string): boolean {
  return brandRulesFor(path).length > 0;
}

const BLOCK_COMMENT_OPEN = /(?:^|[\s{(])\/\*/u;

/**
 * The code on each line with comments removed, so commentary about T3 as
 * upstream stays allowed. Markdown is read as written. Rust test modules
 * (`#[cfg(test)]` to the end of the file) are fixtures, not product text.
 */
function productLines(path: string, contents: string): Array<string> {
  const lines = contents.split(/\r?\n/u);
  if (extension(path) === MARKDOWN_EXTENSION) return lines;
  const rust = extension(path) === ".rs";
  let inBlockComment = false;
  let inRustTests = false;
  return lines.map((raw) => {
    if (inRustTests) return "";
    if (rust && raw.trim() === "#[cfg(test)]") {
      inRustTests = true;
      return "";
    }
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) return "";
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    for (let open = line.search(BLOCK_COMMENT_OPEN); open !== -1;) {
      const start = line.indexOf("/*", open);
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlockComment = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
      open = line.search(BLOCK_COMMENT_OPEN);
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return "";
    // A trailing `// note` after code; `://` in URLs is not preceded by whitespace.
    return line.replace(/\s\/\/\s.*$/u, "");
  });
}

function entryMatches(entry: BrandAllowlistEntry, violation: BrandViolation): boolean {
  if (!entry.rules.includes(violation.rule)) return false;
  const pathMatches = entry.path.endsWith("/")
    ? violation.path.startsWith(entry.path)
    : violation.path === entry.path;
  return pathMatches && (entry.line === undefined || entry.line === violation.text);
}

/** Every rule violation in `files`, before the allowlist is applied. */
export function findBrandViolations(
  files: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
): BrandViolation[] {
  const violations: BrandViolation[] = [];
  for (const file of files) {
    const rules = new Set(brandRulesFor(file.path));
    if (rules.size === 0) continue;
    const original = file.contents.split(/\r?\n/u);
    for (const [index, line] of productLines(file.path, file.contents).entries()) {
      if (line.trim() === "") continue;
      for (const rule of BRAND_RULES) {
        if (!rules.has(rule.id) || !rule.pattern.test(line)) continue;
        violations.push({
          path: file.path,
          line: index + 1,
          text: (original[index] ?? line).trim(),
          rule: rule.id,
        });
      }
    }
  }
  return violations;
}

/** Applies the reviewed allowlist; an entry that exempts nothing is stale. */
export function checkBrand(
  files: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
  allowlist: ReadonlyArray<BrandAllowlistEntry>,
): BrandCheckResult {
  const used = new Set<BrandAllowlistEntry>();
  const violations = findBrandViolations(files).filter((violation) => {
    const entry = allowlist.find((candidate) => entryMatches(candidate, violation));
    if (entry === undefined) return true;
    used.add(entry);
    return false;
  });
  return { violations, staleEntries: allowlist.filter((entry) => !used.has(entry)) };
}

const ALLOWLIST_PATH = "scripts/scient-brand-allowlist.json";
const RULE_IDS = new Set<string>(BRAND_RULES.map((rule) => rule.id));

export function parseBrandAllowlist(text: string): BrandAllowlistEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${ALLOWLIST_PATH} must be a JSON array.`);
  return parsed.map((value: unknown, index) => {
    const entry = value as Partial<Record<keyof BrandAllowlistEntry, unknown>>;
    const problem =
      typeof entry.path !== "string" || entry.path === ""
        ? "a path"
        : entry.line !== undefined && typeof entry.line !== "string"
          ? "a string line"
          : !Array.isArray(entry.rules) ||
              entry.rules.length === 0 ||
              entry.rules.some((rule) => typeof rule !== "string" || !RULE_IDS.has(rule))
            ? `rules from ${[...RULE_IDS].join(", ")}`
            : typeof entry.kind !== "string" || entry.kind === ""
              ? "a kind"
              : typeof entry.reason !== "string" || entry.reason.trim() === ""
                ? "a reason"
                : null;
    if (problem !== null) throw new Error(`${ALLOWLIST_PATH} entry ${index} needs ${problem}.`);
    return entry as BrandAllowlistEntry;
  });
}

const REQUIRED_SCIENT_ANCHORS = new Map<string, readonly string[]>([
  [
    "apps/server/src/provider/CodexProvider.ts",
    [
      'name: "t3code_desktop"',
      'title: "Scient Desktop"',
      "CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_COMPATIBILITY_ORIGINATOR",
    ],
  ],
  ["apps/desktop/package.json", ['"productName": "Scient"']],
  ["apps/web/index.html", ["<title>Scient</title>", 'alt="Scient"']],
  [
    "packages/shared/src/scientDesktopIdentity.ts",
    ['baseName: "Scient"', 'developmentName: "Scient (Dev)"'],
  ],
  [
    "packages/shared/src/scientRelease.ts",
    [
      'SCIENT_DESKTOP_RELEASE_REPOSITORY = "ScientFactory/scient-desktop"',
      'SCIENT_SERVER_CLI_NAME = "scient"',
    ],
  ],
  ["apps/server/src/provider/CodexAuthCallbackPage.ts", ["<strong>Scient</strong>"]],
  ["packages/shared/src/codexAuthCallback.ts", ["<title>Scient</title>"]],
  [
    "scripts/local-dev-app.mjs",
    ['LOCAL_DEV_APP_NAME = "Scient (Dev)"', 'LOCAL_DEV_APP_STABLE_NAME = "Scient (Dev) Stable"'],
  ],
  // The Möbius outline's opening segment pins the geometry; colours pin each variant.
  [
    "assets/prod/app-icon.icon/Assets/symbol.svg",
    [
      'd="M246.52 503.73C322.54 503.73 398.52 472.32 450.13 416.07',
      '<mask id="scient-strip"',
      'fill="#5BA2C2"',
      'fill="#F8AC8B"',
    ],
  ],
  [
    "assets/dev/app-icon.icon/Assets/symbol.svg",
    ['d="M246.52 503.73C322.54 503.73 398.52 472.32 450.13 416.07', 'fill="#252B32"'],
  ],
  [
    "assets/nightly/app-icon.icon/Assets/symbol.svg",
    ['d="M246.52 503.73C322.54 503.73 398.52 472.32 450.13 416.07', 'fill="#FFFFFF"'],
  ],
  [
    "apps/web/src/assets/scient-symbol.svg",
    [
      'd="M246.52 503.73C322.54 503.73 398.52 472.32 450.13 416.07',
      '<mask id="scient-strip"',
      'fill="#5BA2C2"',
      'fill="#F8AC8B"',
    ],
  ],
  ["apps/web/src/components/sidebar/SidebarChrome.tsx", ["APP_BASE_NAME", "<ScientSymbol"]],
  ["assets/dev/app-icon.icon/icon.json", ['"scale": 8.0', '"translation-in-points": [0, 0]']],
  ["assets/nightly/app-icon.icon/icon.json", ['"scale": 8.0', '"translation-in-points": [0, 0]']],
  ["assets/prod/app-icon.icon/icon.json", ['"scale": 8.0', '"translation-in-points": [0, 0]']],
]);

function trackedFiles(): string[] {
  return NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

function verifyRequiredAnchors(): string[] {
  const failures: string[] = [];
  for (const [path, anchors] of REQUIRED_SCIENT_ANCHORS) {
    const contents = NodeFS.readFileSync(path, "utf8");
    for (const anchor of anchors) {
      if (!contents.includes(anchor)) failures.push(`${path}: missing ${JSON.stringify(anchor)}`);
    }
  }
  return failures;
}

function describeEntry(entry: BrandAllowlistEntry): string {
  return entry.line === undefined ? entry.path : `${entry.path}: ${entry.line}`;
}

export function runBrandCheck(): void {
  const files = trackedFiles()
    .filter(isProductSurface)
    .filter((path) => NodeFS.existsSync(path))
    .map((path) => ({ path, contents: NodeFS.readFileSync(path, "utf8") }));
  const allowlist = parseBrandAllowlist(NodeFS.readFileSync(ALLOWLIST_PATH, "utf8"));
  const { violations, staleEntries } = checkBrand(files, allowlist);
  const missingAnchors = verifyRequiredAnchors();
  if (violations.length === 0 && staleEntries.length === 0 && missingAnchors.length === 0) {
    process.stdout.write(
      `Scient brand check passed across ${String(files.length)} product-surface files.\n`,
    );
    return;
  }

  const describeRule = new Map(BRAND_RULES.map((rule) => [rule.id, rule.describe]));
  for (const violation of violations) {
    process.stderr.write(
      `${violation.path}:${String(violation.line)}: ${describeRule.get(violation.rule)}: ${violation.text}\n`,
    );
  }
  for (const entry of staleEntries) {
    process.stderr.write(
      `${ALLOWLIST_PATH}: stale entry no longer exempts anything: ${describeEntry(entry)}\n`,
    );
  }
  for (const failure of missingAnchors) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
}

if (import.meta.main) runBrandCheck();
