/** The agent's `notice` source when its auth layer signed a model account out on its own. */
const SIGNED_OUT_NOTICE_SOURCE = "auth";
const TERMINAL_ADVICE = /\s*Run \/login to sign in again\.?\s*$/u;

/**
 * Scient's wording for the agent's "… was signed out automatically. Run /login to sign in
 * again." notice, or undefined for any other notice. `/login` exists only in the agent's
 * terminal; in Scient the account is signed in again from the composer.
 */
export function scientAgentSignedOutNotice(event: {
  readonly source?: unknown;
  readonly message?: unknown;
}): string | undefined {
  const { source, message } = event;
  if (source !== SIGNED_OUT_NOTICE_SOURCE || typeof message !== "string") return undefined;
  if (!TERMINAL_ADVICE.test(message)) return undefined;
  return `${message.replace(TERMINAL_ADVICE, "")} Sign in again with Reconnect in the composer, or in Settings › Providers.`;
}
