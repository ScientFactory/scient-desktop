import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  GOOGLE_SITE,
  type EnvironmentId,
} from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { accountsState } from "./accountsState";
import { forgetGoogleCopy } from "./googleCopyObservation";
import { useProfileOperations } from "./profileOperations";
import { useAccountCommand } from "./useAccounts";

/**
 * Signs a profile out of one site on the computer that holds its cookies: another computer's
 * server, or this desktop's partitions after Accounts records it, so other computers delete the
 * site too and Main never gets it back. `recorded` skips that record when the caller made it.
 */
export function useSiteSignOut(environmentId: EnvironmentId) {
  // Another computer's sign-ins live in its own browser, and so do a browser-only client's: the
  // server's. Only a desktop holds its own partitions.
  const remote =
    environmentId !== usePrimaryEnvironmentId() || window.desktopBridge?.accounts === undefined;
  const signOutRemote = useAccountCommand(accountsState.sessionsSignOutLocal, environmentId);
  const recordSignOut = useAccountCommand(accountsState.profileSignedOut, environmentId);
  const operations = useProfileOperations(environmentId);
  const signOut = async (
    profileId: string,
    site: string,
    recorded = false,
    name = profileId,
  ): Promise<boolean> => {
    const accounts = window.desktopBridge?.accounts;
    const profile = BrowserProfileId.make(profileId);
    // With Undo (round 6b): the server records it and signs its own browser out, and this
    // desktop's window signs the partition out, keeping the cookies for the hour. Main too,
    // under the lock it shares with every copy into it (round 6c), unless the caller already
    // recorded the sign-out (a university's, which signs out of every site at once).
    if (operations.supported && (profileId !== DEFAULT_BROWSER_PROFILE_ID || !recorded)) {
      const done = await operations.run("sign-out", { id: profileId, name }, site);
      if (done && site === GOOGLE_SITE) forgetGoogleCopy(environmentId, profileId);
      return done === true;
    }
    const done = remote
      ? await signOutRemote({ profileId: profile, site }).then(
          (result) => result.ok && result.value.signedOut,
        )
      : (recorded || (await recordSignOut({ profileId: profile, site })).ok) &&
        (profileId === DEFAULT_BROWSER_PROFILE_ID
          ? await accounts?.signOutMainSite?.(site, environmentId).catch(() => false)
          : await accounts?.signOutSite?.(profileId, site, environmentId).catch(() => false));
    if (done && site === GOOGLE_SITE) forgetGoogleCopy(environmentId, profileId);
    return done === true;
  };
  const available = remote || window.desktopBridge?.accounts?.signOutSite !== undefined;
  return { signOut, available, remote };
}
