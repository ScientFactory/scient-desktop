import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  BrowserProfileId,
  EnvironmentId,
  type AccountSessionsReceiveInput,
  type SessionCookie,
} from "@t3tools/contracts";
import { unitCookies } from "@t3tools/shared/scientSessionCookies";
import { DateTime, Deferred, Effect, Fiber, Option, Queue, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";

import { SessionStore, type SessionCredentialChange } from "../../auth/SessionStore.ts";
import { ServerConfig } from "../../config.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { ServerBrowser } from "../../preview/ServerBrowser.ts";
import { makeHarness } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import type { ProfileCookieJar } from "./profileCookieJar.ts";
import { makeRemoteSessions } from "./remoteSessions.ts";

const WORK = BrowserProfileId.make("profile-work");
const MAC = EnvironmentId.make("macbook");
const desktop = { sessionId: "session-desktop", subject: "desktop" };
/** Far ahead, so every synthetic cookie is live whenever the test runs. */
const NOW = 4_000_000_000;

const cookie = (overrides: Partial<SessionCookie> = {}): SessionCookie => ({
  name: "session",
  value: "synthetic-desktop",
  domain: ".github.com",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  expires: NOW + 3600,
  ...overrides,
});
const key = (value: Pick<SessionCookie, "name" | "domain" | "path">) =>
  `${value.name} ${value.domain} ${value.path}`;

/** Each profile's jar in memory, with the seams a test needs to act as a page or a crash. */
function browserFixture() {
  const jars = new Map<string, SessionCookie[]>();
  const tabs = new Map<string, string[]>();
  const hooks: {
    afterSet?: ((profileId: string) => void) | undefined;
    stopping?: boolean;
    stalled?: boolean;
    quarantined?: boolean;
  } = {};
  const jarOf = (profileId: string) => jars.get(profileId) ?? [];
  const jar = (profileId: string): ProfileCookieJar => ({
    readAll: async () => jarOf(profileId),
    readUnit: async (unit) => unitCookies(unit, jarOf(profileId)),
    set: async (cookies) => {
      const next = jarOf(profileId).filter((c) => !cookies.some((n) => key(n) === key(c)));
      jars.set(profileId, [...next, ...cookies]);
      hooks.afterSet?.(profileId);
    },
    remove: async (cookies) => {
      jars.set(
        profileId,
        jarOf(profileId).filter((c) => !cookies.some((gone) => key(gone) === key(c))),
      );
    },
    openTabSites: () => tabs.get(profileId) ?? [],
    stopping: () => hooks.stopping === true,
    stalled: () => hooks.stalled === true || hooks.quarantined === true,
    quarantined: () => hooks.quarantined === true,
  });
  const browser = {
    // A fresh hold opens a fresh context: whatever stalled the last one is gone.
    profileCookies: (profileId: string) =>
      Effect.sync(() => {
        hooks.quarantined = false;
        hooks.stalled = false;
        return jar(profileId);
      }),
    clearProfile: () => Effect.void,
  } as unknown as ServerBrowser["Service"];
  return { jars, tabs, hooks, browser };
}

const setup = Effect.fn("RemoteSessionsTest.setup")(function* () {
  const { service } = yield* makeHarness();
  const fixture = browserFixture();
  const revoked = new Set<string>();
  const changes = yield* Queue.unbounded<SessionCredentialChange>();
  const looked = yield* Deferred.make<void>();
  /** Resolved by the next session lookup, which a sweep makes while it holds the lock. */
  const lookups = { next: yield* Deferred.make<void>() };
  const remote = yield* makeRemoteSessions.pipe(
    Effect.provideService(AccountsService, service),
    Effect.provideService(ServerBrowser, fixture.browser),
    Effect.provideService(ServerConfig, { devUrl: undefined } as ServerConfig["Service"]),
    Effect.provideService(SessionStore, {
      streamChanges: Stream.fromQueue(changes),
    } as unknown as SessionStore["Service"]),
    Effect.provideService(AuthSessionRepository, {
      getById: ({ sessionId }: { sessionId: string }) =>
        // A sweep that finds a revoked session holds the lock until it is done.
        Deferred.succeed(lookups.next, undefined).pipe(
          Effect.andThen(
            revoked.has(sessionId) ? Deferred.succeed(looked, undefined) : Effect.void,
          ),
          Effect.as(
            Option.some({ revokedAt: revoked.has(sessionId) ? DateTime.nowUnsafe() : null }),
          ),
        ),
    } as unknown as AuthSessionRepository["Service"]),
  );
  const { key } = yield* remote.bind(desktop, { source: MAC, label: "MacBook" });
  keys.desktop = key!;
  return { ...fixture, revoked, changes, looked, lookups, remote, accounts: service };
});

/** The key this computer issued the desktop when the test began. */
const keys: { desktop: Redacted.Redacted<string> } = { desktop: Redacted.make("unset") };

const batch = (
  units: AccountSessionsReceiveInput["units"],
  overrides: Partial<AccountSessionsReceiveInput> = {},
): AccountSessionsReceiveInput => ({
  source: MAC,
  key: keys.desktop,
  label: "MacBook",
  profileId: WORK,
  controls: { access: "allowed", scope: { type: "all-projects" }, scriptSignIn: true },
  mode: "replace",
  units,
  sentAt: "2026-11-04T10:14:00.000Z",
  ...overrides,
});
const copy = (revision: number, cookies = [cookie()], sites = ["github.com"]) => ({
  sites,
  revision,
  kind: "copy" as const,
  cookies: cookies.map(({ value, ...rest }) => ({ ...rest, value: Redacted.make(value) })),
});
const outcomes = (result: { units: ReadonlyArray<{ outcome: string }> }) =>
  result.units.map(({ outcome }) => outcome);

describe("receiving a desktop's sign-ins", () => {
  it.effect("applies a newer revision once; an older one replayed is stale", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      expect(outcomes(yield* remote.receive(desktop, batch([copy(5)])))).toEqual(["copied"]);
      const deleted = yield* remote.receive(
        desktop,
        batch([{ sites: ["github.com"], revision: 6, kind: "delete" }]),
      );
      expect(outcomes(deleted)).toEqual(["deleted"]);
      // The copy read before the sign-out arrives late: it must not bring the site back.
      expect(outcomes(yield* remote.receive(desktop, batch([copy(5)])))).toEqual(["stale"]);
      expect(jars.get(WORK)).toEqual([]);
      const applied = yield* remote.applied(desktop, {
        source: MAC,
        key: keys.desktop,
        profileId: WORK,
      });
      expect(applied).toEqual({
        bound: true,
        units: [{ sites: ["github.com"], revision: 6, outcome: "deleted" }],
      });
    }),
  );

  it.effect("leaves a unit with an open tab for the next delivery, for copies and deletions", () =>
    Effect.gen(function* () {
      const { remote, tabs, jars } = yield* setup();
      tabs.set(WORK, ["github.com"]);
      for (const mode of ["fill", "replace"] as const)
        expect(outcomes(yield* remote.receive(desktop, batch([copy(1)], { mode })))).toEqual([
          "busy",
        ]);
      const deleting = batch([{ sites: ["github.com"], revision: 2, kind: "delete" }]);
      expect(outcomes(yield* remote.receive(desktop, deleting))).toEqual(["busy"]);
      expect(jars.get(WORK)).toBeUndefined();
      // Nothing was recorded, so it comes again.
      expect(
        (yield* remote.applied(desktop, { source: MAC, key: keys.desktop, profileId: WORK })).units,
      ).toEqual([]);
    }),
  );

  it.effect("stops at the next unit once a tab has waited too long, leaving the rest busy", () =>
    Effect.gen(function* () {
      const { remote, jars, hooks } = yield* setup();
      hooks.afterSet = () => (hooks.stopping = true);
      const result = yield* remote.receive(
        desktop,
        batch([copy(1), copy(1, [cookie({ domain: ".example.test" })], ["example.test"])]),
      );
      expect(outcomes(result)).toEqual(["copied", "busy"]);
      expect(jars.get(WORK)?.map(({ domain }) => domain)).toEqual([".github.com"]);
    }),
  );

  it.effect("reports a unit whose operation stalled busy, and gives the hold back at once", () =>
    Effect.gen(function* () {
      const { remote, jars, hooks } = yield* setup();
      hooks.afterSet = () => {
        hooks.afterSet = undefined;
        hooks.stalled = true;
      };
      const result = yield* remote.receive(
        desktop,
        batch([copy(1), copy(1, [cookie({ domain: ".example.test" })], ["example.test"])]),
      );
      expect(outcomes(result)).toEqual(["busy", "busy"]);
      expect(jars.get(WORK)?.map(({ domain }) => domain)).toEqual([".github.com"]);
      // Nothing was recorded: both units come again with the next delivery.
      const applied = yield* remote.applied(desktop, {
        source: MAC,
        key: keys.desktop,
        profileId: WORK,
      });
      expect(applied.units).toEqual([]);
    }),
  );

  it.effect("checks a unit whose context stopped answering on a fresh one", () =>
    Effect.gen(function* () {
      const { remote, jars, hooks } = yield* setup();
      const own = [cookie({ value: "synthetic-own" })];
      // The copy landed, then the context stopped answering: the fresh read shows a change.
      jars.set(WORK, own);
      hooks.afterSet = () => (hooks.quarantined = true);
      expect(outcomes(yield* remote.receive(desktop, batch([copy(1)])))).toEqual([
        "restore-failed",
      ]);
      // The context stopped answering, and the fresh read shows the unit as it was: only busy.
      jars.set(WORK, own);
      hooks.afterSet = () => {
        hooks.quarantined = true;
        jars.set(WORK, own);
      };
      expect(outcomes(yield* remote.receive(desktop, batch([copy(2)])))).toEqual(["busy"]);
    }),
  );

  it.effect("fills only an empty unit the first time, and a newer revision replaces it", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      jars.set(WORK, [cookie({ value: "synthetic-remote-own" })]);
      expect(outcomes(yield* remote.receive(desktop, batch([copy(3)], { mode: "fill" })))).toEqual([
        "kept",
      ]);
      expect(jars.get(WORK)?.[0]?.value).toBe("synthetic-remote-own");
      expect(outcomes(yield* remote.receive(desktop, batch([copy(4)])))).toEqual(["copied"]);
      expect(jars.get(WORK)?.[0]?.value).toBe("synthetic-desktop");
    }),
  );

  it.effect("fails a copy a page changed meanwhile, and its restore leaves the page's cookie", () =>
    Effect.gen(function* () {
      const { remote, jars, hooks } = yield* setup();
      hooks.afterSet = (profileId) => {
        hooks.afterSet = undefined;
        jars.set(profileId, [
          ...(jars.get(profileId) ?? []),
          cookie({ name: "page", value: "synthetic-page" }),
        ]);
      };
      // The page's cookie can't be told from the copy's here, so the unit is not restored exactly.
      expect(outcomes(yield* remote.receive(desktop, batch([copy(1)])))).toEqual([
        "restore-failed",
      ]);
      expect(jars.get(WORK)?.map(({ name }) => name)).toEqual(["page"]);
      expect(
        (yield* remote.applied(desktop, { source: MAC, key: keys.desktop, profileId: WORK })).units,
      ).toEqual([]);
    }),
  );

  it.effect(
    "refuses another authorized peer as the sender, even once the desktop's session expired",
    () =>
      Effect.gen(function* () {
        const { remote, accounts } = yield* setup();
        yield* remote.receive(desktop, batch([copy(1)]));
        const other = { sessionId: "session-other", subject: "desktop" };
        const takeover = yield* remote
          .bind(other, { source: MAC, label: "MacBook" })
          .pipe(Effect.flip);
        expect(takeover.message).toBe("Another connection already sends as MacBook.");
        const guessed = yield* remote
          .receive(other, batch([copy(2)], { key: Redacted.make("guessed") }))
          .pipe(Effect.flip);
        expect(guessed.message).toBe("Another connection already sends as MacBook.");
        // The desktop's next session proves the same key and renews the sender.
        const renewed = { sessionId: "session-renewed", subject: "desktop" };
        expect(
          yield* remote.bind(renewed, { source: MAC, label: "MacBook", key: keys.desktop }),
        ).toEqual({});
        expect(outcomes(yield* remote.receive(renewed, batch([copy(2)])))).toEqual(["same"]);
        expect((yield* accounts.remoteSenders).map(({ sessionId }) => sessionId)).toEqual([
          "session-renewed",
        ]);
      }),
  );

  it.effect(
    "re-issues a key only to the session that bound the sender, when its answer was lost",
    () =>
      Effect.gen(function* () {
        const { remote } = yield* setup();
        const lost = keys.desktop;
        const again = yield* remote.bind(desktop, { source: MAC, label: "MacBook" });
        expect(again.key).toBeDefined();
        keys.desktop = again.key!;
        expect(outcomes(yield* remote.receive(desktop, batch([copy(1)])))).toEqual(["copied"]);
        const stale = yield* remote
          .receive(desktop, batch([copy(2)], { key: lost }))
          .pipe(Effect.flip);
        expect(stale.message).toBe("Another connection already sends as MacBook.");
        const other = { sessionId: "session-other", subject: "desktop" };
        const refused = yield* remote
          .bind(other, { source: MAC, label: "MacBook" })
          .pipe(Effect.flip);
        expect(refused.message).toBe("Another connection already sends as MacBook.");
      }),
  );

  it.effect("binds a reinstalled desktop once the owner here forgets the old one", () =>
    Effect.gen(function* () {
      const { remote, jars, accounts } = yield* setup();
      yield* remote.receive(desktop, batch([copy(1)]));
      const reinstalled = { sessionId: "session-reinstalled", subject: "desktop" };
      yield* remote.bind(reinstalled, { source: MAC, label: "MacBook" }).pipe(Effect.flip);
      expect(yield* remote.forgetSender(MAC)).toEqual({ deleted: 1 });
      expect(jars.get(WORK)).toEqual([]);
      expect(yield* accounts.remoteSenders).toEqual([]);
      const bound = yield* remote.bind(reinstalled, { source: MAC, label: "MacBook" });
      expect(bound.key).toBeDefined();
    }),
  );

  it.effect(
    "refuses a fifth computer for one profile, and follows the strictest sender's controls",
    () =>
      Effect.gen(function* () {
        const { remote, accounts, jars } = yield* setup();
        const access = Effect.map(
          accounts.receivedProfiles,
          (profiles) => profiles.find((profile) => profile.profileId === WORK)?.access,
        );
        yield* remote.receive(desktop, batch([copy(1)]));
        const senders = ["pc-1", "pc-2", "pc-3", "pc-4"].map((id) => EnvironmentId.make(id));
        const keyOf = new Map<EnvironmentId, Redacted.Redacted<string>>();
        for (const source of senders) {
          const bound = yield* remote.bind(desktop, { source, label: source });
          keyOf.set(source, bound.key!);
        }
        const from = (source: EnvironmentId, access: "allowed" | "ask") =>
          remote.receive(
            desktop,
            batch([], {
              source,
              key: keyOf.get(source)!,
              label: source,
              controls: { access, scope: { type: "all-projects" }, scriptSignIn: true },
            }),
          );
        yield* from(senders[0]!, "ask");
        yield* from(senders[1]!, "allowed");
        yield* from(senders[2]!, "allowed");
        expect(yield* access).toBe("ask");
        // A fifth sender would push one out and orphan its copies: it is refused instead.
        const refused = yield* Effect.flip(from(senders[3]!, "allowed"));
        expect(refused.message).toContain("4 computers");
        expect(jars.get(WORK)).toHaveLength(1);
        // The strict sender gone, the others' controls are what's left.
        yield* remote.forgetSender(senders[0]!);
        expect(yield* access).toBe("allowed");
      }),
  );

  it.effect("checks the sender's controls and the university here, under the profile's lock", () =>
    Effect.gen(function* () {
      const { remote, accounts, jars } = yield* setup();
      yield* accounts.save({
        name: "HUJI",
        details: {
          kind: "website",
          sites: ["huji.ac.il"],
          profileId: WORK,
          institution: { name: "HUJI", entityId: "https://idp.huji.ac.il", domain: "huji.ac.il" },
        },
        secrets: {},
      });
      const restricted = batch([copy(1)], {
        controls: { access: "off", scope: { type: "all-projects" }, scriptSignIn: true },
      });
      expect(outcomes(yield* remote.receive(desktop, restricted))).toEqual(["blocked"]);
      const record = (yield* accounts.snapshot).profiles.find((p) => p.profileId === WORK);
      expect([record?.access, record?.received?.[0]?.label]).toEqual(["off", "MacBook"]);
      const university = copy(2, [cookie({ domain: ".huji.ac.il" })], ["huji.ac.il"]);
      expect(outcomes(yield* remote.receive(desktop, batch([university])))).toEqual(["blocked"]);
      expect(jars.get(WORK)).toBeUndefined();
    }),
  );

  it.effect("resends a unit whose record a crash lost: the same copy comes back as same", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      // The cookies landed, but no record of revision 1 was kept.
      jars.set(WORK, [cookie()]);
      expect(outcomes(yield* remote.receive(desktop, batch([copy(1)])))).toEqual(["same"]);
    }),
  );

  it.effect("withdraws every copy from a sender, and sweeps a revoked sender's", () =>
    Effect.gen(function* () {
      const { remote, jars, revoked, accounts } = yield* setup();
      jars.set(WORK, [cookie({ domain: ".kept.test", value: "synthetic-own" })]);
      yield* remote.receive(desktop, batch([copy(1)]));
      yield* remote.receive(
        desktop,
        batch([copy(1, [cookie({ domain: ".kept.test" })], ["kept.test"])], { mode: "fill" }),
      );
      expect(
        yield* remote.withdraw(desktop, { source: MAC, key: keys.desktop, all: true }),
      ).toEqual({ deleted: 1 });
      // A unit this computer kept with its own sign-in is its own; it stays.
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["synthetic-own"]);
      const received = (yield* accounts.snapshot).profiles.flatMap((p) => p.received ?? []);
      expect(received).toEqual([]);
      expect(yield* accounts.remoteSenders).toEqual([]);
      keys.desktop = (yield* remote.bind(desktop, { source: MAC, label: "MacBook" })).key!;

      yield* remote.receive(desktop, batch([copy(2)]));
      revoked.add(desktop.sessionId);
      yield* remote.sweep();
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["synthetic-own"]);
    }),
  );

  it.effect("withdraws only cookies still holding this sender's copy", () =>
    Effect.gen(function* () {
      const { remote, jars, revoked } = yield* setup();
      const pc = { sessionId: "session-pc", subject: "desktop" };
      const PC = EnvironmentId.make("pc");
      const pcKey = (yield* remote.bind(pc, { source: PC, label: "PC" })).key!;
      // A copies github.com; B, another desktop, replaces it with its own session.
      yield* remote.receive(desktop, batch([copy(1)]));
      yield* remote.receive(
        pc,
        batch([copy(1, [cookie({ value: "synthetic-pc" })])], {
          source: PC,
          key: pcKey,
          label: "PC",
        }),
      );
      revoked.add(desktop.sessionId);
      yield* remote.sweep();
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["synthetic-pc"]);
    }),
  );

  it.effect("leaves a sign-in made here after the copy when the sender withdraws", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      yield* remote.receive(desktop, batch([copy(1)]));
      jars.set(WORK, [cookie({ value: "synthetic-signed-in-here" })]);
      expect(
        yield* remote.withdraw(desktop, { source: MAC, key: keys.desktop, all: true }),
      ).toEqual({ deleted: 0 });
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["synthetic-signed-in-here"]);
    }),
  );

  it.effect("drops a revoked sender's copies on an idle computer as soon as it is revoked", () =>
    Effect.gen(function* () {
      const { remote, jars, revoked, changes, looked, lookups, accounts } = yield* setup();
      yield* remote.receive(desktop, batch([copy(1)]));
      lookups.next = yield* Deferred.make<void>();
      const watching = yield* Effect.forkChild(remote.watch);
      // The start-up sweep ran and found nothing to drop.
      yield* Deferred.await(lookups.next);
      yield* remote.list(WORK);
      expect(jars.get(WORK)).toHaveLength(1);
      // The desktop is offline; its access is revoked here, and nothing else happens.
      revoked.add(desktop.sessionId);
      yield* Queue.offer(changes, {
        type: "clientRemoved",
        sessionId: AuthSessionId.make(desktop.sessionId),
      });
      yield* Deferred.await(looked);
      yield* remote.list(WORK);
      expect(jars.get(WORK)).toEqual([]);
      expect(yield* accounts.remoteSenders).toEqual([]);
      yield* Fiber.interrupt(watching);
    }),
  );

  it.effect("drops a sender's copies after 30 days without it, not before", () =>
    Effect.gen(function* () {
      const { remote, jars, accounts } = yield* setup();
      yield* remote.receive(desktop, batch([copy(1)]));
      yield* TestClock.adjust("29 days");
      yield* remote.sweep();
      expect(jars.get(WORK)).toHaveLength(1);
      yield* TestClock.adjust("2 days");
      yield* remote.sweep();
      expect(jars.get(WORK)).toEqual([]);
      expect(yield* accounts.remoteSenders).toEqual([]);
    }),
  );

  it.effect("returns names and numbers only", () =>
    Effect.gen(function* () {
      const { remote, accounts } = yield* setup();
      const result = yield* remote.receive(desktop, batch([copy(1)]));
      const applied = yield* remote.applied(desktop, {
        source: MAC,
        key: keys.desktop,
        profileId: WORK,
      });
      const listed = yield* remote.list(WORK);
      const snapshot = yield* accounts.snapshot;
      for (const value of [result, applied, listed, snapshot]) {
        expect(JSON.stringify(value)).not.toContain("synthetic-desktop");
        expect(JSON.stringify(value)).not.toContain("fingerprint");
      }
      expect(listed).toEqual({ sites: [{ site: "github.com", cookies: 1 }] });
    }),
  );

  it.effect("signs out here only: the desktop's next revision fills the unit again", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      yield* remote.receive(desktop, batch([copy(1)]));
      expect(yield* remote.signOutLocal(WORK, "github.com")).toEqual({ signedOut: true });
      expect(outcomes(yield* remote.receive(desktop, batch([copy(1)])))).toEqual(["stale"]);
      expect(outcomes(yield* remote.receive(desktop, batch([copy(2)])))).toEqual(["copied"]);
      expect(jars.get(WORK)).toHaveLength(1);
    }),
  );
});

