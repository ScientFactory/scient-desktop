import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountBrowserSessions,
  type AccountSummary,
} from "@t3tools/contracts";

/** Cookie presence is evidence only of a possible session; absence is meaningful after prior use. */
export function websiteSessionStatus(
  accounts: ReadonlyArray<AccountSummary>,
  sessions: AccountBrowserSessions,
  observed: Set<string>,
  now: number,
  sourceId?: string,
): ReadonlyArray<AccountSummary> {
  return accounts.map((account) => {
    if (account.details.kind !== "website") return account;
    const { sites, profileId = DEFAULT_BROWSER_PROFILE_ID } = account.details;
    const hosts = sites.flatMap((site) => {
      try {
        return [new URL(site.startsWith("https://") ? site : `https://${site}`).hostname];
      } catch {
        return [];
      }
    });
    if (hosts.length !== sites.length) return account;
    const key = JSON.stringify([
      sourceId,
      account.accountId,
      profileId,
      sites,
      account.details.username,
    ]);
    const session = sessions.find((entry) => entry.profileId === profileId);
    if (!session || sites.length === 0) return account;
    const present = session.cookies.some(
      (cookie) =>
        (cookie.expires === undefined || cookie.expires === -1 || cookie.expires > now / 1000) &&
        hosts.some((host) => {
          const domain = cookie.domain.replace(/^\./, "").toLowerCase();
          return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
        }),
    );
    if (present && sourceId) observed.add(key);
    return {
      ...account,
      signedOut:
        !present &&
        (account.lastSignInOutcome === "signed-in" ||
          (sourceId !== undefined && observed.has(key))),
    };
  });
}
