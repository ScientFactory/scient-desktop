import * as Schema from "effect/Schema";
import type { ProfileDetection } from "./profileDetection.ts";

export const ProfileResult = Schema.Literals(["opens", "sign-in", "denied", "error"]);

export function classifyProfilePage(
  requestedUrl: string,
  page: ProfileDetection | undefined,
): typeof ProfileResult.Type {
  if (!page || !URL.canParse(requestedUrl) || !URL.canParse(page.finalUrl)) return "error";
  const requested = new URL(requestedUrl);
  const final = new URL(page.finalUrl);
  if (final.protocol !== "https:" || final.username || final.password) return "error";
  if (page.deniedText) return "denied";
  const requestedHost =
    final.hostname === requested.hostname || final.hostname.endsWith(`.${requested.hostname}`);
  if (
    page.passwordField ||
    (!requestedHost &&
      (final.hostname === "accounts.google.com" ||
        final.hostname === "login.microsoftonline.com" ||
        /(?:^|[/_-])(?:log[\s_-]?in|sign[\s_-]?in|sso|auth)(?:[/_-]|$)/i.test(final.pathname)))
  )
    return "sign-in";
  return requestedHost ? "opens" : "error";
}
