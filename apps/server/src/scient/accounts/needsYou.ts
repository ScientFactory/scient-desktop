import type { AccountNeedsYou, AccountSummary } from "@t3tools/contracts";

/**
 * Entries whose item is gone or done leave with it: a removed row takes its entries, and a row
 * seen signed in, by a look or a sign-in, settles its `sign-in:` entry.
 */
export function withNeedsYouSettled<
  S extends {
    readonly accounts: ReadonlyArray<{ readonly summary: AccountSummary }>;
    readonly needsYou?: ReadonlyArray<AccountNeedsYou> | undefined;
  },
>(state: S): S {
  if (!state.needsYou?.length) return state;
  const rows = new Map(state.accounts.map(({ summary }) => [summary.accountId, summary]));
  const kept = state.needsYou.filter((need) => {
    if (need.accountId === undefined) return true;
    const row = rows.get(need.accountId);
    return (
      row !== undefined &&
      !(need.needId === `sign-in:${need.accountId}` && row.signIn?.state === "signed-in")
    );
  });
  return kept.length === state.needsYou.length ? state : { ...state, needsYou: kept };
}
