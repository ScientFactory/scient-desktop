import { msg } from "gt-react";
import { AccountId, type AccountSummary, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { accountEditorLink } from "./accountsLink";
import { accountsState } from "./accountsState";
import { useRemoveWithUndo } from "./removeWithUndo";
import { useAccountCommand } from "./useAccounts";

/**
 * What a saved login offers wherever it is listed: Show and Copy its password (the person's own
 * reveal, recorded as theirs), its editor, and Remove with Undo.
 */
export function useLoginActions(environmentId: EnvironmentId) {
  const revealCommand = useAccountCommand(accountsState.reveal, environmentId);
  const navigate = useNavigate();
  const { undo, removeAccounts } = useRemoveWithUndo(environmentId);
  const reveal = async (accountId: string) => {
    const shown = await revealCommand({ accountId: AccountId.make(accountId), field: "password" });
    return shown.ok ? shown.value.value : undefined;
  };
  return {
    reveal,
    copy: async (accountId: string) => {
      const password = await reveal(accountId);
      if (password === undefined) return;
      await navigator.clipboard.writeText(password).then(
        () => toastManager.add({ type: "success", title: m(msg("Password copied")) }),
        () => toastManager.add({ type: "error", title: m(msg("Couldn't copy the password")) }),
      );
    },
    edit: (accountId: string) =>
      void navigate(accountEditorLink(environmentId, AccountId.make(accountId))),
    /**
     * One login: every copy goes with one Undo. None on a server older than Accounts protocol 2,
     * which removes for good: there the login's editor removes it, after asking.
     */
    remove: undo
      ? (copies: ReadonlyArray<Pick<AccountSummary, "accountId" | "updatedAt">>, name: string) =>
          removeAccounts(copies, name)
      : undefined,
  };
}
