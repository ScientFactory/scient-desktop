import { isSupportedOmpMajor } from "@scientfactory/provider-runtime";
import type { ServerProviderVersionAdvisory } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  formatProviderUpdateCommand,
  homebrewOwnershipFromCommandPath,
  makeManualOnlyProviderMaintenanceCapabilities,
  ProviderVersionCache,
  type ProviderMaintenanceCapabilitiesResolver,
  type ProviderMaintenanceResolutionContext,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { ompTarget } from "./OmpTarget.ts";

/**
 * Scient never runs Oh My Pi's own updater: `omp update` cannot install a
 * chosen version, follows npm `latest` across majors, and has no rollback.
 * System installs get a version advisory with the command to run by hand;
 * Scient-managed installs update through the managed-runtime pipeline.
 */
const PROVIDER = ompTarget.driverKind;

/** npm `latest`: what bun, npm and the standalone installer's `omp update` install. */
export const OMP_NPM_LATEST_URL = "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest";
/**
 * The `can1357/tap/omp` formula. Homebrew's formulae API publishes only the
 * official taps (it answers 404 for `omp`), so `brew upgrade` installs
 * whatever version this file names after `brew update` pulls the tap.
 */
export const OMP_HOMEBREW_FORMULA_URL =
  "https://raw.githubusercontent.com/can1357/homebrew-tap/HEAD/Formula/omp.rb";
/** The GitHub release channel: mise's source, and the fallback for the others. */
export const OMP_LATEST_RELEASE_URL =
  "https://api.github.com/repos/can1357/oh-my-pi/releases/latest";

const LATEST_VERSION_TIMEOUT = "4 seconds";
const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;
const LATEST_VERSION_MAX_BYTES = 1024 * 1024;

const ReleaseTag = Schema.Struct({ tag_name: Schema.String });
const decodeReleaseTag = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseTag));
const NpmLatest = Schema.Struct({ version: Schema.String });
const decodeNpmLatest = Schema.decodeUnknownOption(Schema.fromJsonString(NpmLatest));

const SEMVER = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

const stableVersion = (value: string): string | null => {
  const match = SEMVER.exec(value.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
};

/** Accept `18.2.8` or `v18.2.8`, including the `tag_name` of a GitHub release body. */
export function parseOmpReleaseVersion(source: string): string | null {
  const direct = stableVersion(source);
  if (direct) return direct;
  const decoded = decodeReleaseTag(source.trim());
  return decoded._tag === "Some" ? stableVersion(decoded.value.tag_name) : null;
}

/** The stable `version "x.y.z"` declared by the tap's Ruby formula. */
export function parseOmpFormulaVersion(source: string): string | null {
  const declared = /^\s*version\s+"([^"]+)"\s*$/mu.exec(source)?.[1];
  return declared ? stableVersion(declared) : null;
}

const parseNpmLatest = (source: string): string | null => {
  const decoded = decodeNpmLatest(source);
  return decoded._tag === "Some" ? stableVersion(decoded.value.version) : null;
};

/**
 * Who installed the executable. `package` covers npm, bun, pnpm and the
 * standalone installer, whose `omp update` all follow npm `latest`.
 */
export type OmpInstallChannel = "package" | "homebrew" | "mise" | "nix" | "managed";

export interface OmpInstallation {
  /** The executable as found on PATH or configured; what the user runs. */
  readonly resolvedCommandPath: string;
  readonly realCommandPath: string;
  readonly channel: OmpInstallChannel;
  readonly platform: NodeJS.Platform;
}

/** Managed OMP binaries are owned by the receipt/activation pipeline. */
const isOmpManagedRuntimePath = (commandPath: string): boolean =>
  /(?:^|[\\/])provider-runtimes[\\/]omp[\\/](?:versions|staging)(?:[\\/]|$)/u.test(commandPath);

const isMisePath = (commandPath: string): boolean =>
  /(?:^|[\\/])mise[\\/](?:installs|shims)[\\/]/iu.test(commandPath);

export const classifyOmpInstallation = (
  context: ProviderMaintenanceResolutionContext,
): OmpInstallation => {
  const paths = [context.resolvedCommandPath, context.realCommandPath];
  const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
  const channel: OmpInstallChannel = paths.some(isOmpManagedRuntimePath)
    ? "managed"
    : paths.some((path) => path.replaceAll("\\", "/").startsWith("/nix/store/"))
      ? "nix"
      : paths.some(isMisePath)
        ? "mise"
        : homebrew?.kind === "formula" && homebrew.name.toLowerCase() === "omp"
          ? "homebrew"
          : "package";
  return {
    resolvedCommandPath: context.resolvedCommandPath,
    realCommandPath: context.realCommandPath,
    channel,
    platform: context.platform,
  };
};

/**
 * Locate the configured executable the same way the maintenance resolver
 * does. A binary that cannot be found has no installation to advise on.
 */
