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
    const live = session.cookies.filter(
      (cookie) =>
        (cookie.expires === undefined || cookie.expires === -1 || cookie.expires > now / 1000) &&
        hosts.some((host) => {
          const domain = cookie.domain.replace(/^\./, "").toLowerCase();
          return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
        }),
    );
    // Sites keep analytics cookies after sign-out; once a site was seen with a protected
    // (HttpOnly) cookie, that cookie alone stands for its session.
    const protectedKey = `${key}|http-only`;
    const present = live.length > 0;
    const protectedPresent = live.some((cookie) => cookie.httpOnly === true);
    if (protectedPresent) observed.add(protectedKey);
    if (present && sourceId) observed.add(key);
    const sessionPresent = observed.has(protectedKey) ? protectedPresent : present;
    return {
      ...account,
      signedOut:
        !sessionPresent &&
        (account.lastSignInOutcome === "signed-in" ||
          (sourceId !== undefined && observed.has(key))),
    };
  });
}
