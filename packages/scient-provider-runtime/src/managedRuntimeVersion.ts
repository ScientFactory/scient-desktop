import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

import type { ManagedRuntimeCatalogProvider } from "./managedRuntimeArtifact.ts";

export type ManagedRuntimeVersionComparison = "older" | "equal" | "newer" | "unknown";

export interface ManagedRuntimeRelease {
  readonly version: string;
  /** Qualified Cursor replacements on the same calendar date. */
  readonly supersedes?: ReadonlyArray<string> | undefined;
}

export const MAX_CURSOR_SUPERSEDES = 64;

const CURSOR_VERSION = /^(\d{4})\.(\d{2})\.(\d{2})-([0-9a-f]{7,40})$/u;

function cursorDateKey(match: RegExpExecArray): string | undefined {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > (daysInMonth[month - 1] ?? 0)) {
    return undefined;
  }
  return match.slice(1, 4).join("");
}

function comparisonFromNumber(comparison: number): ManagedRuntimeVersionComparison {
  return comparison < 0 ? "older" : comparison > 0 ? "newer" : "equal";
}

function cursorReleaseDate(version: string): string | undefined {
  const match = CURSOR_VERSION.exec(version);
  return match ? cursorDateKey(match) : undefined;
}

export function parseManagedCursorVersion(output: string): string | undefined {
  const version = /\b\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,40}\b/u.exec(output)?.[0];
  return version && cursorReleaseDate(version) ? version : undefined;
}

export function isSameCursorReleaseDate(current: string, candidate: string): boolean {
  const date = cursorReleaseDate(current);
  return date !== undefined && date === cursorReleaseDate(candidate);
}

/** Ordering metadata never authorizes a new date, malformed identity or another provider. */
export function isValidManagedRuntimeSupersedes(
  provider: ManagedRuntimeCatalogProvider,
  version: string,
  supersedes: unknown,
): supersedes is ReadonlyArray<string> | undefined {
  if (supersedes === undefined) return true;
  return (
    provider === "cursor" &&
    Array.isArray(supersedes) &&
    supersedes.length <= MAX_CURSOR_SUPERSEDES &&
    new Set(supersedes).size === supersedes.length &&
    supersedes.every(
      (previous: unknown) =>
        typeof previous === "string" &&
        previous !== version &&
        isSameCursorReleaseDate(previous, version),
    )
  );
}

/** Raw versions keep their vendor semantics; only qualified lineage orders same-day Cursor builds. */
export function compareManagedRuntimeReleases(input: {
  readonly provider: ManagedRuntimeCatalogProvider;
  readonly current: ManagedRuntimeRelease;
  readonly candidate: ManagedRuntimeRelease;
}): ManagedRuntimeVersionComparison {
  const raw = compareManagedRuntimeVersions({
    provider: input.provider,
    current: input.current.version,
    candidate: input.candidate.version,
  });
  if (raw !== "unknown" || input.provider !== "cursor") return raw;
  if (
    !isSameCursorReleaseDate(input.current.version, input.candidate.version) ||
    !isValidManagedRuntimeSupersedes(
      input.provider,
      input.current.version,
      input.current.supersedes,
    ) ||
    !isValidManagedRuntimeSupersedes(
      input.provider,
      input.candidate.version,
      input.candidate.supersedes,
    )
  )
    return "unknown";
  const forward = input.candidate.supersedes?.includes(input.current.version) ?? false;
  const backward = input.current.supersedes?.includes(input.candidate.version) ?? false;
  return forward === backward ? "unknown" : forward ? "newer" : "older";
}

function compareCursorVersions(
  current: string,
  candidate: string,
): ManagedRuntimeVersionComparison {
  if (current === candidate) return "equal";
  const currentMatch = CURSOR_VERSION.exec(current);
  const candidateMatch = CURSOR_VERSION.exec(candidate);
  if (!currentMatch || !candidateMatch) return "unknown";
  const currentDate = cursorDateKey(currentMatch);
  const candidateDate = cursorDateKey(candidateMatch);
  if (!currentDate || !candidateDate || currentDate === candidateDate) return "unknown";
  return candidateDate > currentDate ? "newer" : "older";
}

export function compareManagedRuntimeVersions(input: {
  readonly provider: ManagedRuntimeCatalogProvider;
  readonly current: string;
  readonly candidate: string;
}): ManagedRuntimeVersionComparison {
  if (input.provider === "cursor") {
    return compareCursorVersions(input.current, input.candidate);
  }
  if (!parseSemver(input.current) || !parseSemver(input.candidate)) return "unknown";
  return comparisonFromNumber(compareSemverVersions(input.candidate, input.current));
}

export function isManagedRuntimeUpdate(input: {
  readonly provider: ManagedRuntimeCatalogProvider;
  readonly current: string | null;
  readonly candidate: string;
}): boolean {
  return (
    input.current !== null &&
    compareManagedRuntimeVersions({
      provider: input.provider,
      current: input.current,
      candidate: input.candidate,
    }) === "newer"
  );
}
