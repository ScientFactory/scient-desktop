import type { AccountsSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { pickBrowserProfile } from "@t3tools/shared/scientBrowserProfileChoice";
import { AsyncResult } from "effect/reactivity";
import type { BrowserDefaults } from "~/browser/browserDefaults";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";
import { accountsState } from "./accountsState";

const SNAPSHOT_WAIT_MS = 1_500;

async function accountsSnapshot(threadRef: ScopedThreadRef) {
  const input = { environmentId: threadRef.environmentId, input: {} };
  const current = appAtomRegistry.get(accountsState.snapshot(input));
  if (AsyncResult.isSuccess(current)) return current.value;
  // A locked or unreachable store must not hold up opening a link.
  const read = await Promise.race([
    accountsState.readSnapshot.run(appAtomRegistry, input),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SNAPSHOT_WAIT_MS)),
  ]);
  return read?._tag === "Success" ? read.value : undefined;
}

/**
 * The profile for a tab the user opens without naming one: their switch for this site in this
 * conversation, the profile signed in to the site, this conversation's, the project's, then the
 * default (`pickBrowserProfile`).
 */
export async function openProfileId(
  threadRef: ScopedThreadRef,
  url: string | undefined,
  defaults: BrowserDefaults,
): Promise<string> {
  const snapshot: AccountsSnapshot | undefined = await accountsSnapshot(threadRef).catch(
    () => undefined,
  );
  if (!snapshot) return defaults.profileId;
  return pickBrowserProfile({
    url,
    threadId: threadRef.threadId,
    projectId: appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef))?.projectId,
    profiles: defaults.profiles
      .filter((profile) => profile.kind !== "incognito")
      .map((profile) => profile.id),
    signIns: snapshot.accounts.flatMap((account) =>
      account.details.kind === "website" && account.details.profileId
        ? [
            {
              profileId: account.details.profileId,
              sites: account.details.sites,
              signedOut: account.signedOut,
            },
          ]
        : [],
    ),
    choices: snapshot.profileChoices,
    defaultProfileId: defaults.profileId,
  }).profileId;
}