it.effect("runs the cookie-copy qualification only on a development server", () =>
  Effect.gen(function* () {
    const { remote, jars } = yield* setup();
    const refused = yield* Effect.flip(remote.qualify());
    expect(refused.message).toBe("The check runs only on a development server.");
    expect(jars.size).toBe(0);
  }),
);

it.effect("sweeps a server nobody has used without opening Accounts, a browser or a profile", () =>
  Effect.gen(function* () {
    const { service, blobs, operations } = yield* makeHarness();
    const fixture = browserFixture();
    const opened: string[] = [];
    const remote = yield* makeRemoteSessions.pipe(
      Effect.provideService(AccountsService, service),
      Effect.provideService(ServerBrowser, {
        ...fixture.browser,
        profileCookies: (profileId: string) => {
          opened.push(profileId);
          return fixture.browser.profileCookies!(profileId);
        },
      }),
      Effect.provideService(ServerConfig, { devUrl: undefined } as ServerConfig["Service"]),
    );
    yield* remote.sweep();
    expect(yield* service.remoteSenders).toEqual([]);
    // No vault key, no stored state and no keychain write: nothing to sweep, nothing touched.
    expect(operations).toEqual([]);
    expect([...blobs.keys()]).toEqual([]);
    expect(opened).toEqual([]);
  }),
);
