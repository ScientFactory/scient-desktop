import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { getClientSettings, subscribeClientSettings } from "~/hooks/useSettings";
import { environmentPresentations, environmentSummaries } from "~/state/presentation";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { watchAccountAutofill } from "./accountAutofill";
import { watchGoogleSessions } from "./googleSessions";
import { watchKeepSignedIn } from "./keepSignedIn";
import { watchMainFill } from "./mainFill";
import { watchPasswordUpdates } from "./passwordUpdates";
import { desktopSources } from "./desktopSources";
import { watchPasswordFixes } from "./newPasswords";
import { watchProfileReports, type ThisDesktop } from "./profileReports";
import { watchProfileData } from "./profileDataWatcher";
import { watchSignInKeeps } from "./signInKeeps";
import { offerRemoteQualification } from "./qualifyRemoteSessions";
import { watchRemoteSessions } from "./remoteSessions";

/**
 * Saved sign-ins and session checks run for the primary environment only: they read the
 * desktop's own jars. Filling and keeping what is typed follow each window's tabs; the background
 * work (checks, Main fill, delivery to other computers) runs only in the window the desktop names.
 */
export function startAccountWatchers(registry: AtomRegistry.AtomRegistry) {
  // The desktop app's own: other computers' agents import its browser profiles through it.
  const thisDesktop: ThisDesktop | undefined = window.desktopBridge?.accounts?.sourceProfiles
    ? {
        computer: () => {
          const primary = registry.get(primaryEnvironmentIdAtom);
          if (primary === null) return undefined;
          const label =
            registry.get(environmentPresentations.presentationAtom(primary))?.serverConfig
              ?.environment.label ?? "this desktop";
          return { id: primary, label: label.slice(0, 80) };
        },
        sources: desktopSources,
        ownBackend: (environmentId) => environmentId === registry.get(primaryEnvironmentIdAtom),
      }
    : undefined;
  offerRemoteQualification(registry);
  const elect = window.desktopBridge?.accounts?.onAccountsOwner;
  let owner = elect === undefined;
  let watched:
    | { readonly environmentId: EnvironmentId; readonly owner: boolean; readonly stop: () => void }
    | undefined;
  const keeps = new Map<EnvironmentId, () => void>();
  // Told once, in the window that does Accounts' background work, for every computer: a keep
  // on another computer updates that computer's login.
  const passwords = new Map<EnvironmentId, () => void>();
  // Each computer's Accounts names this client's profiles (protocol 2), from one window.
  const reports = new Map<EnvironmentId, () => void>();
  const remotes = new Map<EnvironmentId, () => void>();
  const sync = () => {
    const primary = registry.get(primaryEnvironmentIdAtom);
    if (watched?.environmentId !== primary || watched.owner !== owner) {
      watched?.stop();
      watched = undefined;
      for (const stop of remotes.values()) stop();
      remotes.clear();
      if (primary !== null) {
        const stops = [
          watchAccountAutofill(registry, primary),
          watchPasswordFixes(registry, primary),
          ...(owner
            ? [
                watchGoogleSessions(registry, primary),
                // Keeps this desktop's own sessions in use; the server renews and signs in.
                watchKeepSignedIn(registry, primary),
                watchMainFill(registry, primary),
              ]
            : []),
        ];
        watched = { environmentId: primary, owner, stop: () => stops.forEach((stop) => stop()) };
      }
    }
    const environmentIds = registry.get(environmentSummaries.environmentIdsAtom);
    const sharing = owner && getClientSettings().signInSharingEnabled;
    // Unlinked: its watchers stop at once; deleting the copies is the removal's own step.
    for (const watchers of [keeps, remotes, passwords, reports])
      for (const [environmentId, stop] of watchers) {
        const wanted =
          watchers === keeps
            ? true
            : watchers === passwords || watchers === reports
              ? owner
              : sharing;
        if (environmentIds.includes(environmentId) && wanted) continue;
        stop();
        watchers.delete(environmentId);
      }
    for (const environmentId of environmentIds) {
      if (!keeps.has(environmentId))
        keeps.set(environmentId, watchSignInKeeps(registry, environmentId));
      if (owner && !passwords.has(environmentId))
        passwords.set(environmentId, watchPasswordUpdates(registry, environmentId));
      if (owner && !reports.has(environmentId)) {
        // This desktop follows each computer's profile decisions (round 6b), from one window.
        const stops = [
          watchProfileReports(registry, environmentId, thisDesktop),
          watchProfileData(registry, environmentId, () => thisDesktop?.computer()?.id),
        ];
        reports.set(environmentId, () => stops.forEach((stop) => stop()));
      }
      if (sharing && primary !== null && environmentId !== primary && !remotes.has(environmentId))
        remotes.set(environmentId, watchRemoteSessions(registry, environmentId, primary));
    }
  };
  const unsubscribe = [
    registry.subscribe(primaryEnvironmentIdAtom, sync),
    registry.subscribe(environmentSummaries.environmentIdsAtom, sync),
    subscribeClientSettings(sync),
    ...(elect
      ? [
          elect((next) => {
            if (next === owner) return;
            owner = next;
            sync();
          }),
        ]
      : []),
  ];
  sync();
  return () => {
    for (const stop of unsubscribe) stop();
    watched?.stop();
    watched = undefined;
    for (const watchers of [keeps, remotes, passwords, reports]) {
      for (const stop of watchers.values()) stop();
      watchers.clear();
    }
  };
}
