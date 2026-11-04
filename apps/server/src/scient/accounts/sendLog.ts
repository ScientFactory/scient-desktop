import {
  type AccountSummary,
  type BrowserProfileId,
  type BrowserProfileRecord,
  type ProfileSendLog,
  type ProfileSharedWith,
} from "@t3tools/contracts";
import { shareable, unitSites } from "@t3tools/shared/scientSessionCookies";

import { effectiveProfile, isGoogleSessionRow } from "./AccountDecisions.ts";
import { siteOf } from "./profileCookieJar.ts";

const UNITS_LIMIT = 5_000;
const SHARED_LIMIT = 32;
const EMPTY: ProfileSendLog = { head: 0, units: [] };

/**
 * The one seam for item 4's `AccountSignIn.by`: whether a row now records a newer real action.
 * Until `by: "action"` lands, an action is a `signed-in` that a finished attempt wrote (it stamps
 * `lastUsedAt` with the same time), or Google showing an account the row had no status for.
 */
const isNewerAction = (before: AccountSummary | undefined, after: AccountSummary) => {
  const signIn = after.signIn;
  if (signIn?.state !== "signed-in" || signIn.at === before?.signIn?.at) return false;
  return (
    after.lastUsedAt === signIn.at || (isGoogleSessionRow(after) && before?.signIn === undefined)
  );
};

const unitKey = (sites: ReadonlyArray<string>) => [...unitSites(sites, siteOf)].sort().join(" ");

/** The next revision for one unit; a full log falls back to a whole-jar revision. */
export function issueUnit(
  log: ProfileSendLog | undefined,
  sites: ReadonlyArray<string>,
  kind: "copy" | "delete",
): ProfileSendLog {
  const current = log ?? EMPTY;
  const head = current.head + 1;
  const key = unitKey(sites);
  const others = current.units.filter((unit) => unitKey(unit.sites) !== key);
  const entry = { sites, revision: head, kind };
  if (others.length < UNITS_LIMIT) return { ...current, head, units: [...others, entry] };
  // Full: the whole jar goes again instead, so no unit is lost; deletions stay until applied.
  const deletes = others.filter((unit) => unit.kind === "delete");
  return {
    ...current,
    head,
    jar: head,
    units: [...deletes, ...(kind === "delete" ? [entry] : [])].slice(-UNITS_LIMIT),
  };
}

export function issueJar(log: ProfileSendLog | undefined): ProfileSendLog {
  const current = log ?? EMPTY;
  const head = current.head + 1;
  return { ...current, head, jar: head, units: current.units.filter((u) => u.kind === "delete") };
}

function issueWithdrawal(log: ProfileSendLog | undefined): ProfileSendLog {
  const current = log ?? EMPTY;
  const head = current.head + 1;
  return { ...current, head, withdrawn: head };
}

/** Entries every computer has applied are dropped; with none recorded, nothing is. */
export function withShared(
  record: BrowserProfileRecord,
  share: ProfileSharedWith,
): BrowserProfileRecord {
  const sharedWith = [
    ...(record.sharedWith ?? []).filter((entry) => entry.environmentId !== share.environmentId),
    share,
  ].slice(-SHARED_LIMIT);
  const applied = Math.min(...sharedWith.map((entry) => entry.applied));
  const send = record.send && {
    ...record.send,
    units: record.send.units.filter((unit) => unit.revision > applied),
  };
  return { ...record, sharedWith, ...(send ? { send } : {}) };
}

type State = {
  readonly accounts: ReadonlyArray<{ readonly summary: AccountSummary }>;
  readonly profiles: ReadonlyArray<BrowserProfileRecord>;
};

const profileOf = (summary: AccountSummary) =>
  summary.details.kind === "website" ? summary.details.profileId : undefined;

/**
 * Revisions written in the commit that records the action: a newer sign-in action in a profile
 * copies its unit; a profile turning restricted withdraws, and turning shareable resends the jar.
 */
export function withSendLog<S extends State>(before: S, next: S): S {
  const changed = new Map<BrowserProfileId, BrowserProfileRecord>();
  const record = (profileId: BrowserProfileId) =>
    changed.get(profileId) ?? effectiveProfile(next.profiles, profileId);
  for (const { summary } of next.accounts) {
    const profileId = profileOf(summary);
    if (!profileId || summary.details.kind !== "website") continue;
    const previous = before.accounts.find(
      (row) => row.summary.accountId === summary.accountId,
    )?.summary;
    if (!isNewerAction(previous, summary)) continue;
    const current = record(profileId);
    changed.set(profileId, {
      ...current,
      send: issueUnit(current.send, summary.details.sites, "copy"),
    });
  }
  for (const profile of next.profiles) {
    const was = shareable(profile.profileId, effectiveProfile(before.profiles, profile.profileId));
    const is = shareable(profile.profileId, profile);
    if (was === is) continue;
    const current = record(profile.profileId);
    changed.set(profile.profileId, {
      ...current,
      send: is ? issueJar(current.send) : issueWithdrawal(current.send),
    });
  }
  if (changed.size === 0) return next;
  return {
    ...next,
    profiles: [
      ...next.profiles.filter((profile) => !changed.has(profile.profileId)),
      ...changed.values(),
    ],
  };
}

/**
 * A profile as clients see it: only the head of its send log (the entries come from
 * profileSendLog), and received units without the digest of what their copy wrote.
 */
export const clientProfile = (profile: BrowserProfileRecord): BrowserProfileRecord => ({
  ...profile,
  ...(profile.send ? { send: { head: profile.send.head, units: [] } } : {}),
  ...(profile.received
    ? {
        received: profile.received.map((entry) => ({
          ...entry,
          units: entry.units.map(({ fingerprint: _, ...unit }) => unit),
        })),
      }
    : {}),
});
