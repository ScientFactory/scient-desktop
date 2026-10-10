import { compareSemverVersions } from "./semver.ts";

const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const EXACT_RELEASE_VERSION = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-[0-9A-Za-z.-]+)?$`,
  "u",
);

export const SCIENT_DESKTOP_RELEASE_REPOSITORY = "ScientFactory/scient-desktop";
export const SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY = "ScientFactory/scient-desktop-beta";

/** Beta artifacts never enter the release index used by installed stable clients. */
export function scientReleaseRepository(version: string): string {
  return /-beta\./u.test(version)
    ? SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY
    : SCIENT_DESKTOP_RELEASE_REPOSITORY;
}

export function scientDesktopUpdateFeed(channel: "latest" | "beta" | "nightly") {
  const repository =
    channel === "beta" ? SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY : SCIENT_DESKTOP_RELEASE_REPOSITORY;
  return {
    provider: "github" as const,
    owner: "ScientFactory",
    repo: repository.slice("ScientFactory/".length),
  };
}
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
  return `https://github.com/${scientReleaseRepository(normalized)}/releases/download/v${normalized}/${scientServerAssetName(normalized)}`;
}

export function scientServerNpxCommand(version: string): string {
  return `npx --yes --allow-scripts=${scientServerAllowedScriptsValue()} --package=${scientServerPackageSpec(version)} ${SCIENT_SERVER_PACKAGE_NAME}`;
}

/** Stable and Beta publication accept distinct, canonical version shapes. */
export function assertScientReleaseChannelVersion(version: string, channel = "stable"): void {
  const valid =
    isExactScientReleaseVersion(version) &&
    (channel === "stable"
      ? !version.includes("-")
      : channel === "beta" && /^\d+\.\d+\.\d+-beta\.\d{8}\.[1-9]\d*$/u.test(version));
  if (!valid)
    throw new Error(
      `${channel === "stable" ? "Stable releases require a canonical x.y.z version" : "Beta releases require x.y.z-beta.YYYYMMDD.N"}, received '${version}'.`,
    );
}

export function assertScientBetaTargetAheadOfStable(beta: string, stable: string): void {
  assertScientReleaseChannelVersion(beta, "beta");
  assertScientReleaseChannelVersion(stable, "stable");
  if (compareSemverVersions(beta, stable) <= 0) {
    throw new Error(`Beta ${beta} must target a version newer than current Stable ${stable}.`);
  }
}
