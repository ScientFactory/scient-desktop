import type {
  EnvironmentId,
  ProviderConnectionAccount,
  ProviderConnectionOperation,
  ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderIcon,
  LogOutIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderAuthorizationCodeForm } from "./ProviderAuthorizationCodeForm";
import {
  isActiveProviderConnectionOperation,
  isSafeProviderAuthorizationUrl,
  providerLifecycleFailureMessage,
} from "./providerConnectionPresentation";
import {
  type ScientAgentAnswerDraft,
  scientAgentAccountOperation,
  scientAgentAccounts,
  scientAgentAccountSections,
  scientAgentAnswerFor,
} from "./scientAgentAccountList";

const ACCOUNT_METHOD = "scient_agent_account";

type Pending =
  | { readonly kind: "sign-in" | "sign-out"; readonly account: string }
  | { readonly kind: "answer" | "cancel" }
  | null;

/**
 * Sign-in to the model accounts Scient Agent supports. The agent reports the
 * list and runs each sign-in; this shows the list and what the agent asks for.
 */
export function ScientAgentAccounts(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly disabled?: boolean;
}) {
  const startConnection = useAtomCommand(serverEnvironment.startProviderConnection, {
    reportFailure: false,
  });
  const cancelConnection = useAtomCommand(serverEnvironment.cancelProviderConnection, {
    reportFailure: false,
  });
  const submitAnswer = useAtomCommand(serverEnvironment.submitProviderAuthorizationCode, {
    reportFailure: false,
  });
  const disconnect = useAtomCommand(serverEnvironment.disconnectProvider, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  // What was typed belongs to the sign-in it was typed for. Another client can
  // replace that sign-in with one for a different account; the draft must not
  // follow it there.
  const [draft, setDraft] = useState<ScientAgentAnswerDraft>({ operationId: "", value: "" });
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard } = useCopyToClipboard();

  const listed = scientAgentAccounts(props.provider);
  const operation = scientAgentAccountOperation(props.provider);
  const active = isActiveProviderConnectionOperation(operation) ? operation : null;
  const failed = operation?.status === "failed" ? operation : null;
  const answer = scientAgentAnswerFor(draft, active);
  const setAnswer = (value: string) => setDraft({ operationId: active?.operationId ?? "", value });
  // Without a list there is nothing to choose from, but a sign-in that is
  // running or just failed is still shown.
  if (listed === undefined && active === null && failed === null) return null;
  const accounts = listed ?? [];

  const instanceId = props.provider.instanceId;
  const nameOf = (id: string | undefined) =>
    accounts.find((account) => account.id === id)?.name ?? "the account";
  const busy = pending !== null || props.disabled === true;

  const fail = (failure: unknown, fallback: string) =>
    setError(providerLifecycleFailureMessage(failure, fallback));

  const openPage = async (url: string) => {
    if (!isSafeProviderAuthorizationUrl(url)) {
      setError("Scient refused a sign-in link that is not secure.");
      return;
    }
    try {
      await ensureLocalApi().shell.openExternal(url);
    } catch (failure) {
      fail(failure, "Scient could not open the sign-in page.");
    }
  };

  const signIn = async (account: ProviderConnectionAccount) => {
    setError(null);
    setPending({ kind: "sign-in", account: account.id });
    const result = await startConnection({
      environmentId: props.environmentId,
      input: { instanceId, method: ACCOUNT_METHOD, account: account.id },
    });
    setPending(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        fail(
          squashAtomCommandFailure(result),
          `Scient could not start the ${account.name} sign-in.`,
        );
      }
      return;
    }
    const started = result.value.providers.find((provider) => provider.instanceId === instanceId)
      ?.connection?.accountOperation;
    if (started?.authorizationUrl && started.authorizationUrlKind !== "manual_fallback") {
      await openPage(started.authorizationUrl);
    }
  };

  const signOut = async (account: ProviderConnectionAccount) => {
    setError(null);
    setPending({ kind: "sign-out", account: account.id });
    const result = await disconnect({
      environmentId: props.environmentId,
      input: { instanceId, account: account.id },
    });
    setPending(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      fail(squashAtomCommandFailure(result), `Scient could not sign out of ${account.name}.`);
    }
  };

  const sendAnswer = async (current: ProviderConnectionOperation) => {
    if (answer.trim().length === 0) return;
    setError(null);
    setPending({ kind: "answer" });
    const result = await submitAnswer({
      environmentId: props.environmentId,
      input: { instanceId, operationId: current.operationId, authorizationCode: answer },
    });
    setPending(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        fail(
          squashAtomCommandFailure(result),
          "Scient could not hand your answer to Scient Agent.",
        );
      }
      return;
    }
    setAnswer("");
  };

  const cancel = async (current: ProviderConnectionOperation) => {
    setError(null);
    setPending({ kind: "cancel" });
    const result = await cancelConnection({
      environmentId: props.environmentId,
      input: { instanceId, operationId: current.operationId },
    });
    setPending(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      fail(squashAtomCommandFailure(result), "Scient could not cancel the sign-in.");
    }
  };

  const sections = scientAgentAccountSections(accounts, query);
  const activeKind = accounts.find((account) => account.id === active?.account)?.kind;
  const nothingMatches =
    sections.yours.length + sections.accounts.length + sections.keys.length === 0;

  return (
    <section aria-label="Model accounts" className="space-y-3">
      <p className="text-sm font-medium text-foreground">Model accounts</p>
      {active ? (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-start gap-3">
            <LoaderIcon className="mt-0.5 size-5 shrink-0 animate-spin text-primary" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {active.status === "verifying"
                  ? `Verifying ${nameOf(active.account)}`
                  : `Signing in to ${nameOf(active.account)}`}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {active.instructions ?? active.message}
              </p>
            </div>
          </div>
          {active.userCode ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Device code
                </p>
                <code className="mt-1 block text-base font-semibold tracking-wider text-foreground">
                  {active.userCode}
                </code>
              </div>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                aria-label="Copy device code"
                onClick={() => copyToClipboard(active.userCode!, undefined)}
              >
                <CopyIcon />
              </Button>
            </div>
          ) : null}
          {active.acceptsAuthorizationCode === true && active.status !== "verifying" ? (
            <ProviderAuthorizationCodeForm
              authorizationCode={answer}
              disabled={busy}
              inputLabel={active.instructions ?? `Answer for ${nameOf(active.account)}`}
              onAuthorizationCodeChange={setAnswer}
              onSubmit={() => void sendAnswer(active)}
              placeholder={activeKind === "key" ? "Paste the API key" : "Paste the code or URL"}
              providerName={nameOf(active.account)}
              // Always hidden: a key, a code and a redirect URL are all
              // credentials, and the list that says which this is can be missing.
              secret
              submitting={pending?.kind === "answer"}
            />
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {active.authorizationUrl ? (
              <Button
                type="button"
                size="sm"
                variant="ghost-primary"
                onClick={() => void openPage(active.authorizationUrl!)}
              >
                <ExternalLinkIcon />
                Open the sign-in page
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost-destructive-action"
              disabled={busy}
              onClick={() => void cancel(active)}
            >
              {pending?.kind === "cancel" ? <LoaderIcon className="animate-spin" /> : <XIcon />}
              Cancel
            </Button>
          </div>
        </div>
      ) : listed === undefined ? null : (
        <>
          <input
            aria-label="Search model accounts"
            autoCapitalize="none"
            autoComplete="off"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-placeholder focus-visible:border-ring"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search accounts and keys"
            spellCheck={false}
            type="search"
            value={query}
          />
          <div className="max-h-64 overflow-y-auto rounded-lg border">
            <AccountGroup
              accounts={sections.yours}
              busy={busy}
              label="Your accounts"
              pending={pending}
              onSignIn={signIn}
              onSignOut={signOut}
            />
            <AccountGroup
              accounts={sections.accounts}
              busy={busy}
              label="Sign in with an account"
              pending={pending}
              onSignIn={signIn}
              onSignOut={signOut}
            />
            <AccountGroup
              accounts={sections.keys}
              busy={busy}
              label="Add an API key"
              pending={pending}
              onSignIn={signIn}
              onSignOut={signOut}
            />
            {nothingMatches ? (
              <p className="p-3 text-xs text-muted-foreground">No account matches that search.</p>
            ) : null}
          </div>
        </>
      )}
      {failed ? (
        <p className="text-xs leading-relaxed text-muted-foreground" role="status">
          {nameOf(failed.account)}: {failed.message}
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}

function AccountGroup(props: {
  readonly accounts: ReadonlyArray<ProviderConnectionAccount>;
  readonly busy: boolean;
  readonly label: string;
  readonly pending: Pending;
  readonly onSignIn: (account: ProviderConnectionAccount) => Promise<void>;
  readonly onSignOut: (account: ProviderConnectionAccount) => Promise<void>;
}) {
  if (props.accounts.length === 0) return null;
  const working = (account: ProviderConnectionAccount, kind: "sign-in" | "sign-out") =>
    props.pending?.kind === kind && props.pending.account === account.id;
  return (
    <div>
      <p className="sticky top-0 border-b bg-muted/60 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
        {props.label}
      </p>
      <ul className="divide-y">
        {props.accounts.map((account) => (
          <li key={account.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
              {account.connected ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden />
              ) : null}
              <span className="truncate">{account.name}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {account.connected ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost-primary"
                  disabled={props.busy}
                  onClick={() => void props.onSignIn(account)}
                >
                  {working(account, "sign-in") ? <LoaderIcon className="animate-spin" /> : null}
                  {account.kind === "key" ? "Add key" : "Sign in"}
                </Button>
              )}
              {/* A stored sign-in can be removed whether or not it still works. */}
              {account.canDisconnect ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost-destructive-action"
                  disabled={props.busy}
                  onClick={() => void props.onSignOut(account)}
                >
                  {working(account, "sign-out") ? (
                    <LoaderIcon className="animate-spin" />
                  ) : (
                    <LogOutIcon />
                  )}
                  Sign out
                </Button>
              ) : account.connected ? (
                <span className="text-xs text-muted-foreground">From environment</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
