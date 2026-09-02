#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Repository verification reads tracked source files and invokes Git before an Effect runtime exists.

// Brand verification is a repository maintenance boundary, not product runtime code.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const PRODUCT_SURFACE_ROOTS = [
  "apps/desktop/",
  "apps/server/",
  "apps/web/",
  "packages/contracts/",
  "packages/ssh/",
] as const;

const PRODUCT_SURFACE_FILES = new Set([
  "packages/shared/src/relayClient.ts",
  "scripts/build-desktop-artifact.ts",
  "scripts/canonical-main-sync.mjs",
  "scripts/local-dev-app.mjs",
  "scripts/notify-discord-release.ts",
  "scripts/resolve-nightly-release.ts",
]);

const EXCLUDED_ROOTS = ["apps/mobile/", "apps/marketing/"] as const;
const SOURCE_EXTENSIONS = new Set([".html", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const FORBIDDEN_PUBLIC_BRANDS =
  /\bT3 Code\b|\bT3 Tools\b|\bT3Wordmark\b|aria-label=["']T3["']|ScientFactory\/scient-desktop-next|github\.com\/(?:pingdotgg\/t3code|t3dotgg\/t3-code)\/releases\b/i;

const REQUIRED_SCIENT_ANCHORS = new Map<string, readonly string[]>([
  ["apps/desktop/package.json", ['"productName": "Scient"']],
  ["apps/web/index.html", ["<title>Scient</title>", 'alt="Scient"']],
  [
    "packages/shared/src/scientDesktopIdentity.ts",
    ['baseName: "Scient"', 'developmentName: "Scient (Dev)"'],
  ],
  [
    "packages/shared/src/scientRelease.ts",
    ['SCIENT_DESKTOP_RELEASE_REPOSITORY = "ScientFactory/scient-desktop"'],
  ],
  [
    "scripts/local-dev-app.mjs",
    ['LOCAL_DEV_APP_NAME = "Scient (Dev)"', 'LOCAL_DEV_APP_STABLE_NAME = "Scient (Dev) Stable"'],
  ],
  [
    "assets/prod/app-icon.icon/Assets/symbol.svg",
    ['fill="#46587E"', 'fill="#471A1A"', 'd="M292 108', 'height="16"'],
  ],
  [
    "apps/web/src/assets/scient-symbol.svg",
    ['fill="#46587E"', 'fill="#471A1A"', 'd="M292 108', 'height="16"'],
  ],
  ["apps/web/src/components/sidebar/SidebarChrome.tsx", ["APP_BASE_NAME", "<ScientSymbol"]],
  ["assets/dev/app-icon.icon/icon.json", ['"scale": 8.0', '"translation-in-points": [0, 0]']],
  ["assets/nightly/app-icon.icon/icon.json", ['"scale": 8.0', '"translation-in-points": [0, 0]']],
  ["assets/prod/app-icon.icon/icon.json", ['"scale": 8.0', '"translation-in-points": [0, 0]']],
]);

export interface BrandViolation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

export function isProductSurface(path: string): boolean {
  if (EXCLUDED_ROOTS.some((root) => path.startsWith(root))) return false;
  if (path.includes(".test.") || path.includes(".spec.")) return false;
  if (!SOURCE_EXTENSIONS.has(extension(path))) return false;
  return (
    PRODUCT_SURFACE_FILES.has(path) || PRODUCT_SURFACE_ROOTS.some((root) => path.startsWith(root))
  );
}

export function findPublicBrandViolations(
  files: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
): BrandViolation[] {
  const violations: BrandViolation[] = [];
  for (const file of files) {
    if (!isProductSurface(file.path)) continue;
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        continue;
      }
      if (!FORBIDDEN_PUBLIC_BRANDS.test(line)) continue;
      violations.push({ path: file.path, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

function trackedFiles(): string[] {
  return NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "-z", "--", ...PRODUCT_SURFACE_ROOTS, ...PRODUCT_SURFACE_FILES],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  )
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

export function runBrandCheck(): void {
  const files = trackedFiles()
    .filter(isProductSurface)
    .map((path) => ({ path, contents: NodeFS.readFileSync(path, "utf8") }));
  const violations = findPublicBrandViolations(files);
  const missingAnchors = verifyRequiredAnchors();
  if (violations.length === 0 && missingAnchors.length === 0) {
    process.stdout.write(
      `Scient brand check passed across ${String(files.length)} product-surface files.\n`,
    );
    return;
  }

  for (const violation of violations) {
    process.stderr.write(
      `${violation.path}:${String(violation.line)}: inherited public brand: ${violation.text}\n`,
    );
  }
  for (const failure of missingAnchors) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
}

if (import.meta.main) runBrandCheck();
