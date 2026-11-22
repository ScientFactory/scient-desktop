import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** The public client ID of the Scient for GitHub app. Device flow needs no secret. */
export const SCIENT_GITHUB_APP_CLIENT_ID = "Iv23lieBEtqTwH75xtnk";

/** `flags` with Scient's app when the operator named none (T3 reads an empty value as none). */
export const withScientGitHubApp = (
  flags: FeatureFlags.FeatureFlagValues,
): FeatureFlags.FeatureFlagValues =>
  Option.isNone(flags.githubAppClientId)
    ? { ...flags, githubAppClientId: Option.some(SCIENT_GITHUB_APP_CLIENT_ID) }
    : flags;

/** Provided to the source control drivers, the only readers of the client ID. */
export const scientGitHubAppFeatureFlags = Layer.effect(
  FeatureFlags.FeatureFlags,
  Effect.map(FeatureFlags.FeatureFlags, withScientGitHubApp),
);
