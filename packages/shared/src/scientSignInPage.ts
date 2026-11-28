import type { AccountHandoff, AccountsSnapshot, AccountUseAction } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Checkbox wording that keeps a sign-in or trusts this device, as source for page scripts. */
export const REMEMBER_SIGN_IN_LABEL = String.raw`remember|keep me (signed|logged)|stay (signed|logged)|trust (this|my)|(don.?t|do not) (ask|show|prompt)( me)?( this)? again`;
/** Wording that means the opposite, on shared-computer options. */
export const FORGET_SIGN_IN_LABEL = String.raw`(don.?t|do not|never) remember|public|shared (computer|device)`;

/** Pages sites answer automation with, as source for page scripts. Retrying prolongs the block. */
export const SITE_LIMITED_TEXT = String.raw`access is temporarily restricted|unusual activity from your|too many (failed )?(requests|attempts|sign.?in)|rate limit(ed)? exceeded|you have been (temporarily )?(blocked|rate.?limited)|account (is|has been) (temporarily )?(locked|suspended)|locked out of your account`;

/** What a sign-in form says when it refuses a password, as source for page scripts. */
export const PASSWORD_REFUSED_TEXT = String.raw`(incorrect|invalid|wrong) (password|credentials|(user ?name|e-?mail|login|id) or password)|(password|credentials) (is |was |are )?(incorrect|invalid|wrong)|(user ?name|e-?mail) (and|or) password (do not|don.?t) match|שם המשתמש או הסיסמה|סיסמה שגויה`;

/** Sign-in pages live at addresses like /login or sso.example.com, often before any password field. */
export const isLoginPlace = (url: URL) =>
  /(?:^|[/_-])(?:log[\s_-]?in|sign[\s_-]?in|sso|auth)(?:[/_-]|$)/i.test(url.pathname) ||
  /^(?:login|signin|sso|auth|idp)\./i.test(url.hostname);

/** University and company sign-in services, which many sites hand a sign-in to. */
export const isIdentityPage = (url: URL) =>
  url.hostname === "login.microsoftonline.com" ||
  url.hostname.endsWith(".okta.com") ||
  url.hostname.endsWith(".openathens.net") ||
  /\/(?:idp|adfs|cas|saml2?|simplesaml)\/|\/shibboleth/i.test(url.pathname);

const HANDOFF_INSTRUCTIONS: Readonly<Record<AccountHandoff["kind"], string>> = {
  push: msg("Approve on your phone"),
  code: msg("Enter the code"),
  captcha: msg("Solve the check."),
  passkey: msg("Use your passkey"),
  other: msg("Finish signing in."),
};

/**
 * What the user has to do to finish a sign-in that is waiting for them, naming the factor: the
 * number to tap, a security key, a texted code. A refusal is said first: the step the page still
 * shows is not what the person must fix.
 */
export const accountHandoffInstruction = (
  handoff: Pick<AccountHandoff, "kind" | "refused" | "choose" | "notLoaded" | "number" | "via">,
  resolve: MFunctionType = mFallback,
) =>
  handoff.refused === "password"
    ? resolve(msg("Password refused. Type it again."))
    : handoff.notLoaded
      ? resolve(msg("Page didn't load."))
      : handoff.choose === "account"
        ? resolve(msg("Choose an account."))
        : handoff.kind === "push" && handoff.number
          ? resolve(msg("Approve on your phone · {number}", { number: handoff.number }))
          : handoff.kind === "passkey" && handoff.via === "security-key"
            ? resolve(msg("Touch your security key"))
            : handoff.kind === "code" && handoff.via === "text"
              ? resolve(msg("Enter the code sent to your phone"))
              : resolve(HANDOFF_INSTRUCTIONS[handoff.kind]);

const APPROVAL_QUESTIONS: Readonly<Record<AccountUseAction, string>> = {
  "sign-in": msg("Let the agent sign in?"),
  credentials: msg("Let the agent read its credentials?"),
  request: msg("Let the agent make a request?"),
  "browser-session": msg("Let the agent use its sign-in in a script?"),
  "open-profile": msg("Let the agent open a browser tab?"),
};

export const accountApprovalQuestion = (
  action: AccountUseAction,
  resolve: MFunctionType = mFallback,
) => resolve(APPROVAL_QUESTIONS[action]);

/**
 * Scient's own background threads (renewal, Check, connector sessions, papers): no chat to open,
 * so their notifications open Accounts.
 */
export const isScientBackgroundThread = (threadId: string) => threadId.startsWith("scient-");

type PasswordFinding = NonNullable<AccountsSnapshot["passwordHealth"]>[number]["finding"];
const PASSWORD_FINDINGS: Readonly<Record<PasswordFinding, string>> = {
  leaked: msg("Leaked"),
  reused: msg("Reused"),
  weak: msg("Weak"),
};

/** The one word a saved password's row shows about its health. */
export const passwordFindingLabel = (
  finding: PasswordFinding,
  resolve: MFunctionType = mFallback,
) => resolve(PASSWORD_FINDINGS[finding]);

/** Each thread with a sign-in or approval waiting for the user, in words for a notification. */
export function accountRequestsByThread(
  snapshot: Pick<AccountsSnapshot, "approvals" | "handoffs" | "needsYou">,
): ReadonlyMap<string, string> {
  return new Map([
    ...(snapshot.needsYou ?? []).flatMap((need) =>
      need.threadId === undefined ? [] : [[need.threadId, `${need.name}: ${need.detail}`] as const],
    ),
    ...snapshot.approvals.map(
      (approval) =>
        [
          approval.threadId,
          `${approval.targetName}: ${accountApprovalQuestion(approval.action)}`,
        ] as const,
    ),
    ...(snapshot.handoffs ?? []).map(
      (handoff) =>
        [
          handoff.threadId,
          // Found codes are news on the phone too: one tap there inserts it.
          `${handoff.accountName}: ${handoff.codes?.length ? "A code arrived." : accountHandoffInstruction(handoff)}`,
        ] as const,
    ),
  ]);
}
