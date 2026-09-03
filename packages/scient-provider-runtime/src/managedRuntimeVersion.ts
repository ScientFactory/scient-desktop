import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

import type { ManagedRuntimeCatalogProvider } from "./managedRuntimeArtifact.ts";

export type ManagedRuntimeVersionComparison = "older" | "equal" | "newer" | "unknown";

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
