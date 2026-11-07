/**
 * The desktop's side of sending sign-ins to another computer: one delivery from durable state,
 * with every request injected, so the web app runs it and a test can wire it to a receiver.
 */

import {
  defaultBrowserProfileRecord,
  type AccountSessionsApplied,
  type AccountSessionsReceiveInput,
  type AccountSessionsReceiveResult,
  type AccountsSnapshot,
  type BrowserProfileRecord,
  type DesktopAccountsBridge,
  type EnvironmentId,
  type ProfileSendLog,
  type ProfileSharedWith,
  type SessionCookie,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  hasAccountRow,
  planDelivery,
  remoteControls,
  shareable,
  travels,
  unitSites,
  universitySites,
  type PlannedUnit,
} from "./scientSessionCookies.ts";

type ReadSessions = NonNullable<DesktopAccountsBridge["readSessions"]>;

/** One persistent profile on the desktop, as delivery sees it. */
export interface DeliveryProfile {
  readonly profileId: string;
  readonly record: BrowserProfileRecord;
}

export interface DeliveryDeps {
  /** This desktop's primary environment, and its name on the remote. */
  readonly source: EnvironmentId;
  readonly label: string;
  readonly remoteId: EnvironmentId;
  readonly remoteLabel: string;
  /** Persistent profiles with their desktop records. */
  readonly profiles: () => ReadonlyArray<DeliveryProfile>;
  /** Desktop rows, for the university's units that never travel. */
  readonly desktopAccounts: () => AccountsSnapshot["accounts"];
  /** Sites of the profile's rows with a sign-in under way: their tabs are the user's, not a source. */
  readonly signingIn: (profileId: string) => ReadonlyArray<string>;
  /** Undefined while the route, destination, permission and feature still hold as planned. */
  readonly revalidate: () => string | undefined;
  /** Proves this desktop is the sender the remote knows, or becomes a new one; its key. */
  readonly bind: () => Promise<Redacted.Redacted<string>>;
  readonly sendLog: (profileId: string) => Promise<ProfileSendLog>;
  /** A whole-jar revision on the desktop, so a reconciliation outranks what the remote holds. */
  readonly resend: (profileId: string) => Promise<void>;
  readonly applied: (
    profileId: string,
    key: Redacted.Redacted<string>,
  ) => Promise<AccountSessionsApplied>;
  readonly remoteRecord: (profileId: string) => BrowserProfileRecord | undefined;
  readonly receive: (input: AccountSessionsReceiveInput) => Promise<AccountSessionsReceiveResult>;
  readonly withdraw: (
    profileId: string,
    revision: number,
    key: Redacted.Redacted<string>,
  ) => Promise<void>;
  readonly shared: (profileId: string, share: ProfileSharedWith) => Promise<void>;
  readonly readSessions: ReadSessions;
  readonly now: () => string;
}

/** Stops a run: every await checks it, so nothing more is sent once it is set. */
export class DeliveryStopped extends Schema.TaggedError<DeliveryStopped>()("DeliveryStopped", {
  message: Schema.String,
}) {}

/** The profile's controls changed after its plan was made. */
class ControlsChanged extends Schema.TaggedError<ControlsChanged>()("ControlsChanged", {}) {}

/** The desktop could not read a jar: a failed run, retried; never read as an empty jar. */
class JarUnreadable extends Schema.TaggedError<JarUnreadable>()("JarUnreadable", {}) {}
const isControlsChanged = Schema.is(ControlsChanged);

const sameProfileControls = (a: BrowserProfileRecord, b: BrowserProfileRecord) =>
  a.access === b.access &&
  a.scriptSignIn === b.scriptSignIn &&
  JSON.stringify(a.scope) === JSON.stringify(b.scope);

const BATCH_UNITS = 100;
const BATCH_COOKIES = 1_000;
const WAITING = new Set(["busy", "failed", "restore-failed"]);

const sameControls = (record: BrowserProfileRecord | undefined, desktop: BrowserProfileRecord) => {
  const sent = remoteControls(desktop);
  return (
    record !== undefined &&
    record.access === sent.access &&
    record.scope.type === "all-projects" &&
    record.scriptSignIn === sent.scriptSignIn
  );
};

