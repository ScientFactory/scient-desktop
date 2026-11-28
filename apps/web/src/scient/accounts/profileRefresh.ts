import {
  type AccountsSnapshot,
  type EnvironmentId,
  type ProfileImportCause,
  type ProfileOperation,
  type ProfileStoreOutcome,
  DEFAULT_BROWSER_PROFILE_ID,
  linksBrowserProfile,
} from "@t3tools/contracts";
import { previewBridge } from "~/components/preview/previewBridge";
import { importBrowserCookiesIntoTarget } from "~/components/settings/IntegrationsSettings";
import { loadSourceProfiles, sitesToKeep } from "./accountsView";
import { recordImportedSessions } from "./importedSessions";
import { sendMainRefresh } from "./mainFill";

/**
 * An agent's import or refresh from a profile's linked browser profile (round 6b), on this
 * desktop with the same import the person's Refresh runs. It copies the person's own browser
 * sign-ins and has no Undo; Activity records it (round 6m). Sources are found by their link only.
 */
export async function refreshFromLink(input: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: AccountsSnapshot;
  readonly operation: ProfileOperation;
  /**
   * Asks its computer's Accounts again whether it still stands: after the import, which may have
   * waited on the OS's prompt, an answer of no stops it before its passwords.
   */
  readonly stillStands?: () => Promise<boolean>;
}): Promise<ProfileStoreOutcome> {
  const { environmentId, snapshot, operation } = input;
  const stillStands = input.stillStands ?? (() => Promise.resolve(true));
  const bridge = window.desktopBridge?.accounts;
  // An import's own source, linked once it succeeds; a refresh's, the profile's link.
  const link =
    operation.link ??
    snapshot.profiles.find(({ profileId }) => profileId === operation.profileId)?.source;
  // Each failure keeps its cause, which names the one thing to do (round 6d).
  const failure = (cause: ProfileImportCause): ProfileStoreOutcome => ({ state: "failed", cause });
  if (!link) return failure("notLinked");
  if (!previewBridge || !bridge) return failure("sessionUnavailable");
  const sources = await loadSourceProfiles().catch(() => []);
  const source = sources.find(({ id }) => id === link.browser);
  const profile = source?.profiles.find((candidate) =>
    linksBrowserProfile(link, { ...candidate, browser: source.id }),
  );
  if (!source) return failure("unknownSource");
  if (!profile) return failure("unknownSourceProfile");
  let cause: ProfileImportCause | undefined;
  let imported = 0;
  let passwords: number | undefined;
  if (operation.cookies) {
    const result = await importBrowserCookiesIntoTarget(previewBridge, source, environmentId, {
      sourceProfileDirectory: profile.directory,
      target: { kind: "existing", profileId: operation.profileId, name: link.profileName },
      keepSites: sitesToKeep(snapshot.accounts, operation.profileId, undefined),
      fillMain: false,
      // Into the data it was decided in (round 6e).
      ...(operation.generation === undefined ? {} : { targetGeneration: operation.generation }),
      // Its write asks this desktop's backend whether it still stands (round 6f).
      operationId: operation.operationId,
    });
    // The computer's managed policy comes as its own sentence; every other reason by name.
    if (result.kind === "blocked")
      cause = "message" in result && result.message ? "managedPolicy" : result.reason;
    else imported = result.importedSites ?? 0;
    // Removed, or no longer the agent's, while the browser asked: it wrote only while it stood,
    // and has no Undo (round 6m).
    if (!(await stillStands())) return failure("stopped");
    // Main's import goes to other computers only now, past its check, and only once it copied
    // something into Main; the server checks the operation again as it records it (6j-6l).
    if (operation.profileId === DEFAULT_BROWSER_PROFILE_ID && imported > 0)
      await sendMainRefresh(environmentId, operation.operationId);
    // Cookies show as imported until a page confirms the sign-in.
    await recordImportedSessions(
      environmentId,
      operation.profileId,
      `${source.name} · ${profile.name}`,
      { fillMain: false },
    );
  }
  // Asked for, passwords are read or the import says why not: never done without them.
  if (
    operation.passwords &&
    (profile.passwordCount === undefined || !bridge.importBrowserPasswords)
  )
    cause ??= "passwordsUnreadable";
  // Asked again before the browser's passwords are read: an OS wait may have come between.
  else if (operation.passwords && !(await stillStands())) cause ??= "stopped";
  else if (operation.passwords && bridge.importBrowserPasswords) {
    // Read by the desktop and handed by it straight to its own backend, under the operation:
    // refused once it no longer stands, never wider than the profile (round 6f).
    const saved = await bridge
      .importBrowserPasswords({
        sourceId: source.id,
        directory: profile.directory,
        profileId: operation.profileId,
        refresh: true,
        operationId: operation.operationId,
      })
      .catch(() => null);
    if (!saved) cause ??= "passwordsUnreadable";
    else if (!saved.result) cause ??= "passwordsNotSaved";
    else passwords = saved.result.created + saved.result.updated;
  }
  if (cause) return failure(cause);
  return {
    state: "done",
    copied: imported,
    ...(passwords === undefined ? {} : { passwords }),
  };
}
