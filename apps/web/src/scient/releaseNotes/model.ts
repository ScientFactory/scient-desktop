import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

export interface ScientReleaseHighlight {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

interface ScientReleaseNoteBase {
  /** Exact application version that owns this note. */
  readonly version: string;
  /** ISO calendar date (`YYYY-MM-DD`) used for deterministic presentation. */
  readonly publishedAt: string;
  readonly headline: string;
  readonly highlights: readonly [ScientReleaseHighlight, ...ScientReleaseHighlight[]];
}

/** Historical format retained so published release notes keep their original presentation. */
export interface ScientLegacyReleaseNote extends ScientReleaseNoteBase {
  readonly format?: "legacy";
  readonly kicker: string;
  readonly summary: string;
  readonly alsoIncluded?: never;
}

/** Current format: one title, dedicated paragraphs, then a final miscellany paragraph. */
export interface ScientParagraphReleaseNote extends ScientReleaseNoteBase {
  readonly format: "paragraphs";
  readonly alsoIncluded: string;
  readonly kicker?: never;
  readonly summary?: never;
}

export type ScientReleaseNote = ScientLegacyReleaseNote | ScientParagraphReleaseNote;

export type ScientReleaseNotesDecision =
  | {
      readonly kind: "show";
      readonly current: ScientReleaseNote;
      readonly history: readonly ScientReleaseNote[];
      readonly nextLastHandledVersion: string;
    }
  | {
      readonly kind: "silent-bootstrap";
      readonly nextLastHandledVersion: string;
    }
  | { readonly kind: "noop" };

export function sortScientReleaseNotes(
  notes: readonly ScientReleaseNote[],
): readonly ScientReleaseNote[] {
  return notes.toSorted((left, right) => compareSemverVersions(right.version, left.version));
}

export function resolveScientReleaseNotesDecision({
  catalog,
  currentVersion,
  lastHandledVersion,
}: {
  readonly catalog: readonly ScientReleaseNote[];
  readonly currentVersion: string;
  readonly lastHandledVersion: string | null;
}): ScientReleaseNotesDecision {
  if (lastHandledVersion === null) {
    return { kind: "silent-bootstrap", nextLastHandledVersion: currentVersion };
  }

  if (compareSemverVersions(currentVersion, lastHandledVersion) <= 0) {
    return { kind: "noop" };
  }

  const current = catalog.find((note) => note.version === currentVersion);
  if (!current) {
    return { kind: "silent-bootstrap", nextLastHandledVersion: currentVersion };
  }

  return {
    kind: "show",
    current,
    history: sortScientReleaseNotes(
      catalog.filter((note) => compareSemverVersions(note.version, currentVersion) <= 0),
    ),
    nextLastHandledVersion: currentVersion,
  };
}

export function formatScientReleaseVersion(version: string): string {
  const normalized = version.trim().replace(/^v/, "");
  const parsed = parseSemver(normalized);
  if (!parsed || parsed.prerelease.length > 0 || parsed.patch !== 0) {
    return normalized;
  }
  return `${parsed.major}.${parsed.minor}`;
}

export function formatScientReleaseMonth(publishedAt: string): string {
  const [year, month] = publishedAt.split("-").map(Number);
  if (
    year === undefined ||
    month === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month)
  ) {
    return publishedAt;
  }
  return new Intl.DateTimeFormat("en", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function validateScientReleaseNotesCatalog(
  catalog: readonly ScientReleaseNote[],
): readonly string[] {
  const issues: string[] = [];
  const versions = new Set<string>();

  for (const [releaseIndex, release] of catalog.entries()) {
    const releasePath = `release[${releaseIndex}]`;
    if (parseSemver(release.version) === null) {
      issues.push(`${releasePath}.version must be a valid semantic version.`);
    }
    if (versions.has(release.version)) {
      issues.push(`${releasePath}.version duplicates ${release.version}.`);
    }
    versions.add(release.version);

    if (!isValidIsoCalendarDate(release.publishedAt)) {
      issues.push(`${releasePath}.publishedAt must be a valid YYYY-MM-DD date.`);
    }
    validateText(releasePath, "headline", release.headline, issues);

    if (release.format === "paragraphs") {
      validateText(releasePath, "alsoIncluded", release.alsoIncluded, issues);
      validateMaximumLength(releasePath, "headline", release.headline, 80, issues);
      validateMaximumLength(releasePath, "alsoIncluded", release.alsoIncluded, 320, issues);
    } else {
      validateText(releasePath, "kicker", release.kicker, issues);
      validateText(releasePath, "summary", release.summary, issues);
    }

    if (release.highlights.length === 0) {
      issues.push(`${releasePath}.highlights must contain at least one item.`);
    }
    const maximumHighlights = release.format === "paragraphs" ? 7 : 5;
    if (release.highlights.length > maximumHighlights) {
      issues.push(
        `${releasePath}.highlights must contain no more than ${numberName(maximumHighlights)} items.`,
      );
    }
    const highlightIds = new Set<string>();
    for (const [highlightIndex, highlight] of release.highlights.entries()) {
      const highlightPath = `${releasePath}.highlights[${highlightIndex}]`;
      validateText(highlightPath, "id", highlight.id, issues);
      validateText(highlightPath, "title", highlight.title, issues);
      validateText(highlightPath, "description", highlight.description, issues);
      if (release.format === "paragraphs") {
        validateMaximumLength(highlightPath, "title", highlight.title, 72, issues);
        validateMaximumLength(highlightPath, "description", highlight.description, 240, issues);
      }
      if (highlightIds.has(highlight.id)) {
        issues.push(`${highlightPath}.id duplicates ${highlight.id} in this release.`);
      }
      highlightIds.add(highlight.id);
    }

    if (release.format === "paragraphs") {
      const totalCopyLength =
        release.headline.length +
        "Also included".length +
        release.alsoIncluded.length +
        release.highlights.reduce(
          (total, highlight) => total + highlight.title.length + highlight.description.length,
          0,
        );
      if (totalCopyLength > 1_600) {
        issues.push(`${releasePath} must contain no more than 1600 characters of visible copy.`);
      }
    }
  }

  return issues;
}

function validateText(path: string, field: string, value: string, issues: string[]): void {
  if (value.trim().length === 0) {
    issues.push(`${path}.${field} must not be empty.`);
  }
}

function validateMaximumLength(
  path: string,
  field: string,
  value: string,
  maximum: number,
  issues: string[],
): void {
  if (value.length > maximum) {
    issues.push(`${path}.${field} must contain no more than ${maximum} characters.`);
  }
}

function numberName(value: number): string {
  if (value === 5) return "five";
  if (value === 7) return "seven";
  return String(value);
}

function isValidIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
