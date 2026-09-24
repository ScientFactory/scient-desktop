import { ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  ProviderVersionCache,
  resolvePackageManagedProviderMaintenance,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";

/** Global installs of the official CLI. Homebrew and GitHub binaries are separate channels. */
export const OMP_NPM_PACKAGE = "@oh-my-pi/pi-coding-agent";
export const OMP_LATEST_RELEASE_URL =
  "https://api.github.com/repos/can1357/oh-my-pi/releases/latest";

const ReleaseTag = Schema.Struct({ tag_name: Schema.String });
const decodeReleaseTag = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseTag));

const SEMVER = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** Accept `18.2.8` or `v18.2.8`, including the `tag_name` of a GitHub release body. */
export function parseOmpReleaseVersion(source: string): string | null {
  const trimmed = source.trim();
  const direct = SEMVER.exec(trimmed);
  if (direct) return `${direct[1]}.${direct[2]}.${direct[3]}`;
  const decoded = decodeReleaseTag(trimmed);
  if (decoded._tag === "None") return null;
  const tag = SEMVER.exec(decoded.value.tag_name.trim());
  return tag ? `${tag[1]}.${tag[2]}.${tag[3]}` : null;
}

/**
 * Package-owned installs keep that package manager's update command. Every other
 * located binary stays discovery-only: no command, and no npm package name that
 * would make the advisory fetch the registry instead of GitHub.
 */
export const ompMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("ompMaintenance.resolve")(function* (context) {
    const packaged = yield* resolvePackageManagedProviderMaintenance(
      {
        provider: ProviderDriverKind.make("omp"),
        npmPackageName: OMP_NPM_PACKAGE,
        nativeUpdate: null,
      },
      context,
    );
    if (packaged.update) return packaged;
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("omp"),
      packageName: null,
    });
  }),
};

/**
 * Fill the latest GitHub release for installs Scient cannot update in place.
 * Package-manager installs already own their version channel.
 */
export const withOmpReleaseVersion = Effect.fn("withOmpReleaseVersion")(function* (
  capabilities: ProviderMaintenanceCapabilities,
  enabled: boolean,
) {
  if (!enabled || capabilities.update || capabilities.packageName) return capabilities;
  const cache = yield* ProviderVersionCache;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const cached = cache.get(OMP_LATEST_RELEASE_URL);
  if (cached && cached.expiresAt > now) return { ...capabilities, latestVersion: cached.version };
  const client = yield* HttpClient.HttpClient;
  const version = yield* client.get(OMP_LATEST_RELEASE_URL).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? collectUint8StreamText({ stream: response.stream, maxBytes: 1024 * 1024 }).pipe(
            Effect.map((body) => (body.truncated ? null : parseOmpReleaseVersion(body.text))),
          )
        : Effect.succeed(null),
    ),
    Effect.timeout("4 seconds"),
    Effect.orElseSucceed(() => null),
  );
  cache.set(OMP_LATEST_RELEASE_URL, { version, expiresAt: now + 60 * 60 * 1000 });
  return { ...capabilities, latestVersion: version };
});
