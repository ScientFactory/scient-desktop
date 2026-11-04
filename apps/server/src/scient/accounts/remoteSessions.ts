// @effect-diagnostics globalDate:off -- Cookie expiries follow the wall clock Chromium uses.
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
  applyUnit,
  shareable,
  travels,
  unitSites,
  universitySites,
} from "@t3tools/shared/scientSessionCookies";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { SessionStore } from "../../auth/SessionStore.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { ServerConfig } from "../../config.ts";
import { ServerBrowser } from "../../preview/ServerBrowser.ts";
import { AccountsService } from "./AccountsService.ts";
import { siteOf, type ProfileCookieJar } from "./profileCookieJar.ts";
import { qualifyProfileCookies } from "./qualifyProfileCookies.ts";

const unavailable = (message: string) => new AccountsError({ reason: "unavailable", message });
const denied = (message: string) => new AccountsError({ reason: "denied", message });

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
  const covering = [...unitSites(unit, siteOf)].map((site) =>
    Math.max(
      floor,
      ...(entry?.units ?? []).flatMap((applied) =>
        unitSites(applied.sites, siteOf).has(site) ? [applied.revision] : [],
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
  const covered = new Set(applied.flatMap((unit) => [...unitSites(unit.sites, siteOf)]));
  return [
    ...units.filter((unit) => ![...unitSites(unit.sites, siteOf)].some((s) => covered.has(s))),
    ...applied,
  ].slice(-RECEIVED_UNITS_LIMIT);
}

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
  const sites = unitSites(unit.sites, siteOf);
  if (jar.openTabSites().some((site) => sites.has(site))) return "busy";
  if (unit.kind === "delete") {
    const present = await jar.readUnit(unit.sites);
    if (present.length) await jar.remove(present);
    return (await jar.readUnit(unit.sites)).length ? "failed" : "deleted";
  }
  const outcome = await applyUnit(jar, {
    unit: unit.sites,
    source: fromSent(unit.cookies),
    mode: mode === "fill" ? "fill" : "fill-or-replace",
    replaceAllowed: true,
    replaceGoogle: true,
    nowSeconds: Date.now() / 1000,
    siteOf,
  });
  return outcome === "conflict" ? "kept" : outcome;
}

/** Sign-ins a desktop copies into this server's browser, one receiver per server. */
export class RemoteSessions extends Context.Service<
  RemoteSessions,
  {
    readonly receive: (
      caller: AccountsCallerSession,
      input: AccountSessionsReceiveInput,
    ) => Effect.Effect<AccountSessionsReceiveResult, AccountsError>;
    readonly applied: (
      caller: AccountsCallerSession,
      input: { readonly source: EnvironmentId; readonly profileId: BrowserProfileId },
    ) => Effect.Effect<AccountSessionsApplied, AccountsError>;
    readonly withdraw: (
      caller: AccountsCallerSession,
      input: {
        readonly source: EnvironmentId;
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
    /** Deletes the copies of every sender whose session was revoked or expired. */
    readonly sweep: () => Effect.Effect<void>;
    /** Dev servers only: item 3's cases on this computer's browser, in throwaway profiles. */
    readonly qualify: () => Effect.Effect<ReadonlyArray<AccountsQualifyCase>, AccountsError>;
  }
>()("t3/scient/accounts/remoteSessions") {}

export const makeRemoteSessions = Effect.gen(function* () {
  const browser = yield* ServerBrowser;
  const config = yield* ServerConfig;
  const accounts = yield* AccountsService;
  const sessions = yield* Effect.serviceOption(SessionStore);
  const sessionRows = yield* Effect.serviceOption(AuthSessionRepository);
  // A development server, as the reusable dev sign-in decides it; never a packaged one.
  const qualifiable = config.devUrl !== undefined;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (profileId: string) => {
    let lock = locks.get(profileId);
    if (!lock) locks.set(profileId, (lock = Semaphore.makeUnsafe(1)));
    return lock;
  };
  const underLock = <A, E>(profileId: string, effect: Effect.Effect<A, E>) =>
    lockFor(profileId).withPermits(1)(effect);

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

  const records = accounts.snapshot;
  const senderOf = (record: BrowserProfileRecord, source: EnvironmentId) =>
    record.received?.find((entry) => entry.source === source);

  const activeSessionIds = Effect.suspend(() =>
    Option.match(sessions, {
      onNone: () => Effect.sync((): ReadonlySet<string> | undefined => undefined),
      onSome: (store) =>
        store.listActive().pipe(
          Effect.map((active) => new Set<string>(active.map((session) => session.sessionId))),
          Effect.orElseSucceed(() => undefined),
        ),
    }),
  );

  /** Deletes a sender's applied copies in one profile; `all` also forgets the sender there. */
  const withdrawProfile = (
    profileId: BrowserProfileId,
    source: EnvironmentId,
    end: { readonly all: true } | { readonly revision: number },
  ) =>
    underLock(
      profileId,
      Effect.gen(function* () {
        const { profiles } = yield* records;
        const entry = profiles
          .find((record) => record.profileId === profileId)
          ?.received?.find((candidate) => candidate.source === source);
        if (!entry) return 0;
        const copies = entry.units.filter(
          (unit) => unit.outcome === "copied" || unit.outcome === "same",
        );
        if (copies.length)
          yield* withJar(profileId, async (jar) => {
            for (const unit of copies) {
              const present = await jar.readUnit(unit.sites);
              if (present.length) await jar.remove(present);
            }
          });
        yield* accounts.updateReceived(profileId, (record) => ({
          received: (record.received ?? []).flatMap((candidate) =>
            candidate.source !== source
              ? [candidate]
              : "all" in end
                ? []
                : [{ ...candidate, units: [], withdrawn: end.revision }],
          ),
        }));
        return copies.length;
      }),
    );

  /** Revoked on this computer; an expired session only lets the desktop's next one take over. */
  const revoked = (sessionId: string) =>
    Option.isNone(sessionRows)
      ? Effect.succeed(false)
      : sessionRows.value.getById({ sessionId: AuthSessionId.make(sessionId) }).pipe(
          Effect.map((row) => Option.isSome(row) && row.value.revokedAt !== null),
          Effect.orElseSucceed(() => false),
        );

  const sweep = Effect.fn("RemoteSessions.sweep")(function* () {
    const { profiles } = yield* records;
    for (const record of profiles)
      for (const entry of record.received ?? [])
        if (yield* revoked(entry.sessionId))
          yield* withdrawProfile(record.profileId, entry.source, { all: true });
  }, Effect.ignore);

  /**
   * A sender is the session that first sent as `source`. Another session takes over only once
   * that one is revoked or expired; then the old copies stay and the new session owns them.
   */
  const bind = Effect.fn("RemoteSessions.bind")(function* (
    caller: AccountsCallerSession,
    source: EnvironmentId,
  ) {
    const { profiles } = yield* records;
    const bound = profiles.flatMap((record) => {
      const entry = senderOf(record, source);
      return entry ? [{ profileId: record.profileId, entry }] : [];
    });
    const other = bound.find(({ entry }) => entry.sessionId !== caller.sessionId);
    if (!other) return;
    const active = yield* activeSessionIds;
    if (!active || active.has(other.entry.sessionId))
      return yield* denied(`Another connection already sends as ${other.entry.label}.`);
    for (const { profileId } of bound)
      yield* accounts.updateReceived(profileId, (record) => ({
        received: (record.received ?? []).map((entry) =>
          entry.source === source ? { ...entry, sessionId: caller.sessionId } : entry,
        ),
      }));
  });

  const receive = Effect.fn("RemoteSessions.receive")(function* (
    caller: AccountsCallerSession,
    input: AccountSessionsReceiveInput,
  ) {
    yield* bind(caller, input.source);
    yield* sweep();
    return yield* underLock(
      input.profileId,
      Effect.gen(function* () {
        const before = yield* accounts.updateReceived(input.profileId, (record) => {
          const entry = senderOf(record, input.source);
          return {
            received: [
              ...(record.received ?? []).filter((candidate) => candidate !== entry),
              {
                source: input.source,
                sessionId: caller.sessionId,
                label: input.label,
                sentAt: input.sentAt,
                ...(entry?.withdrawn === undefined ? {} : { withdrawn: entry.withdrawn }),
                units: entry?.units ?? [],
              },
            ].slice(-4),
            controls: input.controls,
          };
        });
        const entry = senderOf(before, input.source);
        // Checked again here, against this computer's own rows and the controls just set.
        const allowed = shareable(input.profileId, input.controls);
        const university = universitySites((yield* records).accounts);
        const decided = input.units.map((unit) => {
          if (!allowed || !travels(unit.sites, university, siteOf)) return "blocked" as const;
          return unit.revision <= appliedRevision(entry, unit.sites) ? ("stale" as const) : unit;
        });
        const pending = decided.flatMap((unit) => (typeof unit === "string" ? [] : [unit]));
        const outcomes = new Map<(typeof pending)[number], SessionReceiveOutcome>();
        if (pending.length)
          yield* withJar(input.profileId, async (jar) => {
            for (const unit of pending)
              outcomes.set(
                unit,
                // A tab waited too long for this profile: the rest goes with the next delivery.
                jar.stopping()
                  ? "busy"
                  : await receiveUnit(jar, unit, input.mode).catch(() => "failed"),
              );
          });
        const result = input.units.map((unit, index) => {
          const early = decided[index];
          return {
            sites: unit.sites,
            revision: unit.revision,
            outcome: typeof early === "string" ? early : (outcomes.get(unit) ?? "failed"),
          };
        });
        const applied = result.flatMap((unit) =>
          RECORDED.has(unit.outcome)
            ? [
                {
                  sites: unit.sites,
                  revision: unit.revision,
                  outcome: unit.outcome as ReceivedUnit["outcome"],
                },
              ]
            : [],
        );
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
    input: { readonly source: EnvironmentId; readonly profileId: BrowserProfileId },
  ) {
    yield* bind(caller, input.source);
    const { profiles } = yield* records;
    const record = profiles.find((candidate) => candidate.profileId === input.profileId);
    const entry = record && senderOf(record, input.source);
    return {
      bound: entry !== undefined,
      ...(entry?.withdrawn === undefined ? {} : { withdrawn: entry.withdrawn }),
      units: entry?.units ?? [],
    };
  });

  const withdraw = Effect.fn("RemoteSessions.withdraw")(function* (
    caller: AccountsCallerSession,
    input: {
      readonly source: EnvironmentId;
      readonly profileId?: BrowserProfileId | undefined;
      readonly all?: true | undefined;
      readonly revision?: number | undefined;
    },
  ) {
    yield* bind(caller, input.source);
    const { profiles } = yield* records;
    const targets = profiles.filter(
      (record) =>
        senderOf(record, input.source) &&
        (input.all === true || record.profileId === input.profileId),
    );
    let deleted = 0;
    for (const record of targets)
      deleted += yield* withdrawProfile(
        record.profileId,
        input.source,
        input.all === true ? { all: true } : { revision: input.revision ?? 0 },
      );
    return { deleted };
  });

  const list = Effect.fn("RemoteSessions.list")(function* (profileId: BrowserProfileId) {
    const cookies = yield* underLock(
      profileId,
      withJar(profileId, (jar) => jar.readAll()),
    );
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
    return yield* underLock(
      profileId,
      withJar(profileId, async (jar) => {
        const present = await jar.readUnit([site]);
        if (present.length) await jar.remove(present);
        return { signedOut: (await jar.readUnit([site])).length === 0 };
      }),
    );
  });

  const qualify = Effect.fn("RemoteSessions.qualify")(function* () {
    const profileCookies = browser.profileCookies;
    if (!qualifiable || !profileCookies)
      return yield* unavailable("The check runs only on a development server.");
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
    receive,
    applied,
    withdraw,
    list,
    signOutLocal,
    sweep,
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
        const copy = unit.outcome === "copied" || unit.outcome === "same";
        if (!copy || !unitSites(unit.sites, siteOf).has(site)) return unit;
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
