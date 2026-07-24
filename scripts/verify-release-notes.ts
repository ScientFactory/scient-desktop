// FILE: verify-release-notes.ts
// Purpose: Fail a release preflight unless its exact, curated Scient note exists.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface ReleaseNoteFeature {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly image?: string;
  readonly imageAlt?: string;
  readonly details?: string;
}

export interface ReleaseNoteEntry {
  readonly version: string;
  readonly date: string;
  readonly headline: string;
  readonly kind?: "standard" | "hotfix";
  readonly features: readonly ReleaseNoteFeature[];
  readonly heroImage?: string;
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ReleaseNoteVerification {
  readonly version: string;
  readonly errors: readonly string[];
}

export interface ReleaseNoteVerificationOptions {
  readonly assetExists?: (publicPath: string) => boolean;
}

const RELEASE_NOTE_ASSET_PATTERN =
  /^\/release-notes\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:avif|jpe?g|png|webp)$/i;
const WEB_PUBLIC_ROOT = fileURLToPath(new URL("../apps/web/public/", import.meta.url));

const FORBIDDEN_RELEASE_NOTE_COPY: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  { label: "commit references", pattern: /\bcommits?\b/i },
  { label: "pull request references", pattern: /\bpull requests?\b|\bpr\s*#?\d+\b/i },
  { label: "framework references", pattern: /\bframeworks?\b/i },
  { label: "protocol references", pattern: /\bprotocols?\b/i },
  { label: "migration references", pattern: /\bmigrations?\b/i },
  { label: "implementation details", pattern: /\bimplementation(?:s| details?)?\b/i },
  {
    label: "developer terminology",
    pattern:
      /\b(?:backend|codebase|dependencies|dependency|developer|developers|frontend|refactor|refactored|refactoring|renderer|runtime|schema)\b/i,
  },
  {
    label: "internal framework or protocol names",
    pattern: /\b(?:bun|electron|ipc|react|tailwind|typescript|vite|vitest|webcontents(?:view)?)\b/i,
  },
];

