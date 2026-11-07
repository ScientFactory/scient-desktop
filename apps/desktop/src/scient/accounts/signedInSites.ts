import type { DesktopProfileSignedInSite } from "@t3tools/contracts";
import { siteOf } from "@t3tools/shared/scientSiteMatch";

/** A cookie domain's registrable site, or undefined for a domain no site could have. */
export function cookieSite(cookieDomain: string): string | undefined {
  const host = cookieDomain.replace(/^\./, "").toLowerCase();
  if (!host || /[\s/:]/.test(host) || host.includes("\u0000")) return undefined;
  return siteOf(host);
}

/** The URL and name that remove each of a site's cookies, for every cookie of that registrable domain. */
export function siteCookieRemovals(
  cookies: ReadonlyArray<{
    readonly domain?: string | undefined;
    readonly path?: string | undefined;
    readonly name: string;
    readonly secure?: boolean | undefined;
  }>,
  site: string,
) {
  return cookies.flatMap((cookie) =>
    cookie.domain !== undefined && cookieSite(cookie.domain) === site
      ? [
          {
            url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path ?? "/"}`,
            name: cookie.name,
          },
        ]
      : [],
  );
}

/** How many sites these cookie domains or hosts belong to. */
export function countSites(hosts: Iterable<string>) {
  const sites = new Set<string>();
  for (const host of hosts) {
    const site = cookieSite(host);
    if (site !== undefined) sites.add(site);
  }
  return sites.size;
}

export function groupSignedInSites(
  cookies: ReadonlyArray<{ readonly domain: string }>,
): DesktopProfileSignedInSite[] {
  const counts = new Map<string, number>();
  for (const cookie of cookies) {
    const domain = cookieSite(cookie.domain);
    if (domain === undefined) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts]
    .map(([domain, cookies]) => ({ domain, cookies }))
    .sort((a, b) => b.cookies - a.cookies || a.domain.localeCompare(b.domain))
    .slice(0, 1000);
}
