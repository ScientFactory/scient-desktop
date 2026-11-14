import type { ServerProvider } from "@t3tools/contracts";

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

/** Why a voice call can't start in this thread now, or null when it can. */
export function liveVoiceUnavailableReason(input: {
  readonly provider: ServerProvider | undefined;
  readonly threadStarted: boolean;
}): string | null {
  const signedIn = input.provider ? scientAgentChatGptSignedIn(input.provider) : undefined;
  if (signedIn === false) return "Sign in to ChatGPT in Scient Agent to talk";
  if (!input.threadStarted) return "Send a first message, then talk";
  return null;
}
