import type { AccountSignIn, AccountSignInState, AccountSummary } from "@t3tools/contracts";

const LIMITED_PAUSE_MS = 60 * 60 * 1000;
const RETRY_PAUSE_MS = 15 * 60 * 1000;

type SignInFields = Pick<AccountSummary, "signIn"> & Partial<Pick<AccountSummary, "secrets">>;

/** What a sign-in attempt leaves besides `signed-in`. A look can also find a limit or `needs-you`. */
const ATTEMPT_STATES: ReadonlySet<AccountSignInState> = new Set([
  "needs-you",
  "password-rejected",
  "code-rejected",
  "limited",
  "failed",
]);

const within = (signIn: AccountSignIn | undefined, ms: number, nowMs: number) =>
  signIn !== undefined && nowMs - Date.parse(signIn.at) < ms;

/** The site said it is limiting automation, within the hour. */
export const siteLimiting = (account: Pick<AccountSummary, "signIn">, nowMs: number) =>
  account.signIn?.state === "limited" && within(account.signIn, LIMITED_PAUSE_MS, nowMs);

/**
 * The site refused what's saved, so nothing should try it again until that changes: a rejected
 * password, or a rejected code while a code secret is saved. Only a new attempt or a save that
 * changes the password or code replaces it; nothing seen on the site does (see `withSignIn`).
 */
export const signInRefused = (account: SignInFields) =>
  account.signIn?.state === "password-rejected" ||
  // A one-time code the user typed says nothing about what's saved, and nothing here can change it.
  (account.signIn?.state === "code-rejected" && account.secrets?.totp !== undefined);

/**
 * True while Scient must not try this sign-in by itself: refused, limited within the hour, or
 * needing the user or failed within 15 minutes. A refused one can lock the account, a site
 * limiting automation stays limited for longer when pushed, and one that failed or needed the user
 * will do the same again.
 */
export const signInOnHold = (account: SignInFields, nowMs: number) =>
  signInRefused(account) ||
  siteLimiting(account, nowMs) ||
  ((account.signIn?.state === "needs-you" || account.signIn?.state === "failed") &&
    within(account.signIn, RETRY_PAUSE_MS, nowMs));

/** Signed in within 15 minutes and needed again: something keeps ending it. */
export const signedInMomentsAgo = (account: Pick<AccountSummary, "signIn">, nowMs: number) =>
  account.signIn?.state === "signed-in" && within(account.signIn, RETRY_PAUSE_MS, nowMs);

/**
 * True while Scient must not sign in by itself. Beyond the hold, one whose last attempt needed the
 * user, was refused, limited or failed would only do so again with nobody there to help, and one
 * signed in moments ago keeps being ended. A session seen to end (`signed-out`) is no hold: that
 * is when signing back in by itself helps.
 */
export const automaticSignInOnHold = (account: SignInFields, nowMs: number) =>
  signInOnHold(account, nowMs) ||
  (account.signIn !== undefined && ATTEMPT_STATES.has(account.signIn.state)) ||
  signedInMomentsAgo(account, nowMs);

/** True while an agent mustn't repeat a sign-in. A person can still finish one that needed them. */
export const agentSignInOnHold = (
  account: SignInFields,
  session: { readonly unattended: boolean },
  nowMs: number,
) => signInOnHold(account, nowMs) && (session.unattended || account.signIn?.state !== "needs-you");

/**
 * The one way an account's sign-in state changes: after a finished sign-in (`attempt`) or a look
 * at the site (`look`). Returns `summary` itself when nothing changes.
 */
export const withSignIn = (
  summary: AccountSummary,
  next: AccountSignIn,
  nowMs: number,
  source: "attempt" | "look",
): AccountSummary => {
  // A refusal outlasts every look, a working session included: none says the saved password works.
  if (source === "look" && signInRefused(summary)) return summary;
  // While the site is limiting, only a session seen working, or a refusal, replaces the limit.
  if (
    next.state !== "signed-in" &&
    !signInRefused({ secrets: summary.secrets, signIn: next }) &&
    siteLimiting(summary, nowMs)
  )
    return summary;
  // Ended moments after signing in: saying only "signed out" would lift the hold on signing back in.
  const state =
    next.state === "signed-out" && signedInMomentsAgo(summary, nowMs) ? "needs-you" : next.state;
  return { ...summary, signIn: { ...next, state } };
};
