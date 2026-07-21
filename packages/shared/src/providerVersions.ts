// FILE: providerVersions.ts
// Purpose: Strictly parse and compare provider CLI semantic versions across server and web.
// Layer: Shared runtime utility

const SEMVER_NUMBER_SEGMENT = /^\d+$/u;
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/u;

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

function normalizeSemverVersion(version: string): string {
  const [main, prerelease] = version.trim().replace(/^v/u, "").split("-", 2);
  const segments = (main ?? "")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 2) segments.push("0");
  return prerelease ? `${segments.join(".")}-${prerelease}` : segments.join(".");
}

function parseSemver(value: string): ParsedSemver | null {
  const [main = "", prerelease] = normalizeSemverVersion(value).split("-", 2);
  const segments = main.split(".");
  if (segments.length !== 3) return null;

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (
    majorSegment === undefined ||
    minorSegment === undefined ||
    patchSegment === undefined ||
    !SEMVER_NUMBER_SEGMENT.test(majorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(minorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null;
  }

  return {
    major: Number.parseInt(majorSegment, 10),
    minor: Number.parseInt(minorSegment, 10),
    patch: Number.parseInt(patchSegment, 10),
    prerelease:
      prerelease
        ?.split(".")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0) ?? [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = SEMVER_NUMBER_SEGMENT.test(left);
  const rightNumeric = SEMVER_NUMBER_SEGMENT.test(right);
  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left.localeCompare(right);
}

export function isStableSemver(value: string): boolean {
  return STABLE_SEMVER.test(value.trim());
}

export function compareSemverVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) return left.localeCompare(right);

  if (parsedLeft.major !== parsedRight.major) return parsedLeft.major - parsedRight.major;
  if (parsedLeft.minor !== parsedRight.minor) return parsedLeft.minor - parsedRight.minor;
  if (parsedLeft.patch !== parsedRight.patch) return parsedLeft.patch - parsedRight.patch;
  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) return 0;
  if (parsedLeft.prerelease.length === 0) return 1;
  if (parsedRight.prerelease.length === 0) return -1;

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }
  return 0;
}