export const resolveOmpInstallation = Effect.fn("resolveOmpInstallation")(function* (input: {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}) {
  const resolvedCommandPath = yield* resolveCommandPath(input.binaryPath, { env: input.env }).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (!resolvedCommandPath) return null;
  const fs = yield* FileSystem.FileSystem;
  const realCommandPath = yield* fs
    .realPath(resolvedCommandPath)
    .pipe(Effect.orElseSucceed(() => resolvedCommandPath));
  return classifyOmpInstallation({
    binaryPath: input.binaryPath,
    resolvedCommandPath,
    realCommandPath,
    env: input.env,
    platform: input.platform,
  });
});

/** Every Oh My Pi installation is manual-only: Scient never spawns an OMP updater. */
export const ompMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: () =>
    Effect.succeed(
      makeManualOnlyProviderMaintenanceCapabilities({ provider: PROVIDER, packageName: null }),
    ),
};

const fetchLatest = (url: string, parse: (body: string) => string | null) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("accept", "application/json")),
    );
    if (response.status < 200 || response.status >= 300) return null;
    const body = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: LATEST_VERSION_MAX_BYTES,
    });
    return body.truncated ? null : parse(body.text);
  }).pipe(
    Effect.timeout(LATEST_VERSION_TIMEOUT),
    Effect.orElseSucceed(() => null),
  );

/** A cached success is reused; a failed lookup is never cached, so it is retried. */
const cachedLatest = (url: string, parse: (body: string) => string | null) =>
  Effect.gen(function* () {
    const cache = yield* ProviderVersionCache;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const cached = cache.get(url);
    if (cached?.version && cached.expiresAt > now) return cached.version;
    const version = yield* fetchLatest(url, parse);
    if (version) cache.set(url, { version, expiresAt: now + LATEST_VERSION_CACHE_TTL_MS });
    return version;
  });

const primarySource = (
  channel: OmpInstallChannel,
): { readonly url: string; readonly parse: (body: string) => string | null } | null => {
  switch (channel) {
    case "package":
      return { url: OMP_NPM_LATEST_URL, parse: parseNpmLatest };
    case "homebrew":
      return { url: OMP_HOMEBREW_FORMULA_URL, parse: parseOmpFormulaVersion };
    case "mise":
      return { url: OMP_LATEST_RELEASE_URL, parse: parseOmpReleaseVersion };
    case "nix":
    case "managed":
      return null;
  }
};

/**
 * The latest stable release the user's install channel would deliver. Nix
 * pins its own inputs and managed runtimes update through Scient, so neither
 * is checked here.
 */
export const resolveOmpLatestVersion = Effect.fn("resolveOmpLatestVersion")(function* (
  installation: OmpInstallation,
) {
  const primary = primarySource(installation.channel);
  if (!primary) return null;
  const version = yield* cachedLatest(primary.url, primary.parse);
  if (version || primary.url === OMP_LATEST_RELEASE_URL) return version;
  return yield* cachedLatest(OMP_LATEST_RELEASE_URL, parseOmpReleaseVersion);
});

/** Nix has no `omp update`; every other channel's `omp update` delegates to its owner. */
const manualUpdateCommand = (installation: OmpInstallation): string | null =>
  installation.channel === "nix" || installation.channel === "managed"
    ? null
    : formatProviderUpdateCommand(
        installation.resolvedCommandPath,
        ["update"],
        installation.platform,
      );

const advisoryMessage = (input: {
  readonly latestVersion: string;
  readonly command: string | null;
  readonly managedAvailable: boolean;
}): string =>
  [
    `Oh My Pi ${input.latestVersion} is available.`,
    input.command
      ? `Update this installation by running \`${input.command}\` in a terminal.`
      : "Update this installation with the tool that installed it.",
    input.managedAvailable
      ? "Or use Scient-managed Oh My Pi, which Scient verifies and updates for you."
      : null,
  ]
    .filter((part) => part !== null)
    .join(" ");

/**
 * A notice is offered only for a newer stable release inside the supported
 * major, from a stable install in that same major. The advisory never carries
 * an update action.
 */
export const shapeOmpVersionAdvisory = (input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly installation: OmpInstallation | null;
  readonly managedAvailable: boolean;
  readonly checkedAt: string | null;
}): ServerProviderVersionAdvisory => {
  const current = input.currentVersion ? stableVersion(input.currentVersion) : null;
  const latest = input.latestVersion ? stableVersion(input.latestVersion) : null;
  const base = {
    currentVersion: input.currentVersion,
    canUpdate: false,
    canInstallVersion: false,
    checkedAt: input.checkedAt,
  };
  if (
    current === null ||
    latest === null ||
    !isSupportedOmpMajor(current) ||
    !isSupportedOmpMajor(latest)
  ) {
    return { ...base, status: "unknown", latestVersion: null, updateCommand: null, message: null };
  }
  if (compareSemverVersions(current, latest) >= 0) {
    return {
      ...base,
      status: "current",
      latestVersion: latest,
      updateCommand: null,
      message: null,
    };
  }
  const command = input.installation ? manualUpdateCommand(input.installation) : null;
  return {
    ...base,
    status: "behind_latest",
    latestVersion: latest,
    updateCommand: command,
    message: advisoryMessage({
      latestVersion: latest,
      command,
      managedAvailable: input.managedAvailable,
    }),
  };
};
