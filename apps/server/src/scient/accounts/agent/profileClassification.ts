import { isLoginPlace } from "@t3tools/shared/scientSignInPage";
import * as Schema from "effect/Schema";
import type { ProfileDetection } from "./profileDetection.ts";

export const ProfileResult = Schema.Literals(["opens", "sign-in", "denied", "error"]);

/**
 * Whether Scient may submit a saved password here. A password field alone isn't enough: it also
 * asks to confirm closing an account or changing settings. So a page the agent didn't ask for, or
 * one made for signing in, and never one for someone already signed in.
 */
export function isAutomaticSignInPage(requestedUrl: string, page: ProfileDetection) {
  if (page.signOutLink || !URL.canParse(requestedUrl) || !URL.canParse(page.finalUrl)) return false;
  const requested = new URL(requestedUrl);
  const final = new URL(page.finalUrl);
  return (
    isLoginPlace(final) ||
    final.origin !== requested.origin ||
    final.pathname.replace(/\/$/u, "") !== requested.pathname.replace(/\/$/u, "")
  );
}

export function classifyProfilePage(
  requestedUrl: string,
  page: ProfileDetection | undefined,
): typeof ProfileResult.Type {
  if (!page || !URL.canParse(requestedUrl) || !URL.canParse(page.finalUrl)) return "error";
  const requested = new URL(requestedUrl);
  const final = new URL(page.finalUrl);
  // Signing out lands on a sign-in page on purpose.
  if (/(?:^|[/_-])(?:log|sign)[\s_-]?(?:out|off)(?:[/_-]|$)/i.test(requested.pathname))
    return final.protocol === "https:" ? "opens" : "error";
  if (final.protocol !== "https:" || final.username || final.password) return "error";
  if (page.deniedText) return "denied";
  const requestedHost =
    final.hostname === requested.hostname || final.hostname.endsWith(`.${requested.hostname}`);
  if (
    page.passwordField ||
    final.hostname === "accounts.google.com" ||
    final.hostname === "login.microsoftonline.com" ||
    (isLoginPlace(final) && !isLoginPlace(requested))
  )
    return "sign-in";
  return requestedHost ? "opens" : "error";
}
