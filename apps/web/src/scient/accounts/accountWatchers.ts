import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { environmentSummaries } from "~/state/presentation";
import { watchAccountAutofill } from "./accountAutofill";
import { watchGoogleSessions } from "./googleSessions";

/** Saved sign-ins and session checks run for every environment, whatever the notification settings. */
export function startAccountWatchers(registry: AtomRegistry.AtomRegistry) {
  const watched = new Map<EnvironmentId, () => void>();
  const sync = () => {
    const environmentIds = registry.get(environmentSummaries.environmentIdsAtom);
    for (const [environmentId, stop] of watched) {
      if (environmentIds.includes(environmentId)) continue;
      stop();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (watched.has(environmentId)) continue;
      const stopAutofill = watchAccountAutofill(registry, environmentId);
      const stopGoogleSessions = watchGoogleSessions(registry, environmentId);
      watched.set(environmentId, () => {
        stopAutofill();
        stopGoogleSessions();
      });
    }
  };
  const unsubscribe = registry.subscribe(environmentSummaries.environmentIdsAtom, sync);
  sync();
  return () => {
    unsubscribe();
    for (const stop of watched.values()) stop();
    watched.clear();
  };
}
