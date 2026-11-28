import {
  ACCOUNTS_PROTOCOL_2,
  AccountsError,
  type AccountNeedsYou,
  type AccountsSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

/** One chat's requests, or those of no chat the phone lists, as the desktop's Accounts band. */
export type AccountRequestsScope =
  | { readonly threadId: ThreadId }
  | { readonly outside: ReadonlySet<string> };

export function accountRequestsIn(
  data: AccountsSnapshot | null | undefined,
  scope: AccountRequestsScope,
) {
  const here = (threadId: string | undefined) =>
    "threadId" in scope
      ? threadId === scope.threadId
      : threadId === undefined || !scope.outside.has(threadId);
  // Insert and Dismiss are protocol 2's.
  const speaks2 = (data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2;
  return {
    speaks2,
    approvals: data?.approvals.filter((item) => here(item.threadId)) ?? [],
    handoffs: data?.handoffs?.filter((item) => here(item.threadId)) ?? [],
    needs: speaks2 ? (data?.needsYou?.filter((item) => here(item.threadId)) ?? []) : [],
    // What this chat's papers wait on that one tap here settles: a sign-in, or turning it on.
    papers: ("threadId" in scope ? (data?.paperQueues ?? []) : [])
      .filter((queue) => here(queue.threadId))
      .flatMap((queue) =>
        queue.requests.flatMap((request) =>
          (request.kind === "sign-in" || request.kind === "access") && request.accountId
            ? [{ root: queue.root, request, accountId: request.accountId }]
            : [],
        ),
      ),
  };
}

/** Where a sign-in started from the phone opens when its entry came from no chat. */
const PHONE_SIGN_IN_THREAD = ThreadId.make("scient-accounts-phone");

/**
 * The person's own sign-in for a waiting entry, started from the phone: beside the chat it came
 * from, else on its own. Its steps (a push number, a code, the computer's tab) show here too.
 */
export const needSignIn = (need: AccountNeedsYou, scope: AccountRequestsScope) =>
  need.action === "sign-in" && need.accountId !== undefined
    ? {
        accountId: need.accountId,
        threadId: need.threadId ?? ("threadId" in scope ? scope.threadId : PHONE_SIGN_IN_THREAD),
      }
    : undefined;

const isAccountsError = Schema.is(AccountsError);

/** Account errors are written for the person, such as a code that lost to another. */
export const accountsErrorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isAccountsError(error) ? error.message : undefined;
};
