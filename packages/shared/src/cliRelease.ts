// SCIENT-FORK: Scient keeps its own release identity for environment updates.
//
// Upstream's environment-maintenance flow (mobile) checks the release index of
// the repository that publishes the environment server. Scient distributes its
// desktop app and server runtime from `ScientFactory/scient-desktop` rather than
// T3's release feed, and Scient intentionally removed upstream's T3 CLI-release
// module that named `pingdotgg/t3code`. This narrow seam restores the helpers
// that flow needs, pointed at Scient's own release repository.
//
// Keep the behavior identical to upstream: channel names, tag shape, and the
// "never offer a downgrade" rule. Only the repository identity differs.
import { SCIENT_DESKTOP_RELEASE_REPOSITORY } from "./scientRelease.ts";

export type CliReleaseChannel = "stable" | "nightly" | "preview";

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/**
 * One page of GitHub's list-releases endpoint, newest first. Callers walk pages
 * until a channel match turns up; a busy nightly train can push the newest
 * preview or stable release past any single page.
 */
export function cliReleaseIndexPageUrl(page: number): string {
  return `https://api.github.com/repos/${SCIENT_DESKTOP_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;
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
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (version === undefined) continue;
    if (cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}
