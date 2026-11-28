import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ACCOUNTS_PROTOCOL_2,
  type AccountId,
  type AccountsSnapshot,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { accountHandoffInstruction } from "@t3tools/shared/scientSignInPage";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useGT, useMessages } from "gt-react";
import { XIcon } from "lucide-react";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { environmentShell } from "~/state/shell";
import { buildThreadRouteParams } from "~/threadRoutes";
import { AccountApprovals } from "./AccountApprovals";
import { accountsState } from "./accountsState";
import { HandoffCodeButtons } from "./HandoffCodes";
import { useAccountCommand } from "./useAccounts";
import { useSignIn } from "./useSignIn";

/**
 * Everything waiting for the person, in one place: approvals and sign-ins handed to them, each
 * with its chat. Scient's own upkeep has no chat, so its sign-ins show without one.
 */
export function NeedsYouBand({
  environmentId,
  snapshot,
  canWrite,
}: {
  environmentId: EnvironmentId;
  snapshot: Pick<
    AccountsSnapshot,
    "approvals" | "handoffs" | "needsYou" | "accountsProtocol" | "pendingSecrets" | "accounts"
  >;
  canWrite: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const cancel = useAccountCommand(accountsState.cancelHandoff, environmentId);
  const show = useAccountCommand(accountsState.showHandoff, environmentId);
  const dismiss = useAccountCommand(accountsState.dismissNeedsYou, environmentId);
  const pending = useAccountCommand(accountsState.pending, environmentId);
  const signIn = useSignIn(environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const handoffs = snapshot.handoffs ?? [];
  // Entries and their Dismiss are protocol 2's.
  const needs =
    (snapshot.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2 ? (snapshot.needsYou ?? []) : [];
  const waiting = snapshot.pendingSecrets ?? [];
  if (
    snapshot.approvals.length === 0 &&
    handoffs.length === 0 &&
    needs.length === 0 &&
    waiting.length === 0
  )
    return null;
  const nameOf = (accountId: AccountId) => {
    const row = snapshot.accounts.find((account) => account.accountId === accountId);
    return row?.details.kind === "website" ? (row.details.username ?? row.name) : (row?.name ?? "");
  };
  const isChat = (threadId: ThreadId) =>
    Option.isSome(shell.snapshot) && shell.snapshot.value.threads.some(({ id }) => id === threadId);
  const openChat = (threadId: ThreadId) =>
    isChat(threadId) ? (
      <Button
        size="xs"
        variant="outline"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
          })
        }
      >
        {gt("Open chat")}
      </Button>
    ) : null;
  return (
    <SettingsSection id="accounts-needs-you" title={gt("Needs you")}>
      {snapshot.approvals.map((approval) => (
        <SettingsRow
          key={approval.approvalId}
          title={
            <AccountApprovals
              environmentId={environmentId}
              approvals={[approval]}
              canWrite={canWrite}
            />
          }
          control={openChat(approval.threadId)}
        />
      ))}
      {handoffs.map((handoff) => (
        <SettingsRow
          key={handoff.handoffId}
          title={handoff.accountName}
          description={accountHandoffInstruction(handoff, messages)}
          control={
            <span className="flex flex-wrap items-center gap-2">
              <HandoffCodeButtons
                environmentId={environmentId}
                handoff={handoff}
                canWrite={canWrite}
              />
              {handoff.notLoaded ? (
                <Button
                  size="xs"
                  disabled={!canWrite}
                  onClick={() => void show({ handoffId: handoff.handoffId })}
                >
                  {gt("Open in browser")}
                </Button>
              ) : null}
              {openChat(handoff.threadId)}
              <Button
                size="xs"
                variant="ghost"
                disabled={!canWrite}
                onClick={() => void cancel({ handoffId: handoff.handoffId })}
              >
                {gt("Cancel sign-in")}
              </Button>
            </span>
          }
        />
      ))}
      {needs.map((need) => (
        <SettingsRow
          key={need.needId}
          title={need.name}
          description={need.detail}
          control={
            <span className="flex flex-wrap items-center gap-2">
              {need.action === "sign-in" && need.accountId ? (
                <Button
                  size="xs"
                  disabled={!canWrite}
                  onClick={() => need.accountId && void signIn(need.accountId)}
                >
                  {gt("Sign in")}
                </Button>
              ) : null}
              {need.threadId ? openChat(need.threadId) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Dismiss")}
                disabled={!canWrite}
                onClick={() => void dismiss({ needId: need.needId })}
              >
                <XIcon />
              </Button>
            </span>
          }
        />
      ))}
      {waiting.map((held) => {
        const site = URL.parse(held.site)?.hostname ?? held.site;
        const what =
          held.kind === "password"
            ? held.conflict
              ? gt("{name} changed since this new password for {site} was made. Both are kept.", {
                  site,
                  name: held.accountId ? nameOf(held.accountId) : (held.label ?? site),
                })
              : gt("Did {site} take the new password for {name}?", {
                  site,
                  name: held.accountId ? nameOf(held.accountId) : (held.label ?? site),
                })
            : held.kind === "totp"
              ? held.label
                ? gt("A 2FA key for {label} from this site, waiting to be saved", {
                    label: held.label,
                  })
                : gt("A 2FA key from this site, waiting to be saved")
              : gt("Backup codes from this site, waiting to be saved");
        // A factor goes where the person says: the login its label names first, then each other
        // login of the site (the server sends at most 20), or a new one.
        const choices = [
          ...(held.accountId ? [held.accountId] : []),
          ...(held.candidates ?? []).filter((id) => id !== held.accountId),
        ];
        // The login as shown here: changed meanwhile, the save is refused and asked again.
        const seenAt = (accountId: AccountId) =>
          snapshot.accounts.find((row) => row.accountId === accountId)?.updatedAt;
        return (
          <SettingsRow
            key={held.pendingId}
            title={site}
            description={what}
            control={
              <span className="flex flex-wrap items-center gap-2">
                {held.kind === "password" ? (
                  <Button
                    size="xs"
                    disabled={!canWrite}
                    onClick={() => {
                      const updatedAt = held.accountId ? seenAt(held.accountId) : undefined;
                      void pending({
                        type: "save",
                        pendingId: held.pendingId,
                        ...(held.conflict ? { replace: true as const } : {}),
                        ...(held.conflict && updatedAt ? { updatedAt } : {}),
                      });
                    }}
                  >
                    {held.conflict ? gt("Use this one") : gt("It took it")}
                  </Button>
                ) : (
                  <>
                    {choices.map((accountId) => {
                      const updatedAt = seenAt(accountId);
                      return (
                        <Button
                          key={accountId}
                          size="xs"
                          disabled={!canWrite}
                          onClick={() =>
                            void pending({
                              type: "save",
                              pendingId: held.pendingId,
                              accountId,
                              ...(updatedAt ? { updatedAt } : {}),
                            })
                          }
                        >
                          {gt("Save to {name}", { name: nameOf(accountId) })}
                        </Button>
                      );
                    })}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canWrite}
                      onClick={() => void pending({ type: "save", pendingId: held.pendingId })}
                    >
                      {gt("Save as a new login")}
                    </Button>
                  </>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canWrite}
                  onClick={() => void pending({ type: "discard", pendingId: held.pendingId })}
                >
                  {held.kind !== "password"
                    ? gt("Discard")
                    : held.conflict
                      ? gt("Keep the saved one")
                      : gt("It didn't")}
                </Button>
              </span>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
