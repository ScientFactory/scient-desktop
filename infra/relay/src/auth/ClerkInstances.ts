// SCIENT-FORK:START clerk-legacy-instance — whole file.
// Scient moved sign-in from its development Clerk instance to production. Builds up to
// v0.6.28 still sign in with the development instance, so the relay also accepts tokens
// it issued while those builds update. Remove with CLERK_LEGACY_* once they have aged out.
import * as Redacted from "effect/Redacted";
import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";

import type * as RelayConfiguration from "../Config.ts";

export interface ClerkInstance {
  readonly name: "primary" | "legacy";
  readonly secretKey: Redacted.Redacted<string>;
  readonly publishableKey: string;
}

type Settings = Pick<
  RelayConfiguration.RelayConfiguration["Service"],
  "clerkSecretKey" | "clerkPublishableKey" | "clerkLegacy"
>;

export const primaryClerkInstance = (config: Settings): ClerkInstance => ({
  name: "primary",
  secretKey: config.clerkSecretKey,
  publishableKey: config.clerkPublishableKey,
});

export const legacyClerkInstance = (config: Settings): ClerkInstance | undefined =>
  config.clerkLegacy ? { name: "legacy", ...config.clerkLegacy } : undefined;

const jwtIssuerHostname = (token: string): string | undefined => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const json = globalThis.atob(payload.replace(/-/gu, "+").replace(/_/gu, "/"));
    const issuer = (JSON.parse(json) as { readonly iss?: unknown }).iss;
    return typeof issuer === "string" ? new URL(issuer).hostname : undefined;
  } catch {
    return undefined;
  }
};

const frontendApiHostname = (publishableKey: string): string | undefined => {
  try {
    return clerkFrontendApiHostnameFromPublishableKey(publishableKey);
  } catch {
    return undefined;
  }
};

/**
 * The instance whose keys verify a session JWT: legacy only when the token names it as
 * issuer. The issuer is read unverified; the chosen instance's keys still verify it.
 */
export const clerkInstanceForJwt = (config: Settings, token: string): ClerkInstance => {
  const legacy = legacyClerkInstance(config);
  if (!legacy) return primaryClerkInstance(config);
  const issuer = jwtIssuerHostname(token);
  return issuer !== undefined && issuer === frontendApiHostname(legacy.publishableKey)
    ? legacy
    : primaryClerkInstance(config);
};

/**
 * Instances that may hold the user a bearer token names, most likely first. An opaque OAuth
 * token names no issuer, so it may come from either instance.
 */
export const clerkInstancesForBearer = (
  config: Settings,
  token: string,
): ReadonlyArray<ClerkInstance> => {
  const legacy = legacyClerkInstance(config);
  if (jwtIssuerHostname(token) !== undefined || !legacy) {
    return [clerkInstanceForJwt(config, token)];
  }
  return [primaryClerkInstance(config), legacy];
};
// SCIENT-FORK:END clerk-legacy-instance
