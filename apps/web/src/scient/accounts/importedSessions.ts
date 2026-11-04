import { GOOGLE_SITE, type AccountSummary, type EnvironmentId } from "@t3tools/contracts";
import { universityDetails } from "@t3tools/shared/scientPaperLinks";
import { isIdentityPage } from "@t3tools/shared/scientSignInPage";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import { accountsState } from "./accountsState";
import { accountCatalogue, isSavedPassword } from "./accountsView";
import { fillMainFromProfile } from "./mainFill";
import type { CookieMetadata } from "./sessionDetection";

const MOST_SITES = 200;
const SITE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const hostOf = (site: string) => {
  try {
    return new URL(site.startsWith("https://") ? site : `https://${site}`).hostname;
  } catch {
    return undefined;
  }
};
const under = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

/**
 * Sites an import brought a session for: an unexpired HttpOnly cookie, on a site with a saved
 * password or in the catalogue. Each is named by its shortest cookie domain, which a browser never
 * sets above the registrable site. Google and sign-in services are left out: Google reports its own
 * accounts, and a university's sign-in belongs to the university.
 */
export function importedSessionSites(
  cookies: ReadonlyArray<CookieMetadata>,
  accounts: ReadonlyArray<AccountSummary>,
  now: number,
): ReadonlyArray<string> {
  const live = cookies.flatMap((cookie) =>
    cookie.httpOnly === true &&
    (cookie.expires === undefined || cookie.expires <= 0 || cookie.expires * 1000 > now)
      ? [cookie.domain.replace(/^\./, "").toLowerCase()]
      : [],
  );
  const signInServices = accounts.flatMap(
    ({ details }) =>
      universityDetails(details)
        ?.sites.filter((site) => site.startsWith("https://"))
        .flatMap((site) => hostOf(site) ?? []) ?? [],
  );
  const candidates = [
    ...accounts
      .filter(isSavedPassword)
      .flatMap(({ details }) => ("sites" in details ? details.sites : [])),
    ...accountCatalogue.map((entry) => entry.site).filter(Boolean),
  ].flatMap((site) => hostOf(site) ?? []);
  const sites = new Set<string>();
  for (const candidate of candidates) {
    const named = live.flatMap((domain) =>
      under(candidate, domain) ? [domain] : under(domain, candidate) ? [candidate] : [],
    );
    const site = named.toSorted((a, b) => a.length - b.length)[0];
    if (
      site === undefined ||
      !SITE.test(site) ||
      under(site, GOOGLE_SITE) ||
      isIdentityPage(new URL(`https://${site}/`)) ||
      signInServices.some((host) => under(host, site) || under(site, host))
    )
      continue;
    sites.add(site);
    if (sites.size === MOST_SITES) break;
  }
  return [...sites];
}

/**
 * After an import or Refresh into a profile, its sessions become that profile's rows; then
 * `fillMain` fills Main once from it, so each copy finds its row.
 */
export async function recordImportedSessions(
  environmentId: EnvironmentId,
  profileId: string,
  from: string,
  options: { readonly fillMain: boolean },
) {
  await recordRows(environmentId, profileId, from).catch(() => undefined);
  if (options.fillMain) await fillMainFromProfile(environmentId, profileId).catch(() => undefined);
}

async function recordRows(environmentId: EnvironmentId, profileId: string, from: string) {
  const cookies = await window.desktopBridge?.accounts
    ?.cookieMetadata?.(profileId, environmentId)
    .catch(() => null);
  if (!cookies) return;
  const read = await accountsState.readSnapshot
    .run(appAtomRegistry, { environmentId, input: {} })
    .catch(() => null);
  if (read?._tag !== "Success" || !read.value.features?.sessionsSeen) return;
  const sites = importedSessionSites(cookies, read.value.accounts, Date.now());
  if (sites.length === 0) return;
  await accountsState.sessionsSeen.run(appAtomRegistry, {
    environmentId,
    input: {
      profileId,
      sessions: sites.map((site) => ({ site, how: "imported" as const, from })),
    },
  });
}
