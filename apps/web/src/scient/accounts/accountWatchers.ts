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
import { watchRemoteSessions } from "./remoteSessions";

/**
 * Saved sign-ins and session checks run whatever the notification settings, for the primary
 * environment only: they read the desktop's own jars, and another computer's tabs live in its
 * browser. What the user types in a sign-in goes to the attempt of whichever environment runs it.
 * Each other computer gets this desktop's sign-ins, one way.
 */
export function startAccountWatchers(registry: AtomRegistry.AtomRegistry) {
  offerRemoteQualification(registry);
  let watched: { readonly environmentId: EnvironmentId; readonly stop: () => void } | undefined;
  const keeps = new Map<EnvironmentId, () => void>();
  const remotes = new Map<EnvironmentId, () => void>();
  const sync = () => {
    const primary = registry.get(primaryEnvironmentIdAtom);
    if (watched?.environmentId !== primary) {
      watched?.stop();
      watched = undefined;
      for (const stop of remotes.values()) stop();
      remotes.clear();
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
    // Unlinked: its watchers stop at once; deleting the copies is the removal's own step.
    for (const watchers of [keeps, remotes])
      for (const [environmentId, stop] of watchers) {
        if (environmentIds.includes(environmentId)) continue;
        stop();
        watchers.delete(environmentId);
      }
    for (const environmentId of environmentIds) {
      if (!keeps.has(environmentId))
        keeps.set(environmentId, watchSignInKeeps(registry, environmentId));
      if (primary !== null && environmentId !== primary && !remotes.has(environmentId))
        remotes.set(environmentId, watchRemoteSessions(registry, environmentId, primary));
    }
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
    for (const watchers of [keeps, remotes]) {
      for (const stop of watchers.values()) stop();
      watchers.clear();
    }
  };
}
