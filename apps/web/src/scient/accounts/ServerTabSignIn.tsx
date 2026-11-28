import { msg } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import {
  ACCOUNTS_PROTOCOL_2,
  AccountId,
  PreviewTabId,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";
import { InputGroupAddon } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { savedPasswordsLink } from "./accountsLink";
import { useLoginActions } from "./loginActions";
import { loginState, signInKeyChoices } from "./savedLogins";
import { accountsState } from "./accountsState";
import { signInChoiceLabels, signInsForTab } from "@t3tools/shared/scientAccountSignIn";
import { SignInKey } from "./SignInKey";
import { useAccountCommand, useAccounts } from "./useAccounts";

/**
 * The key on a tab the server runs, on web and the phone: Scient signs the person in on that tab
 * with the saved sign-in, on the server, so no password reaches this device.
 */
export function ServerTabSignIn({
  environmentId,
  threadRef,
  previewTabId,
  profileId,
  url,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  previewTabId: string;
  profileId: string;
  url: string;
}) {
  const { data, canWrite } = useAccounts(environmentId);
  const signIn = useAccountCommand(accountsState.signInAsPerson, environmentId);
  const login = useLoginActions(environmentId);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  // The login the person chose on this page of this tab, on this computer: the key shows it, and
  // Edit opens its row. The controls stay mounted when another tab shows, so all four are kept.
  const page = `${environmentId}\u0000${threadRef.threadId}\u0000${previewTabId}\u0000${url}`;
  const [chosen, setChosen] = useState<{ accountId: string; page: string } | null>(null);
  if (!data || !canWrite || (data.accountsProtocol ?? 0) < ACCOUNTS_PROTOCOL_2) return null;
  const matches = signInsForTab(data.accounts, url, profileId);
  if (matches.length === 0) return null;
  const filled =
    chosen?.page === page
      ? matches.find((match) => match.accountId === chosen.accountId)
      : undefined;
  // Copies of one login are one choice, signed in with the copy in this tab's profile.
  const choices = signInKeyChoices(matches, profileId, filled?.accountId, data.accounts);
  const labels = signInChoiceLabels(choices.map(({ account }) => account));
  return (
    <InputGroupAddon align="inline-end">
      <SignInKey
        site={new URL(url).hostname}
        rows={choices.map(({ account, copies }) => ({
          accountId: account.accountId,
          username: labels.get(account.accountId) ?? "",
          ...loginState(copies),
        }))}
        filledId={filled?.accountId}
        busy={busy}
        onFill={async (accountId) => {
          setBusy(true);
          const started = await signIn({
            accountId: AccountId.make(accountId),
            threadId: threadRef.threadId,
            tabId: PreviewTabId.make(previewTabId),
          });
          setBusy(false);
          if (started.ok) setChosen({ accountId, page });
          else toastManager.add({ type: "error", title: m(msg("Could not fill sign-in")) });
        }}
        onReveal={login.reveal}
        onCopy={(accountId) => void login.copy(accountId)}
        onEditRow={login.edit}
        onRemove={
          login.remove &&
          ((accountId) => {
            const choice = choices.find(({ account }) => account.accountId === accountId);
            if (choice)
              void login.remove?.(
                choice.copies,
                labels.get(choice.account.accountId) || choice.account.name,
              );
          })
        }
        onEdit={() => void navigate(savedPasswordsLink(environmentId, url))}
      />
    </InputGroupAddon>
  );
}