const multiSiteRows = (accounts: AccountsSnapshot["accounts"], profileId: string) =>
  accounts.flatMap(({ details }) =>
    details.kind === "website" && details.profileId === profileId && details.sites.length > 1
      ? [details.sites]
      : [],
  );

/**
 * One delivery to one remote, from durable state only: each persistent profile's send log, its
 * jar now, and what the remote applied. Revalidates before every batch. Resolves with how many
 * units still wait (busy, failed or not restored there), which the caller retries.
 */
export async function deliverOnce(deps: DeliveryDeps): Promise<{ readonly waiting: number }> {
  const check = () => {
    const stopped = deps.revalidate();
    if (stopped !== undefined) throw new DeliveryStopped({ message: stopped });
  };
  const university = universitySites(deps.desktopAccounts());
  check();
  const key = await deps.bind();
  // An unreadable jar plans, acknowledges and deletes nothing.
  const readJar = async (input: Parameters<ReadSessions>[0]) => {
    const read = await deps.readSessions(input);
    if (!read) throw new JarUnreadable();
    return read.units;
  };
  const recordOf = (profileId: string) =>
    deps.profiles().find((profile) => profile.profileId === profileId)?.record ??
    defaultBrowserProfileRecord(profileId);
  const deliverProfile = async (profileId: string): Promise<number> => {
    check();
    // A fresh desktop record each time: a profile restricted meanwhile switches to the withdrawal.
    const record = recordOf(profileId);
    // Merged into Main: its copies on the remote stay, neither updated nor taken back.
    if (record.retired) return 0;
    /** The controls this plan was made under still hold: checked before every read and send. */
    const hold = () => {
      check();
      if (!sameProfileControls(recordOf(profileId), record)) throw new ControlsChanged();
    };
    const isShareable = shareable(profileId, record);
    const applied = await deps.applied(profileId, key);
    // A computer this desktop forgot (unlinked, then linked again) is reconciled in full.
    const reconcile =
      isShareable &&
      applied.bound &&
      !record.sharedWith?.some((entry) => entry.environmentId === deps.remoteId);
    if (reconcile) await deps.resend(profileId);
    const log = await deps.sendLog(profileId);
    const controls = remoteControls(record);
    const join = multiSiteRows(deps.desktopAccounts(), profileId);
    hold();
    const jar = isShareable
      ? (await readJar({ profileId, join })).filter(({ sites }) =>
          hasAccountRow(sites, deps.desktopAccounts(), profileId),
        )
      : [];
    hold();
    const plan = planDelivery({
      log,
      applied,
      jar: jar.map(({ sites }) => sites),
      shareable: isShareable,
      reconcile,
      travels: (unit) => travels(unit, university),
    });
    if (plan.kind === "withdraw") await deps.withdraw(profileId, plan.revision, key);
    const batch = (units: AccountSessionsReceiveInput["units"], mode: "fill" | "replace") =>
      deps.receive({
        source: deps.source,
        key,
        label: deps.label,
        profileId,
        controls,
        mode,
        units,
        sentAt: deps.now(),
      });
    // Controls go for every persistent profile; a restricted one sends nothing else.
    if (plan.kind !== "units" || plan.units.length === 0) {
      if (!applied.bound || !sameControls(deps.remoteRecord(profileId), record)) {
        hold();
        await batch([], plan.kind === "units" ? plan.mode : "replace");
      }
      return plan.kind === "units" ? recordShare(deps, key, profileId, plan, []) : 0;
    }
    const outcomes: Array<{ unit: PlannedUnit; outcome: string }> = [];
    // A unit someone is signing in to goes once that sign-in ends; until then it waits. Asked
    // afresh each time, so a sign-in that begins mid-delivery holds its units back too.
    const underWay = (unit: PlannedUnit) => {
      const busy = unitSites(deps.signingIn(profileId));
      return [...unitSites(unit.sites)].some((site) => busy.has(site));
    };
    for (const group of batches(plan.units)) {
      hold();
      const copies = group.filter((unit) => unit.kind === "copy" && !underWay(unit));
      const read = copies.length
        ? await readJar({ profileId, units: copies.map((unit) => unit.sites) })
        : [];
      hold();
      const ready: Array<{ planned: PlannedUnit; unit: SentUnit }> = [];
      for (const planned of group) {
        const { sites, revision } = planned;
        if (underWay(planned)) {
          outcomes.push({ unit: planned, outcome: "busy" });
          continue;
        }
        if (planned.kind === "delete") {
          ready.push({
            planned,
            unit: {
              sites,
              revision,
              kind: "delete",
              ...(planned.copyOnly ? { copyOnly: true } : {}),
            },
          });
          continue;
        }
        const cookies = cookiesOf(read, planned);
        // Gone from the jar since planning: nothing to copy, and no deletion by absence.
        if (cookies.length === 0) continue;
        if (cookies.length > BATCH_COOKIES) outcomes.push({ unit: planned, outcome: "failed" });
        else
          ready.push({ planned, unit: { sites, revision, kind: "copy", cookies: sent(cookies) } });
      }
      for (const part of byCookies(ready)) {
        hold();
        const sending = part.filter(({ planned }) => {
          if (!underWay(planned)) return true;
          outcomes.push({ unit: planned, outcome: "busy" });
          return false;
        });
        if (sending.length === 0) continue;
        const result = await batch(
          sending.map(({ unit }) => unit),
          plan.mode,
        );
        sending.forEach(({ planned }, index) =>
          outcomes.push({ unit: planned, outcome: result.units[index]?.outcome ?? "failed" }),
        );
      }
    }
    return recordShare(deps, key, profileId, plan, outcomes);
  };
  let waiting = 0;
  for (const { profileId } of deps.profiles())
    for (let attempt = 0; ; attempt += 1)
      try {
        waiting += await deliverProfile(profileId);
        break;
      } catch (cause) {
        // Changed controls: plan the profile again, which withdraws it if it is now restricted.
        if (!isControlsChanged(cause)) throw cause;
        if (attempt >= 2) throw new DeliveryStopped({ message: "controls keep changing" });
      }
  return { waiting };
}

