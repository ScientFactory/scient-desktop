import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { environmentSummaries } from "~/state/presentation";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { watchAccountAutofill } from "./accountAutofill";
import { watchGoogleSessions } from "./googleSessions";
import { watchKeepSignedIn } from "./keepSignedIn";
import { watchMainFill } from "./mainFill";
import { watchSignInKeeps } from "./signInKeeps";
import { offerRemoteQualification } from "./qualifyRemoteSessions";

/**
 * Saved sign-ins and session checks run whatever the notification settings, for the primary
 * environment only: they read the desktop's own jars, and another computer's tabs live in its
 * browser. What the user types in a sign-in goes to the attempt of whichever environment runs it.
 */
export function startAccountWatchers(registry: AtomRegistry.AtomRegistry) {
  offerRemoteQualification(registry);
  let watched: { readonly environmentId: EnvironmentId; readonly stop: () => void } | undefined;
  const keeps = new Map<EnvironmentId, () => void>();
  const sync = () => {
    const primary = registry.get(primaryEnvironmentIdAtom);
    if (watched?.environmentId !== primary) {
      watched?.stop();
      watched = undefined;
      if (primary !== null) {
        const stops = [
          watchAccountAutofill(registry, primary),
          watchGoogleSessions(registry, primary),
          watchKeepSignedIn(registry, primary),
          watchMainFill(registry, primary),
        ];
        watched = { environmentId: primary, stop: () => stops.forEach((stop) => stop()) };
      }
    }
    const environmentIds = registry.get(environmentSummaries.environmentIdsAtom);
    for (const [environmentId, stop] of keeps) {
      if (environmentIds.includes(environmentId)) continue;
      stop();
      keeps.delete(environmentId);
    }
    for (const environmentId of environmentIds)
      if (!keeps.has(environmentId))
        keeps.set(environmentId, watchSignInKeeps(registry, environmentId));
  };
  const unsubscribe = [
    registry.subscribe(primaryEnvironmentIdAtom, sync),
    registry.subscribe(environmentSummaries.environmentIdsAtom, sync),
  ];
  sync();
  return () => {
    for (const stop of unsubscribe) stop();
    watched?.stop();
    watched = undefined;
    for (const stop of keeps.values()) stop();
    keeps.clear();
  };
}
