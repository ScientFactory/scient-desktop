import type { ProviderAuthState, ServerProvider } from "@t3tools/contracts";

/** Preserve older servers' success semantics, but never infer verification for explicitly unverified setup. */
export function providerAuthPresentation(
  provider: Pick<ServerProvider, "auth" | "installed"> | undefined,
  state: ProviderAuthState | null | undefined,
) {
  const active =
    state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying";
  const unverified = state?.accountVerified === false;
  const signedIn =
    provider?.auth.status === "authenticated" ||
    (provider?.auth.status === "unknown" && state?.phase === "succeeded" && !unverified);
  const unverifiedMessage =
    unverified && (state?.phase === "succeeded" || state?.phase === "idle") ? state.message : null;
  return {
    active,
    signedIn,
    unverified,
    unverifiedMessage,
    canClearCredentials:
      unverified && provider?.installed === true && provider.auth.canLogout === true,
    // A verified provider finishes only when signed in; native-only setup when its write completed.
    finished:
      signedIn ||
      (unverified &&
        (state?.phase === "succeeded" || (state?.phase === "idle" && state.flowId !== null))),
  };
}
