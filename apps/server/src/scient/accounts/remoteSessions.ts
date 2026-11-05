// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- Cookie expiries follow the wall clock Chromium uses; digests use node:crypto.
import {
  AccountsError,
  type AccountSessionsApplied,
  type AccountSessionsList,
  type AccountSessionsReceiveInput,
  type AccountSessionsReceiveResult,
  type AccountsQualifyCase,
  AuthSessionId,
  type BrowserProfileId,
  type BrowserProfileRecord,
  type EnvironmentId,
  type ProfileReceived,
  type ReceivedUnit,
  type SessionCookie,
  type SessionReceiveOutcome,
} from "@t3tools/contracts";
import {
  SENDER_KEEP_DAYS,
  applyUnit,
  sameUnit,
  shareable,
  unitCookies,
  travels,
  isLive,
  unitFingerprint,
  withdrawCopies,
  unitSites,
  universitySites,
} from "@t3tools/shared/scientSessionCookies";
import { siteOf } from "@t3tools/shared/scientSiteMatch";
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerBrowser } from "../../preview/ServerBrowser.ts";
import { AccountsService } from "./AccountsService.ts";
import type { ProfileCookieJar } from "./profileCookieJar.ts";

const unavailable = (message: string) => new AccountsError({ reason: "unavailable", message });
const denied = (message: string) => new AccountsError({ reason: "denied", message });

/** Senders one profile takes copies from; a further one is refused, never squeezed out. */
const SENDERS_PER_PROFILE = 4;

const ACCESS_ORDER = ["off", "ask", "allowed"] as const;

/** The strictest of the controls a profile's senders set; undefined when none set any. */
const strictestControls = (received: ReadonlyArray<ProfileReceived>) => {
  const sent = received.flatMap(({ controls }) => (controls ? [controls] : []));
  if (sent.length === 0) return undefined;
  return {
    access: ACCESS_ORDER[Math.min(...sent.map(({ access }) => ACCESS_ORDER.indexOf(access)))]!,
    scope: { type: "all-projects" as const },
    scriptSignIn: sent.every(({ scriptSignIn }) => scriptSignIn),
  };
};

/** The authenticated session a request came over; a sender is bound to it, never to a label. */
export interface AccountsCallerSession {
  readonly sessionId: string;
  readonly subject: string;
}

const RECEIVED_UNITS_LIMIT = 5_000;
const RECORDED = new Set<SessionReceiveOutcome>(["copied", "same", "kept", "deleted"]);

/** What this computer applied for a unit: the oldest revision covering any of its sites. */
function appliedRevision(
  entry: Pick<ProfileReceived, "units" | "withdrawn"> | undefined,
  unit: ReadonlyArray<string>,
) {
  const floor = entry?.withdrawn ?? -1;
  const covering = [...unitSites(unit)].map((site) =>
    Math.max(
      floor,
      ...(entry?.units ?? []).flatMap((applied) =>
        unitSites(applied.sites).has(site) ? [applied.revision] : [],
      ),
    ),
  );
  return Math.min(...covering);
}

/** The sender's units with these applied ones in place of every unit they overlap. */
function withApplied(
  units: ReadonlyArray<ReceivedUnit>,
  applied: ReadonlyArray<ReceivedUnit>,
): ReadonlyArray<ReceivedUnit> {
  const covered = new Set(applied.flatMap((unit) => [...unitSites(unit.sites)]));
  return [
    ...units.filter((unit) => ![...unitSites(unit.sites)].some((s) => covered.has(s))),
    ...applied,
  ].slice(-RECEIVED_UNITS_LIMIT);
}

const isCopy = (unit: { readonly outcome: string }) =>
  unit.outcome === "copied" || unit.outcome === "same";

/** Deletes a unit's cookies; true once none is left. */
const clearUnit = async (jar: ProfileCookieJar, sites: ReadonlyArray<string>) => {
  const present = await jar.readUnit(sites);
  if (present.length) await jar.remove(present);
  return (await jar.readUnit(sites)).length === 0;
};

const fromSent = (cookie: AccountSessionsReceiveInput["units"][number]["cookies"]) =>
  (cookie ?? []).map(({ value, ...rest }): SessionCookie => ({
    ...rest,
    value: Redacted.value(value),
  }));

