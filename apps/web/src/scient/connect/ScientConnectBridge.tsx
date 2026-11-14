/**
 * Lends this window's sign-in to the computer's server whenever it asks, so signing in turns
 * Scient Connect on with nothing else to do. Also moves the computer to the signed-in account
 * when it is linked to another one. Desktop app only; the server does the setup itself.
 */
import { useAuth, useClerk } from "@clerk/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "~/cloud/publicConfig";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { authorizeScientConnect, useScientConnectHost } from "./connectHost";

export function ScientConnectBridge() {
  if (!hasCloudPublicConfig()) return null;
  return <ConfiguredScientConnectBridge />;
}

function ConfiguredScientConnectBridge() {
  // A pending session is not signed out, and a token refresh is not a new sign-in.
  const { isLoaded, isSignedIn, userId, sessionId, getToken } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const environmentId = usePrimaryEnvironmentId();
  const status = useScientConnectHost(environmentId);
  const authorize = useAtomCommand(authorizeScientConnect, { reportFailure: false });
  const clerk = useClerk();
  const answered = useRef<string | null>(null);
  // Bumped after a failed answer, so the same request is tried again a little later.
  const [retry, setRetry] = useState(0);
  const retryTimer = useRef<number | null>(null);

  const block = status?.block;
  const wanted =
    environmentId !== null &&
    status !== null &&
    !status.off &&
    isLoaded &&
    isSignedIn === true &&
    typeof userId === "string" &&
    typeof sessionId === "string" &&
    (status.phase === "needs-authorization" ||
      (status.phase === "connected" && status.linkedAccountId !== userId) ||
      // Another account's limit or failure: this account starts over.
      (status.phase === "blocked" &&
        block !== undefined &&
        "accountId" in block &&
        block.accountId !== undefined &&
        block.accountId !== userId));
  // One answer per server request, per session.
  const requestKey = wanted
    ? `${environmentId}:${sessionId}:${status.phase}:${status.authorizationRequest}:${retry}`
    : null;

  const answer = useEffectEvent(async (key: string) => {
    if (answered.current === key || environmentId === null || !userId || !sessionId) return;
    answered.current = key;
    const token = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    // Signed out or into another account meanwhile: that session answers for itself.
    if (clerk.session?.id !== sessionId) return;
    const delivered =
      token._tag === "Success" &&
      token.value !== null &&
      (
        await authorize({
          environmentId,
          input: { accountId: userId, token: token.value, turnOn: false },
        })
      )._tag === "Success";
    // Offline or between sessions: ask again shortly while the request is still open.
    if (!delivered && retryTimer.current === null) {
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null;
        setRetry((value) => value + 1);
      }, 15_000);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- answers each server token request once, after render
  useEffect(() => {
    if (requestKey !== null) void answer(requestKey);
  }, [requestKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the pending retry when the window closes
  useEffect(
    () => () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    },
    [],
  );

  return null;
}
