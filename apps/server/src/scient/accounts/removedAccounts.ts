import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PasswordVersion, StoredAccount, type RemovedLogin } from "./AccountPersistence.ts";
import { loginKeysOf, loginUserKey } from "@t3tools/shared/scientLoginIdentity";

/** Its own record, so builds that don't know Undo leave `accounts-state` as it is. */
export const REMOVED_ACCOUNTS_RECORD = "accounts-removed";
/** How long a removed row and its values wait for Undo. */
export const UNDO_FOR_MS = 60 * 60 * 1000;

/** One removal waiting for Undo. */
export const RemovedAccount = Schema.Struct({
  row: StoredAccount,
  until: Schema.Number,
  removalId: Schema.String,
  operationId: Schema.optional(Schema.String),
  /** An agent's removal: only its chat may bring it back. */
  threadId: Schema.optional(Schema.String),
  /** The row's password history, back with the row on Undo. */
  history: Schema.optional(Schema.Array(PasswordVersion)),
});
export const RemovedAccounts = Schema.Array(RemovedAccount);
export type RemovedAccounts = typeof RemovedAccounts.Type;

const readsRemoved = Schema.decodeUnknownOption(RemovedAccount);
/**
 * The stored removals read one by one, as the state's lists are: one that doesn't read is
 * dropped alone (`dropped`, as stored), never the others' Undo; one that does is also given as
 * stored beside what it read as (`read`). None if it isn't a list.
 */
export const readRemovedAccounts = (
  raw: unknown,
):
  | {
      readonly removed: RemovedAccounts;
      readonly dropped: ReadonlyArray<unknown>;
      readonly read: ReadonlyArray<{ readonly record: unknown; readonly decoded: unknown }>;
    }
  | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const removed: Array<RemovedAccounts[number]> = [];
  const dropped: unknown[] = [];
  const read: Array<{ record: unknown; decoded: unknown }> = [];
  for (const entry of raw) {
    const decoded = readsRemoved(entry);
    if (Option.isNone(decoded)) {
      dropped.push(entry);
      continue;
    }
    removed.push(decoded.value);
    read.push({ record: entry, decoded: decoded.value });
  }
  return { removed, dropped, read };
};

/** The entries Undo can still bring back. */
export const unexpired = (removed: RemovedAccounts, now: number) =>
  removed.filter(({ until }) => until > now);

/** Remembered removals stop here; the oldest are forgotten first. */
const REMOVED_LOGINS_KEPT = 1_000;

/**
 * The logins a removed website row stood for, one per site, by the one login identity. A login
 * with no saved address names no tenant: its removal covers any page.
 */
export const removedLoginsOf = (row: StoredAccount): ReadonlyArray<RemovedLogin> => {
  const { details } = row.summary;
  if (details.kind !== "website") return [];
  return loginKeysOf(details).map(({ tenant, ...key }) => ({
    ...key,
    ...(details.loginUrl === undefined ? {} : { tenant }),
    ...(details.profileId ? { profileId: details.profileId } : {}),
  }));
};

// A marker written before a username rule changed compares by today's rule too.
const markerKey = (entry: RemovedLogin) =>
  JSON.stringify([entry.site, entry.tenant, loginUserKey(entry.username), entry.profileId]);

export const withRemovedLogins = (
  removed: ReadonlyArray<RemovedLogin> | undefined,
  added: ReadonlyArray<RemovedLogin>,
) =>
  [
    ...new Map([...(removed ?? []), ...added].map((entry) => [markerKey(entry), entry])).values(),
  ].slice(-REMOVED_LOGINS_KEPT);

/** Forgets the removals Undo brought back. */
export const withoutRemovedLogins = (
  removed: ReadonlyArray<RemovedLogin> | undefined,
  back: ReadonlyArray<RemovedLogin>,
) => {
  const keys = new Set(back.map(markerKey));
  return (removed ?? []).filter((entry) => !keys.has(markerKey(entry)));
};