export function normalizeReleaseVersion(rawVersion: string): string {
  const version = rawVersion.trim().replace(/^v/, "");
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Expected a full semantic version, got ${JSON.stringify(rawVersion)}.`);
  }
  return version;
}

export function verifyReleaseNoteForVersion(
  rawVersion: string,
  entries: readonly ReleaseNoteEntry[],
  options: ReleaseNoteVerificationOptions = {},
): ReleaseNoteVerification {
  let version = rawVersion.trim().replace(/^v/, "");
  const errors: string[] = [];
  try {
    version = normalizeReleaseVersion(rawVersion);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const releaseVersions = new Set<string>();
  for (const [entryIndex, entry] of entries.entries()) {
    const label = `Entry ${entryIndex + 1}`;
    if (!SEMVER_PATTERN.test(entry.version) || entry.version.startsWith("v")) {
      errors.push(`${label} must use a canonical full semantic version without a leading v.`);
    }
    if (releaseVersions.has(entry.version)) {
      errors.push(`Release ${entry.version} appears more than once.`);
    }
    releaseVersions.add(entry.version);

    if (entry.date.trim().length === 0) errors.push(`${label} needs a release date.`);
    if (entry.headline.trim().length === 0) errors.push(`${label} needs a benefit-led headline.`);
    validateUserFacingCopy(label, "headline", entry.headline, errors);
    const isHotfix = entry.kind === "hotfix";
    if (entry.kind !== undefined && entry.kind !== "standard" && !isHotfix) {
      errors.push(`${label} kind must be standard or hotfix.`);
    }
    const minimumHighlights = isHotfix ? 1 : 3;
    const maximumHighlights = isHotfix ? 2 : 5;
    if (entry.features.length < minimumHighlights || entry.features.length > maximumHighlights) {
      errors.push(
        isHotfix
          ? `${label} hotfix must contain between 1 and 2 user-facing highlights.`
          : `${label} must contain between 3 and 5 user-facing highlights.`,
      );
    }
    validateImage(label, "hero", entry.heroImage, errors, options.assetExists);

    const featureIds = new Set<string>();
    for (const [featureIndex, feature] of entry.features.entries()) {
      const featureLabel = `${label}, highlight ${featureIndex + 1}`;
      if (feature.id.trim().length === 0) errors.push(`${featureLabel} needs an id.`);
      if (featureIds.has(feature.id)) errors.push(`${featureLabel} reuses id ${feature.id}.`);
      featureIds.add(feature.id);
      if (feature.title.trim().length === 0) errors.push(`${featureLabel} needs a title.`);
      validateUserFacingCopy(featureLabel, "title", feature.title, errors);
      if (feature.description.trim().length === 0) {
        errors.push(`${featureLabel} needs a description.`);
      }
      validateUserFacingCopy(featureLabel, "description", feature.description, errors);
      if (feature.details !== undefined && feature.details.trim().length === 0) {
        errors.push(`${featureLabel} details cannot be blank.`);
      }
      if (feature.details !== undefined) {
        validateUserFacingCopy(featureLabel, "details", feature.details, errors);
      }
      validateImagePair(
        featureLabel,
        "image",
        feature.image,
        feature.imageAlt,
        errors,
        options.assetExists,
      );
      if (feature.imageAlt !== undefined) {
        validateUserFacingCopy(featureLabel, "image alt text", feature.imageAlt, errors);
      }
    }
  }

  if (SEMVER_PATTERN.test(version)) {
    const matches = entries.filter((entry) => entry.version === version);
    if (matches.length !== 1) {
      errors.push(
        `Release ${version} requires exactly one curated Scient release note; found ${matches.length}.`,
      );
    }
  }

  return { version, errors };
}

function validateUserFacingCopy(
  label: string,
  field: string,
  value: string,
  errors: string[],
): void {
  const forbidden = FORBIDDEN_RELEASE_NOTE_COPY.find(({ pattern }) => pattern.test(value));
  if (!forbidden) return;
  errors.push(
    `${label} ${field} contains ${forbidden.label}; rewrite it as a plain-language user benefit.`,
  );
}

function validateImagePair(
  label: string,
  kind: string,
  image: string | undefined,
  alt: string | undefined,
  errors: string[],
  assetExists: ((publicPath: string) => boolean) | undefined,
) {
  if ((image === undefined) !== (alt === undefined)) {
    errors.push(`${label} ${kind} and accessible alt text must be provided together.`);
  }
  validateImage(label, kind, image, errors, assetExists);
  if (alt !== undefined && alt.trim().length === 0)
    errors.push(`${label} ${kind} alt text is blank.`);
}

function validateImage(
  label: string,
  kind: string,
  image: string | undefined,
  errors: string[],
  assetExists: ((publicPath: string) => boolean) | undefined,
) {
  if (image === undefined) return;
  if (image.trim().length === 0) {
    errors.push(`${label} ${kind} is blank.`);
    return;
  }
  if (!RELEASE_NOTE_ASSET_PATTERN.test(image)) {
    errors.push(
      `${label} ${kind} must be a bundled raster asset under /release-notes/ with no URL, query, hash, or traversal.`,
    );
  } else if (!(assetExists ?? bundledReleaseNoteAssetExists)(image)) {
    errors.push(`${label} ${kind} asset does not exist in apps/web/public${image}.`);
  }
}

function bundledReleaseNoteAssetExists(publicPath: string): boolean {
  return existsSync(resolve(WEB_PUBLIC_ROOT, publicPath.slice(1)));
}

function main(args: readonly string[]) {
  if (args.length !== 1) {
    throw new Error("Usage: node scripts/verify-release-notes.ts <version>");
  }
  const entries = readReleaseNoteCatalog();
  const result = verifyReleaseNoteForVersion(args[0] ?? "", entries);
  if (result.errors.length > 0) {
    throw new Error(`Release-note preflight failed:\n- ${result.errors.join("\n- ")}`);
  }
  console.log(
    `Release-note preflight passed for Scient v${result.version} (${entries.length} catalog entries).`,
  );
}

function readReleaseNoteCatalog(): readonly ReleaseNoteEntry[] {
  const path = fileURLToPath(new URL("../apps/web/src/whatsNew/entries.json", import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("The Scient release-note catalog must be a JSON array.");
  }
  return parsed as readonly ReleaseNoteEntry[];
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2));
