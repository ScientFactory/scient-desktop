import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ACCOUNTS_PROTOCOL_1,
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
    (useAccounts(environmentId).data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_1
      ? current
      : older;
  const scratchThread = useScratchThread(environmentId);
  return async (
    accountId: AccountId,
    options: { readonly threadId?: ThreadId; readonly discardIfUnfinished?: true } = {},
  ) => {
    const thread = options.threadId
      ? scopeThreadRef(environmentId, options.threadId)
      : await scratchThread();
    if (!thread) return false;
    const panels = useRightPanelStore.getState();
    // A new conversation opens straight onto its browser, loading, rather than an empty chat.
    if (!options.threadId) {
      panels.requestMaximize(thread);
      panels.openBrowser(thread, null);
    }
    const started = await signIn({
      accountId,
      threadId: thread.threadId,
      ...(options.discardIfUnfinished ? { discardIfUnfinished: true } : {}),
    });
    if (!started.ok) {
      if (!options.threadId) panels.closeSurface(thread, "browser:new");
      return false;
    }
    panels.openBrowser(
      scopeThreadRef(environmentId, started.value.threadId ?? thread.threadId),
      started.value.tabId,
    );
    return true;
  };
}
