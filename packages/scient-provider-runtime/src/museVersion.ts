/**
 * Muse's release revision is numeric, not a lexically ordered semver prerelease.
 * Stricter than the provider package's advisory parser: an installed release's
 * identity must match its catalog entry exactly, so partial versions never parse.
 */
export function parseManagedMuseVersion(output: string): string | undefined {
  return /(?<![\d.])(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-R(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?\b(?![A-Za-z0-9_.-])/u.exec(
    output,
  )?.[0];
}

export function compareManagedMuseVersions(current: string, candidate: string) {
  const parse = (version: string) => {
    if (parseManagedMuseVersion(version) !== version) return undefined;
    return version.replace("-R", ".").split(".").map(Number);
  };
  const a = parse(current);
  const b = parse(candidate);
  if (!a || !b || [...a, ...b].some((part) => !Number.isSafeInteger(part))) return undefined;
  for (let index = 0; index < 5; index++) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
