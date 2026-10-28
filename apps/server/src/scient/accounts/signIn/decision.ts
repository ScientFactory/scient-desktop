import type { SignInDetection } from "./detection.ts";
import { matchesAccountOrigin } from "./origin.ts";

export function decideSignIn(
  page: SignInDetection,
  sites: ReadonlyArray<string>,
  available: { username: boolean; password: boolean; otp: boolean },
) {
  if (!matchesAccountOrigin(page.origin, sites))
    return {
      type: "needs-user",
      kind: undefined,
      message: "Continue sign-in on an allowed site.",
    } as const;
  if (page.signedIn) return { type: "signed-in" } as const;
  if (page.challenge)
    return {
      type: "needs-user",
      kind: page.challenge,
      message:
        page.challenge === "captcha"
          ? "Complete the CAPTCHA in the browser."
          : page.challenge === "passkey"
            ? "Use your passkey in the browser."
            : "Approve sign-in on your device.",
    } as const;
  const fields = [
    ...(page.username ? [{ field: "username" as const, selector: page.username }] : []),
    ...(page.password ? [{ field: "password" as const, selector: page.password }] : []),
    ...(page.otp ? [{ field: "otp" as const, selector: page.otp }] : []),
  ];
  if (fields.length === 0)
    return {
      type: "needs-user",
      kind: "other",
      message: "Finish sign-in in the browser; its status could not be confirmed.",
    } as const;
  if (fields.some(({ field }) => !available[field]))
    return {
      type: "needs-user",
      kind: page.otp && !available.otp ? "code" : "other",
      message: "Enter the missing sign-in information in the browser.",
    } as const;
  return { type: "fill", fields, submit: page.submit } as const;
}

export interface SignInSubmission {
  origin: string;
  fields: ReadonlyArray<"username" | "password" | "otp">;
  otpPeriod: number | undefined;
}

export function decideSignInContinuation(
  page: SignInDetection,
  submissions: ReadonlyArray<SignInSubmission>,
  step: number,
  otpPeriod: number | undefined,
) {
  // A challenge is the user's to finish; it says nothing about the password.
  if (page.challenge) return { type: "continue" } as const;
  const sameOrigin = submissions.filter((entry) => entry.origin === page.origin);
  if (page.password && sameOrigin.some((entry) => entry.fields.includes("password")))
    return {
      type: "password-rejected",
      message:
        "The site did not accept the saved password. Ask the user to check it in Settings → Accounts.",
    } as const;
  const codes = sameOrigin.filter((entry) => entry.fields.includes("otp"));
  if (
    page.otp &&
    codes.length &&
    (codes.length >= 2 ||
      otpPeriod === undefined ||
      otpPeriod <= (codes[0]!.otpPeriod ?? Number.POSITIVE_INFINITY))
  )
    return {
      type: "code-rejected",
      message:
        "The site did not accept the sign-in code. Ask the user to check it in Settings → Accounts.",
    } as const;
  if (step >= 6)
    return { type: "failed", message: "Sign-in did not finish after six steps." } as const;
  return { type: "continue" } as const;
}
