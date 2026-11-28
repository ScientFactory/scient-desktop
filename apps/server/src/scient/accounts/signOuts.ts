import {
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserProfileId,
  type AccountSummary,
} from "@t3tools/contracts";
import { siteUnder } from "@t3tools/shared/scientSiteMatch";
import * as Effect from "effect/Effect";
import { effectiveProfile } from "./AccountDecisions.ts";
import type { SignOut } from "./AccountPersistence.ts";
import { AccountsService } from "./AccountsService.ts";

const profileOf = (account: Pick<AccountSummary, "details">) =>
  ("profileId" in account.details ? account.details.profileId : undefined) ??
  DEFAULT_BROWSER_PROFILE_ID;

const covers = (sites: ReadonlyArray<string>, site: string) =>
  sites.some((own) => siteUnder(own, site));

/**
 * The person signed out of this row's site, in its own profile, with Accounts' Sign out on this
 * computer. Nothing signs back in by itself there.
 */
export function signedOutOfSite(
  account: Pick<AccountSummary, "details">,
  signedOut: ReadonlyArray<SignOut>,
) {
  const { details } = account;
  if (details.kind !== "website") return false;
  const profileId = profileOf(account);
  return signedOut.some(
    (entry) => entry.profileId === profileId && covers(details.sites, entry.site),
  );
}

export const withSignOut = (
  signedOut: ReadonlyArray<SignOut> | undefined,
  profileId: BrowserProfileId,
  site: string,
): ReadonlyArray<SignOut> => [
  ...(signedOut ?? []).filter((entry) => entry.profileId !== profileId || entry.site !== site),
  { profileId, site },
];

/**
 * The person signed in again in a profile: its sign-outs for those sites go. Only the person's own
 * sign-in does this, never one Scient made by itself, which a sign-out it raced must outlive.
 */
export const withoutSignOuts = (
  signedOut: ReadonlyArray<SignOut> | undefined,
  profileId: BrowserProfileId,
  sites: ReadonlyArray<string>,
): ReadonlyArray<SignOut> | undefined =>
  signedOut?.some((entry) => entry.profileId === profileId && covers(sites, entry.site))
    ? signedOut.filter((entry) => entry.profileId !== profileId || !covers(sites, entry.site))
    : signedOut;

/**
 * Whether a sign-out of this row's site was recorded after `sequence` (`signOutSequence`), in its
 * profile or the one the sign-in runs in: one the person may since have undone still counts.
 */
export const signedOutSince = Effect.fn("AccountsSignOuts.signedOutSince")(function* (
  account: Pick<AccountSummary, "details">,
  sequence: number,
  inProfile?: BrowserProfileId,
) {
  const { details } = account;
  if (details.kind !== "website") return false;
  const since = yield* (yield* AccountsService).signOutsSince(sequence);
  return (
    signedOutOfSite(account, since) ||
    (inProfile !== undefined &&
      signedOutOfSite({ details: { ...details, profileId: inProfile } }, since))
  );
});

/** Whether the person signed out of this row's site on purpose, read from Accounts now. */
export const signedOutHere = Effect.fn("AccountsSignOuts.signedOutHere")(function* (
  account: Pick<AccountSummary, "details">,
  /** The profile the sign-in actually runs in, when it isn't the row's. */
  inProfile?: BrowserProfileId,
) {
  if (account.details.kind !== "website") return false;
  const accounts = yield* AccountsService;
  const signedOut = yield* accounts.signedOut;
  // Main's own record, kept for imports and back-fills, says the same for Main.
  const mainSites =
    effectiveProfile((yield* accounts.snapshot).profiles ?? [], DEFAULT_BROWSER_PROFILE_ID).main
      ?.signedOutSites ?? [];
  const records = [
    ...signedOut,
    ...mainSites.map((site) => ({ profileId: DEFAULT_BROWSER_PROFILE_ID, site })),
  ];
  const { details } = account;
  return (
    signedOutOfSite(account, records) ||
    (inProfile !== undefined &&
      signedOutOfSite({ details: { ...details, profileId: inProfile } }, records))
  );
});
