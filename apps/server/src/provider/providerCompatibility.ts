import {
  TrimmedNonEmptyString,
  ServerProviderCompatibilityStatus,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import {
  compareSemverVersions,
  normalizeSemverVersion,
  satisfiesSemverRange,
} from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };

// Deliberately uses the shared CLI gate syntax: comparator groups joined by ||.
// Prereleases and unrecognized release tags remain unknown.
const StableVersion = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.makeFilter((value) => /^\d+\.\d+\.\d+$/.test(value))),
);
const VersionRange = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.split("||").every((group) => {
        const tokens = group.trim().split(/\s+/);
        return tokens.every((token) => /^(?:\^|>=|>|<=|<|=)?v?\d+(?:\.\d+){0,2}$/.test(token));
      }),
    ),
  ),
);
const Policy = Schema.Struct({
  driver: TrimmedNonEmptyString,
  t3CodeRange: VersionRange,
  recommendedRange: Schema.optionalKey(VersionRange),
  recommendedVersion: Schema.optionalKey(StableVersion),
  ranges: Schema.Array(
    Schema.Struct({
      range: VersionRange,
      status: ServerProviderCompatibilityStatus,
    }),
  ),
});

export const ProviderCompatibilityPolicy = Policy.pipe(
  Schema.check(
    Schema.makeFilter(
      (policy) => {
        const version = policy.recommendedVersion;
        if (version === undefined) return true;
        return (
          (policy.recommendedRange === undefined ||
            satisfiesSemverRange(version, policy.recommendedRange)) &&
          policy.ranges.find((entry) => satisfiesSemverRange(version, entry.range))?.status ===
            "supported"
        );
      },
      { expected: "a recommended version in a supported range" },
    ),
  ),
);
export type ProviderCompatibilityPolicy = typeof ProviderCompatibilityPolicy.Type;

const FIRST_SCIENT_RELEASE_VERSION = "0.6.0";
const DEVELOPMENT_BUILD_VERSION = `${Number.MAX_SAFE_INTEGER}.0.0`;

/**
 * The version a policy's `t3CodeRange` is matched against. Installed releases
 * fetch the manifest from `main`, so policies that follow code on `main` must be
 * scoped to the next Scient release. Release builds are stamped with their Scient
 * version; unstamped development builds keep upstream's 0.0.x version but run
 * `main`'s code, so they match as newer than every release.
 */
function compatibilityBuildVersion(buildVersion: string): string {
  return compareSemverVersions(buildVersion, FIRST_SCIENT_RELEASE_VERSION) < 0
    ? DEVELOPMENT_BUILD_VERSION
    : buildVersion;
}

export function resolveProviderCompatibility(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  driver: ProviderDriverKind,
  version: string | null,
  t3CodeVersion = packageJson.version,
): ServerProviderCompatibilityAdvisory | undefined {
  const buildVersion = compatibilityBuildVersion(t3CodeVersion);
  const policy = policies?.find(
    (entry) => entry.driver === driver && satisfiesSemverRange(buildVersion, entry.t3CodeRange),
  );
  if (!policy) return undefined;
  const unprefixed = version?.replace(/^v/, "");
  // Cursor appends a build hash to its date; Google's ACP runtime uses a release prefix;
  // Muse appends a release revision. Strip only these driver-specific forms, keeping
  // semver prereleases unknown.
  const stable =
    driver === "cursor"
      ? unprefixed?.replace(/^(\d{4}\.\d{2}\.\d{2})-[a-f0-9]+$/, "$1")
      : driver === "antigravity"
        ? unprefixed?.replace(/^agy_acp_server_(\d+\.\d+\.\d+)$/, "$1")
        : driver === "muse"
          ? unprefixed?.replace(/^(\d+\.\d+\.\d+)-R\d+(?:\.\d+)?$/, "$1")
          : unprefixed;
  const status =
    stable && /^\d+\.\d+\.\d+$/.test(stable)
      ? (policy.ranges.find((entry) => satisfiesSemverRange(stable, entry.range))?.status ??
        "unknown")
      : "unknown";
  const message =
    status === "broken"
      ? "This provider version is known to be incompatible with this Scient release."
      : status === "unsupported"
        ? "This provider version is outside the supported range for this Scient release."
        : status === "graceful"
          ? "This provider version has limited compatibility with this Scient release."
          : null;
  const recommendedVersion = policy.recommendedVersion ?? null;
  const recommendedRange = policy.recommendedRange ?? null;
  const recommendation = recommendedVersion ?? recommendedRange;
  return {
    status,
    message: message && recommendation ? `${message} Use ${recommendation}.` : message,
    recommendedVersion,
    recommendedRange,
  };
}

