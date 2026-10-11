// SCIENT-FORK: Scient keeps its own release identity for environment updates.
//
// Stable discovery rejects every prerelease, including unknown suffixes. Beta
// discovery uses an isolated artifact index so previously released clients
// cannot mistake a Beta tag for Stable. Legacy channel parsing remains available
// at the compatibility boundary.
import {
  SCIENT_DESKTOP_RELEASE_REPOSITORY,
  SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY,
} from "./scientRelease.ts";

export const CLI_RELEASE_CHANNELS = ["stable", "beta", "nightly", "preview"] as const;
export type CliReleaseChannel = (typeof CLI_RELEASE_CHANNELS)[number];

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  if (/^[^-+]+-beta\./u.test(version)) return "beta";
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/**
 * One page of GitHub's list-releases endpoint, newest first. Callers walk pages
 * until a channel match turns up; a busy nightly train can push the newest
 * preview or stable release past any single page.
 */
export function cliReleaseIndexPageUrl(
  page: number,
  channel: CliReleaseChannel = "stable",
): string {
  const repository =
    channel === "beta" ? SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY : SCIENT_DESKTOP_RELEASE_REPOSITORY;
  return `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`;
}

/**
 * Picks the newest version on a channel from the release index. Tags are
 * `v<version>`; the channel is decided by the same rule the runtime uses, so
 * a preview tag never satisfies a nightly lookup and vice versa. Drafts are
 * skipped because their assets are not downloadable.
 */
export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
    readonly prerelease?: boolean | undefined;
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft || (channel === "stable" && release.prerelease)) continue;
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (version === undefined) continue;
    if (channel === "stable" && version.includes("-")) continue;
    if (cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}
