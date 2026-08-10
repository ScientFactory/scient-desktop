import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

export interface ScientReleaseHighlight {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export interface ScientReleaseNote {
  /** Exact application version that owns this note. */
  readonly version: string;
  /** ISO calendar date (`YYYY-MM-DD`) used for deterministic presentation. */
  readonly publishedAt: string;
  readonly kicker: string;
  readonly headline: string;
  readonly summary: string;
  readonly highlights: readonly [ScientReleaseHighlight, ...ScientReleaseHighlight[]];
}

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
    validateText(releasePath, "kicker", release.kicker, issues);
    validateText(releasePath, "headline", release.headline, issues);
    validateText(releasePath, "summary", release.summary, issues);

    if (release.highlights.length === 0) {
      issues.push(`${releasePath}.highlights must contain at least one item.`);
    }
    if (release.highlights.length > 5) {
      issues.push(`${releasePath}.highlights must contain no more than five items.`);
    }
    const highlightIds = new Set<string>();
    for (const [highlightIndex, highlight] of release.highlights.entries()) {
      const highlightPath = `${releasePath}.highlights[${highlightIndex}]`;
      validateText(highlightPath, "id", highlight.id, issues);
      validateText(highlightPath, "title", highlight.title, issues);
      validateText(highlightPath, "description", highlight.description, issues);
      if (highlightIds.has(highlight.id)) {
        issues.push(`${highlightPath}.id duplicates ${highlight.id} in this release.`);
      }
      highlightIds.add(highlight.id);
    }
  }

  return issues;
}

function validateText(path: string, field: string, value: string, issues: string[]): void {
  if (value.trim().length === 0) {
    issues.push(`${path}.${field} must not be empty.`);
  }
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
