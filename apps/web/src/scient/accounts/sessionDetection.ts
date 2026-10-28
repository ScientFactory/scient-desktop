export interface CookieMetadata {
  readonly domain: string;
  readonly httpOnly?: boolean;
  readonly expires?: number;
}

export function siteHost(site: string) {
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

export function hasNewSiteCookie(
  before: ReadonlyArray<CookieMetadata>,
  after: ReadonlyArray<CookieMetadata>,
  site: string,
  now = Date.now(),
) {
  const counts = new Map<string, number>();
  const key = (cookie: CookieMetadata) =>
    `${cookie.domain.toLowerCase()}:${cookie.expires ?? "session"}`;
  for (const cookie of siteCookies(before, site, now))
    counts.set(key(cookie), (counts.get(key(cookie)) ?? 0) + 1);
  return siteCookies(after, site, now).some((cookie) => {
    const count = counts.get(key(cookie)) ?? 0;
    counts.set(key(cookie), count - 1);
    return count === 0;
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

export function shouldOfferSession(input: {
  previousUrl: string;
  url: string;
  incognito: boolean;
  hasAccount: boolean;
  offered: boolean;
  before: ReadonlyArray<CookieMetadata>;
  after: ReadonlyArray<CookieMetadata>;
}) {
  return (
    !input.incognito &&
    !input.hasAccount &&
    !input.offered &&
    isIdentityProvider(input.previousUrl) &&
    !isIdentityProvider(input.url) &&
    siteHost(input.url) !== null &&
    hasNewSiteCookie(input.before, input.after, input.url)
  );
}
