// FILE: onboarding.logic.ts
// Purpose: Pure state rules for the first-run "connect your accounts" surface.
// Layer: Web presentation logic

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { Schema } from "effect";

export const ONBOARDING_STORAGE_KEY = "scient:onboarding:v1";

export const OnboardingStorageSchema = Schema.Struct({
  completedAt: Schema.NullOr(Schema.String),
  dismissed: Schema.Boolean,
});
export type OnboardingStorage = typeof OnboardingStorageSchema.Type;

export const INITIAL_ONBOARDING_STORAGE: OnboardingStorage = {
  completedAt: null,
  dismissed: false,
};

/**
 * Accounts featured on first run: the providers a new install is most likely
 * to connect. Every row reuses the regular provider connection dialog, so the
 * rest of the catalog stays one click away in Settings.
 */
export const ONBOARDING_FEATURED_PROVIDERS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "antigravity",
];

export type OnboardingVisibility = "show" | "complete" | "hide";

/**
 * Decides whether the first-run surface may appear.
 *
 * - Never before the first complete provider snapshot (no flashing).
 * - Never again once dismissed or completed.
 * - "complete" when a featured provider is already connected — either from a
 *   previous life of this install or because the user just finished a sign-in
 *   while the surface was open; the caller records completion.
 */
export function decideOnboardingVisibility(input: {
  readonly storage: OnboardingStorage;
  readonly providers: ReadonlyArray<ServerProviderStatus> | undefined;
}): OnboardingVisibility {
  if (input.storage.dismissed || input.storage.completedAt !== null) return "hide";
  if (!input.providers || input.providers.length === 0) return "hide";
  const anyFeaturedConnected = input.providers.some(
    (status) =>
      ONBOARDING_FEATURED_PROVIDERS.includes(status.provider) &&
      status.available &&
      status.authStatus === "authenticated",
  );
  return anyFeaturedConnected ? "complete" : "show";
}

export type OnboardingProviderStateKind =
  | "connected"
  | "sign_in_pending"
  | "not_connected"
  | "checking";

/** Plain-language per-row state chip derived from the provider status. */
export function onboardingProviderState(
  status: ServerProviderStatus | undefined,
): OnboardingProviderStateKind {
  if (!status) return "checking";
  if (status.available && status.authStatus === "authenticated") return "connected";
  const operation = status.connectionState;
  if (operation && ["starting", "waiting_for_browser", "verifying"].includes(operation.status)) {
    return "sign_in_pending";
  }
  const installation = status.installationState;
  if (
    installation &&
    !["installed", "succeeded", "failed", "cancelled"].includes(installation.status)
  ) {
    return "sign_in_pending";
  }
  if (status.available || status.runtime !== undefined) return "not_connected";
  return "checking";
}
