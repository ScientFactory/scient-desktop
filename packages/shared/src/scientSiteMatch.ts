import { getDomain } from "tldts";

/**
 * The account-site rule: `https:` only, no username or password in the URL. A `https://…` site
 * matches the page whose origin (scheme, host, port) is its own; a bare site such as `example.com`
 * matches that host and its subdomains on the default port only.
 */
export function siteMatchesUrl(site: string, url: string | URL): boolean {
  const page = httpsPage(url);
  return page !== undefined && covers(site, page);
}

/** Whether any of an account's sites matches the page, by the rule of `siteMatchesUrl`. */
export function anySiteMatches(sites: ReadonlyArray<string>, url: string | URL): boolean {
  const page = httpsPage(url);
  return page !== undefined && sites.some((site) => covers(site, page));
}

function httpsPage(url: string | URL) {
  const page = typeof url === "string" ? parse(url) : url;
  return page?.protocol === "https:" && !page.username && !page.password ? page : undefined;
}

function covers(site: string, page: URL) {
  if (site.startsWith("https://")) return parse(site)?.origin === page.origin;
  return page.port === "" && (page.hostname === site || page.hostname.endsWith(`.${site}`));
}

function parse(url: string) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** The registrable site of a host or cookie domain, such as `huji.ac.il` for `.idp.cc.huji.ac.il`. */
export function siteOf(host: string): string {
  const bare = host.replace(/^\./, "").toLowerCase();
  return getDomain(bare, { allowPrivateDomains: true }) ?? bare;
}

/** The host an account site names: a bare site as written, or a `https://` origin's host. */
export function siteHost(site: string): string {
  if (!site.startsWith("https://")) return site.replace(/^\./, "").toLowerCase();
  return parse(site)?.hostname ?? site.replace(/^\./, "").toLowerCase();
}

/** Whether `site`'s host is `ancestor`'s host or lies under it, such as `idp.example.ac.il`. */
export function siteUnder(site: string, ancestor: string): boolean {
  const host = siteHost(site);
  const above = siteHost(ancestor);
  return host === above || host.endsWith(`.${above}`);
}

/** Whether a site of `a` and a site of `b` lie one under the other. */
export function sitesNest(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.some((left) => b.some((right) => siteUnder(left, right) || siteUnder(right, left)));
}
