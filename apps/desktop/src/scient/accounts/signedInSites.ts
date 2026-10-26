import type { DesktopProfileSignedInSite } from "@t3tools/contracts";
import { getDomain } from "tldts";

export function groupSignedInSites(
  cookies: ReadonlyArray<{ readonly domain: string }>,
): DesktopProfileSignedInSite[] {
  const counts = new Map<string, number>();
  for (const cookie of cookies) {
    const host = cookie.domain.replace(/^\./, "").toLowerCase();
    if (!host || /[\s/:]/.test(host) || host.includes("\u0000")) continue;
    const domain = getDomain(host, { allowPrivateDomains: true }) ?? host;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts]
    .map(([domain, cookies]) => ({ domain, cookies }))
    .sort((a, b) => b.cookies - a.cookies || a.domain.localeCompare(b.domain))
    .slice(0, 50);
}
