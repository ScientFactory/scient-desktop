import {
  defaultBrowserProfileRecord,
  type AccountId,
  type AccountSummary,
  type AccountsSnapshot,
  type BrowserProfileId,
  type BrowserProfileRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** What lost or changed its agent access; `all` once the global switch turns it off. */
export type AccessChange =
  | "all"
  | {
      readonly accounts: ReadonlyArray<AccountId>;
      readonly profiles: ReadonlyArray<BrowserProfileId>;
    };

/** One thing an agent was given access to, and the controls it was given under. */
export const Grant = Schema.Struct({ key: Schema.String, version: Schema.String });
export type Grant = typeof Grant.Type;
/** A grant to an account is for its controls and its sites as they were: a site taken away ends it. */
export const accountGrant = ({
  accountId,
  controls,
  details,
}: Pick<AccountSummary, "accountId" | "controls" | "details">): Grant => ({
  key: accountId,
  version: JSON.stringify([controls, "sites" in details ? details.sites : []]),
});
export const profileGrant = ({
  profileId,
  access,
  scope,
  allowedProjects,
  scriptSignIn,
  retired,
  generation,
  removed,
}: BrowserProfileRecord): Grant => ({
  key: `profile:${profileId}`,
  // Its data as well as its controls: a Clear or Remove takes back what was given from it.
  version: JSON.stringify([
    access,
    scope,
    allowedProjects,
    scriptSignIn,
    retired,
    generation ?? 0,
    removed !== undefined,
  ]),
});

/** Every grant's current version; a grant that is gone has none. */
export const grantsOf = (snapshot: AccountsSnapshot) =>
  new Map(
    [...snapshot.accounts.map(accountGrant), ...snapshot.profiles.map(profileGrant)].map(
      ({ key, version }) => [key, version] as const,
    ),
  );

/** Whether a grant still stands as it was given; a profile with no record has the defaults. */
export const grantStands = (current: ReadonlyMap<string, string>, grant: Grant) =>
  (current.get(grant.key) ??
    (grant.key.startsWith("profile:")
      ? profileGrant(
          defaultBrowserProfileRecord(grant.key.slice("profile:".length) as BrowserProfileId),
        ).version
      : undefined)) === grant.version;

const changed = (was: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>) =>
  [...new Set([...was.keys(), ...now.keys()])].filter((key) => was.get(key) !== now.get(key));

/**
 * The one place that says when something an agent was given must be taken back or read again:
 * Off, Remove, a changed scope or visibility, or agent access turned off, between two snapshots.
 * Every holder of a copy (issued files, caches of resolved keys) asks this instead of comparing
 * snapshots itself.
 */
export const accessChange = (
  before: AccountsSnapshot,
  next: AccountsSnapshot,
): AccessChange | undefined => {
  if (before.agentAccess && !next.agentAccess) return "all";
  const keys = changed(grantsOf(before), grantsOf(next));
  if (keys.length === 0) return undefined;
  return {
    accounts: keys.filter((key) => !key.startsWith("profile:")) as Array<AccountId>,
    profiles: keys.flatMap((key) =>
      key.startsWith("profile:") ? [key.slice("profile:".length) as BrowserProfileId] : [],
    ),
  };
};
