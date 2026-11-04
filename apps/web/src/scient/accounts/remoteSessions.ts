// @effect-diagnostics globalDate:off -- Delivery times are UI labels; decisions use revisions.
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  BrowserProfileId,
  defaultBrowserProfileRecord,
  resolveBrowserProfiles,
  type AccountSessionsApplied,
  type AccountSessionsReceiveInput,
  type AccountSessionsReceiveResult,
  type AccountsSnapshot,
  type BrowserProfileRecord,
  type DesktopAccountsBridge,
  type DesktopEnvironmentBootstrap,
  type EnvironmentId,
  type ProfileSendLog,
  type ProfileSharedWith,
  type SessionCookie,
} from "@t3tools/contracts";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";
import {
  hasAccountRow,
  planDelivery,
  remoteControls,
  shareable,
  travels,
  unitSites,
  universitySites,
  type PlannedUnit,
} from "@t3tools/shared/scientSessionCookies";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { readDesktopSecondaryBootstraps } from "~/connection/desktopLocal";
import { getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironment, readPrimaryEnvironmentId } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { environmentSession, readEnvironmentScope, readPreparedConnection } from "~/state/session";

import { accountsState } from "./accountsState";

type ReadSessions = NonNullable<DesktopAccountsBridge["readSessions"]>;

export type RouteRefusal = "relay" | "unencrypted";

/**
 * Sign-ins go only over the environment's own socket on a route that is encrypted or stays on
 * this computer: an SSH tunnel's local end, TLS, a Tailscale name, loopback, or this desktop's WSL.
 */
export function allowedRoute(
  connection: Pick<PreparedConnection, "environmentId" | "socketUrl" | "target">,
  localBackends: ReadonlyArray<Pick<DesktopEnvironmentBootstrap, "id" | "httpBaseUrl">>,
): RouteRefusal | undefined {
  const url = URL.parse(connection.socketUrl);
  if (!url) return "unencrypted";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  switch (connection.target._tag) {
    case "RelayConnectionTarget":
      return "relay";
    case "PrimaryConnectionTarget":
      return "unencrypted";
    case "SshConnectionTarget":
      return url.protocol === "ws:" && isLocalLoopbackHost(host) ? undefined : "unencrypted";
    case "BearerConnectionTarget": {
      const local = localBackends.find((backend) => backend.id === connection.environmentId);
      if (local) {
        const backend = local.httpBaseUrl ? URL.parse(local.httpBaseUrl) : null;
        return backend && backend.hostname === url.hostname && backend.port === url.port
          ? undefined
          : "unencrypted";
      }
      if (url.protocol === "wss:") return undefined;
      return url.protocol === "ws:" && (isLocalLoopbackHost(host) || isTailnetHost(host))
        ? undefined
        : "unencrypted";
    }
  }
}

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
export class DeliveryStopped extends Error {}

/** Why a delivery failed, in words safe to show: never a cookie, a key or a server's message. */
export type DeliveryFailureReason = "refused" | "failed";

/** A request of the delivery that the remote or this desktop answered with an error. */
class DeliveryFailed extends Error {
  readonly reason: DeliveryFailureReason;
  constructor(reason: DeliveryFailureReason) {
    super("The request failed.");
    this.reason = reason;
  }
}

const failureReason = (result: { readonly _tag: string; readonly cause?: unknown }) => {
  const error = Cause.isCause(result.cause) ? Cause.squash(result.cause) : result.cause;
  return typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "denied"
    ? ("refused" as const)
    : ("failed" as const);
};

/** The profile's controls changed after its plan was made. */
class ControlsChanged extends DeliveryStopped {}

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
 * jar now, and what the remote applied. Revalidates before every batch.
 */
