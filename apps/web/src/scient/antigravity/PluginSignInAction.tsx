import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type OrchestrationV2PluginSignIn,
  PluginSignInError,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { InlineButton } from "../../components/ui/button";
import { formatEnvironmentQueryError } from "../../state/query";
import { useQuietThreadVisibleTurnItems } from "../../state/entities";
import { sameHostEnvironmentIdsAtom } from "../sameHost";
import { useAtomCommand } from "../../state/use-atom-command";
import { openAuthorizationPage } from "../extensions/openAuthorizationPage";
import { pluginSignInOpenCommand } from "./pluginSignInCommands";

type Phase =
  | { readonly phase: "idle" | "opening" | "opened" | "expired" | "confirmed" }
  | { readonly phase: "blocked"; readonly url: string }
  | { readonly phase: "failed"; readonly message: string };

const isPluginSignInError = Schema.is(PluginSignInError);
const stopRowToggle = (event: KeyboardEvent<HTMLElement> | MouseEvent<HTMLElement>) =>
  event.stopPropagation();

/**
 * Signs an Antigravity plugin in from the notice its failed call raised. The running agent
 * listens for the browser's return on this computer, so the page opens only here.
 */
export function PluginSignInAction({
  environmentId,
  threadId,
  providerThreadId,
  pluginSignIn,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly pluginSignIn: OrchestrationV2PluginSignIn;
}) {
  const gt = useGT();
  const allowed = useAtomValue(pluginSignInOpenCommand.permissionAtom(environmentId));
  const sameHost = useAtomValue(sameHostEnvironmentIdsAtom).has(environmentId);
  const items = useQuietThreadVisibleTurnItems(scopeThreadRef(environmentId, threadId));
  const open = useAtomCommand(pluginSignInOpenCommand, { reportFailure: false });
  const [state, setState] = useState<Phase>({ phase: "idle" });
  // Counts clicks, so a slow answer to an older click changes nothing.
  const attempt = useRef(0);
  const name = pluginSignIn.displayName ?? pluginSignIn.plugin;
  const signedInLater = items.some(
    ({ item }) =>
      item.type === "system_notice" &&
      item.pluginSignIn?.attemptId === pluginSignIn.attemptId &&
      item.pluginSignIn.signedIn === true,
  );

  if (pluginSignIn.signedIn === true || signedInLater || state.phase === "confirmed") {
    return (
      <span className="shrink-0 text-sm text-success-foreground">
        <T>Signed in</T>
      </span>
    );
  }
  if (!allowed) return null;
  if (!sameHost) {
    return (
      <span className="shrink-0 text-sm text-muted-foreground">
        <T>Sign in on the computer that runs this agent</T>
      </span>
    );
  }
  if (state.phase === "expired") {
    return (
      <span className="shrink-0 text-sm text-muted-foreground">
        <T>Ask the agent to try again</T>
      </span>
    );
  }

  const begin = async () => {
    const current = ++attempt.current;
    setState({ phase: "opening" });
    let failure: Phase | null = null;
    const opening = await openAuthorizationPage(async () => {
      const result = await open({
        environmentId,
        input: { threadId, providerThreadId, attemptId: pluginSignIn.attemptId },
      });
      if (result._tag === "Success") return result.value.authorizationUrl;
      const error = Cause.squash(result.cause);
      failure =
        isPluginSignInError(error) && error.reason === "expired"
          ? { phase: "expired" }
          : { phase: "failed", message: formatEnvironmentQueryError(result.cause) };
      return null;
    });
    if (current !== attempt.current) return;
    if (opening.outcome === "opened") setState({ phase: "opened" });
    else if (opening.outcome === "blocked") setState({ phase: "blocked", url: opening.url });
    else setState(failure ?? { phase: "idle" });
  };

  return (
    <>
      {state.phase === "blocked" ? (
        <InlineButton
          render={<a href={state.url} target="_blank" rel="noopener noreferrer" />}
          onClick={(event) => {
            stopRowToggle(event);
            setState({ phase: "opened" });
          }}
          onKeyDown={stopRowToggle}
        >
          <T>Open sign-in page</T>
        </InlineButton>
      ) : (
        <InlineButton
          aria-label={gt("Sign in to {server}", { server: name })}
          disabled={state.phase === "opening"}
          onClick={(event) => {
            stopRowToggle(event);
            void begin();
          }}
          onKeyDown={stopRowToggle}
        >
          {gt("Sign in to {server}", { server: name })}
        </InlineButton>
      )}
      {state.phase === "opened" ? (
        <InlineButton
          tone="muted"
          onClick={(event) => {
            stopRowToggle(event);
            setState({ phase: "confirmed" });
          }}
          onKeyDown={stopRowToggle}
        >
          <T>I've signed in</T>
        </InlineButton>
      ) : null}
      {state.phase === "failed" ? (
        <span role="alert" className="min-w-0 truncate text-sm text-destructive-foreground">
          {state.message}
        </span>
      ) : null}
    </>
  );
}
