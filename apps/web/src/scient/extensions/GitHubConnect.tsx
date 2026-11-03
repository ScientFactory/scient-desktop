import { useAtomValue } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type EnvironmentId,
  SourceControlProviderKind,
  type SourceControlSignInPrompt,
} from "@t3tools/contracts";
import { CopyIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button, InlineButton } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { NativeSelect } from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAccountBrowser } from "../accounts/useAccountBrowser";

/** A GitHub login Source Control holds; Source Control's own choice comes first. */
export interface SourceControlLogin {
  readonly login: string;
  readonly via: "gh" | "app" | "token" | undefined;
}

type SignIn =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "waiting"; readonly prompt: SourceControlSignInPrompt }
  | { readonly status: "failed"; readonly message: string };

const SIGN_IN_INPUT = { provider: SourceControlProviderKind.make("github"), host: "github.com" };

function signInFailure(result: AtomCommandResult<unknown, unknown>): string {
  const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : undefined;
  return error instanceof Error && "detail" in error
    ? error.message
    : "Scient could not sign in to GitHub. Try again.";
}

/**
 * Connect GitHub with Source Control's account: as a login it already has, or after signing in
 * with GitHub's device code, which then serves Source Control too. A token stays one link away.
 */
export function GitHubConnect({
  environmentId,
  logins,
  busy,
  onConnect,
  onUseToken,
}: {
  readonly environmentId: EnvironmentId;
  readonly logins: ReadonlyArray<SourceControlLogin>;
  readonly busy: boolean;
  readonly onConnect: (account: string) => void;
  readonly onUseToken: () => void;
}) {
  const appSignIn = sourceControlClients.find(SIGN_IN_INPUT.provider)?.credentials?.appSignIn;
  const canSignIn = useAtomValue(
    sourceControlEnvironment.startSignIn.permissionAtom(environmentId),
  );
  const start = useAtomCommand(sourceControlEnvironment.startSignIn, { reportFailure: false });
  const wait = useAtomCommand(sourceControlEnvironment.waitForSignIn, { reportFailure: false });
  const cancel = useAtomCommand(sourceControlEnvironment.cancelSignIn, { reportFailure: false });
  const openInBrowser = useAccountBrowser(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "sign-in code",
  });
  const [chosen, setChosen] = useState("");
  const [signIn, setSignIn] = useState<SignIn>({ status: "idle" });
  const pending = useRef<SourceControlSignInPrompt | null>(null);
  const selected = logins.find((entry) => entry.login === chosen) ?? logins[0];

  const startSignIn = async () => {
    setSignIn({ status: "starting" });
    const started = await start({ environmentId, input: SIGN_IN_INPUT });
    if (started._tag !== "Success") {
      setSignIn({ status: "failed", message: signInFailure(started) });
      return;
    }
    const prompt = started.value;
    pending.current = prompt;
    setSignIn({ status: "waiting", prompt });
    // GitHub never redirects back, so its page can open in Scient's own browser.
    void openInBrowser(prompt.verificationUri, DEFAULT_BROWSER_PROFILE_ID);
    const finished = await wait({ environmentId, input: SIGN_IN_INPUT });
    // A cancel or a newer attempt owns the dialog by now.
    if (pending.current !== prompt) return;
    pending.current = null;
    if (finished._tag !== "Success") {
      setSignIn({ status: "failed", message: signInFailure(finished) });
      return;
    }
    setSignIn({ status: "idle" });
    onConnect(finished.value.account);
  };

  if (signIn.status === "waiting") {
    const { userCode, verificationUri } = signIn.prompt;
    return (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Enter this code on GitHub's device page, then approve {appSignIn?.appName ?? "the app"}.
          Source Control uses the same sign-in.
        </p>
        <div className="flex items-center gap-2">
          <code className="font-mono text-lg font-medium tracking-widest">{userCode}</code>
          <Button
            size="xs"
            variant="outline"
            aria-label="Copy sign-in code"
            onClick={() => copyToClipboard(userCode)}
          >
            <CopyIcon aria-hidden />
            {isCopied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <InlineButton render={<a href={verificationUri} target="_blank" rel="noreferrer" />}>
            {verificationUri.replace(/^https:\/\//, "")}
          </InlineButton>
          <InlineButton
            onClick={() => {
              pending.current = null;
              setSignIn({ status: "idle" });
              void cancel({ environmentId, input: SIGN_IN_INPUT });
            }}
          >
            Cancel sign-in
          </InlineButton>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {selected ? (
        <>
          {logins.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="github-account">Account</Label>
              <NativeSelect
                id="github-account"
                value={selected.login}
                onChange={(event) => setChosen(event.target.value)}
              >
                {logins.map((entry) => (
                  <option key={entry.login} value={entry.login}>
                    {entry.login}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <Button disabled={busy} onClick={() => onConnect(selected.login)}>
            {busy ? <Spinner /> : null}
            Connect as {selected.login}
          </Button>
          <p className="text-xs text-muted-foreground">
            The account Source Control uses. Agents act as {selected.login}.
          </p>
        </>
      ) : (
        <Button
          disabled={busy || !canSignIn || signIn.status === "starting"}
          onClick={() => void startSignIn()}
        >
          {signIn.status === "starting" ? <Spinner /> : null}
          {signIn.status === "failed" ? "Try again" : "Sign in with GitHub"}
        </Button>
      )}
      {signIn.status === "failed" ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {signIn.message}
        </p>
      ) : null}
      {appSignIn && (selected === undefined || selected.via === "app") ? (
        <p className="text-xs text-muted-foreground">
          {appSignIn.appName} reaches the accounts and organizations it is installed on.{" "}
          <InlineButton render={<a href={appSignIn.installUrl} target="_blank" rel="noreferrer" />}>
            Install on an organization
          </InlineButton>
        </p>
      ) : null}
      <p className="text-xs">
        <InlineButton tone="muted" onClick={onUseToken}>
          Use a token instead
        </InlineButton>
      </p>
    </div>
  );
}