export async function deliverOnce(deps: DeliveryDeps) {
  const check = () => {
    const stopped = deps.revalidate();
    if (stopped !== undefined) throw new DeliveryStopped(stopped);
  };
  const university = universitySites(deps.desktopAccounts());
  check();
  const key = await deps.bind();
  const recordOf = (profileId: string) =>
    deps.profiles().find((profile) => profile.profileId === profileId)?.record ??
    defaultBrowserProfileRecord(profileId);
  const deliverProfile = async (profileId: string) => {
    check();
    // A fresh desktop record each time: a profile restricted meanwhile switches to the withdrawal.
    const record = recordOf(profileId);
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
    const own = { access: record.access, scope: record.scope, scriptSignIn: record.scriptSignIn };
    const join = multiSiteRows(deps.desktopAccounts(), profileId);
    hold();
    const jar = isShareable
      ? ((await deps.readSessions({ profileId, controls: own, join }))?.units ?? []).filter(
          ({ sites }) => hasAccountRow(sites, deps.desktopAccounts(), profileId),
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
      if (plan.kind === "units") await recordShare(deps, key, profileId, plan, []);
      return;
    }
    const outcomes: Array<{ unit: PlannedUnit; outcome: string }> = [];
    // A unit someone is signing in to goes once that sign-in ends; until then it waits.
    const busy = unitSites(deps.signingIn(profileId));
    const underWay = (unit: PlannedUnit) =>
      [...unitSites(unit.sites)].some((site) => busy.has(site));
    for (const group of batches(plan.units)) {
      hold();
      const copies = group.filter((unit) => unit.kind === "copy" && !underWay(unit));
      const read = copies.length
        ? ((
            await deps.readSessions({
              profileId,
              controls: own,
              units: copies.map((unit) => unit.sites),
            })
          )?.units ?? [])
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
          ready.push({ planned, unit: { sites, revision, kind: "delete" } });
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
        const result = await batch(
          part.map(({ unit }) => unit),
          plan.mode,
        );
        part.forEach(({ planned }, index) =>
          outcomes.push({ unit: planned, outcome: result.units[index]?.outcome ?? "failed" }),
        );
      }
    }
    await recordShare(deps, key, profileId, plan, outcomes);
  };
  for (const { profileId } of deps.profiles())
    for (let attempt = 0; ; attempt += 1)
      try {
        await deliverProfile(profileId);
        break;
      } catch (cause) {
        // Changed controls: plan the profile again, which withdraws it if it is now restricted.
        if (!(cause instanceof ControlsChanged) || attempt >= 2) throw cause;
      }
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
}

const recordOf = (snapshot: AccountsSnapshot | undefined, profileId: string) =>
  snapshot?.profiles.find((record) => record.profileId === profileId) ??
  defaultBrowserProfileRecord(profileId);

const value = <A>(result: AsyncResult.AsyncResult<A, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value : undefined;

const call = async <I, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  environmentId: EnvironmentId,
  input: I,
): Promise<A> => {
  const result = await command.run(registry, { environmentId, input });
  if (result._tag !== "Success") throw new DeliveryFailed(failureReason(result));
  return result.value;
};

const desktopLabel = (primaryId: EnvironmentId) =>
  readEnvironment(primaryId)?.serverConfig?.environment.label ?? "this computer";

/**
 * The key the remote issued this desktop, kept encrypted with this desktop's Accounts. Without
 * one, the remote issues a new key, once; a remote that already knows another key refuses.
 */
async function bindSender(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  primaryId: EnvironmentId,
) {
  const kept = await call(registry, accountsState.senderKey, primaryId, { environmentId });
  const bound = await call(registry, accountsState.sessionsBind, environmentId, {
    source: primaryId,
    label: desktopLabel(primaryId),
    ...(kept.key ? { key: kept.key } : {}),
  });
  if (bound.key)
    await call(registry, accountsState.keepSenderKey, primaryId, { environmentId, key: bound.key });
  const key = bound.key ?? kept.key;
  if (!key) throw new DeliveryStopped("unbound");
  return key;
}

/** The last delivery to each remote that failed, until one succeeds. */
export interface DeliveryFailure {
  readonly reason: DeliveryFailureReason;
  readonly at: string;
}

export const deliveryFailuresAtom = Atom.make(
  new Map<EnvironmentId, DeliveryFailure>() as ReadonlyMap<EnvironmentId, DeliveryFailure>,
).pipe(Atom.keepAlive);

/** Waits before each retry of a failed delivery; past the last, the next change tries again. */
const RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

/** Remotes being sent sign-ins now, for "sending your sign-ins…". */
export const sendingRemotesAtom = Atom.make(
  new Set<EnvironmentId>() as ReadonlySet<EnvironmentId>,
).pipe(Atom.keepAlive);

/** Where delivery to a remote stands: what would stop it, or the identity it plans with. */
function routeOf(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  const presentation = registry.get(environmentPresentations.presentationAtom(environmentId));
  if (!presentation?.entry.enabled) return { stopped: "removed" } as const;
  if (presentation.connection.phase !== "connected") return { stopped: "offline" } as const;
  const connection = readPreparedConnection(environmentId);
  if (!connection) return { stopped: "offline" } as const;
  const refused = allowedRoute(connection, readDesktopSecondaryBootstraps());
  if (refused) return { stopped: refused } as const;
  if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope))
    return { stopped: "permission" } as const;
  const remote = value(registry.get(accountsState.snapshot({ environmentId, input: {} })));
  if (!remote?.features?.sessionsReceive) return { stopped: "no-feature" } as const;
  const target = connection.target;
  return {
    identity: JSON.stringify([
      target._tag,
      "connectionId" in target ? target.connectionId : null,
      connection.socketUrl,
    ]),
    label: presentation.entry.target.label,
  } as const;
}

