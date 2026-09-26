import { managedRuntimeSmokeEnvironment } from "@scientfactory/provider-runtime";
import { ProviderDriverKind, type ServerProviderVersionAdvisory } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { ompMajorCompatible } from "./OmpSessionCursor.ts";
import {
  createProviderVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  ProviderVersionCache,
  resolvePackageManagedProviderMaintenance,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";

/** Global installs of the official CLI. Homebrew and GitHub binaries are separate channels. */
const OMP_NPM_PACKAGE = "@oh-my-pi/pi-coding-agent";
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

export const OMP_EXTERNAL_UPDATE_MESSAGE =
  "A newer stable Oh My Pi release is available. This installation is managed outside Scient. Update it with Oh My Pi or the tool that installed it.";
export const OMP_NATIVE_UPDATE_MESSAGE =
  "A newer stable Oh My Pi release is available. Update it with Oh My Pi.";

export const OMP_NATIVE_UPDATE_LOCK_KEY = "omp-native";

/** Managed OMP binaries are owned by the receipt/activation pipeline. */
export const isOmpManagedRuntimePath = (commandPath: string): boolean =>
  /(?:^|[\\/])provider-runtimes[\\/]omp[\\/](?:versions|staging)(?:[\\/]|$)/u.test(commandPath);

/**
 * OMP owns its update protocol. Restrict the native action to the official
 * command names so an arbitrary configured executable is never treated as an
 * updater merely because it can be launched.
 */
export const isOmpNativeUpdatePath = (commandPath: string): boolean => {
  const basename = commandPath.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return (
    basename === "omp" || basename === "omp.exe" || basename === "omp.cmd" || basename === "omp.ps1"
  );
};

const stableRelease = (version: string | null): string | null => {
  if (!version) return null;
  return parseOmpReleaseVersion(version) === version ? version : null;
};

const parentDirectory = (commandPath: string): string => {
  const normalized = commandPath.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  if (separator < 0) return ".";
  if (separator === 2 && normalized[1] === ":") return normalized.slice(0, 3);
  return separator > 0 ? normalized.slice(0, separator) : "/";
};

const OMP_UPDATER_CONFIG_KEYS = [
  "PI_CODING_AGENT_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const;

const ompUpdateEnvironment = (input: {
  readonly commandPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}): NodeJS.ProcessEnv => {
  const separator = input.platform === "win32" ? ";" : ":";
  const configuredPath = input.env.PATH ?? input.env.Path ?? input.env.path ?? "";
  // Keep the updater's environment explicit. The maintenance runner normally
  // inherits the server environment for other providers; OMP must not receive
  // unrelated credentials just to run its own updater.
  const safe = managedRuntimeSmokeEnvironment(input.env);
  const path = [parentDirectory(input.commandPath), configuredPath].filter(Boolean).join(separator);
  const result: NodeJS.ProcessEnv = { ...safe, PATH: path };
  if (input.platform === "win32") result.Path = path;
  for (const key of OMP_UPDATER_CONFIG_KEYS) {
    const value = input.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
};

/**
 * A routine notice is a newer stable release in the same major. A prerelease
 * install and a future major stay unqualified.
 */
const ompRoutineLatestVersion = (
  currentVersion: string | null,
  latestVersion: string | null,
): string | null => {
  const latest = stableRelease(latestVersion);
  if (!latest) return null;
  const current = stableRelease(currentVersion);
  if (current && !ompMajorCompatible(current, latest)) return null;
  if (currentVersion && !current) return null;
  return latest;
};

/**
 * Package-managed and standalone OMP installations both expose the same native
 * `omp update` command. The command is passed as argv (never through a shell),
 * and OMP itself verifies and selects the correct installation channel.
 */
export const ompMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("ompMaintenance.resolve")(function* (context) {
    if (context && isOmpManagedRuntimePath(context.realCommandPath)) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        provider: ProviderDriverKind.make("omp"),
        packageName: null,
      });
    }
    const packaged = yield* resolvePackageManagedProviderMaintenance(
      {
        provider: ProviderDriverKind.make("omp"),
        npmPackageName: OMP_NPM_PACKAGE,
        nativeUpdate: {
          // The advisory is qualified against the stable release channel.
          // Make that channel explicit instead of inheriting a user's canary
          // setting and installing an unqualified release.
          args: ["update", "--stable"],
          isCommandPath: isOmpNativeUpdatePath,
        },
      },
      context,
    );
    const update = packaged.update;
    if (context && update?.lockKey === OMP_NATIVE_UPDATE_LOCK_KEY) {
      // Native OMP updates use the GitHub release channel, not the npm
      // registry version. Keeping packageName null makes the existing
      // maintenance runner resolve and verify the release advisory correctly.
      return {
        ...packaged,
        packageName: null,
        update: {
          ...update,
          inheritEnv: false,
          env: ompUpdateEnvironment({
            commandPath: context.resolvedCommandPath,
            env: context.env,
            platform: context.platform,
          }),
        },
      };
    }
    // A package-manager path that is not an official OMP launcher remains
    // discovery-only; never infer an installer for an arbitrary executable.
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("omp"),
      packageName: null,
    });
  }),
};

export const shapeOmpExternalAdvisory = (input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory => {
  const advisory = createProviderVersionAdvisory({
    driver: ProviderDriverKind.make("omp"),
    currentVersion: input.currentVersion,
    latestVersion: ompRoutineLatestVersion(input.currentVersion, input.latestVersion),
    ...(input.checkedAt === undefined ? {} : { checkedAt: input.checkedAt }),
    maintenanceCapabilities:
      input.maintenanceCapabilities ??
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: ProviderDriverKind.make("omp"),
        packageName: null,
      }),
  });
  if (advisory.status !== "behind_latest") return advisory;
  return {
    ...advisory,
    message: advisory.canUpdate ? OMP_NATIVE_UPDATE_MESSAGE : OMP_EXTERNAL_UPDATE_MESSAGE,
  };
};

/**
 * Fill the latest GitHub release for installs Scient cannot update in place.
 * Package-manager installs already own their version channel.
 */
export const withOmpReleaseVersion = Effect.fn("withOmpReleaseVersion")(function* (
  capabilities: ProviderMaintenanceCapabilities,
  enabled: boolean,
) {
  const usesNativeUpdater = capabilities.update?.lockKey === OMP_NATIVE_UPDATE_LOCK_KEY;
  if (!enabled || (!usesNativeUpdater && (capabilities.update || capabilities.packageName))) {
    return capabilities;
  }
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
