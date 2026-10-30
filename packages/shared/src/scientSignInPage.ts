import type { AccountHandoff, AccountsSnapshot, AccountUseAction } from "@t3tools/contracts";

/** Checkbox wording that keeps a sign-in or trusts this device, as source for page scripts. */
export const REMEMBER_SIGN_IN_LABEL = String.raw`remember|keep me|stay (signed|logged)|trust (this|my)|(don.?t|do not) (ask|show|prompt)( me)?( this)? again`;
/** Wording that means the opposite, on shared-computer options. */
export const FORGET_SIGN_IN_LABEL = String.raw`(don.?t|do not|never) remember|public|shared (computer|device)`;

/** What the user has to do to finish a sign-in that is waiting for them. */
export function accountHandoffInstruction(kind: AccountHandoff["kind"]) {
  switch (kind) {
    case "push":
      return "Approve the sign-in on your phone.";
    case "code":
      return "Type the code you were sent.";
    case "captcha":
      return "Complete the check.";
    case "passkey":
      return "Use your passkey or Touch ID.";
    case "other":
      return "Finish signing in.";
  }
}

const APPROVAL_QUESTIONS: Readonly<Record<AccountUseAction, string>> = {
  "sign-in": "Let the agent sign in?",
  credentials: "Let the agent read its credentials?",
  request: "Let the agent make a request?",
  "browser-session": "Let the agent use its sign-in in a script?",
  "open-profile": "Let the agent open a browser tab?",
};

export const accountApprovalQuestion = (action: AccountUseAction) => APPROVAL_QUESTIONS[action];

/** Each thread with a sign-in or approval waiting for the user, in words for a notification. */
export function accountRequestsByThread(
  snapshot: Pick<AccountsSnapshot, "approvals" | "handoffs">,
): ReadonlyMap<string, string> {
  return new Map([
    ...snapshot.approvals.map(
      (approval) =>
        [
          approval.threadId,
          `${approval.targetName}: ${APPROVAL_QUESTIONS[approval.action]}`,
        ] as const,
    ),
    ...(snapshot.handoffs ?? []).map(
      (handoff) =>
        [
          handoff.threadId,
          `${handoff.accountName}: ${accountHandoffInstruction(handoff.kind)}`,
        ] as const,
    ),
  ]);
}
