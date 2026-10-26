import type { SignInDetection } from "./detection.ts";
import { matchesAccountOrigin } from "./origin.ts";

export function decideSignIn(
  page: SignInDetection,
  sites: ReadonlyArray<string>,
  available: { username: boolean; password: boolean; otp: boolean },
) {
  if (!matchesAccountOrigin(page.origin, sites))
    return { type: "needs-user", message: "Continue sign-in on an allowed site." } as const;
  if (page.challenge)
    return {
      type: "needs-user",
      message:
        page.challenge === "captcha"
          ? "Complete the CAPTCHA in the browser."
          : page.challenge === "passkey"
            ? "Use your passkey in the browser."
            : "Approve sign-in on your device.",
    } as const;
  if (page.signedIn) return { type: "signed-in" } as const;
  const fields = [
    ...(page.username ? [{ field: "username" as const, selector: page.username }] : []),
    ...(page.password ? [{ field: "password" as const, selector: page.password }] : []),
    ...(page.otp ? [{ field: "otp" as const, selector: page.otp }] : []),
  ];
  if (fields.length === 0)
    return {
      type: "needs-user",
      message: "Finish sign-in in the browser; its status could not be confirmed.",
    } as const;
  if (fields.some(({ field }) => !available[field]))
    return {
      type: "needs-user",
      message: "Enter the missing sign-in information in the browser.",
    } as const;
  return { type: "fill", fields, submit: page.submit } as const;
}
