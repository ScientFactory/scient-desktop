import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function isBetaDesktopVersion(version: string): boolean {
  return /-beta\.\d{8}\.\d+$/u.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isBetaDesktopVersion(appVersion)
    ? "beta"
    : isNightlyDesktopVersion(appVersion)
      ? "nightly"
      : "latest";
}

/** Only an empty Beta release index is a normal pre-publication state. */
export function isEmptyBetaFeedError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.message === "No published versions on GitHub" ||
      ("code" in cause && cause.code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS"))
  );
}
