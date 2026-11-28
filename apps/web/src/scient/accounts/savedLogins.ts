import type { AccountAccess, AccountSummary } from "@t3tools/contracts";
import { loginGroups, loginSiteKey } from "@t3tools/shared/scientLoginIdentity";

/** One saved login as Saved passwords lists it: its copies, one per row Scient stores. */
export interface SavedLogin {
  /** The copy the row shows: the one whose password last worked, else the last used. */
  readonly account: AccountSummary;
  readonly copies: ReadonlyArray<AccountSummary>;
  /** The profiles its copies are saved in; an empty id is a copy kept for no one profile. */
  readonly profileIds: ReadonlyArray<string>;
  /** The copies' access when they agree; `mixed` when they don't. */
  readonly access: AccountAccess | "mixed";
  /** When a copy's password last worked. */
  readonly workedAt?: string;
}

const newest = (values: ReadonlyArray<string | undefined>) =>
  values.reduce<string | undefined>(
    (top, value) => (value && (!top || value > top) ? value : top),
    undefined,
  );

/** Saved passwords grouped into logins, never merged: each copy stays its own row. */
export function savedLogins(accounts: ReadonlyArray<AccountSummary>): SavedLogin[] {
  const groups = loginGroups(accounts);
  const grouped = new Set(groups.flat());
  // A row the identity doesn't call a login is still listed, on its own.
  const rows = [
    ...groups,
    ...accounts.filter((account) => !grouped.has(account)).map((account) => [account]),
  ];
  return rows.map((copies) => {
    const rank = (account: AccountSummary) =>
      account.secrets.password?.verifiedAt ?? account.lastUsedAt ?? "";
    const account = copies.reduce((top, copy) => (rank(copy) > rank(top) ? copy : top));
    const accesses = new Set(copies.map((copy) => copy.controls.access));
    const workedAt = newest(copies.map((copy) => copy.secrets.password?.verifiedAt));
    return {
      account,
      copies,
      profileIds: [
        ...new Set(
          copies.map((copy) =>
            copy.details.kind === "website" ? (copy.details.profileId ?? "") : "",
          ),
        ),
      ],
      access: accesses.size === 1 ? account.controls.access : "mixed",
      ...(workedAt ? { workedAt } : {}),
    };
  });
}

/**
 * A site's saved sign-ins as the key offers them: the copies of one login (`CC\\user` and
 * `cc\\user`, or one per profile) are one choice, shown and filled from an eligible copy (`rows`):
 * the one filled, else the one in the tab's profile, else the first. `copies` is the whole login
 * among `all`, every profile's copy included, which is what Remove takes.
 */
export function signInKeyChoices<Row extends AccountSummary>(
  rows: ReadonlyArray<Row>,
  profileId: string,
  filledId?: string,
  all: ReadonlyArray<Row> = rows,
): Array<{ readonly account: Row; readonly copies: ReadonlyArray<Row> }> {
  const groups = loginGroups([...new Set([...all, ...rows])]);
  const groupOf = new Map(groups.flatMap((group) => group.map((row) => [row, group] as const)));
  const seen = new Set<ReadonlyArray<Row>>();
  return rows.flatMap((row) => {
    const copies = groupOf.get(row) ?? [row];
    if (seen.has(copies)) return [];
    seen.add(copies);
    const fillable = copies.filter((copy) => rows.includes(copy));
    const account =
      fillable.find((copy) => copy.accountId === filledId) ??
      fillable.find(
        (copy) => copy.details.kind === "website" && copy.details.profileId === profileId,
      ) ??
      row;
    return [{ account, copies }];
  });
}

/** A login's password state, from all its copies: refused wins, else when it last worked. */
export function loginState(copies: ReadonlyArray<AccountSummary>): {
  readonly refused: boolean;
  readonly workedAt?: string;
} {
  const refused = copies.some(
    (copy) =>
      copy.secrets.password?.refusedAt !== undefined || copy.signIn?.state === "password-rejected",
  );
  const workedAt = newest(copies.map((copy) => copy.secrets.password?.verifiedAt));
  return { refused, ...(workedAt ? { workedAt } : {}) };
}

/** A username without its `DOMAIN\` part, without case: `cc\yaacovc` and `yaacovc` read alike. */
const bareUser = (account: AccountSummary) => {
  const username = account.details.kind === "website" ? (account.details.username ?? "") : "";
  return (username.split("\\").at(-1) ?? "").toLowerCase();
};
const loginSites = (login: SavedLogin) =>
  login.copies.flatMap((copy) =>
    copy.details.kind === "website"
      ? copy.details.sites.flatMap((site) => loginSiteKey(site) ?? [])
      : [],
  );

/**
 * Logins sharing a site whose usernames differ only by a `DOMAIN\\` part, which may be one login
 * saved twice: each set of them, for the person to keep one. Nothing merges them.
 */
function duplicateSets(logins: ReadonlyArray<SavedLogin>): SavedLogin[][] {
  const parent = new Map<SavedLogin, SavedLogin>();
  const root = (login: SavedLogin): SavedLogin => {
    const up = parent.get(login) ?? login;
    return up === login ? login : root(up);
  };
  const byKey = new Map<string, SavedLogin>();
  for (const login of logins) {
    const user = bareUser(login.account);
    if (!user) continue;
    // Any site of any copy: a login also saved for a second site meets its twin there.
    for (const site of loginSites(login)) {
      const key = `${site}\u0000${user}`;
      const seen = byKey.get(key);
      if (!seen) byKey.set(key, login);
      else if (root(seen) !== root(login)) parent.set(root(login), root(seen));
    }
  }
  const sets = new Map<SavedLogin, SavedLogin[]>();
  for (const login of logins)
    if (bareUser(login.account)) sets.set(root(login), [...(sets.get(root(login)) ?? []), login]);
  return [...sets.values()].filter((set) => set.length > 1);
}

/** The logins `duplicateSets` marks as possible duplicates. */
export function possibleDuplicates(logins: ReadonlyArray<SavedLogin>): ReadonlySet<string> {
  return new Set(
    duplicateSets(logins).flatMap((set) => set.map((login) => login.account.accountId)),
  );
}

/** Saved passwords' order: by site, then a username's bare part. */
const savedLoginOrder = (a: SavedLogin, b: SavedLogin) =>
  a.account.name.localeCompare(b.account.name, undefined, { numeric: true }) ||
  bareUser(a.account).localeCompare(bareUser(b.account));

/** Saved passwords in order, each set of possible duplicates side by side where its first one is. */
export function orderSavedLogins(logins: ReadonlyArray<SavedLogin>): SavedLogin[] {
  const sorted = logins.toSorted(savedLoginOrder);
  const setOf = new Map(
    duplicateSets(sorted).flatMap((set) => set.map((login) => [login, set] as const)),
  );
  const placed = new Set<SavedLogin>();
  return sorted.flatMap((login) => {
    if (placed.has(login)) return [];
    const together = setOf.get(login) ?? [login];
    for (const each of together) placed.add(each);
    return together;
  });
}
