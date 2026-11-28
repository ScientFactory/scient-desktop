import { msg } from "gt-react";
import {
  ACCOUNTS_PROTOCOL_2,
  type AccountId,
  type AccountSummary,
  type AccountsSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { m } from "~/i18n/messages";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";

/** Long enough to read the notice and press Undo; Accounts keeps offering it for the hour. */
const UNDO_NOTICE_MS = 30_000;

type Receipt = { readonly accountId: AccountId; readonly removalId: string };
type Removed = NonNullable<AccountsSnapshot["removed"]>[number];

/**
 * Removals Undo can still bring back, as the person made them: the rows one press removed (a
 * university's) are one, with one Undo.
 */
/** A removal's Undo hour, as its receipt counts it. */
const REMOVED_FOR_MS = 60 * 60 * 1000;

export function removedItems(removed: ReadonlyArray<Removed>) {
  const items = new Map<
    string,
    { name: string; receipts: Array<Receipt>; threadId?: Removed["threadId"]; at: string }
  >();
  for (const entry of removed.toSorted((a, b) => a.until.localeCompare(b.until))) {
    const receipt = { accountId: entry.accountId, removalId: entry.removalId };
    const operation = entry.operationId ?? entry.removalId;
    const item = items.get(operation);
    if (item) item.receipts.push(receipt);
    else
      items.set(operation, {
        name: entry.name,
        receipts: [receipt],
        // When and by which chat, from the removal's own receipt.
        at: new Date(Date.parse(entry.until) - REMOVED_FOR_MS).toISOString(),
        ...(entry.threadId ? { threadId: entry.threadId } : {}),
      });
  }
  return [...items.values()];
}

/**
 * Remove at once, with Undo in the notice that says so and on Accounts for the hour. One item may
 * be several rows (a university's); one Undo brings every row back. `undo` is false on a server
 * older than Accounts protocol 2, which deletes for good; its callers keep their confirmation.
 */
export function useRemoveWithUndo(environmentId: EnvironmentId) {
  const remove = useAccountCommand(accountsState.remove, environmentId);
  const restore = useAccountCommand(accountsState.restore, environmentId);
  const undo = (useAccounts(environmentId).data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2;
  const undoRemoval = (receipts: ReadonlyArray<Receipt>) => {
    for (const receipt of receipts) void restore(receipt);
  };
  const removeAccounts = async (
    rows: ReadonlyArray<Pick<AccountSummary, "accountId" | "updatedAt">>,
    name: string,
    uses: ReadonlyArray<string> = [],
  ) => {
    const operationId = randomUUID();
    const results = await Promise.all(
      rows.map(async ({ accountId, updatedAt }) => ({
        accountId,
        result: await remove({ accountId, updatedAt, operationId }),
      })),
    );
    if (!results.some(({ result }) => result.ok)) return false;
    const receipts = results.flatMap(({ accountId, result }) =>
      result.ok && result.value.removalId ? [{ accountId, removalId: result.value.removalId }] : [],
    );
    toastManager.add({
      type: "success",
      title: m(msg("Removed {name}", { name })),
      ...(uses.length
        ? {
            description: m(
              msg("Used by {uses}", {
                uses: new Intl.ListFormat(undefined, { type: "conjunction" }).format(uses),
              }),
            ),
          }
        : {}),
      ...(undo && receipts.length
        ? {
            timeout: UNDO_NOTICE_MS,
            actionProps: { children: m(msg("Undo")), onClick: () => undoRemoval(receipts) },
          }
        : {}),
    });
    return true;
  };
  const removeAccount = (
    account: Pick<AccountSummary, "accountId" | "name" | "updatedAt">,
    uses: ReadonlyArray<string> = [],
  ) => removeAccounts([account], account.name, uses);
  return { undo, removeAccount, removeAccounts, undoRemoval };
}