const persistentProfiles = () =>
  resolveBrowserProfiles(getClientSettings().browserProfiles).filter(
    (profile) => profile.kind === "persistent",
  );

/**
 * Delivers this desktop's sign-ins to one remote, serially: a nudge while a run goes sets "run
 * again". Each run recomputes from durable state, so a missed nudge only delays delivery. A route,
 * destination or permission change interrupts the run; it sends nothing more.
 */
export function watchRemoteSessions(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  primaryId: EnvironmentId,
) {
  const readSessions = window.desktopBridge?.accounts?.readSessions;
  if (!readSessions) return () => undefined;
  const desktopAtom = accountsState.snapshot({ environmentId: primaryId, input: {} });
  const remoteAtom = accountsState.snapshot({ environmentId, input: {} });
  let stopped = false;
  let running: { readonly identity: string; cancelled: boolean } | undefined;
  let again = false;
  let lastKey: string | undefined;
  let retries = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const setSending = (sending: boolean) => {
    const current = new Set(registry.get(sendingRemotesAtom));
    if (sending) current.add(environmentId);
    else current.delete(environmentId);
    registry.set(sendingRemotesAtom, current);
  };

  const setFailure = (failure: DeliveryFailure | undefined) => {
    const current = new Map(registry.get(deliveryFailuresAtom));
    if (failure) current.set(environmentId, failure);
    else if (!current.delete(environmentId)) return;
    registry.set(deliveryFailuresAtom, current);
  };

  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    again = false;
    const route = routeOf(registry, environmentId);
    if (stopped || "stopped" in route) return;
    const token = { identity: route.identity, cancelled: false };
    running = token;
    setSending(true);
    const desktop = () => value(registry.get(desktopAtom));
    const outcome = await deliverOnce({
      source: primaryId,
      label: readEnvironment(primaryId)?.serverConfig?.environment.label ?? "this computer",
      remoteId: environmentId,
      remoteLabel: route.label,
      profiles: () =>
        persistentProfiles().map(({ id }) => ({
          profileId: id,
          record: recordOf(desktop(), id),
        })),
      desktopAccounts: () => desktop()?.accounts ?? [],
      signingIn: (profileId) => {
        const snapshot = desktop();
        const accounts = new Set((snapshot?.attempts ?? []).map(({ accountId }) => accountId));
        return (snapshot?.accounts ?? []).flatMap((row) =>
          accounts.has(row.accountId) &&
          row.details.kind === "website" &&
          row.details.profileId === profileId
            ? row.details.sites
            : [],
        );
      },
      revalidate: () => {
        if (token.cancelled || stopped) return "cancelled";
        const now = routeOf(registry, environmentId);
        return "stopped" in now
          ? now.stopped
          : now.identity === token.identity
            ? undefined
            : "route";
      },
      sendLog: (profileId) =>
        call(registry, accountsState.profileSendLog, primaryId, {
          profileId: BrowserProfileId.make(profileId),
        }),
      bind: () => bindSender(registry, environmentId, primaryId),
      applied: (profileId, key) =>
        call(registry, accountsState.sessionsApplied, environmentId, {
          source: primaryId,
          key,
          profileId: BrowserProfileId.make(profileId),
        }),
      remoteRecord: (profileId) =>
        value(registry.get(remoteAtom))?.profiles.find((record) => record.profileId === profileId),
      receive: (input) => call(registry, accountsState.sessionsReceive, environmentId, input),
      withdraw: (profileId, revision, key) =>
        call(registry, accountsState.sessionsWithdraw, environmentId, {
          source: primaryId,
          key,
          profileId: BrowserProfileId.make(profileId),
          revision,
        }).then(() => undefined),
      resend: (profileId) =>
        call(registry, accountsState.profileResend, primaryId, {
          profileId: BrowserProfileId.make(profileId),
          why: "send-again",
        }).then(() => undefined),
      shared: (profileId, share) =>
        call(registry, accountsState.profileShared, primaryId, {
          profileId: BrowserProfileId.make(profileId),
          share,
        }).then(() => undefined),
      readSessions,
      now: () => new Date().toISOString(),
    }).then(
      () => "delivered" as const,
      // A changed route, permission or control stops a run; that is no failure.
      (cause: unknown) =>
        cause instanceof DeliveryStopped
          ? ("stopped" as const)
          : cause instanceof DeliveryFailed
            ? cause.reason
            : ("failed" as const),
    );
    running = undefined;
    setSending(false);
    if (outcome === "delivered") {
      retries = 0;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      setFailure(undefined);
    } else if (outcome !== "stopped" && !stopped) {
      setFailure({ reason: outcome, at: new Date().toISOString() });
      const wait = RETRY_MS[retries];
      if (wait !== undefined && retry === undefined) {
        retries += 1;
        retry = setTimeout(() => {
          retry = undefined;
          // The same state as the failed run: forget it, so it runs again.
          lastKey = undefined;
          nudge();
        }, wait);
      }
    }
    if (again && !stopped) return run();
  };

  /** What a run depends on; a change nudges, and a route change interrupts the running one. */
  const nudge = () => {
    const route = routeOf(registry, environmentId);
    if (running && ("stopped" in route || route.identity !== running.identity))
      running.cancelled = true;
    if ("stopped" in route) {
      lastKey = undefined;
      return;
    }
    const desktop = value(registry.get(desktopAtom));
    const remote = value(registry.get(remoteAtom));
    const key = JSON.stringify([
      route.identity,
      // A unit held for a sign-in goes once that sign-in ends.
      (desktop?.attempts ?? []).map(({ attemptId }) => attemptId),
      persistentProfiles().map(({ id }) => {
        const record = recordOf(desktop, id);
        return [id, record.send?.head ?? 0, record.access, record.scope, record.scriptSignIn];
      }),
      (remote?.profiles ?? []).map((record) =>
        record.received
          ?.filter((entry) => entry.source === primaryId)
          .map((entry) => [
            entry.withdrawn,
            entry.units.map((unit) => [unit.revision, unit.outcome, unit.needsYou]),
          ]),
      ),
    ]);
    if (key === lastKey) return;
    lastKey = key;
    void run();
  };

  const stops = [
    registry.subscribe(desktopAtom, nudge),
    registry.subscribe(remoteAtom, nudge),
    registry.subscribe(environmentPresentations.presentationAtom(environmentId), nudge),
    registry.subscribe(environmentSession.sessionStateAtom(environmentId), nudge),
  ];
  nudge();
  return () => {
    stopped = true;
    if (running) running.cancelled = true;
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    for (const stop of stops) stop();
  };
}

