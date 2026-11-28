import {
  type AccountSummary,
  type AccountsSnapshot,
  keyServesUse,
  type KeyUser,
} from "@t3tools/contracts";

/** One entry in a key picker: a saved key, standing for every row that holds the same value. */
export interface KeyChoice {
  readonly account: AccountSummary;
  /** Other rows with the same value, shown as this one entry. */
  readonly copies: number;
}

/**
 * The keys a use may choose: keys that serve it and fit it, then rows holding the same value grouped
 * into one entry. A row's own rights decide whether it fits before any grouping, so a copy with
 * other rights never stands in for this one. The chosen row always stays, even if it no longer
 * fits, so the picker can show it.
 */
export function keyChoices(
  snapshot: Pick<AccountsSnapshot, "accounts" | "sameKeys">,
  use: KeyUser,
  fits: (account: AccountSummary) => boolean,
  chosen?: string,
): ReadonlyArray<KeyChoice> {
  const fitting = snapshot.accounts.filter(
    (account) => account.accountId === chosen || (keyServesUse(account, use) && fits(account)),
  );
  const groupOf = new Map<string, number>();
  (snapshot.sameKeys ?? []).forEach((ids, group) => {
    for (const id of ids) groupOf.set(id, group);
  });
  const shown = new Map<number | string, KeyChoice>();
  for (const account of fitting) {
    const group = groupOf.get(account.accountId) ?? account.accountId;
    const seen = shown.get(group);
    // The chosen row stands for its group; otherwise the first one listed does.
    if (!seen) shown.set(group, { account, copies: 0 });
    else
      shown.set(group, {
        account: account.accountId === chosen ? account : seen.account,
        copies: seen.copies + 1,
      });
  }
  return [...shown.values()];
}