const isScientVersion = (version: string) =>
  compareSemverVersions(normalizeSemverVersion(version), FIRST_SCIENT_RELEASE_VERSION) >= 0;

/**
 * A range is written for Scient releases when every alternative is bounded in
 * Scient's version space: its lower bound is a Scient release, or it has only
 * an upper bound above the first release (`<0.6.18`). Upstream ranges start in
 * T3's 0.0.x space (`>=0.0.42`, `>=0.0.42 <1.0.0`).
 */
function namesScientRelease(range: string): boolean {
  return range.split("||").every((group) => {
    const comparators = [...group.matchAll(/(\^|>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})/g)];
    const lower = comparators.filter(([, operator]) => operator !== "<" && operator !== "<=");
    const bounds = lower.length > 0 ? lower : comparators;
    return (
      bounds.length > 0 &&
      bounds.every(([, , version]) => version !== undefined && isScientVersion(version))
    );
  });
}

/**
 * The fetched manifest's policies that may apply to this build. The manifest
 * is fetched from `main`, where upstream policies use T3's 0.0.x version space
 * and describe `main`'s code. A release build therefore applies only policies
 * whose range names a Scient release; everything else comes from its bundle.
 */
export function releaseScopedCompatibilityPolicies(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  t3CodeVersion = packageJson.version,
): ReadonlyArray<ProviderCompatibilityPolicy> | undefined {
  if (compatibilityBuildVersion(t3CodeVersion) !== t3CodeVersion) return policies;
  return policies?.filter((policy) => namesScientRelease(policy.t3CodeRange));
}

/** A fetched policy scoped to this build replaces its bundled policy; omission keeps the bundle. */
export function resolveManifestProviderCompatibility(input: {
  readonly manifest: ReadonlyArray<ProviderCompatibilityPolicy> | undefined;
  readonly bundled: ReadonlyArray<ProviderCompatibilityPolicy> | undefined;
  readonly driver: ProviderDriverKind;
  readonly version: string | null;
  readonly t3CodeVersion?: string;
}): ServerProviderCompatibilityAdvisory | undefined {
  const t3CodeVersion = input.t3CodeVersion ?? packageJson.version;
  return (
    resolveProviderCompatibility(
      releaseScopedCompatibilityPolicies(input.manifest, t3CodeVersion),
      input.driver,
      input.version,
      t3CodeVersion,
    ) ?? resolveProviderCompatibility(input.bundled, input.driver, input.version, t3CodeVersion)
  );
}

export function applyProviderCompatibility(
  snapshot: ServerProvider,
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  fallback: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
): ServerProvider {
  const { compatibilityAdvisory: _previous, ...base } = snapshot;
  if (!snapshot.enabled || !snapshot.installed) return base;
  const resolve = (version: string | null) =>
    resolveManifestProviderCompatibility({
      manifest: policies,
      bundled: fallback,
      driver: snapshot.driver,
      version,
    });
  const advisory = resolve(snapshot.version);
  const latestVersion = snapshot.versionAdvisory?.latestVersion;
  const latestAdvisory = latestVersion ? resolve(latestVersion) : undefined;
  return advisory
    ? {
        ...base,
        compatibilityAdvisory: {
          ...advisory,
          ...(latestAdvisory ? { latestVersionStatus: latestAdvisory.status } : {}),
        },
      }
    : base;
}