/** One unit into this computer's jar, after the sender's binding and controls were checked. */
async function receiveUnit(
  jar: ProfileCookieJar,
  unit: AccountSessionsReceiveInput["units"][number],
  mode: AccountSessionsReceiveInput["mode"],
): Promise<SessionReceiveOutcome> {
  const sites = unitSites(unit.sites);
  if (jar.openTabSites().some((site) => sites.has(site))) return "busy";
  if (unit.kind === "delete") return (await clearUnit(jar, unit.sites)) ? "deleted" : "failed";
  const outcome = await applyUnit(jar, {
    unit: unit.sites,
    source: fromSent(unit.cookies),
    mode: mode === "fill" ? "fill" : "fill-or-replace",
    replaceAllowed: true,
    replaceGoogle: true,
    nowSeconds: Date.now() / 1000,
  });
  return outcome === "conflict" ? "kept" : outcome;
}

/** Sign-ins a desktop copies into this server's browser, one receiver per server. */
export class RemoteSessions extends Context.Service<
  RemoteSessions,
  {
    readonly bind: (
      caller: AccountsCallerSession,
      input: {
        readonly source: EnvironmentId;
        readonly label: string;
        readonly key?: Redacted.Redacted<string> | undefined;
      },
    ) => Effect.Effect<{ readonly key?: Redacted.Redacted<string> }, AccountsError>;
    readonly receive: (
      caller: AccountsCallerSession,
      input: AccountSessionsReceiveInput,
    ) => Effect.Effect<AccountSessionsReceiveResult, AccountsError>;
    readonly applied: (
      caller: AccountsCallerSession,
      input: {
        readonly source: EnvironmentId;
        readonly key: Redacted.Redacted<string>;
        readonly profileId: BrowserProfileId;
      },
    ) => Effect.Effect<AccountSessionsApplied, AccountsError>;
    readonly withdraw: (
      caller: AccountsCallerSession,
      input: {
        readonly source: EnvironmentId;
        readonly key: Redacted.Redacted<string>;
        readonly profileId?: BrowserProfileId | undefined;
        readonly all?: true | undefined;
        readonly revision?: number | undefined;
      },
    ) => Effect.Effect<{ readonly deleted: number }, AccountsError>;
    readonly list: (
      profileId: BrowserProfileId,
    ) => Effect.Effect<AccountSessionsList, AccountsError>;
    /** This computer's sign-out only; a newer desktop revision may fill the unit again. */
    readonly signOutLocal: (
      profileId: BrowserProfileId,
      site: string,
    ) => Effect.Effect<{ readonly signedOut: boolean }, AccountsError>;
    /** The owner here forgets a desktop: its copies, as it wrote them, and its key go. */
    readonly forgetSender: (
      source: EnvironmentId,
    ) => Effect.Effect<{ readonly deleted: number }, AccountsError>;
    /** Forgets every sender revoked here or silent past the keep limit, with its copies. */
    readonly sweep: () => Effect.Effect<void>;
    /** The server's lifelong sweeps: at start, daily, and on every removed session. */
    readonly watch: Effect.Effect<void>;
    /** Dev servers only: item 3's cases on this computer's browser, in throwaway profiles. */
    readonly qualify: () => Effect.Effect<ReadonlyArray<AccountsQualifyCase>, AccountsError>;
  }
>()("t3/scient/accounts/remoteSessions") {}

const hashKey = (key: string) => NodeCrypto.createHash("sha256").update(key).digest();

const keyMatches = (key: Redacted.Redacted<string>, keyHash: string) => {
  const expected = Buffer.from(keyHash, "base64url");
  const actual = hashKey(Redacted.value(key));
  return expected.length === actual.length && NodeCrypto.timingSafeEqual(expected, actual);
};

