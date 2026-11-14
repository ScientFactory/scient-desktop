import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";

import { scientAgentAccounts } from "../providerConnection/scientAgentAccountList.ts";

/** Scient Agent's ChatGPT sign-in, which carries calls and ChatGPT dictation. */
const CHATGPT_ACCOUNT_ID = "openai-codex";

/** Whether this Scient Agent is signed in to ChatGPT; undefined while its account list is unknown. */
export function scientAgentChatGptSignedIn(provider: ServerProvider): boolean | undefined {
  return scientAgentAccounts(provider)?.some(
    (account) =>
      account.connected &&
      (account.id === CHATGPT_ACCOUNT_ID || account.sameAccountAs === CHATGPT_ACCOUNT_ID),
  );
}

/** The first Scient Agent release that runs a call in an agent of its own. */
const OWN_AGENT_CALL_VERSION = "0.1.10";

/**
 * The Scient Agent instance that runs a call in an agent of its own, so the call needs no running
 * conversation; null when this agent is too old and the call joins the conversation's session.
 */
export function liveVoiceCallInstance(
  provider: ServerProvider | undefined,
): ProviderInstanceId | null {
  if (!provider?.version) return null;
  return compareSemverVersions(provider.version, OWN_AGENT_CALL_VERSION) >= 0
    ? provider.instanceId
    : null;
}

/** Why a voice call can't start in this thread now, or null when it can. */
export function liveVoiceUnavailableReason(input: {
  readonly provider: ServerProvider | undefined;
  readonly threadStarted: boolean;
}): string | null {
  const signedIn = input.provider ? scientAgentChatGptSignedIn(input.provider) : undefined;
  if (signedIn === false) return "Sign in to ChatGPT in Scient Agent to talk";
  if (!input.threadStarted && liveVoiceCallInstance(input.provider) === null) {
    return "Send a first message, then talk";
  }
  return null;
}
