// FILE: verify-release-notes.ts
// Purpose: Fail a release preflight unless its exact, curated Scient note exists.

import { fileURLToPath } from "node:url";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstatSync, readFileSync, realpathSync } from "node:fs";

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
      if (feature.description.trim().length === 0) {
        errors.push(`${featureLabel} needs a description.`);
      }
      if (feature.details !== undefined && feature.details.trim().length === 0) {
        errors.push(`${featureLabel} details cannot be blank.`);
      }
      validateImagePair(
        featureLabel,
        "image",
        feature.image,
        feature.imageAlt,
        errors,
        options.assetExists,
      );
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
    errors.push(
      `${label} ${kind} must resolve to a regular, non-symlinked raster file in apps/web/public${image}.`,
    );
  }
}

function bundledReleaseNoteAssetExists(publicPath: string): boolean {
  return isSafeBundledReleaseNoteRasterAsset(publicPath, WEB_PUBLIC_ROOT);
}

export function isSafeBundledReleaseNoteRasterAsset(
  publicPath: string,
  publicRoot: string,
): boolean {
  try {
    const canonicalPublicRoot = realpathSync(publicRoot);
    const releaseNotesRoot = resolve(canonicalPublicRoot, "release-notes");
    const releaseNotesRootStat = lstatSync(releaseNotesRoot);
    if (!releaseNotesRootStat.isDirectory() || releaseNotesRootStat.isSymbolicLink()) return false;

    const candidatePath = resolve(canonicalPublicRoot, publicPath.slice(1));
    const lexicalRelativePath = relative(releaseNotesRoot, candidatePath);
    if (!isContainedRelativePath(lexicalRelativePath)) {
      return false;
    }

    let inspectedPath = releaseNotesRoot;
    for (const segment of lexicalRelativePath.split(/[\\/]/)) {
      inspectedPath = resolve(inspectedPath, segment);
      if (lstatSync(inspectedPath).isSymbolicLink()) return false;
    }

    const candidateStat = lstatSync(candidatePath);
    if (!candidateStat.isFile()) return false;
    const canonicalCandidatePath = realpathSync(candidatePath);
    const canonicalRelativePath = relative(realpathSync(releaseNotesRoot), canonicalCandidatePath);
    if (!isContainedRelativePath(canonicalRelativePath)) {
      return false;
    }

    return hasExpectedRasterSignature(
      readFileSync(canonicalCandidatePath),
      extname(canonicalCandidatePath).toLowerCase(),
    );
  } catch {
    return false;
  }
}

function isContainedRelativePath(pathValue: string): boolean {
  return (
    pathValue.length > 0 &&
    pathValue !== ".." &&
    !pathValue.startsWith(`..${sep}`) &&
    !isAbsolute(pathValue)
  );
}

function hasExpectedRasterSignature(contents: Buffer, extension: string): boolean {
  if (extension === ".png") {
    return (
      contents.length >= 45 &&
      contents
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
      contents.toString("ascii", 12, 16) === "IHDR" &&
      contents.readUInt32BE(16) > 0 &&
      contents.readUInt32BE(20) > 0 &&
      contents.readUInt32BE(contents.length - 12) === 0 &&
      contents.toString("ascii", contents.length - 8, contents.length - 4) === "IEND"
    );
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return (
      contents.length >= 4 &&
      contents[0] === 0xff &&
      contents[1] === 0xd8 &&
      contents[2] === 0xff &&
      contents[contents.length - 2] === 0xff &&
      contents[contents.length - 1] === 0xd9
    );
  }
  if (extension === ".webp") {
    const chunkType = contents.toString("ascii", 12, 16);
    return (
      contents.length >= 16 &&
      contents.toString("ascii", 0, 4) === "RIFF" &&
      contents.toString("ascii", 8, 12) === "WEBP" &&
      contents.readUInt32LE(4) + 8 <= contents.length &&
      (chunkType === "VP8 " || chunkType === "VP8L" || chunkType === "VP8X")
    );
  }
  if (
    extension === ".avif" &&
    contents.length >= 16 &&
    contents.toString("ascii", 4, 8) === "ftyp"
  ) {
    const boxSize = contents.readUInt32BE(0);
    if (boxSize < 16 || boxSize > contents.length) return false;
    for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
      const brand = contents.toString("ascii", offset, offset + 4);
      if (brand === "avif" || brand === "avis") return true;
    }
  }
  return false;
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
  return parseReleaseNoteCatalog(parsed);
}

export function parseReleaseNoteCatalog(parsed: unknown): readonly ReleaseNoteEntry[] {
  if (!Array.isArray(parsed)) {
    throw new Error("The Scient release-note catalog must be a JSON array.");
  }

  for (const [entryIndex, entry] of parsed.entries()) {
    const label = `Entry ${entryIndex + 1}`;
    assertRecord(entry, `${label} must be an object.`);
    assertString(entry.version, `${label} version must be a string.`);
    assertString(entry.date, `${label} date must be a string.`);
    assertString(entry.headline, `${label} headline must be a string.`);
    if (entry.kind !== undefined) assertString(entry.kind, `${label} kind must be a string.`);
    if (entry.heroImage !== undefined) {
      assertString(entry.heroImage, `${label} hero image must be a string.`);
    }
    if (!Array.isArray(entry.features)) {
      throw new Error(`${label} features must be an array.`);
    }
    for (const [featureIndex, feature] of entry.features.entries()) {
      const featureLabel = `${label}, highlight ${featureIndex + 1}`;
      assertRecord(feature, `${featureLabel} must be an object.`);
      assertString(feature.id, `${featureLabel} id must be a string.`);
      assertString(feature.title, `${featureLabel} title must be a string.`);
      assertString(feature.description, `${featureLabel} description must be a string.`);
      for (const [field, fieldLabel] of [
        ["image", "image"],
        ["imageAlt", "image alt text"],
        ["details", "details"],
      ] as const) {
        if (feature[field] !== undefined) {
          assertString(feature[field], `${featureLabel} ${fieldLabel} must be a string.`);
        }
      }
    }
  }
  return parsed as readonly ReleaseNoteEntry[];
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
}

function assertString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string") throw new Error(message);
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2));
