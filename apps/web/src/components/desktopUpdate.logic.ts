import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import {
  SCIENT_DESKTOP_RELEASE_REPOSITORY,
  SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY,
  scientReleaseRepository,
} from "@t3tools/shared/scientRelease";
import { isWindowsPlatform } from "~/lib/utils";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

// SCIENT-FORK: invalid configuration must remain in Scient's release authority.
const DEFAULT_DESKTOP_RELEASE_REPOSITORY = SCIENT_DESKTOP_RELEASE_REPOSITORY;
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(
  repository: string | undefined,
  // SCIENT-FORK: exact builds can select the isolated Beta repository.
  fallback = DEFAULT_DESKTOP_RELEASE_REPOSITORY,
): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : fallback;
  // SCIENT-FORK:START — stable and Beta builds keep their owning distribution repository.
  const owningRepository =
    releaseRepository === SCIENT_DESKTOP_RELEASE_REPOSITORY ||
    releaseRepository === SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY
      ? fallback
      : releaseRepository;
  return `https://github.com/${owningRepository}/releases`;
  // SCIENT-FORK:END
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  // SCIENT-FORK: release notes belong to the exact build's distribution.
  return `${desktopReleaseRepositoryUrl(repository, scientReleaseRepository(normalizedVersion))}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

// SCIENT-FORK:START — existing callers select stable/Beta history by update channel.
export function getDesktopUpdateReleaseHistoryUrl(
  channelOrRepository?: string,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string {
  const isChannel =
    channelOrRepository === undefined ||
    channelOrRepository === "latest" ||
    channelOrRepository === "beta" ||
    channelOrRepository === "nightly";
  return desktopReleaseRepositoryUrl(
    isChannel ? repository : channelOrRepository,
    channelOrRepository === "beta"
      ? SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY
      : SCIENT_DESKTOP_RELEASE_REPOSITORY,
  );
}
// SCIENT-FORK:END

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

// SCIENT-FORK:START — the desktop downloads an offered update by itself. Until it is ready the
// control stays idle, unless the download failed or the user started it; then it shows progress.
export function isBackgroundDesktopUpdate(
  state: DesktopUpdateState | null,
  userStartedDownload: boolean,
): boolean {
  if (state === null || userStartedDownload) return false;
  if (state.status === "downloading") return true;
  return state.status === "available" && state.errorContext !== "download";
}

export function getDesktopUpdateBackgroundTooltip(
  state: DesktopUpdateState,
  resolve: MessageResolver = m,
): string {
  const version = state.availableVersion || null;
  if (state.status !== "downloading") {
    return version === null
      ? resolve(msg("Update will download in the background"))
      : resolve(msg("Update {version} will download in the background", { version }));
  }
  const percent = state.downloadPercent;
  if (typeof percent === "number" && Number.isFinite(percent)) {
    const progress = Math.floor(Math.min(100, Math.max(0, percent)));
    return version === null
      ? resolve(msg("Downloading update in the background ({percent}%)", { percent: progress }))
      : resolve(
          msg("Downloading update {version} in the background ({percent}%)", {
            version,
            percent: progress,
          }),
        );
  }
  return version === null
    ? resolve(msg("Downloading update in the background"))
    : resolve(msg("Downloading update {version} in the background", { version }));
}
// SCIENT-FORK:END

/** Scient's compact footer copy; action admission remains owned by the updater. */
export function getScientDesktopUpdateLabel(
  state: DesktopUpdateState,
  resolve: MessageResolver = m,
): string | null {
  if (state.status === "downloading") {
    const percent = state.downloadPercent;
    return percent !== null && Number.isFinite(percent)
      ? `${Math.floor(Math.min(100, Math.max(0, percent)))}%`
      : "…";
  }
  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "none") return null;
  if (state.errorContext === "download" || state.errorContext === "install")
    return resolve(msg("Retry", { $context: "button, retries a failed app update" }));
  // SCIENT-FORK: a downloaded update is one click away; its card offers the restart.
  return resolve(msg("Update", { $context: "button, starts an app update" }));
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading" || state?.status === "preparing";
}

export function getArm64IntelBuildWarningDescription(
  state: DesktopUpdateState,
  resolve: MessageResolver = m,
): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return resolve(msg("This install is using the correct architecture."));
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return resolve(
      msg(
        "This Mac has Apple Silicon, but Scient is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
      ),
    );
  }
  if (action === "install") {
    return resolve(
      msg(
        "This Mac has Apple Silicon, but Scient is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
      ),
    );
  }
  return resolve(
    msg(
      "This Mac has Apple Silicon, but Scient is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
    ),
  );
}

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  resolve: MessageResolver = m,
): string {
  if (state.status === "preparing") {
    return state.message ?? resolve(msg("Preparing update… You can keep working."));
  }
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return resolve(
      msg("Update {version} did not apply. Click to retry.", { version: state.notAppliedVersion }),
    );
  }
  if (
    (state.status === "available" || state.status === "error") &&
    state.errorContext === "download" &&
    state.availableVersion
  ) {
    return resolve(
      msg("Download failed for {version}. Click to retry.", { version: state.availableVersion }),
    );
  }
  if (state.status === "available") {
    return state.availableVersion === null
      ? resolve(msg("Update available ready to download"))
      : resolve(msg("Update {version} ready to download", { version: state.availableVersion }));
  }
  if (state.status === "downloading") {
    return typeof state.downloadPercent === "number"
      ? resolve(
          msg("Downloading update ({percent}%)", { percent: Math.floor(state.downloadPercent) }),
        )
      : resolve(msg("Downloading update"));
  }
  if (state.status === "downloaded") {
    // SCIENT-FORK: the click opens the restart card.
    const version = state.downloadedVersion ?? state.availableVersion;
    return version === null
      ? resolve(msg("Restart and update to the new version"))
      : resolve(msg("Restart and update to {version}", { version }));
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return resolve(
        msg("Install failed for {version}. Click to retry.", { version: state.downloadedVersion }),
      );
    }
    if (state.downloadedVersion) {
      return resolve(msg("Restart and update to {version}", { version: state.downloadedVersion }));
    }
    return state.message ?? resolve(msg("Update failed"));
  }
  return resolve(msg("Up to date"));
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  resolve: MessageResolver = m,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const windowsInstallWarning = isWindowsPlatform(platform)
    ? resolve(
        msg(
          "On Windows, Scient may remain closed for several minutes while the update installs, and no installer window may appear. Scient will reopen automatically when installation finishes.",
        ),
      )
    : null;
  const confirmation = version
    ? resolve(
        msg(
          "Install update {version} and restart Scient?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
          { version },
        ),
      )
    : resolve(
        msg(
          "Install update and restart Scient?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
        ),
      );
  return windowsInstallWarning === null
    ? confirmation
    : `${confirmation}\n\n${windowsInstallWarning}`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  // SCIENT-FORK: still preparing means the installer took over; every failure leaves preparing.
  if (result.state.status === "preparing") return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "preparing" &&
    state.status !== "disabled"
  );
}

/** `managedDenial` is this machine's policy refusing updates (`managedUpdatesDenial`); it wins. */
export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
  resolve: MessageResolver = m,
): string | null {
  if (managedDenial !== undefined) return managedDenial;
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return (
    state.message?.trim() || resolve(msg("Automatic updates are not available in this build."))
  );
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
  resolve: MessageResolver = m,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state, managedDenial, resolve);
  return disabledReason
    ? { title: resolve(msg("Updates unavailable")), detail: disabledReason }
    : { title: resolve(msg("Check for updates")), detail: null };
}
