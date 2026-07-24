// FILE: verify-release-notes.ts
// Purpose: Fail a release preflight unless its exact, curated Scient note exists.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

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
  readonly features: readonly ReleaseNoteFeature[];
  readonly heroImage?: string;
  readonly heroImageAlt?: string;
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ReleaseNoteVerification {
  readonly version: string;
  readonly errors: readonly string[];
}

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
    if (entry.features.length < 1 || entry.features.length > 5) {
      errors.push(`${label} must contain between 1 and 5 user-facing highlights.`);
    }
    validateImagePair(label, "hero", entry.heroImage, entry.heroImageAlt, errors);

    const featureIds = new Set<string>();
    for (const [featureIndex, feature] of entry.features.entries()) {
      const featureLabel = `${label}, highlight ${featureIndex + 1}`;
      if (feature.id.trim().length === 0) errors.push(`${featureLabel} needs an id.`);
      if (featureIds.has(feature.id)) errors.push(`${featureLabel} reuses id ${feature.id}.`);
      featureIds.add(feature.id);
      if (feature.title.trim().length === 0) errors.push(`${featureLabel} needs a title.`);
      if (feature.description.trim().length === 0) {
        errors.push(`${featureLabel} needs a description.`);
      }
      if (feature.details !== undefined && feature.details.trim().length === 0) {
        errors.push(`${featureLabel} details cannot be blank.`);
      }
      validateImagePair(featureLabel, "image", feature.image, feature.imageAlt, errors);
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

function validateImagePair(
  label: string,
  kind: string,
  image: string | undefined,
  alt: string | undefined,
  errors: string[],
) {
  if ((image === undefined) !== (alt === undefined)) {
    errors.push(`${label} ${kind} and accessible alt text must be provided together.`);
  }
  if (image !== undefined && image.trim().length === 0) errors.push(`${label} ${kind} is blank.`);
  if (alt !== undefined && alt.trim().length === 0)
    errors.push(`${label} ${kind} alt text is blank.`);
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
