import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import { hasCloudAccount, useCloudAccount } from "./useCloudAccount";

/** The account known to have synced conversations, so the sidebar can offer them. */
const syncedAccountAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("scient-cloud:synced-account"),
);

/** Called when this computer starts syncing, so the sidebar shows the entry right away. */
export function markCloudConversationsAvailable(userId: string): void {
  appAtomRegistry.set(syncedAccountAtom, userId);
}

function useSignedInCloudConversationsAvailable(): boolean {
  const account = useCloudAccount();
  const syncedAccount = useAtomValue(syncedAccountAtom);
  const userId = account.isSignedIn ? account.userId : null;
  const known = userId !== null && syncedAccount === userId;
  const listComputers = useEffectEvent(() => account.api.computers());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks Scient Cloud once whether any of the person's computers syncs
  useEffect(() => {
    if (userId === null || known) return;
    let cancelled = false;
    listComputers().then(
      (computers) => {
        if (!cancelled && computers.length > 0) markCloudConversationsAvailable(userId);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [userId, known]);
  return known;
}

/** Whether the signed-in person has conversations in Scient Cloud from any computer. */
export const useCloudConversationsAvailable: () => boolean = hasCloudAccount()
  ? useSignedInCloudConversationsAvailable
  : () => false;
