import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ACCOUNTS_PROTOCOL,
  type AccountId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { useScratchThread } from "./useScratchThread";

/**
 * The user's own sign-in to a row, beside the conversation or in a new one. Scient types what it
 * may, resumes a sign-in already waiting at a code, and the person finishes in the tab it shows.
 */
export function useSignIn(environmentId: EnvironmentId) {
  const current = useAccountCommand(accountsState.signInAsPerson, environmentId);
  const older = useAccountCommand(accountsState.universitySignIn, environmentId);
  const signIn =
    (useAccounts(environmentId).data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL ? current : older;
  const scratchThread = useScratchThread(environmentId);
  return async (
    accountId: AccountId,
    options: { readonly threadId?: ThreadId; readonly discardIfUnfinished?: true } = {},
  ) => {
    const thread = options.threadId
      ? scopeThreadRef(environmentId, options.threadId)
      : await scratchThread();
    if (!thread) return false;
    if (!options.threadId) useRightPanelStore.getState().requestMaximize(thread);
    const started = await signIn({
      accountId,
      threadId: thread.threadId,
      ...(options.discardIfUnfinished ? { discardIfUnfinished: true } : {}),
    });
    if (!started.ok) return false;
    useRightPanelStore
      .getState()
      .openBrowser(
        scopeThreadRef(environmentId, started.value.threadId ?? thread.threadId),
        started.value.tabId,
      );
    return true;
  };
}
