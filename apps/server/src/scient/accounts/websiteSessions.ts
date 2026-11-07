import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountBrowserSessions,
  type AccountId,
  type AccountSummary,
} from "@t3tools/contracts";
import { signedInMomentsAgo } from "./AccountDecisions.ts";

/**
 * Sign-ins whose cookies are gone, to record as signed out: one last signed in, or unknown after
 * this source saw its cookies. A recorded one no longer qualifies. One signed in moments ago is
 * skipped: the cookies may predate that sign-in, and recording would make it `needs-you`.
 */
export function endedWebsiteSessions(
  accounts: ReadonlyArray<AccountSummary>,
  sessions: AccountBrowserSessions,
  observed: Set<string>,
  now: number,
  sourceId?: string,
  defaultProfileId: string = DEFAULT_BROWSER_PROFILE_ID,
): ReadonlyArray<AccountId> {
  return accounts.flatMap((account) => {
    if (account.details.kind !== "website") return [];
    // Imported and copied rows are no evidence of a session, so its cookies leaving say nothing.
    if (account.signIn?.from !== undefined) return [];
    // Without a named profile, sign-ins and "Open site" use the user's default profile.
    const { sites, profileId = defaultProfileId } = account.details;
    const hosts = sites.flatMap((site) => {
      try {
        return [new URL(site.startsWith("https://") ? site : `https://${site}`).hostname];
      } catch {
        return [];
      }
    });
    if (hosts.length !== sites.length) return [];
    const key = JSON.stringify([
      sourceId,
      account.accountId,
      profileId,
      sites,
      account.details.username,
    ]);
    const session = sessions.find((entry) => entry.profileId === profileId);
    if (!session || sites.length === 0) return [];
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
    const state = account.signIn?.state;
    const ended =
      !sessionPresent &&
      !signedInMomentsAgo(account, now) &&
      (state === "signed-in" ||
        (sourceId !== undefined &&
          observed.has(key) &&
          (state === undefined || state === "unknown")));
    return ended ? [account.accountId] : [];
  });
}