/** Send again: every shareable profile's whole jar goes to every remote with the next delivery. */
export async function sendAgain(registry: AtomRegistry.AtomRegistry, primaryId: EnvironmentId) {
  const desktop = value(
    registry.get(accountsState.snapshot({ environmentId: primaryId, input: {} })),
  );
  for (const { id } of persistentProfiles())
    if (shareable(id, recordOf(desktop, id)))
      await call(registry, accountsState.profileResend, primaryId, {
        profileId: BrowserProfileId.make(id),
        why: "send-again",
      });
}

const WITHDRAW_LIMIT_MS = 5_000;

/**
 * Before a remote is removed: its copies of this desktop's sign-ins are deleted there, if it
 * answers within 5 s. Removal never waits longer; an offline remote keeps them until it finds
 * this desktop's access revoked.
 */
export async function withdrawCopies(environmentId: EnvironmentId) {
  const primaryId = readPrimaryEnvironmentId();
  if (!primaryId || primaryId === environmentId || !window.desktopBridge?.accounts?.readSessions)
    return "none" as const;
  const kept = await call(appAtomRegistry, accountsState.senderKey, primaryId, {
    environmentId,
  }).catch(() => undefined);
  const withdrawn = kept?.key
    ? call(appAtomRegistry, accountsState.sessionsWithdraw, environmentId, {
        source: primaryId,
        key: kept.key,
        all: true,
      }).then(
        () => "withdrawn" as const,
        () => "offline" as const,
      )
    : Promise.resolve("none" as const);
  const timeout = new Promise<"offline">((resolve) =>
    setTimeout(() => resolve("offline"), WITHDRAW_LIMIT_MS),
  );
  const outcome = await Promise.race([withdrawn, timeout]);
  // Delivery stops either way, and no deletion waits for this computer any more. The key goes
  // only after a confirmed withdrawal; kept, a later link proves this desktop and reconciles.
  await call(appAtomRegistry, accountsState.profilesUnshared, primaryId, {
    environmentId,
    ...(outcome === "withdrawn" ? { forgetKey: true as const } : {}),
  }).catch(() => undefined);
  if (outcome === "offline" && readEnvironment(environmentId)) return "offline" as const;
  return outcome;
}

/** After removing a computer that didn't answer: its copies stay until this desktop's access goes. */
export const copiesStayToast = (label: string) => ({
  type: "info" as const,
  title: `${label} is offline`,
  description: `The sign-ins copied there stay until you remove this computer's access on ${label}.`,
});
