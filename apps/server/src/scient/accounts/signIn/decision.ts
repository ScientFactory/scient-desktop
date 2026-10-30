import type { SignInDetection } from "./detection.ts";
import { matchesAccountOrigin } from "./origin.ts";

/** Google alone can take seven: account list, address, passkey, options, password, code, trust. */
export const MAX_SIGN_IN_STEPS = 10;
export const SIGN_IN_TOO_LONG = `Sign-in did not finish after ${MAX_SIGN_IN_STEPS} steps.`;

export function decideSignIn(
  page: SignInDetection,
  sites: ReadonlyArray<string>,
  available: {
    username: boolean;
    password: boolean;
    otp: boolean;
    accountName?: string;
    passwordSent?: boolean;
  },
) {
  if (page.broken && !page.signedIn)
    return {
      type: "needs-user",
      kind: undefined,
      message: "The site's sign-in page didn't load. Try again later.",
    } as const;
  if (!matchesAccountOrigin(page.origin, sites))
    return {
      type: "needs-user",
      kind: undefined,
      message: "Continue sign-in on an allowed site.",
    } as const;
  if (page.signedIn) return { type: "signed-in" } as const;
  if (page.limited)
    return {
      type: "needs-user",
      kind: undefined,
      message: "The site is limiting access from this network. Try again later.",
    } as const;
  // Passkeys can't be used in this browser yet, and many accounts offer one first.
  if (page.challenge === "passkey" && page.signInLink && available.password)
    return { type: "fill", fields: [], submit: page.signInLink } as const;
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
  const listed = page.accountChoices?.find(
    ({ email }) => email.toLowerCase() === available.accountName?.toLowerCase(),
  );
  if (fields.length === 0 && listed)
    return { type: "fill", fields, submit: listed.selector } as const;
  // "Stay signed in?" has no fields; its Yes button is the whole step.
  if (fields.length === 0 && page.stay) return { type: "fill", fields, submit: page.stay } as const;
  // A site's home page often has only a link to its sign-in page.
  if (fields.length === 0 && page.signInLink)
    return { type: "fill", fields, submit: page.signInLink } as const;
  // "Try another way" leads to the password. After it, the same link belongs to the user's two-step
  // check, and pressing it would use up their attempts.
  if (fields.length === 0 && page.anotherWay && available.password && !available.passwordSent)
    return { type: "fill", fields, submit: page.anotherWay } as const;
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

/** Nothing here to fill or press, so another address may still reach the sign-in. */
export function pageOffersNoSignIn(page: SignInDetection, sites: ReadonlyArray<string>) {
  if (page.broken) return !page.signedIn;
  if (page.signedIn || page.limited || page.challenge) return false;
  if (!matchesAccountOrigin(page.origin, sites)) return false;
  return !(
    page.username ||
    page.password ||
    page.otp ||
    page.stay ||
    page.signInLink ||
    page.anotherWay ||
    page.accountChoices?.length
  );
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
        "The site did not accept the saved password. Ask the user to check it in Settings → Accounts & secrets.",
    } as const;
  // Going round in circles looks like an attack to a site, and has got a browser restricted.
  if (page.username && sameOrigin.filter((entry) => entry.fields.includes("username")).length >= 2)
    return { type: "failed", message: "The site kept returning to its first step." } as const;
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
        "The site did not accept the sign-in code. Ask the user to check it in Settings → Accounts & secrets.",
    } as const;
  if (step >= MAX_SIGN_IN_STEPS) return { type: "failed", message: SIGN_IN_TOO_LONG } as const;
  return { type: "continue" } as const;
}