type SentUnit = AccountSessionsReceiveInput["units"][number];

const cookiesOf = (
  read: ReadonlyArray<{
    readonly sites: ReadonlyArray<string>;
    readonly cookies: ReadonlyArray<SessionCookie>;
  }>,
  unit: PlannedUnit,
) => {
  const sites = unitSites(unit.sites);
  return read
    .filter((entry) => [...unitSites(entry.sites)].some((site) => sites.has(site)))
    .flatMap((entry) => entry.cookies);
};

const sent = (cookies: ReadonlyArray<SessionCookie>) =>
  cookies.map(({ value, ...rest }) => ({ ...rest, value: Redacted.make(value) }));

function* batches(units: ReadonlyArray<PlannedUnit>) {
  for (let start = 0; start < units.length; start += BATCH_UNITS)
    yield units.slice(start, start + BATCH_UNITS);
}

/** Never splits a unit: a batch closes before the unit that would pass 1,000 cookies. */
function* byCookies<A extends { readonly unit: SentUnit }>(entries: ReadonlyArray<A>) {
  let part: A[] = [];
  let count = 0;
  for (const entry of entries) {
    const size = entry.unit.cookies?.length ?? 0;
    if (part.length && count + size > BATCH_COOKIES) {
      yield part;
      part = [];
      count = 0;
    }
    part.push(entry);
    count += size;
  }
  if (part.length) yield part;
}

/** The remote's line on the desktop; `applied` is the revision below which nothing waits. */
async function recordShare(
  deps: DeliveryDeps,
  key: Redacted.Redacted<string>,
  profileId: string,
  plan: Extract<ReturnType<typeof planDelivery>, { kind: "units" }>,
  outcomes: ReadonlyArray<{ unit: PlannedUnit; outcome: string }>,
) {
  const waiting = outcomes.filter(({ outcome }) => WAITING.has(outcome));
  const after = await deps.applied(profileId, key).catch(() => undefined);
  const at = deps.now();
  await deps.shared(profileId, {
    environmentId: deps.remoteId,
    label: deps.remoteLabel,
    sentAt: at,
    seenAt: at,
    applied: waiting.length
      ? Math.max(0, Math.min(...waiting.map(({ unit }) => unit.revision)) - 1)
      : plan.head,
    waiting: waiting.length,
    kept: after?.units.filter((unit) => unit.outcome === "kept").length ?? 0,
    needsYou: [
      ...new Set(
        (after?.units ?? []).flatMap((unit) => (unit.needsYou ? [...unitSites(unit.sites)] : [])),
      ),
    ].slice(0, 50),
  });
  return waiting.length;
}
