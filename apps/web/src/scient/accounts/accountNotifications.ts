import {
  ACCOUNTS_PROTOCOL_2,
  AccountsError,
  type AccountPendingInput,
  type AccountPendingSecret,
  type AccountSummary,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  accountApprovalQuestion,
  accountHandoffInstruction,
} from "@t3tools/shared/scientSignInPage";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { accountsState } from "./accountsState";

const isAccountsError = Schema.is(AccountsError);

/** What was already announced, so a reload doesn't announce it again. */
const readSeen = (key: string) => {
  try {
    return new Set<string>(JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set<string>();
  }
};
const writeSeen = (key: string, seen: ReadonlySet<string>) => {
  try {
    sessionStorage.setItem(key, JSON.stringify([...seen]));
  } catch {
    // Without storage a reload may announce a wait once more; nothing else depends on it.
  }
};

/** A notice's button: `stay` acts where it is; otherwise (or with no `run`) it opens the place. */
export interface AccountNoticeButton {
  readonly label: string;
  readonly run?: () => void;
  readonly stay?: boolean;
}

/** One wait's notice: `waitId` names it, so presenting it again replaces only it. */
export interface AccountNotice {
  readonly waitId: string;
  /** The chat it belongs to; without one it opens Accounts. */
  readonly threadId: ThreadId | undefined;
  readonly title: string;
  readonly body: string;
  /** A code's notice inserts it on the way to the chat. */
  readonly action?: AccountNoticeButton;
  /** A second button, in the app's own notice only. */
  readonly secondary?: AccountNoticeButton;
}

/** Runs a pending secret's answer; a refusal (the login changed meanwhile) says why. */
const answerPending = (
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  input: AccountPendingInput,
) =>
  void runAtomCommand(
    registry,
    accountsState.pending,
    { environmentId, input },
    { reportFailure: false },
  ).then((answered) => {
    if (answered._tag !== "Failure") return;
    const error = Cause.squash(answered.cause);
    if (isAccountsError(error)) toastManager.add({ type: "error", title: error.message });
  });

/**
 * A pending secret's notice. A 2FA key or backup codes: "Save to ‹login›" for the login its label
 * names (else the site's only one), as the person sees it now, and "Other…" to choose in
 * Accounts. A new password the site's answer left unclear: "It took it" / "It didn't". One whose
 * login changed meanwhile (both kept): "Use this one" / "Keep the saved one".
 */
function pendingNotice(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  entry: AccountPendingSecret,
  accounts: ReadonlyArray<AccountSummary>,
): AccountNotice & { readonly version: string } {
  const answer = (input: AccountPendingInput) => () =>
    answerPending(registry, environmentId, input);
  const pendingId = entry.pendingId;
  const base = {
    waitId: pendingId,
    threadId: undefined,
    title: URL.parse(entry.site)?.hostname ?? entry.site,
  };
  // The login as the person sees it now: an answer for it holds only while it stays so.
  const login = accounts.find((account) => account.accountId === entry.accountId);
  if (entry.kind === "password")
    return entry.conflict
      ? {
          ...base,
          version: `:conflict:${login?.updatedAt ?? ""}`,
          body: m(msg("The login changed since this new password was made. Both are kept.")),
          ...(login
            ? {
                action: {
                  label: m(msg("Use this one")),
                  stay: true,
                  run: answer({
                    type: "save",
                    pendingId,
                    replace: true,
                    updatedAt: login.updatedAt,
                  }),
                },
              }
            : {}),
          secondary: {
            label: m(msg("Keep the saved one")),
            stay: true,
            run: answer({ type: "discard", pendingId }),
          },
        }
      : {
          ...base,
          version: ":unclear",
          body: m(msg("Did the site take the new password?")),
          action: {
            label: m(msg("It took it")),
            stay: true,
            run: answer({ type: "save", pendingId }),
          },
          secondary: {
            label: m(msg("It didn't")),
            stay: true,
            run: answer({ type: "discard", pendingId }),
          },
        };
  const body =
    entry.kind === "totp"
      ? m(msg("A 2FA key waits to be saved."))
      : m(msg("Backup codes wait to be saved."));
  if (!login) return { ...base, version: "", body };
  return {
    ...base,
    // The suggestion as shown: another login, or this one changed, is a new notice.
    version: `:${login.accountId}:${login.updatedAt}`,
    body,
    action: {
      label: m(msg("Save to {name}", { name: login.name })),
      stay: true,
      run: answer({
        type: "save",
        pendingId,
        accountId: login.accountId,
        updatedAt: login.updatedAt,
      }),
    },
    secondary: { label: m(msg("Other…")) },
  };
}

/**
 * One notice per approval, hand-off and Needs-you entry: the account in the title, what to do in
 * the body. A wait whose news changes (its codes arrive, one becomes several) is presented again
 * under the same `waitId`; a wait that ends withdraws its own notice and no other.
 */
export function watchAccountNotifications(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  present: (notice: AccountNotice) => void,
  withdraw: (waitId: string) => void,
) {
  const key = `scient:account-notices:${environmentId}`;
  let seen = readSeen(key);
  let waits = new Set<string>();
  return registry.subscribe(
    accountsState.snapshot({ environmentId, input: {} }),
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const notices: Array<AccountNotice & { readonly version: string }> = [];
      // Insert is protocol 2's: an older server's notice says what to do, without the action.
      const speaks2 = (result.value.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2;
      for (const entry of result.value.handoffs ?? []) {
        const codes = speaks2 ? (entry.codes ?? []) : [];
        const [code] = codes;
        // A changed step (a push turned into a code, a new number to tap) is a new notice.
        notices.push({
          waitId: entry.handoffId,
          version: `:${entry.kind}:${entry.number ?? ""}:${entry.via ?? ""}${
            codes.length === 0 ? "" : codes.length === 1 ? `:${code!.codeId}` : ":codes"
          }`,
          threadId: entry.threadId,
          title: entry.accountName,
          body:
            codes.length === 1
              ? m(msg("A code arrived."))
              : codes.length
                ? m(msg("Codes arrived. Pick one in the chat."))
                : accountHandoffInstruction(entry, m),
          // One code: the notice's own click inserts it; with several the person picks in the chat.
          ...(codes.length === 1
            ? {
                action: {
                  label: m(msg("Insert code")),
                  run: () =>
                    void runAtomCommand(
                      registry,
                      accountsState.insertHandoffCode,
                      {
                        environmentId,
                        input: { handoffId: entry.handoffId, codeId: code!.codeId },
                      },
                      { reportFailure: false },
                    ).then((inserted) => {
                      // Another click or Scient itself may have put a code in first.
                      if (inserted._tag !== "Failure") return;
                      const error = Cause.squash(inserted.cause);
                      if (isAccountsError(error))
                        toastManager.add({ type: "error", title: error.message });
                    }),
                },
              }
            : {}),
        });
      }
      for (const entry of result.value.needsYou ?? [])
        notices.push({
          waitId: entry.needId,
          version: `:${entry.detail}`,
          threadId: entry.threadId,
          title: entry.name,
          body: entry.detail,
        });
      for (const entry of result.value.approvals)
        notices.push({
          waitId: entry.approvalId,
          version: "",
          threadId: entry.threadId,
          title: entry.targetName,
          body: accountApprovalQuestion(entry.action, m),
        });
      // Secrets held until the person settles them: the notice itself carries the answer (save to
      // the suggested login, or "It took it" / "It didn't"); anything else opens Accounts.
      for (const entry of result.value.pendingSecrets ?? [])
        notices.push(pendingNotice(registry, environmentId, entry, result.value.accounts));
      const next = new Set(notices.map(({ waitId }) => waitId));
      for (const waitId of waits) if (!next.has(waitId)) withdraw(waitId);
      for (const { version, ...notice } of notices)
        if (!seen.has(notice.waitId + version)) present(notice);
      waits = next;
      seen = new Set(notices.map(({ waitId, version }) => waitId + version));
      writeSeen(key, seen);
    },
    { immediate: true },
  );
}
