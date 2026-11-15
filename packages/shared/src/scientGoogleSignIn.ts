import { parseUrl } from "./url.ts";

/**
 * Google decides each sign-in in an embedded browser itself: some go through, others end on its
 * refusal ("This browser or app may not be secure"). Only Google's sign-in pages are recognized
 * here, never its apps or its session upkeep (`ListAccounts`, `CheckCookie`, `RotateCookies`…).
 */
export type GoogleSignInPage =
  /** Asks for an account, a password, a passkey or a second step. */
  | "credentials"
  /** Passes a signed-in session on (account chooser, a Google app's bounce, "Continue with
   *  Google"); without a session Google moves on to its credential pages. */
  | "transit"
  /** Google's refusal page. */
  | "rejected";

const GOOGLE_ACCOUNTS_HOST = "accounts.google.com";

const REJECTED = /^\/(?:v\d+\/)?signin\/rejected(?:\/|$)/i;
const OAUTH = /^\/(?:o\/oauth2(?:\/v\d+)?\/auth|(?:v\d+\/)?signin\/oauth)(?:\/|$)/i;
const TRANSIT = /^\/(?:ServiceLogin|AccountChooser)(?:\/|$)/i;
const CREDENTIALS = /^\/(?:AddSession|InteractiveLogin|(?:v\d+\/)?signin)(?:\/|$)/i;

const googleAccountsPath = (raw: string) => {
  const url = parseUrl(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port !== "" || url.hostname.replace(/\.$/, "").toLowerCase() !== GOOGLE_ACCOUNTS_HOST)
    return null;
  return url.pathname;
};

/** Which Google sign-in page `raw` is, or null for any other address. */
export function googleSignInPage(raw: string): GoogleSignInPage | null {
  const path = googleAccountsPath(raw);
  if (path === null) return null;
  // `/` sends a signed-out person to the sign-in page and a signed-in one to their account.
  if (path === "/" || TRANSIT.test(path) || OAUTH.test(path)) return "transit";
  if (REJECTED.test(path)) return "rejected";
  return CREDENTIALS.test(path) ? "credentials" : null;
}

/** Whether `raw` is another site's "Continue with Google" rather than Google's own sign-in. */
export function isGoogleOAuthPage(raw: string) {
  const path = googleAccountsPath(raw);
  return path !== null && OAUTH.test(path);
}

/** Where the person can sign in again: a safe https origin, never a URL carrying OAuth state. */
export function signInRestartUrl(raw: string | null | undefined): string | null {
  const url = raw ? parseUrl(raw) : null;
  if (!url || url.protocol !== "https:" || url.username || url.password) return null;
  return googleAccountsPath(url.href) === null ? `${url.origin}/` : null;
}
