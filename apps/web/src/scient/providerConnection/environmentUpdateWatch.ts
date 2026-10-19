import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";

/** How long a machine may be out of contact before an update on it is treated as lost. */
export const ENVIRONMENT_CONTACT_GRACE_MS = 2 * 60_000;

export type EnvironmentProvidersSnapshot =
  | { readonly status: "removed" | "lost" }
  | { readonly status: "connected"; readonly providers: ReadonlyArray<ServerProvider> };

/**
 * Follows a machine's provider snapshots. A machine removed from the catalog reports at once;
 * one out of contact reports only after the grace period, so a reconnect is not a failure.
 * Returns a stop function that is safe to call from within the callback.
 */
export function watchEnvironmentProviders(
  environmentId: EnvironmentId,
  onSnapshot: (snapshot: EnvironmentProvidersSnapshot) => void,
): () => void {
  let stopped = false;
  let lossTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  const clearLoss = () => {
    if (lossTimer !== null) clearTimeout(lossTimer);
    lossTimer = null;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearLoss();
    unsubscribe?.();
  };
  unsubscribe = appAtomRegistry.subscribe(
    Atom.make((get) => ({
      presentation: get(environmentPresentations.presentationAtom(environmentId)),
      providers: get(serverEnvironment.providersValueAtom(environmentId)),
    })),
    ({ presentation, providers }) => {
      if (stopped) return;
      if (presentation === null) {
        clearLoss();
        onSnapshot({ status: "removed" });
        return;
      }
      const config = presentation.serverConfig;
      if (presentation.connection.phase === "connected" && config !== null) {
        clearLoss();
        onSnapshot({ status: "connected", providers: providers ?? [] });
        return;
      }
      lossTimer ??= setTimeout(() => {
        lossTimer = null;
        if (!stopped) onSnapshot({ status: "lost" });
      }, ENVIRONMENT_CONTACT_GRACE_MS);
    },
    { immediate: true },
  );
  if (stopped) unsubscribe();
  return stop;
}
