/**
 * Lends this window's sign-in to the computer's server whenever it asks, so signing in turns
 * Scient Connect on with nothing else to do. Also moves the computer to the signed-in account
 * when it is linked to another one. Desktop app only; the server does the setup itself.
 */
import { useAuth, useClerk } from "@clerk/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef } from "react";

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

  const wanted =
    environmentId !== null &&
    status !== null &&
    !status.off &&
    isLoaded &&
    isSignedIn === true &&
    typeof userId === "string" &&
    typeof sessionId === "string" &&
    (status.phase === "needs-authorization" ||
      (status.phase === "connected" && status.linkedAccountId !== userId));
  // One answer per request from the server, per account.
  const requestKey = wanted
    ? `${environmentId}:${userId}:${status.phase}:${status.authorizationRequest}`
    : null;

  const answer = useEffectEvent(async (key: string) => {
    if (answered.current === key || environmentId === null || !userId || !sessionId) return;
    answered.current = key;
    const token = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (token._tag !== "Success" || !token.value) return;
    // Signed out or into another account meanwhile: that session answers for itself.
    if (clerk.session?.id !== sessionId) return;
    await authorize({
      environmentId,
      input: { accountId: userId, token: token.value, turnOn: false },
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- answers each server token request once, after render
  useEffect(() => {
    if (requestKey !== null) void answer(requestKey);
  }, [requestKey]);

  return null;
}
