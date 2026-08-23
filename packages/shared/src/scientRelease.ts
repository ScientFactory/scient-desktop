const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const EXACT_RELEASE_VERSION = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-[0-9A-Za-z.-]+)?$`,
  "u",
);

export const SCIENT_DESKTOP_RELEASE_REPOSITORY = "ScientFactory/scient-desktop";
export const SCIENT_SERVER_PACKAGE_NAME = "t3";
export const SCIENT_SERVER_ALLOWED_INSTALL_SCRIPTS = [
  "node-pty@1.1.0",
  "msgpackr-extract@3.0.4",
] as const;

export function scientServerAllowedScriptsValue(): string {
  return SCIENT_SERVER_ALLOWED_INSTALL_SCRIPTS.join(",");
}

export function isExactScientReleaseVersion(version: string): boolean {
  return EXACT_RELEASE_VERSION.test(version.trim());
}

export function scientServerAssetName(version: string): string {
  const normalized = version.trim();
  if (!isExactScientReleaseVersion(normalized)) {
    throw new Error(`Invalid Scient server release version: '${version}'.`);
  }
  return `scient-server-${normalized}.tgz`;
}

/**
 * Exact, immutable server package consumed by SSH and background-service
 * runtimes. Scient distributes this through the same signed GitHub release as
 * the desktop app rather than publishing a package name owned by T3.
 */
export function scientServerPackageSpec(version: string): string {
  const normalized = version.trim();
  return `https://github.com/${SCIENT_DESKTOP_RELEASE_REPOSITORY}/releases/download/v${normalized}/${scientServerAssetName(normalized)}`;
}

export function scientServerNpxCommand(version: string): string {
  return `npx --yes --allow-scripts=${scientServerAllowedScriptsValue()} --package=${scientServerPackageSpec(version)} ${SCIENT_SERVER_PACKAGE_NAME}`;
}
