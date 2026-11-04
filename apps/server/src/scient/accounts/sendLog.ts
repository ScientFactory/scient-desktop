import {
  type AccountSummary,
  type BrowserProfileId,
  type BrowserProfileRecord,
  type EnvironmentId,
  type ProfileSendLog,
  type ProfileSharedWith,
} from "@t3tools/contracts";
import { shareable, unitSites } from "@t3tools/shared/scientSessionCookies";

import { effectiveProfile } from "./AccountDecisions.ts";

/** Copies beyond this fall back to a whole-jar revision; deletions are never dropped unapplied. */
const COPIES_LIMIT = 5_000;
const EMPTY: ProfileSendLog = { head: 0, units: [] };

/**
 * Whether a row now records a newer real sign-in: `by: "action"`, signed in, at a later time than
 * before. Looks (`by: "look"`, imports, Checks, copies into Main) never make a revision.
 */
const isNewerAction = (before: AccountSummary | undefined, after: AccountSummary) => {
  const signIn = after.signIn;
  if (signIn?.by !== "action" || signIn.state !== "signed-in") return false;
  const previous = before?.signIn?.at;
  return previous === undefined || Date.parse(signIn.at) > Date.parse(previous);
};

const unitKey = (sites: ReadonlyArray<string>) => [...unitSites(sites)].sort().join(" ");

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
  const copies = others.filter((unit) => unit.kind === "copy").length;
  if (kind === "delete" || copies < COPIES_LIMIT)
    return { ...current, head, units: [...others, entry] };
  // Full of copies: the whole jar goes again instead, so no unit is lost.
  return { ...current, head, jar: head, units: others.filter((unit) => unit.kind === "delete") };
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

/**
 * Entries every computer still sent to has applied are dropped; with none recorded, nothing is.
 * `share` undefined forgets that computer, as unlinking it does.
 */
export function withShared(
  record: BrowserProfileRecord,
  environmentId: EnvironmentId,
  share: ProfileSharedWith | undefined,
): BrowserProfileRecord {
  const sharedWith = [
    ...(record.sharedWith ?? []).filter((entry) => entry.environmentId !== environmentId),
    ...(share ? [share] : []),
  ];
  if (sharedWith.length === 0) {
    const { sharedWith: _, ...rest } = record;
    return rest;
  }
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
 * A profile no other computer follows keeps no unit entries: a computer that links later is
 * filled whole, or reconciled whole if it already held copies. Head, jar and withdrawal stay.
 */
const unfollowed = (profile: BrowserProfileRecord) =>
  !profile.sharedWith?.length && (profile.send?.units.length ?? 0) > 0;

/**
 * Revisions written in the commit that records the action: a newer sign-in action in a profile
 * copies its unit; a profile turning restricted withdraws, and turning shareable resends the jar.
 */
export function withSendLog<S extends State>(before: S, next: S): S {
  const changed = new Map<BrowserProfileId, BrowserProfileRecord>();
  const record = (profileId: BrowserProfileId) =>
    changed.get(profileId) ?? effectiveProfile(next.profiles, profileId);
  const previousRows = new Map(before.accounts.map(({ summary }) => [summary.accountId, summary]));
  for (const { summary } of next.accounts) {
    const profileId = profileOf(summary);
    if (!profileId || summary.details.kind !== "website") continue;
    if (!isNewerAction(previousRows.get(summary.accountId), summary)) continue;
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
  const profiles =
    changed.size === 0
      ? next.profiles
      : [
          ...next.profiles.filter((profile) => !changed.has(profile.profileId)),
          ...changed.values(),
        ];
  if (changed.size === 0 && !profiles.some(unfollowed)) return next;
  return {
    ...next,
    profiles: profiles.map((profile) =>
      unfollowed(profile) && profile.send
        ? { ...profile, send: { ...profile.send, units: [] } }
        : profile,
    ),
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
