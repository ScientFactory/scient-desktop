import { GOOGLE_SITE } from "@t3tools/contracts";

export interface CookieMetadata {
  readonly domain: string;
  readonly httpOnly?: boolean;
  readonly expires?: number;
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

export function isIdentityProvider(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return (
      ["accounts.google.com", "login.microsoftonline.com", "appleid.apple.com"].includes(
        url.hostname,
      ) ||
      (url.hostname === "github.com" && /^\/login(?:\/|$)/.test(url.pathname)) ||
      (url.hostname === "orcid.org" && /^\/signin(?:\/|$)/.test(url.pathname)) ||
      url.hostname.endsWith(".okta.com") ||
      /\/idp\/|\/shibboleth/i.test(url.pathname)
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
  hasAccount: boolean;
  before: ReadonlyArray<CookieMetadata>;
  after: ReadonlyArray<CookieMetadata>;
  now?: number;
}): string | null {
  const provider = siteHost(input.previousUrl);
  if (
    input.incognito ||
    input.hasAccount ||
    provider === null ||
    !isIdentityProvider(input.previousUrl) ||
    isIdentityProvider(input.url) ||
    siteHost(input.url) === null
  )
    return null;
  // Google's own services are one session, which Scient asks Google about (`googleSessions`).
  const insideGoogle = (domain: string) =>
    provider.endsWith(`.${GOOGLE_SITE}`) && domain.endsWith(`.${GOOGLE_SITE}`);
  const domains = newSessionDomains(input.before, input.after, input.url, input.now ?? Date.now())
    .filter(
      (domain) => provider !== domain && !provider.endsWith(`.${domain}`) && !insideGoogle(domain),
    )
    .toSorted((a, b) => a.length - b.length);
  return domains[0] ?? null;
}
