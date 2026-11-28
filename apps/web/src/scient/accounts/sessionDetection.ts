import { GOOGLE_SITE } from "@t3tools/contracts";
import { isIdentityPage } from "@t3tools/shared/scientSignInPage";

export interface CookieMetadata {
  readonly domain: string;
  readonly httpOnly?: boolean;
  readonly expires?: number;
  readonly name?: string;
  readonly path?: string;
  readonly digest?: string;
}

/**
 * Cookies bot checks and request guards set on any page, a refusal too: never a sign-in's evidence
 * (Cloudflare, Akamai, Imperva, PerimeterX, DataDome, AWS WAF, CSRF tokens).
 */
const NOT_A_SESSION =
  /^(?:__cf_bm|cf_clearance|__cfruid|_cfuvid|ak_bmsc|bm_sz|bm_sv|bm_mi|_abck|incap_ses_.*|visid_incap_.*|nlbi_.*|reese84|datadome|_px.*|aws-waf-token|awswaf.*|__ddg.*|awsalb.*|xsrf-token|csrftoken|.*csrf.*)$/i;

/**
 * A cookie named as a site keeps its sign-in in. A bare "token", "user" or "account" names
 * anything (a visitor's token, a user's preference): never positive evidence alone (round 6e).
 */
const SESSION_NAME =
  /sess|sid|auth|login|logged|remember|jwt|ident|(?:access|refresh|id|bearer|api)[-_]?token/i;
/** A flow's state, nonce or challenge, or a visitor's, device's or tracker's: no sign-in. */
const FLOW_NAME =
  /state|nonce|flow|challenge|verifier|pkce|redirect|return|consent|captcha|visit|guest|anon|device|track|analytic|pref|locale|lang|theme|experiment/i;

/**
 * What the site's cookies say about a sign-in since `before` (round 6d). "signed-in": positive
 * evidence, a session rotated in place, or a new HttpOnly cookie named as a session. "unverified":
 * a new HttpOnly cookie that could be a refusal's flow state, a bot check's cookie, or cookies
 * without names; it never counts as signed in, nor as signed out. "none": nothing new.
 */
export function signInEvidence(
  before: ReadonlyArray<CookieMetadata>,
  after: ReadonlyArray<CookieMetadata>,
  site: string,
  now = Date.now(),
): "signed-in" | "unverified" | "none" {
  if (after.some((cookie) => cookie.name === undefined))
    return hasNewSessionCookie(before, after, site, now) ? "unverified" : "none";
  const identity = (cookie: CookieMetadata) =>
    `${cookie.name}\u0000${cookie.domain.toLowerCase()}\u0000${cookie.path ?? "/"}`;
  const earlier = new Map(
    siteCookies(before, site, now).map((cookie) => [identity(cookie), cookie]),
  );
  let evidence: "signed-in" | "unverified" | "none" = "none";
  for (const cookie of siteCookies(after, site, now)) {
    const was = earlier.get(identity(cookie));
    const rotated =
      was !== undefined && cookie.digest !== undefined && was.digest !== cookie.digest;
    if (was !== undefined && !rotated) continue;
    const name = cookie.name ?? "";
    if (NOT_A_SESSION.test(name) || FLOW_NAME.test(name)) evidence = "unverified";
    // New or replaced, it counts when it is named as a session; a generic one replaced, as a
    // refusal may, proves nothing alone (round 6f).
    else if (SESSION_NAME.test(name)) return "signed-in";
    else evidence = "unverified";
  }
  return evidence;
}

function siteHost(site: string) {
  try {
    const url = new URL(site.includes("://") ? site : `https://${site}`);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function siteCookies(
  cookies: ReadonlyArray<CookieMetadata>,
  site: string,
  now = Date.now(),
) {
  const host = siteHost(site);
  return cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    return (
      host &&
      cookie.httpOnly === true &&
      (cookie.expires === undefined || cookie.expires <= 0 || cookie.expires * 1000 > now) &&
      (host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`))
    );
  });
}

/** Domains of HttpOnly cookies for the site that `after` has and `before` didn't. */
function newSessionDomains(
  before: ReadonlyArray<CookieMetadata>,
  after: ReadonlyArray<CookieMetadata>,
  site: string,
  now: number,
) {
  const counts = new Map<string, number>();
  const key = (cookie: CookieMetadata) =>
    `${cookie.domain.toLowerCase()}:${cookie.expires ?? "session"}`;
  for (const cookie of siteCookies(before, site, now))
    counts.set(key(cookie), (counts.get(key(cookie)) ?? 0) + 1);
  return siteCookies(after, site, now).flatMap((cookie) => {
    const count = counts.get(key(cookie)) ?? 0;
    counts.set(key(cookie), count - 1);
    return count > 0 ? [] : [cookie.domain.replace(/^\./, "").toLowerCase()];
  });
}

/** Whether the site got a new HttpOnly cookie between the two reads: a sign-in's evidence. */
function hasNewSessionCookie(
  before: ReadonlyArray<CookieMetadata>,
  after: ReadonlyArray<CookieMetadata>,
  site: string,
  now = Date.now(),
) {
  return newSessionDomains(before, after, site, now).length > 0;
}

const YOUTUBE_SITE = "youtube.com";

export function isIdentityProvider(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return (
      ["accounts.google.com", "appleid.apple.com"].includes(url.hostname) ||
      (url.hostname === "github.com" && /^\/login(?:\/|$)/.test(url.pathname)) ||
      (url.hostname === "orcid.org" && /^\/signin(?:\/|$)/.test(url.pathname)) ||
      isIdentityPage(url)
    );
  } catch {
    return false;
  }
}

/**
 * The site a sign-in through an identity provider just created, or null. The site is where the
 * new session cookie lives. A cookie that also covers the sign-in page is the provider's own
 * session (Google's sign-in, then Docs or Gmail), so it is no new sign-in.
 */
export function signedInSite(input: {
  previousUrl: string;
  url: string;
  incognito: boolean;
  before: ReadonlyArray<CookieMetadata>;
  after: ReadonlyArray<CookieMetadata>;
  now?: number;
}): string | null {
  const provider = siteHost(input.previousUrl);
  if (
    input.incognito ||
    provider === null ||
    !isIdentityProvider(input.previousUrl) ||
    isIdentityProvider(input.url) ||
    siteHost(input.url) === null
  )
    return null;
  // Google's own services are one session, which Scient asks Google about (`googleSessions`).
  const insideGoogle = (domain: string) =>
    provider.endsWith(`.${GOOGLE_SITE}`) &&
    (domain.endsWith(`.${GOOGLE_SITE}`) ||
      domain === YOUTUBE_SITE ||
      domain.endsWith(`.${YOUTUBE_SITE}`));
  const domains = newSessionDomains(input.before, input.after, input.url, input.now ?? Date.now())
    .filter(
      (domain) => provider !== domain && !provider.endsWith(`.${domain}`) && !insideGoogle(domain),
    )
    .toSorted((a, b) => a.length - b.length);
  return domains[0] ?? null;
}