/** How often a sender proving its key again is written down. */
const SEEN_WRITE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const makeRemoteSessions = Effect.gen(function* () {
  const browser = yield* ServerBrowser;
  const config = yield* ServerConfig;
  const accounts = yield* AccountsService;
  const sessionRows = yield* Effect.serviceOption(AuthSessionRepository);
  const sessions = yield* Effect.serviceOption(SessionStore);
  // A development server, as the reusable dev sign-in decides it; never a packaged one.
  const qualifiable = config.devUrl !== undefined;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  // Binding, receiving, withdrawing and sweeping never interleave.
  const lock = Semaphore.makeUnsafe(1);
  const exclusive = <A, E>(effect: Effect.Effect<A, E>) => lock.withPermits(1)(effect);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /** Runs cookie work holding the profile's jar; the jar is released however it ends. */
  const withJar = <A>(profileId: string, use: (jar: ProfileCookieJar) => Promise<A>) => {
    const profileCookies = browser.profileCookies;
    if (!profileCookies)
      return Effect.fail(unavailable("This computer's browser can't hold sign-ins."));
    return Effect.scoped(
      profileCookies(profileId).pipe(
        Effect.mapError(() => unavailable("This computer's browser could not open the profile.")),
        Effect.flatMap((jar) =>
          Effect.tryPromise({
            try: () => use(jar),
            catch: () => unavailable("This computer's browser could not change the profile."),
          }),
        ),
      ),
    );
  };

  const records = accounts.receivedProfiles.pipe(Effect.map((profiles) => ({ profiles })));
  const senderOf = (record: BrowserProfileRecord, source: EnvironmentId) =>
    record.received?.find((entry) => entry.source === source);

  /** Deletes a sender's applied copies in one profile; `all` also forgets the sender there. */
  const withdrawProfile = Effect.fn("RemoteSessions.withdrawProfile")(function* (
    profileId: BrowserProfileId,
    source: EnvironmentId,
    end: { readonly all: true } | { readonly revision: number },
  ) {
    const { profiles } = yield* records;
    const entry = profiles
      .find((record) => record.profileId === profileId)
      ?.received?.find((candidate) => candidate.source === source);
    if (!entry) return 0;
    const copies = entry.units.filter(isCopy);
    // Only a unit still holding exactly this sender's copy goes; a later change is someone's.
    const deleted = copies.length
      ? yield* withJar(profileId, async (jar) =>
          withdrawCopies(
            jar,
            copies.flatMap(({ sites, fingerprint }) =>
              fingerprint ? [{ sites, fingerprint }] : [],
            ),
            () => Date.now() / 1000,
          ).then((removed) => removed.length),
        )
      : 0;
    yield* accounts.updateReceived(profileId, (record) => {
      const received = (record.received ?? []).flatMap((candidate) =>
        candidate.source !== source
          ? [candidate]
          : "all" in end
            ? []
            : [{ ...candidate, units: [], withdrawn: end.revision }],
      );
      // A forgotten sender's controls no longer count; the others' strictest still does.
      const controls = "all" in end ? strictestControls(received) : undefined;
      return controls ? { received, controls } : { received };
    });
    return deleted;
  });

  /** A sender is forgotten: its copies go, and its key proves nothing any more. */
  const forget = Effect.fn("RemoteSessions.forget")(function* (source: EnvironmentId) {
    let deleted = 0;
    for (const record of (yield* records).profiles)
      if (senderOf(record, source))
        deleted += yield* withdrawProfile(record.profileId, source, { all: true });
    yield* accounts.setRemoteSender(source, undefined);
    return deleted;
  });

  /** Revoked here: the session a sender last proved its key over. */
  const revoked = (sessionId: string) =>
    Option.isNone(sessionRows)
      ? Effect.succeed(false)
      : sessionRows.value.getById({ sessionId: AuthSessionId.make(sessionId) }).pipe(
          Effect.map((row) => Option.isSome(row) && row.value.revokedAt !== null),
          Effect.orElseSucceed(() => false),
        );

  /** Revoked here, or silent past the keep limit: the sender and its copies go. */
  const sweepSenders = Effect.gen(function* () {
    const at = Date.parse(yield* now);
    for (const sender of yield* accounts.remoteSenders)
      if (
        at - Date.parse(sender.seenAt) > SENDER_KEEP_DAYS * DAY_MS ||
        (yield* revoked(sender.sessionId))
      )
        yield* forget(sender.source);
  });

  /** The sender proves its key; a new session proving it renews the sender on that session. */
  const authorize = Effect.fn("RemoteSessions.authorize")(function* (
    caller: AccountsCallerSession,
    source: EnvironmentId,
    key: Redacted.Redacted<string>,
  ) {
    const sender = (yield* accounts.remoteSenders).find((entry) => entry.source === source);
    if (!sender || !keyMatches(key, sender.keyHash))
      return yield* denied(
        sender
          ? `Another connection already sends as ${sender.label}.`
          : "This computer doesn't know this sender.",
      );
    const at = yield* now;
    if (
      sender.sessionId !== caller.sessionId ||
      Date.parse(at) - Date.parse(sender.seenAt) > SEEN_WRITE_MS
    )
      yield* accounts.setRemoteSender(source, {
        ...sender,
        sessionId: caller.sessionId,
        seenAt: at,
      });
  });

  /**
   * A desktop proves it is the sender it was, with the key this computer issued it. A source with
   * no sender gets a new one and its key, once. Another connection without the key is refused,
   * whatever happened to the first one's session. Revoked senders go first.
   */
  const bind = Effect.fn("RemoteSessions.bind")(function* (
    caller: AccountsCallerSession,
    input: {
      readonly source: EnvironmentId;
      readonly label: string;
      readonly key?: Redacted.Redacted<string> | undefined;
    },
  ) {
    return yield* exclusive(
      Effect.gen(function* () {
        yield* sweepSenders;
        const sender = (yield* accounts.remoteSenders).find(
          (entry) => entry.source === input.source,
        );
        // The session that bound the sender may lose the key in transit: it gets a new one.
        if (sender && !input.key && sender.boundBy === caller.sessionId) {
          const key = NodeCrypto.randomBytes(32).toString("base64url");
          yield* accounts.setRemoteSender(input.source, {
            ...sender,
            keyHash: hashKey(key).toString("base64url"),
            seenAt: yield* now,
          });
          return { key: Redacted.make(key) };
        }
        if (sender) {
          if (!input.key)
            return yield* denied(`Another connection already sends as ${sender.label}.`);
          yield* authorize(caller, input.source, input.key);
          return {};
        }
        // Copies left by a sender nobody can prove any more are not anyone's to keep.
        yield* forget(input.source);
        const key = NodeCrypto.randomBytes(32).toString("base64url");
        yield* accounts.setRemoteSender(input.source, {
          source: input.source,
          label: input.label,
          keyHash: hashKey(key).toString("base64url"),
          sessionId: caller.sessionId,
          boundBy: caller.sessionId,
          seenAt: yield* now,
        });
        return { key: Redacted.make(key) };
      }),
    );
  });

  const forgetSender = Effect.fn("RemoteSessions.forgetSender")(function* (source: EnvironmentId) {
    return { deleted: yield* exclusive(forget(source)) };
  });

  const sweep = Effect.fn("RemoteSessions.sweep")(function* () {
    yield* exclusive(sweepSenders);
  }, Effect.ignore);

  /**
   * Runs for the server's life: a sweep at start and then daily, and one whenever a session that
   * a sender last proved its key over is removed, so an idle computer drops a revoked one's copies.
   */
  const watch = Effect.all(
    [
      sweep().pipe(Effect.repeat(Schedule.spaced(Duration.days(1)))),
      Option.isNone(sessions)
        ? Effect.never
        : sessions.value.streamChanges.pipe(
            Stream.filter((change) => change.type === "clientRemoved"),
            Stream.runForEach(() => sweep()),
          ),
    ],
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.asVoid);

  const receive = Effect.fn("RemoteSessions.receive")(function* (
    caller: AccountsCallerSession,
    input: AccountSessionsReceiveInput,
  ) {
    return yield* exclusive(
      Effect.gen(function* () {
        yield* authorize(caller, input.source, input.key);
        yield* sweepSenders;
        const current = (yield* records).profiles.find(
          (record) => record.profileId === input.profileId,
        );
        if (
          current &&
          !senderOf(current, input.source) &&
          (current.received?.length ?? 0) >= SENDERS_PER_PROFILE
        )
          return yield* denied(
            `This computer already takes this profile's sign-ins from ${SENDERS_PER_PROFILE} computers. Forget one there first.`,
          );
        const before = yield* accounts.updateReceived(input.profileId, (record) => {
          const entry = senderOf(record, input.source);
          const received = [
            ...(record.received ?? []).filter((candidate) => candidate !== entry),
            {
              source: input.source,
              label: input.label,
              sentAt: input.sentAt,
              ...(entry?.withdrawn === undefined ? {} : { withdrawn: entry.withdrawn }),
              units: entry?.units ?? [],
              controls: input.controls,
            },
          ];
          const controls = strictestControls(received);
          return controls ? { received, controls } : { received };
        });
        const entry = senderOf(before, input.source);
        // Checked again here, against this computer's own rows and the controls just set.
        const allowed = shareable(input.profileId, input.controls);
        const university = universitySites((yield* accounts.snapshot).accounts);
        const decided = input.units.map((unit) => {
          if (!allowed || !travels(unit.sites, university)) return "blocked" as const;
          return unit.revision <= appliedRevision(entry, unit.sites) ? ("stale" as const) : unit;
        });
        const pending = decided.flatMap((unit) => (typeof unit === "string" ? [] : [unit]));
        const outcomes = new Map<(typeof pending)[number], SessionReceiveOutcome>();
        // A context that stopped answering is discarded mid-unit: that unit is checked afresh.
        let lost:
          | {
              readonly unit: (typeof pending)[number];
              readonly before: ReadonlyArray<SessionCookie>;
            }
          | undefined;
        if (pending.length)
          yield* withJar(input.profileId, async (jar) => {
            for (const unit of pending) {
              // A tab waited too long, or an operation stalled: the rest goes next time.
              if (jar.stopping() || jar.stalled()) {
                outcomes.set(unit, "busy");
                continue;
              }
              const before = await jar.readUnit(unit.sites).catch(() => undefined);
              if (!before) {
                outcomes.set(unit, jar.stalled() ? "busy" : "failed");
                continue;
              }
              const outcome = await receiveUnit(jar, unit, input.mode).catch(
                (): SessionReceiveOutcome => "failed",
              );
              if (jar.quarantined()) lost = { unit, before };
              outcomes.set(
                unit,
                jar.quarantined()
                  ? "restore-failed"
                  : jar.stalled() && outcome !== "restore-failed"
                    ? "busy"
                    : outcome,
              );
            }
          });
        if (lost) {
          const { unit, before } = lost;
          const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
          const fresh = yield* withJar(input.profileId, (jar) => jar.readUnit(unit.sites)).pipe(
            Effect.option,
          );
          const live = (cookies: ReadonlyArray<SessionCookie>) =>
            cookies.filter((cookie) => isLive(cookie, nowSeconds));
          if (Option.isSome(fresh) && sameUnit(live(fresh.value), live(before)))
            outcomes.set(unit, "busy");
        }
        const result = input.units.map((unit, index) => {
          const early = decided[index];
          return {
            sites: unit.sites,
            revision: unit.revision,
            outcome: typeof early === "string" ? early : (outcomes.get(unit) ?? "failed"),
          };
        });
        const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
        const applied = result.flatMap((unit, index) => {
          if (!RECORDED.has(unit.outcome)) return [];
          const sent = input.units[index]!;
          return [
            {
              sites: unit.sites,
              revision: unit.revision,
              outcome: unit.outcome as ReceivedUnit["outcome"],
              ...(isCopy(unit)
                ? {
                    fingerprint: unitFingerprint(
                      unitCookies(unit.sites, fromSent(sent.cookies)),
                      nowSeconds,
                    ),
                  }
                : {}),
            },
          ];
        });
        if (applied.length)
          yield* accounts.updateReceived(input.profileId, (record) => ({
            received: (record.received ?? []).map((candidate) =>
              candidate.source === input.source
                ? { ...candidate, units: withApplied(candidate.units, applied) }
                : candidate,
            ),
          }));
        return { units: result };
      }),
    );
  });

  const applied = Effect.fn("RemoteSessions.applied")(function* (
    caller: AccountsCallerSession,
    input: {
      readonly source: EnvironmentId;
      readonly key: Redacted.Redacted<string>;
      readonly profileId: BrowserProfileId;
    },
  ) {
    return yield* exclusive(
      Effect.gen(function* () {
        yield* authorize(caller, input.source, input.key);
        const { profiles } = yield* records;
        const record = profiles.find((candidate) => candidate.profileId === input.profileId);
        const entry = record && senderOf(record, input.source);
        return {
          bound: entry !== undefined,
          ...(entry?.withdrawn === undefined ? {} : { withdrawn: entry.withdrawn }),
          units: (entry?.units ?? []).map(({ fingerprint: _, ...unit }) => unit),
        };
      }),
    );
  });

  const withdraw = Effect.fn("RemoteSessions.withdraw")(function* (
    caller: AccountsCallerSession,
    input: {
      readonly source: EnvironmentId;
      readonly key: Redacted.Redacted<string>;
      readonly profileId?: BrowserProfileId | undefined;
      readonly all?: true | undefined;
      readonly revision?: number | undefined;
    },
  ) {
    return yield* exclusive(
      Effect.gen(function* () {
        yield* authorize(caller, input.source, input.key);
        if (input.all === true) return { deleted: yield* forget(input.source) };
        if (!input.profileId) return { deleted: 0 };
        return {
          deleted: yield* withdrawProfile(input.profileId, input.source, {
            revision: input.revision ?? 0,
          }),
        };
      }),
    );
  });

  const list = Effect.fn("RemoteSessions.list")(function* (profileId: BrowserProfileId) {
    const cookies = yield* exclusive(withJar(profileId, (jar) => jar.readAll()));
    const counts = new Map<string, number>();
    for (const cookie of cookies) {
      const site = siteOf(cookie.domain);
      counts.set(site, (counts.get(site) ?? 0) + 1);
    }
    return {
      sites: [...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([site, count]) => ({ site, cookies: count })),
    };
  });

  const signOutLocal = Effect.fn("RemoteSessions.signOutLocal")(function* (
    profileId: BrowserProfileId,
    site: string,
  ) {
    return yield* exclusive(
      withJar(profileId, async (jar) => ({ signedOut: await clearUnit(jar, [site]) })),
    );
  });

  const qualify = Effect.fn("RemoteSessions.qualify")(function* () {
    const profileCookies = browser.profileCookies;
    if (!qualifiable || !profileCookies)
      return yield* unavailable("The check runs only on a development server.");
    // Loaded only on a development server.
    const { qualifyProfileCookies } = yield* Effect.promise(
      () => import("./qualifyProfileCookies.ts"),
    );
    return yield* Effect.promise(() =>
      qualifyProfileCookies({
        open: (profileId) =>
          run(
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              const jar = yield* profileCookies(profileId).pipe(Scope.provide(scope));
              return { jar, release: () => run(Scope.close(scope, Exit.void)) };
            }),
          ),
        clear: (profileId) => run(browser.clearProfile(profileId)),
      }),
    );
  });

  return RemoteSessions.of({
    bind,
    receive,
    applied,
    withdraw,
    list,
    signOutLocal,
    forgetSender,
    sweep,
    watch,
    qualify,
  });
});

/** On a remote: whether a page in a profile shows its received copy refused, or working again. */
export const markNeedsYou = Effect.fn("RemoteSessions.markNeedsYou")(function* (
  profileId: BrowserProfileId,
  url: string,
  page: "refused" | "signed-in",
  at: string,
) {
  const accounts = yield* AccountsService;
  const host = URL.parse(url)?.hostname;
  if (!host) return undefined;
  const site = siteOf(host);
  let label: string | undefined;
  yield* accounts.updateReceived(profileId, (record) => {
    const received = record.received ?? [];
    let changed = false;
    const next = received.map((entry) => ({
      ...entry,
      units: entry.units.map((unit) => {
        if (!isCopy(unit) || !unitSites(unit.sites).has(site)) return unit;
        label = entry.label;
        if ((unit.needsYou !== undefined) === (page === "refused")) return unit;
        changed = true;
        if (page === "refused") return { ...unit, needsYou: at };
        const { needsYou: _, ...rest } = unit;
        return rest;
      }),
    }));
    return { received: changed ? next : received };
  });
  return label;
});
