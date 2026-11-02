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
