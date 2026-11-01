import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// SCIENT-FORK: Stable rejects all prereleases; Beta uses an isolated artifact index so old clients stay safe.
// Legacy channel parsing remains at the compatibility boundary.
import {
  SCIENT_DESKTOP_RELEASE_REPOSITORY,
  SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY,
} from "./scientRelease.ts";

/** Use System32 bsdtar on Windows; Git-for-Windows GNU tar cannot open zip archives. */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export const CLI_RELEASE_CHANNELS = ["stable", "beta", "nightly", "preview"] as const;
export type CliReleaseChannel = (typeof CLI_RELEASE_CHANNELS)[number];

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  if (/^[^-+]+-beta\./u.test(version)) return "beta";
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/** Whether updating between these versions crosses Stable and Nightly. Preview builds cross nothing.
 * Hosts refuse a crossing outside a track switch, which checks the database first. */
export function crossesReleaseTrack(fromVersion: string, toVersion: string): boolean {
  const from = cliReleaseChannelOf(fromVersion);
  const to = cliReleaseChannelOf(toVersion);
  // SCIENT-FORK: Beta crosses nothing either. Stable promotes a Beta commit, and a staged server
  // runtime's preflight refuses a database with migrations it does not know.
  if (from === "beta" || to === "beta") return false;
  return from !== to && from !== "preview" && to !== "preview";
}

/** The desktop update track a build belongs to. Preview builds have no feed and read as Stable. */
// SCIENT-FORK: Beta builds belong to the Beta track.
export function desktopUpdateChannelOf(version: string): "latest" | "beta" | "nightly" {
  const channel = cliReleaseChannelOf(version);
  return channel === "nightly" || channel === "beta" ? channel : "latest";
}

/** Page until the channel matches; nightlies can push preview/stable releases past the first page. */
export function cliReleaseIndexPageUrl(
  page: number,
  channel: CliReleaseChannel = "stable",
): string {
  const repository =
    channel === "beta" ? SCIENT_DESKTOP_BETA_RELEASE_REPOSITORY : SCIENT_DESKTOP_RELEASE_REPOSITORY;
  return `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`;
}

/** Draft assets are not downloadable. */
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

const NpmReleaseMigrationManifest = Schema.Struct({
  t3code: Schema.Struct({ databaseMigration: Schema.Int }),
});
const decodeNpmReleaseMigrationManifest = Schema.decodeUnknownOption(NpmReleaseMigrationManifest);

/** Highest database migration a release's server knows, from its npm `t3` manifest. */
export function npmReleaseDatabaseMigration(manifest: unknown): number | undefined {
  return Option.getOrUndefined(decodeNpmReleaseMigrationManifest(manifest))?.t3code
    .databaseMigration;
}
