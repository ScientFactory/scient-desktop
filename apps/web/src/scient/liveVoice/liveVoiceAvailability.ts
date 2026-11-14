import type { ServerProvider } from "@t3tools/contracts";

import { scientAgentAccounts } from "../providerConnection/scientAgentAccountList.ts";

/** Scient Agent's ChatGPT sign-in, which carries the call. */
const CHATGPT_ACCOUNT_ID = "openai-codex";

/** Why a voice call can't start in this thread now, or null when it can. */
export function liveVoiceUnavailableReason(input: {
  readonly provider: ServerProvider | undefined;
  readonly threadStarted: boolean;
}): string | null {
  const accounts = input.provider ? scientAgentAccounts(input.provider) : undefined;
  const signedIn = accounts?.some(
    (account) =>
      account.connected &&
      (account.id === CHATGPT_ACCOUNT_ID || account.sameAccountAs === CHATGPT_ACCOUNT_ID),
  );
  if (signedIn === false) return "Sign in to ChatGPT in Scient Agent to talk";
  if (!input.threadStarted) return "Send a first message, then talk";
  return null;
}
