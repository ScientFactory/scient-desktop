import {
  DEFAULT_BROWSER_PROFILE_ID,
  defaultBrowserProfileRecord,
  type AccountSummary,
  type BrowserProfileRecord,
} from "@t3tools/contracts";

import { isGoogleSessionRow } from "./AccountDecisions.ts";

type Website = Extract<AccountSummary["details"], { readonly kind: "website" }>;
type Row = { readonly summary: AccountSummary };

const hostOf = (site: string) => (site.startsWith("https://") ? new URL(site).hostname : site);
/** Whether a row's site lies under a registrable site, such as `idp.example.ac.il` under `example.ac.il`. */
const under = (rowSite: string, site: string) => {
  const host = hostOf(rowSite);
  return host === site || host.endsWith(`.${site}`);
};
const overlaps = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.some((left) => b.some((right) => under(left, hostOf(right)) || under(right, hostOf(left))));

const isMainRow = (
  summary: AccountSummary,
): summary is AccountSummary & {
  readonly details: Website;
} => summary.details.kind === "website" && summary.details.profileId === DEFAULT_BROWSER_PROFILE_ID;

/** Main's row for the same sign-in as `source`: its sites, and the same person where both say. */
export function mainRowFor<A extends Row>(accounts: ReadonlyArray<A>, source: AccountSummary) {
  if (source.details.kind !== "website") return undefined;
  const { sites, username } = source.details;
  const google = isGoogleSessionRow(source);
  return accounts.find(({ summary }) => {
    if (!isMainRow(summary) || !overlaps(summary.details.sites, sites)) return false;
    const theirs = summary.details.username;
    return google
      ? isGoogleSessionRow(summary) && theirs === username
      : theirs === undefined || username === undefined || theirs === username;
  });
}

/** Main's record with one more site the user signed out of. */
export function withSignedOutSite(profiles: ReadonlyArray<BrowserProfileRecord>, site: string) {
  const main =
    profiles.find((profile) => profile.profileId === DEFAULT_BROWSER_PROFILE_ID) ??
    defaultBrowserProfileRecord(DEFAULT_BROWSER_PROFILE_ID);
  return [
    ...profiles.filter((profile) => profile !== main),
    { ...main, signedOutSites: [...new Set([...(main.signedOutSites ?? []), site])] },
  ];
}

/** A row recording a new sign-in in Main: an action, never a look. */
const signedInNow = (summary: AccountSummary, before: AccountSummary | undefined) =>
  summary.signIn?.state === "signed-in" &&
  summary.signIn.by === "action" &&
  before?.signIn?.at !== summary.signIn.at;

/** A real sign-in in Main clears its sites from the record of Accounts' sign-outs. */
export function withMainSignOutsCleared<
  S extends {
    readonly accounts: ReadonlyArray<Row>;
    readonly profiles: ReadonlyArray<BrowserProfileRecord>;
  },
>(before: S, next: S): S {
  const main = next.profiles.find((profile) => profile.profileId === DEFAULT_BROWSER_PROFILE_ID);
  if (!main?.signedOutSites?.length) return next;
  const seen = next.accounts.flatMap(({ summary }) =>
    isMainRow(summary) &&
    signedInNow(
      summary,
      before.accounts.find((row) => row.summary.accountId === summary.accountId)?.summary,
    )
      ? summary.details.sites
      : [],
  );
  if (seen.length === 0) return next;
  const kept = main.signedOutSites.filter((site) => !seen.some((rowSite) => under(rowSite, site)));
  if (kept.length === main.signedOutSites.length) return next;
  const { signedOutSites: _, ...rest } = main;
  return {
    ...next,
    profiles: next.profiles.map((profile) =>
      profile === main ? (kept.length ? { ...rest, signedOutSites: kept } : rest) : profile,
    ),
  };
}
