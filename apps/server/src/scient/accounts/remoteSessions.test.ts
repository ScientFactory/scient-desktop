import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  AccountsError,
  AuthSessionId,
  BrowserProfileId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  defaultAccountControls,
  defaultBrowserProfileRecord,
  type AccountSessionsReceiveInput,
  type AccountSummary,
  type BrowserProfileRecord,
  type SessionCookie,
} from "@t3tools/contracts";
import { unitCookies } from "@t3tools/shared/scientSessionCookies";
import { deliverOnce, type DeliveryDeps } from "@t3tools/shared/scientSessionDelivery";
import { DateTime, Deferred, Effect, Fiber, Option, Queue, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";

import { SessionStore, type SessionCredentialChange } from "../../auth/SessionStore.ts";
import { ServerConfig } from "../../config.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { ServerBrowser } from "../../preview/ServerBrowser.ts";
import { ClientActivityLeases } from "./clientLeases.ts";
import type { AccountKeychain } from "./AccountVault.ts";
import {
  makeHarness,
  memoryStore,
  recordingKeychain,
  website,
  windowLeases,
} from "./Accounts.testkit.ts";
import { AccountsService, type ProfileStore } from "./AccountsService.ts";
import { ProfileCookiesError, type ProfileCookieJar } from "./profileCookieJar.ts";
import { makeRemoteSessions } from "./remoteSessions.ts";
import { issueJar, issueUnit } from "./sendLog.ts";

const WORK = BrowserProfileId.make("profile-work");
const MAC = EnvironmentId.make("macbook");
const LAB = EnvironmentId.make("lab");
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
    /** Awaited before a jar is read: a test acts meanwhile, as a person would. */
    beforeRead?: ((profileId: string) => Promise<void>) | undefined;
    /** Awaited before a jar is written. */
    beforeSet?: ((profileId: string) => Promise<void>) | undefined;
    /** Awaited before cookies are removed from a jar. */
    beforeRemove?: ((profileId: string) => Promise<void>) | undefined;
    /** A cookie the browser refuses to set. */
    refuses?: ((cookie: SessionCookie) => boolean) | undefined;
    /** Each profile's cookies no API can address, by domain (round 6f). */
    opaque?: Map<string, string[]>;
    /** Each profile's generation, as Clear left it (round 6e). */
    generations?: Map<string, number>;
    stopping?: boolean;
    stalled?: boolean;
    quarantined?: boolean;
    /** The jar's context closed while still held (round 6i); false: unconfirmed (6k). */
    fence?: ((profileId: string) => Promise<boolean | void>) | undefined;
    /** Its profile fenced in memory for the life of the server (rounds 6l, 6p). */
    quarantine?: ((profileId: string) => boolean | void) | undefined;
  } = {};
  const jarOf = (profileId: string) => jars.get(profileId) ?? [];
  const jar = (profileId: string): ProfileCookieJar => ({
    readAll: async () => {
      await hooks.beforeRead?.(profileId);
      return jarOf(profileId);
    },
    readUnit: async (unit) => unitCookies(unit, jarOf(profileId)),
    unaddressable: async () => hooks.opaque?.get(profileId) ?? [],
    set: async (cookies) => {
      await hooks.beforeSet?.(profileId);
      if (cookies.some((cookie) => hooks.refuses?.(cookie))) throw new Error("Synthetic refusal");
      const next = jarOf(profileId).filter((c) => !cookies.some((n) => key(n) === key(c)));
      jars.set(profileId, [...next, ...cookies]);
      hooks.afterSet?.(profileId);
    },
    remove: async (cookies) => {
      await hooks.beforeRemove?.(profileId);
      jars.set(
        profileId,
        jarOf(profileId).filter((c) => !cookies.some((gone) => key(gone) === key(c))),
      );
    },
    openTabSites: () => tabs.get(profileId) ?? [],
    stopping: () => hooks.stopping === true,
    stalled: () => hooks.stalled === true || hooks.quarantined === true,
    quarantined: () => hooks.quarantined === true,
    fence: async () => (await hooks.fence?.(profileId)) !== false,
    quarantineProfile: () => {
      fenced.add(profileId);
      hooks.quarantine?.(profileId);
    },
  });
  /** Profiles fenced as the server's browser fences them: its close is refused (round 6r). */
  const fenced = new Set<string>();
  const browser = {
    // A fresh hold opens a fresh context: whatever stalled the last one is gone.
    profileCookies: (profileId: string, generation?: number) =>
      // Another generation's jar is refused, as the server's browser does once cleared.
      generation !== undefined && generation !== (hooks.generations?.get(profileId) ?? 0)
        ? Effect.fail(new ProfileCookiesError({ profileId, cause: "cleared" }))
        : Effect.sync(() => {
            hooks.quarantined = false;
            hooks.stalled = false;
            return jar(profileId);
          }),
    clearProfile: () => Effect.void,
    profileGenerations: () => Effect.void,
    quarantinedProfiles: () => [...fenced],
    closeProfile: (profileId: string) =>
      fenced.has(profileId)
        ? Effect.fail(new ProfileCookiesError({ profileId, cause: "fenced" }))
        : Effect.void,
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
  /** The browser store this computer's Accounts was handed, to call as Accounts does. */
  const stores: Array<ProfileStore> = [];
  const remote = yield* makeRemoteSessions.pipe(
    Effect.provideService(AccountsService, {
      ...service,
      attachProfileStore: (store: ProfileStore) =>
        Effect.suspend(() => {
          stores.push(store);
          return service.attachProfileStore(store);
        }),
    }),
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
  /** What this computer recorded applying from the desktop, for Work. */
  const applied = () =>
    remote.applied(desktop, { source: MAC, key: keys.desktop, profileId: WORK });
  return {
    ...fixture,
    revoked,
    changes,
    looked,
    lookups,
    remote,
    applied,
    accounts: service,
    store: () => stores[0]!,
  };
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
      const { remote, applied, jars, accounts } = yield* setup();
      expect(outcomes(yield* remote.receive(desktop, batch([copy(5)])))).toEqual(["copied"]);
      const deleted = yield* remote.receive(
        desktop,
        batch([{ sites: ["github.com"], revision: 6, kind: "delete" }]),
      );
      expect(outcomes(deleted)).toEqual(["deleted"]);
      // The person signed out on the desktop: renewal here must not sign back in either.
      expect(yield* accounts.signedOut).toEqual([{ profileId: WORK, site: "github.com" }]);
      // The copy read before the sign-out arrives late: it must not bring the site back.
      expect(outcomes(yield* remote.receive(desktop, batch([copy(5)])))).toEqual(["stale"]);
      expect(jars.get(WORK)).toEqual([]);
      const recorded = yield* applied();
      expect(recorded).toEqual({
        bound: true,
        units: [{ sites: ["github.com"], revision: 6, outcome: "deleted" }],
      });
    }),
  );

  it.effect("deletes a vendor's host alone when a Sign out sends it, never its neighbours", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      jars.set(WORK, [
        cookie({ domain: "proxy.library-vendor.com", name: "ezproxy" }),
        cookie({ domain: "portal.library-vendor.com", name: "other" }),
      ]);
      const deleted = yield* remote.receive(
        desktop,
        batch([{ sites: ["proxy.library-vendor.com"], revision: 7, kind: "delete" }]),
      );
      expect(outcomes(deleted)).toEqual(["deleted"]);
      expect(jars.get(WORK)?.map(({ name }) => name)).toEqual(["other"]);
    }),
  );

  it.effect("leaves a unit with an open tab for the next delivery, for copies and deletions", () =>
    Effect.gen(function* () {
      const { remote, applied, tabs, jars } = yield* setup();
      tabs.set(WORK, ["github.com"]);
      for (const mode of ["fill", "replace"] as const)
        expect(outcomes(yield* remote.receive(desktop, batch([copy(1)], { mode })))).toEqual([
          "busy",
        ]);
      const deleting = batch([{ sites: ["github.com"], revision: 2, kind: "delete" }]);
      expect(outcomes(yield* remote.receive(desktop, deleting))).toEqual(["busy"]);
      expect(jars.get(WORK)).toBeUndefined();
      // Nothing was recorded, so it comes again.
      expect((yield* applied()).units).toEqual([]);
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
      const { remote, applied, jars, hooks } = yield* setup();
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
      const recorded = yield* applied();
      expect(recorded.units).toEqual([]);
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
      const { remote, applied, jars, hooks } = yield* setup();
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
      expect((yield* applied()).units).toEqual([]);
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

  it.effect("owns only what it wrote: a unit found here, or since written by another, stays", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      const takeBack = (revision: number) =>
        remote.receive(
          desktop,
          batch([{ sites: ["github.com"], revision, kind: "delete", copyOnly: true }]),
        );
      // Signed in here before the desktop's first copy, to the same session: it isn't the copy's.
      jars.set(WORK, [cookie()]);
      expect(outcomes(yield* remote.receive(desktop, batch([copy(1)])))).toEqual(["same"]);
      yield* takeBack(2);
      expect(jars.get(WORK)).toHaveLength(1);
      expect(
        yield* remote.withdraw(desktop, { source: MAC, key: keys.desktop, all: true }),
      ).toEqual({ deleted: 0 });
      expect(jars.get(WORK)).toHaveLength(1);

      // Copied, then written by another computer, even back to the same cookies: that one's now.
      keys.desktop = (yield* remote.bind(desktop, { source: MAC, label: "MacBook" })).key!;
      jars.set(WORK, []);
      expect(outcomes(yield* remote.receive(desktop, batch([copy(3)])))).toEqual(["copied"]);
      const PC = EnvironmentId.make("pc-1");
      const pcKey = (yield* remote.bind(desktop, { source: PC, label: "PC" })).key!;
      const fromPc = (revision: number, value: string) =>
        remote.receive(
          desktop,
          batch([copy(revision, [cookie({ value })])], { source: PC, key: pcKey, label: "PC" }),
        );
      expect(outcomes(yield* fromPc(1, "synthetic-other"))).toEqual(["copied"]);
      expect(outcomes(yield* fromPc(2, cookie().value))).toEqual(["copied"]);
      yield* takeBack(4);
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual([cookie().value]);
    }),
  );

  it.effect("never widens or refreshes a claim on a same: what it didn't write stays", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      const takeBack = (revision: number, sites = ["github.com"]) =>
        remote.receive(desktop, batch([{ sites, revision, kind: "delete", copyOnly: true }]));
      // Copied, then signed in again here: the desktop now sends that same new session.
      expect(outcomes(yield* remote.receive(desktop, batch([copy(1)])))).toEqual(["copied"]);
      const here = cookie({ value: "signed-in-here" });
      jars.set(WORK, [here]);
      expect(outcomes(yield* remote.receive(desktop, batch([copy(2, [here])])))).toEqual(["same"]);
      yield* takeBack(3);
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["signed-in-here"]);

      // A claim on GitHub never stretches to a site merged into its unit later.
      jars.set(WORK, []);
      expect(outcomes(yield* remote.receive(desktop, batch([copy(4)])))).toEqual(["copied"]);
      const own = cookie({ domain: ".example.test", value: "own-example" });
      jars.set(WORK, [...jars.get(WORK)!, own]);
      const merged = ["github.com", "example.test"];
      expect(
        outcomes(yield* remote.receive(desktop, batch([copy(5, jars.get(WORK)!, merged)]))),
      ).toEqual(["same"]);
      yield* takeBack(6, merged);
      expect(jars.get(WORK)?.map(({ value }) => value)).toContain("own-example");
    }),
  );

  it.effect(
    "keeps the writer's claim when another sender's take-back finds nothing of its own",
    () =>
      Effect.gen(function* () {
        const { remote, jars } = yield* setup();
        const PC = EnvironmentId.make("pc-1");
        const pcKey = (yield* remote.bind(desktop, { source: PC, label: "PC" })).key!;
        const fromPc = { source: PC, key: pcKey, label: "PC" };
        const takeBack = (revision: number, overrides = {}) =>
          remote.receive(
            desktop,
            batch([{ sites: ["github.com"], revision, kind: "delete", copyOnly: true }], overrides),
          );
        expect(outcomes(yield* remote.receive(desktop, batch([copy(1)])))).toEqual(["copied"]);
        const pcs = [cookie({ value: "synthetic-pc" })];
        expect(outcomes(yield* remote.receive(desktop, batch([copy(1, pcs)], fromPc)))).toEqual([
          "copied",
        ]);
        // The Mac's copy is gone: its take-back leaves the PC's, and the PC's claim on it.
        expect(outcomes(yield* takeBack(2))).toEqual(["kept"]);
        expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["synthetic-pc"]);
        expect(outcomes(yield* takeBack(2, fromPc))).toEqual(["deleted"]);
        expect(jars.get(WORK)).toEqual([]);
      }),
  );

  it.effect("keeps another writer's claim on a site a wider take-back left untouched", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      const PC = EnvironmentId.make("pc-1");
      const pcKey = (yield* remote.bind(desktop, { source: PC, label: "PC" })).key!;
      const fromPc = { source: PC, key: pcKey, label: "PC" };
      const takeBack = (revision: number, sites: ReadonlyArray<string>, overrides = {}) =>
        remote.receive(
          desktop,
          batch([{ sites: [...sites], revision, kind: "delete", copyOnly: true }], overrides),
        );
      yield* remote.receive(desktop, batch([copy(1)]));
      const pcs = [cookie({ domain: ".example.test", value: "synthetic-pc" })];
      yield* remote.receive(desktop, batch([copy(1, pcs, ["example.test"])], fromPc));
      // The Mac takes back GitHub over both sites: the PC's example.test stays the PC's.
      yield* takeBack(2, ["github.com", "example.test"]);
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["synthetic-pc"]);
      expect(outcomes(yield* takeBack(2, ["example.test"], fromPc))).toEqual(["deleted"]);
      expect(jars.get(WORK)).toEqual([]);
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

  it.effect(
    "takes nothing more into a profile merged into Main here, from a sender it follows",
    () =>
      Effect.gen(function* () {
        const { remote, jars, accounts } = yield* setup();
        yield* remote.receive(desktop, batch([copy(1)]));
        yield* accounts.retireProfile(WORK, { name: "Work" });
        const refused = yield* remote
          .receive(desktop, batch([copy(2, [cookie({ value: "synthetic-later" })])]))
          .pipe(Effect.flip);
        expect(refused.reason).toBe("denied");
        expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["synthetic-desktop"]);
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
      const { remote, applied, accounts } = yield* setup();
      const result = yield* remote.receive(desktop, batch([copy(1)]));
      const recorded = yield* applied();
      const listed = yield* remote.list(WORK);
      const snapshot = yield* accounts.snapshot;
      for (const value of [result, recorded, listed, snapshot]) {
        expect(JSON.stringify(value)).not.toContain("synthetic-desktop");
        expect(JSON.stringify(value)).not.toContain("fingerprint");
      }
      expect(listed).toEqual({ sites: [{ site: "github.com", cookies: 1 }] });
    }),
  );

  it.effect("signs a vendor's host out alone, never its siblings on that site", () =>
    Effect.gen(function* () {
      const { remote, jars } = yield* setup();
      jars.set(WORK, [
        cookie({ domain: "proxy.library-vendor.com", name: "ezproxy" }),
        cookie({ domain: "portal.library-vendor.com", name: "other" }),
      ]);
      expect(yield* remote.signOutLocal(WORK, "proxy.library-vendor.com")).toEqual({
        signedOut: true,
      });
      expect(jars.get(WORK)?.map(({ name }) => name)).toEqual(["other"]);
      // A shared parent cookie still reaches the host: never deleted, and not signed out.
      jars.set(WORK, [cookie({ domain: ".library-vendor.com", name: "shared", httpOnly: true })]);
      expect(yield* remote.signOutLocal(WORK, "proxy.library-vendor.com")).toEqual({
        signedOut: false,
      });
      expect(jars.get(WORK)?.map(({ name }) => name)).toEqual(["shared"]);
    }),
  );

  it.effect("signs out here only: the desktop's next revision fills the unit again", () =>
    Effect.gen(function* () {
      const { remote, jars, accounts } = yield* setup();
      yield* remote.receive(desktop, batch([copy(1)]));
      expect(yield* remote.signOutLocal(WORK, "github.com")).toEqual({ signedOut: true });
      // Remembered here, so this computer's renewal never signs back in.
      expect(yield* accounts.signedOut).toEqual([{ profileId: WORK, site: "github.com" }]);
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

it.effect("agrees with the desktop's sender on revisions: link, sign out, link again", () =>
  Effect.gen(function* () {
    const { remote, jars, accounts } = yield* setup();
    const services = yield* Effect.context<never>();
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- deliverOnce is the desktop's Promise sender; its requests reach the receiver here.
    const run = Effect.runPromiseWith(services);
    const row: AccountSummary = {
      accountId: AccountId.make("acc_githubwork"),
      name: "github.com",
      details: { kind: "website", sites: ["github.com"], profileId: WORK },
      secrets: {},
      controls: defaultAccountControls("website"),
      status: "ready",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    /** The desktop: its jar, send log, record and the key this computer issued it. */
    const sender = {
      jar: [cookie({ value: "synthetic-first" })],
      log: issueUnit(undefined, ["github.com"], "copy"),
      record: defaultBrowserProfileRecord(WORK),
      key: keys.desktop as Redacted.Redacted<string> | undefined,
      remote: undefined as BrowserProfileRecord | undefined,
      batches: 0,
    };
    const deps: DeliveryDeps = {
      source: MAC,
      label: "MacBook",
      remoteId: LAB,
      remoteLabel: "Lab server",
      profiles: () => [{ profileId: WORK, record: sender.record }],
      desktopAccounts: () => [row],
      signingIn: () => [],
      revalidate: () => undefined,
      bind: async () => {
        const bound = await run(
          remote.bind(desktop, { source: MAC, label: "MacBook", key: sender.key }),
        );
        sender.key = bound.key ?? sender.key;
        return sender.key!;
      },
      sendLog: async () => sender.log,
      resend: async () => void (sender.log = issueJar(sender.log)),
      applied: (profileId, key) =>
        run(
          remote.applied(desktop, {
            source: MAC,
            key,
            profileId: BrowserProfileId.make(profileId),
          }),
        ),
      remoteRecord: () => sender.remote,
      receive: (input) => {
        sender.batches += 1;
        return run(remote.receive(desktop, input));
      },
      withdraw: (profileId, revision, key) =>
        run(
          remote.withdraw(desktop, {
            source: MAC,
            key,
            profileId: BrowserProfileId.make(profileId),
            revision,
          }),
        ).then(() => undefined),
      shared: async (_profileId, share) =>
        void (sender.record = { ...sender.record, sharedWith: [share] }),
      readSessions: async () => ({
        units: sender.jar.length ? [{ sites: ["github.com"], cookies: sender.jar }] : [],
      }),
      now: () => "2026-11-04T10:14:00.000Z",
    };
    const deliver = Effect.fn("RemoteSessionsTest.deliver")(function* () {
      sender.remote = (yield* accounts.snapshot).profiles.find((p) => p.profileId === WORK);
      sender.batches = 0;
      yield* Effect.promise(() => deliverOnce(deps));
      return sender.record.sharedWith?.[0];
    });
    const values = () => jars.get(WORK)?.map(({ value }) => value);

    // Linked: the whole jar goes, and the line says the head is applied.
    expect(yield* deliver()).toMatchObject({ applied: sender.log.head, waiting: 0 });
    expect(values()).toEqual(["synthetic-first"]);
    expect(yield* deliver()).toMatchObject({ applied: sender.log.head, waiting: 0 });
    expect(sender.batches).toBe(0);

    // Signed out on the desktop: one deletion, at the log's next revision.
    sender.jar = [];
    sender.log = issueUnit(sender.log, ["github.com"], "delete");
    expect(yield* deliver()).toMatchObject({ applied: sender.log.head, waiting: 0 });
    expect(values()).toEqual([]);

    // Unlinked, signed in again, linked: a new key, and the new sign-in arrives in full.
    yield* remote.withdraw(desktop, { source: MAC, key: sender.key!, all: true });
    sender.key = undefined;
    sender.record = defaultBrowserProfileRecord(WORK);
    sender.jar = [cookie({ value: "synthetic-again" })];
    sender.log = issueUnit(sender.log, ["github.com"], "copy");
    expect(yield* deliver()).toMatchObject({ applied: sender.log.head, waiting: 0 });
    expect(values()).toEqual(["synthetic-again"]);
    expect(Redacted.value(sender.key!)).not.toBe(Redacted.value(keys.desktop));

    // Taken back, as Main gives back a restricted profile's copy: only the copy as sent goes.
    sender.jar = [];
    sender.log = issueUnit(sender.log, ["github.com"], "delete", { copyOnly: true });
    expect(yield* deliver()).toMatchObject({ applied: sender.log.head, waiting: 0 });
    expect(values()).toEqual([]);
    // A sign-in made here since is this computer's own, and stays.
    sender.jar = [cookie({ value: "synthetic-third" })];
    sender.log = issueUnit(sender.log, ["github.com"], "copy");
    yield* deliver();
    jars.set(WORK, [cookie({ value: "signed-in-here" })]);
    sender.jar = [];
    sender.log = issueUnit(sender.log, ["github.com"], "delete", { copyOnly: true });
    expect(yield* deliver()).toMatchObject({ applied: sender.log.head, waiting: 0 });
    expect(values()).toEqual(["signed-in-here"]);
  }),
);

describe("a profile's sign-out Undo through this server's browser (round 6c, finding 2)", () => {
  it.effect("sets back what the sign-out removed, never over a sign-in made since", () =>
    Effect.gen(function* () {
      const { jars, accounts } = yield* setup();
      jars.set(WORK, [
        cookie(),
        cookie({ name: "theme", value: "synthetic-theme", httpOnly: false }),
      ]);
      yield* accounts.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: WORK, site: "github.com" },
        undefined,
        [],
      );
      expect(jars.get(WORK)).toEqual([]);
      // The person signs in again: a new session cookie, the old theme not set again.
      jars.set(WORK, [cookie({ value: "synthetic-newer" })]);
      const undone = yield* accounts.undoProfileOperation("op-out", undefined);
      expect(undone.undone?.server).toEqual({ state: "done", restored: 1, refused: 0, newer: 1 });
      expect(
        jars
          .get(WORK)
          ?.map(({ name, value }) => [name, value])
          .toSorted(),
      ).toEqual([
        ["session", "synthetic-newer"],
        ["theme", "synthetic-theme"],
      ]);
    }),
  );
});

describe("a copy through this server's browser loses no sign-in (round 6c, finding 4)", () => {
  const HOME = BrowserProfileId.make("profile-home");
  it.effect("copies only what the source has, over the same cookies, sealed before it writes", () =>
    Effect.gen(function* () {
      const { jars, accounts } = yield* setup();
      jars.set(WORK, [cookie({ value: "work-session" })]);
      jars.set(HOME, [
        cookie({ value: "home-session" }),
        // Only Home's: it stays.
        cookie({ name: "pref", value: "home-pref", httpOnly: false }),
        cookie({ name: "kept", value: "home-only", domain: ".gitlab.com" }),
      ]);
      const copied = (yield* accounts.operateProfile(
        {
          operationId: "op-copy",
          kind: "copy",
          profileId: WORK,
          into: HOME,
          sites: ["github.com", "gitlab.com"],
        },
        undefined,
        [],
      )).operation!;
      // GitLab: nothing in Work, so Home's own stays and the site is named.
      expect(copied.server).toEqual({ state: "done", copied: 1, uncovered: ["gitlab.com"] });
      expect(copied.sites).toEqual(["github.com", "gitlab.com"]);
      expect(
        jars
          .get(HOME)
          ?.map(({ name, value }) => [name, value])
          .toSorted(),
      ).toEqual([
        ["kept", "home-only"],
        ["pref", "home-pref"],
        ["session", "work-session"],
      ]);
      // A page in Home signs in again meanwhile: Undo leaves that newer cookie.
      jars.set(
        HOME,
        jars.get(HOME)!.map((c) => (c.name === "session" ? { ...c, value: "home-newer" } : c)),
      );
      yield* accounts.profileStoreDone({
        operationId: "op-copy",
        phase: "do",
        outcome: { state: "done", copied: 1 },
      });
      const undone = yield* accounts.undoProfileOperation("op-copy", undefined);
      expect(undone.undone?.server).toEqual({ state: "done", restored: 0, refused: 0, newer: 1 });
      expect(
        jars
          .get(HOME)
          ?.map(({ name, value }) => [name, value])
          .toSorted(),
      ).toEqual([
        ["kept", "home-only"],
        ["pref", "home-pref"],
        ["session", "home-newer"],
      ]);
    }),
  );

  it.effect("seals what it replaces before the destination's jar changes", () =>
    Effect.gen(function* () {
      const { jars, store } = yield* setup();
      jars.set(WORK, [cookie({ value: "work-session" })]);
      jars.set(HOME, [cookie({ value: "home-session" })]);
      const atSeal: Array<ReadonlyArray<string>> = [];
      const result = yield* store().copy(WORK, HOME, ["github.com"], (saved) =>
        Effect.sync(() => {
          // Handed over while Home is still as it was: nothing changed before the seal.
          atSeal.push(jars.get(HOME)!.map(({ value }) => value));
          expect(saved.before.map(({ value }) => value)).toEqual(["home-session"]);
          expect(saved.copied.map(({ value }) => value)).toEqual(["work-session"]);
        }),
      );
      expect(atSeal).toEqual([["home-session"]]);
      expect(result.copied).toBe(1);
      // A seal that fails stops the copy before it writes.
      jars.set(HOME, [cookie({ value: "home-session" })]);
      const failed = yield* store()
        .copy(WORK, HOME, ["github.com"], () =>
          Effect.fail(new AccountsError({ reason: "unavailable", message: "synthetic" })),
        )
        .pipe(Effect.flip);
      expect(failed.reason).toBe("unavailable");
      expect(jars.get(HOME)?.map(({ value }) => value)).toEqual(["home-session"]);
    }),
  );
});

describe("each write is checked where it commits, in its own data (round 6e)", () => {
  const HOME = BrowserProfileId.make("profile-home");
  const by = { threadId: ThreadId.make("thread-agent"), projectId: ProjectId.make("project-lab") };
  /** Holds the next read of `profileId` until the test lets it go. */
  const holdNextRead = (
    hooks: ReturnType<typeof browserFixture>["hooks"],
    profileId: string,
    skip = 0,
  ) => {
    let seen = 0;
    let release = () => undefined as void;
    let reached = () => undefined as void;
    const reading = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    hooks.beforeRead = async (read) => {
      if (read !== profileId || held || seen++ < skip) return;
      held = true;
      reached();
      await gate;
    };
    return { reading, release: () => release() };
  };

  it.effect("signs nothing out once the agent's access went while it read and sealed", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie()]);
      const read = holdNextRead(hooks, WORK);
      const running = yield* accounts
        .operateProfile(
          { operationId: "op-out", kind: "sign-out", profileId: WORK, site: "github.com" },
          by,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => read.reading);
      // The person turns the profile off for agents while the jar is read.
      yield* accounts.setControls({ target: { type: "profile", profileId: WORK }, access: "off" });
      read.release();
      const done = (yield* Fiber.join(running)).operation!;
      // regression: the sign-out removed the cookies after the grant was gone.
      expect(jars.get(WORK)).toEqual([cookie()]);
      expect(done.server?.state).toBe("failed");
      expect(done.stopped).toBeDefined();
    }),
  );

  it.effect("copies nothing, and moves no marker, once the grant went during the copy", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie({ value: "work-session" })]);
      jars.set(HOME, [cookie({ value: "home-session" })]);
      const read = holdNextRead(hooks, HOME);
      const running = yield* accounts
        .operateProfile(
          {
            operationId: "op-move",
            kind: "move",
            profileId: WORK,
            into: HOME,
            sites: ["github.com"],
          },
          by,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => read.reading);
      yield* accounts.setControls({ target: { type: "profile", profileId: HOME }, access: "off" });
      read.release();
      const done = (yield* Fiber.join(running)).operation!;
      // regression: Home took the copy and Work was marked signed out after the grant went.
      expect(jars.get(HOME)?.map(({ value }) => value)).toEqual(["home-session"]);
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["work-session"]);
      expect(done.stopped).toBeDefined();
    }),
  );

  it.effect(
    "keeps the source signed in, unmarked, once the grant went before the move took it",
    () =>
      Effect.gen(function* () {
        const { jars, hooks, accounts } = yield* setup();
        jars.set(WORK, [cookie({ value: "work-session" })]);
        jars.set(HOME, []);
        // The move's own read of Work, after the copy's.
        const read = holdNextRead(hooks, WORK, 1);
        const running = yield* accounts
          .operateProfile(
            {
              operationId: "op-move",
              kind: "move",
              profileId: WORK,
              into: HOME,
              sites: ["github.com"],
            },
            by,
            [],
          )
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => read.reading);
        yield* accounts.setControls({
          target: { type: "profile", profileId: WORK },
          access: "off",
        });
        read.release();
        const done = (yield* Fiber.join(running)).operation!;
        expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["work-session"]);
        expect(done.stopped).toBeDefined();
        // regression: the move marked Work signed out of the site it never left.
        expect(
          (yield* accounts.signedOut).some(
            (entry) => entry.profileId === WORK && entry.site === "github.com",
          ),
        ).toBe(false);
      }),
  );

  it.effect("writes an Undo only into the data the operation was done in", () =>
    Effect.gen(function* () {
      const { jars, hooks, store } = yield* setup();
      jars.set(WORK, []);
      hooks.generations = new Map([[WORK, 1]]);
      // Cleared since: generation 0's Undo has nowhere to go in generation 1's jar.
      const refused = yield* store().restore(WORK, [cookie()], { generation: 0 }).pipe(Effect.flip);
      expect(refused.reason).toBe("unavailable");
      expect(jars.get(WORK)).toEqual([]);
      const back = yield* store().restore(WORK, [cookie()], { generation: 1 });
      expect(back.restored).toBe(1);
    }),
  );
});

describe("the check and the write land under one permit (round 6f)", () => {
  const HOME = BrowserProfileId.make("profile-home");
  const by = { threadId: ThreadId.make("thread-agent"), projectId: ProjectId.make("project-lab") };
  it.effect("holds a revoke made during the copy's write until the write has landed", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie({ value: "work-session" })]);
      jars.set(HOME, []);
      let release = () => undefined as void;
      let writing = () => undefined as void;
      const started = new Promise<void>((resolve) => (writing = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      hooks.beforeSet = async (profileId) => {
        if (profileId !== HOME) return;
        writing();
        await gate;
      };
      const copying = yield* accounts
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: WORK,
            into: HOME,
            sites: ["github.com"],
          },
          by,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started);
      const revoking = yield* accounts
        .setControls({ target: { type: "profile", profileId: HOME }, access: "off" })
        .pipe(Effect.forkChild);
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      // regression: the revoke landed between the check and the write, mid-copy.
      expect(revoking.pollUnsafe()).toBeUndefined();
      release();
      const done = (yield* Fiber.join(copying)).operation!;
      yield* Fiber.join(revoking);
      expect(done.server?.state).toBe("done");
      expect(jars.get(HOME)?.map(({ value }) => value)).toEqual(["work-session"]);
    }),
  );
});

describe("this server's sign-out counts what no API can reach (round 6f, verdict 5)", () => {
  it.effect("names the site's opaque cookies it left, as the desktop does", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie()]);
      hooks.opaque = new Map([[WORK, [".github.com", ".other.org"]]]);
      const done = (yield* accounts.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: WORK, site: "github.com" },
        undefined,
        [],
      )).operation!;
      // regression: this server's sign-out said nothing of the cookie it couldn't reach.
      expect(done.server).toEqual({ state: "done", saved: 1, leftBehind: 1 });
    }),
  );

  it.effect("names them for a move too, which signs the source out (6i)", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      const HOME = BrowserProfileId.make("profile-home");
      jars.set(WORK, [cookie()]);
      jars.set(HOME, []);
      hooks.opaque = new Map([[WORK, [".github.com", ".other.org"]]]);
      const done = (yield* accounts.operateProfile(
        {
          operationId: "op-move",
          kind: "move",
          profileId: WORK,
          into: HOME,
          sites: ["github.com"],
        },
        undefined,
        [],
      )).operation!;
      // regression: the move's sign-out of the source counted nothing it couldn't reach.
      expect(done.server).toMatchObject({ state: "done", leftBehind: 1 });
    }),
  );
});

describe("the permit is held until the writes have ended (round 6h, A)", () => {
  const HOME = BrowserProfileId.make("profile-home");
  const by = { threadId: ThreadId.make("thread-agent"), projectId: ProjectId.make("project-lab") };
  it.effect("keeps a revoke waiting through a slow write, however long it takes", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie({ value: "work-session" })]);
      jars.set(HOME, []);
      let release = () => undefined as void;
      let writing = () => undefined as void;
      const started = new Promise<void>((resolve) => (writing = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      hooks.beforeSet = async (profileId) => {
        if (profileId !== HOME) return;
        writing();
        await gate;
      };
      const copying = yield* accounts
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: WORK,
            into: HOME,
            sites: ["github.com"],
          },
          by,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started);
      const revoking = yield* accounts
        .setControls({ target: { type: "profile", profileId: HOME }, access: "off" })
        .pipe(Effect.forkChild);
      // Long past any timer: the cookie command is still running.
      yield* TestClock.adjust("2 minutes");
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      // regression: a 15 s timer released the permit while the write went on, and the revoke landed.
      expect(revoking.pollUnsafe()).toBeUndefined();
      release();
      const done = (yield* Fiber.join(copying)).operation!;
      yield* Fiber.join(revoking);
      expect(done.server?.state).toBe("done");
    }),
  );
});

describe("a jar that stopped answering is fenced before the permit goes (round 6i, A)", () => {
  const HOME = BrowserProfileId.make("profile-home");
  const by = { threadId: ThreadId.make("thread-agent"), projectId: ProjectId.make("project-lab") };
  it.effect("closes its context while a revoke still waits", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie({ value: "work-session" })]);
      jars.set(HOME, []);
      // The write's command times out and its helper won't close: the context is quarantined.
      hooks.beforeSet = async (profileId) => {
        if (profileId !== HOME) return;
        hooks.quarantined = true;
        throw new Error("Synthetic stalled command");
      };
      let release = () => undefined as void;
      let fencing = () => undefined as void;
      const fenced = new Promise<void>((resolve) => (fencing = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      hooks.fence = async (profileId) => {
        if (profileId !== HOME) return;
        fencing();
        await gate;
      };
      const copying = yield* accounts
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: WORK,
            into: HOME,
            sites: ["github.com"],
          },
          by,
          [],
        )
        .pipe(Effect.forkChild);
      // regression: the context was discarded only after the permit went, so the command's
      // late answer could land after a revoke's check.
      yield* Effect.promise(() => fenced);
      const revoking = yield* accounts
        .setControls({ target: { type: "profile", profileId: HOME }, access: "off" })
        .pipe(Effect.forkChild);
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      expect(revoking.pollUnsafe()).toBeUndefined();
      release();
      yield* Fiber.join(copying);
      yield* Fiber.join(revoking);
    }),
  );
});

describe("a copy tells each cookie it set while it holds the destination (round 6j)", () => {
  it.effect("keeps a site's confirmed write though another cookie of the site failed", () =>
    Effect.gen(function* () {
      const { jars, hooks, store } = yield* setup();
      const HOME = BrowserProfileId.make("profile-home");
      jars.set(WORK, [cookie({ name: "a" }), cookie({ name: "b" })]);
      jars.set(HOME, []);
      hooks.refuses = (candidate) => candidate.name === "b";
      const told: Array<string> = [];
      const result = yield* store().copy(WORK, HOME, ["github.com"], () => Effect.void, {
        wrote: (cookies) => Effect.sync(() => told.push(...cookies.map(({ name }) => name))),
      });
      expect(result.uncovered).toEqual(["github.com"]);
      // regression: the site's failure hid the cookie that was written, from every retry.
      expect(told).toEqual(["a"]);
    }),
  );
});

describe("an unconfirmed fence holds the profile before the permit goes (rounds 6k, 6l)", () => {
  const HOME = BrowserProfileId.make("profile-home");
  const by = { threadId: ThreadId.make("thread-agent"), projectId: ProjectId.make("project-lab") };
  it.effect("marks the profile held, then lets a waiting revoke through", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie({ value: "work-session" })]);
      jars.set(HOME, []);
      hooks.beforeSet = async (profileId) => {
        if (profileId !== HOME) return;
        hooks.quarantined = true;
        throw new Error("Synthetic stalled command");
      };
      // Neither the context nor its browser confirms it closed.
      let release = () => undefined as void;
      let fencing = () => undefined as void;
      const reached = new Promise<void>((resolve) => (fencing = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      hooks.fence = async () => {
        fencing();
        await gate;
        return false;
      };
      const order: string[] = [];
      hooks.quarantine = (profileId) => void order.push(`held ${profileId}`);
      const copying = yield* accounts
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: WORK,
            into: HOME,
            sites: ["github.com"],
          },
          by,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => reached);
      const revoking = yield* accounts
        .setControls({ target: { type: "profile", profileId: HOME }, access: "off" })
        .pipe(
          Effect.tap(() => Effect.sync(() => order.push("revoke"))),
          Effect.forkChild,
        );
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      expect(revoking.pollUnsafe()).toBeUndefined();
      release();
      yield* Fiber.join(copying);
      yield* Fiber.join(revoking);
      // regression: the permit went with the profile still open to writes.
      expect(order).toEqual([`held ${HOME}`, "revoke"]);
    }),
  );
});

describe("the fence holds up no other Accounts write (rounds 6n, 6p)", () => {
  const HOME = BrowserProfileId.make("profile-home");
  const by = { threadId: ThreadId.make("thread-agent"), projectId: ProjectId.make("project-lab") };
  it.effect("holds the profile and lets a waiting revoke through", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie({ value: "work-session" })]);
      jars.set(HOME, []);
      hooks.beforeSet = async (profileId) => {
        if (profileId !== HOME) return;
        hooks.quarantined = true;
        throw new Error("Synthetic stalled command");
      };
      let fenced = () => undefined as void;
      const reached = new Promise<void>((resolve) => (fenced = resolve));
      hooks.fence = async () => {
        fenced();
        return false;
      };
      let attempts = 0;
      hooks.quarantine = () => void attempts++;
      const copying = yield* accounts
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: WORK,
            into: HOME,
            sites: ["github.com"],
          },
          by,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => reached);
      const revoking = yield* accounts
        .setControls({ target: { type: "profile", profileId: HOME }, access: "off" })
        .pipe(Effect.forkChild);
      yield* Fiber.join(copying);
      // regression: the permit stayed, retrying a mark on disk, and the revoke never ran.
      yield* Fiber.join(revoking);
      expect(attempts).toBe(1);
    }),
  );
});

describe("a close the fenced browser refuses is recorded failed, never done (round 6r)", () => {
  it.effect("Undo of an earlier Clear after a sign-out fenced the profile", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie()]);
      const cleared = yield* accounts.operateProfile(
        { operationId: "op-clear", kind: "clear", profileId: WORK },
        undefined,
        [],
      );
      expect(cleared.operation?.server).toEqual({ state: "done" });
      hooks.generations = new Map([[WORK, cleared.operation!.to!]]);
      // The sign-out's command stalls, and its browser never confirms it closed.
      hooks.beforeRemove = async () => {
        hooks.quarantined = true;
        throw new Error("Synthetic stalled command");
      };
      hooks.fence = async () => false;
      yield* accounts
        .operateProfile(
          { operationId: "op-out", kind: "sign-out", profileId: WORK, site: "github.com" },
          undefined,
          [],
        )
        .pipe(Effect.ignore);
      const undone = yield* accounts.undoProfileOperation("op-clear", undefined);
      // regression: the adapter swallowed the refused close, and Undo recorded it done.
      expect(undone.undone?.server).toEqual({ state: "failed" });
    }),
  );
});

describe("a copy's write is refused once its destination was cleared (round 6s)", () => {
  const HOME = BrowserProfileId.make("profile-home");
  it.effect("a Clear of the destination during the copy, and the copy's commit is refused", () =>
    Effect.gen(function* () {
      const { jars, hooks, accounts } = yield* setup();
      jars.set(WORK, [cookie({ value: "work-session" })]);
      jars.set(HOME, []);
      // The person clears the destination while the copy reads it, before it writes.
      const reading = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let cleared = false;
      hooks.beforeRead = async (profileId) => {
        if (profileId !== HOME || cleared) return;
        cleared = true;
        reading.resolve();
        await resume.promise;
      };
      const copying = yield* accounts
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: WORK,
            into: HOME,
            sites: ["github.com"],
          },
          undefined,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => reading.promise);
      yield* accounts.operateProfile(
        { operationId: "op-clear-home", kind: "clear", profileId: HOME },
        undefined,
        [],
      );
      resume.resolve();
      const copied = yield* Fiber.join(copying);
      expect(cleared).toBe(true);
      // Refused at its commit, by the destination's version and its generation alike: nothing
      // reaches the data the Clear set aside.
      expect(copied.operation?.stopped).toMatch(/since; nothing was done\.$/u);
      expect(copied.operation?.server?.state).toBe("failed");
      expect(jars.get(HOME)).toEqual([]);
    }),
  );
});

/** Starts this computer again on `storage`, sweeps once, and returns its Accounts. */
const sweepAfterRestart = Effect.fn("RemoteSessionsTest.sweepAfterRestart")(function* (
  storage: ReturnType<typeof memoryStore>,
  keychain: AccountKeychain,
  leases: ClientActivityLeases["Service"],
) {
  const { service } = yield* makeHarness({ storage, keychain, leases });
  const remote = yield* makeRemoteSessions.pipe(
    Effect.provideService(AccountsService, service),
    Effect.provideService(ServerBrowser, browserFixture().browser),
    Effect.provideService(ServerConfig, { devUrl: undefined } as ServerConfig["Service"]),
    Effect.provideService(SessionStore, {
      streamChanges: Stream.empty,
    } as unknown as SessionStore["Service"]),
    Effect.provideService(AuthSessionRepository, {
      getById: () => Effect.succeedSome({ revokedAt: DateTime.nowUnsafe() }),
    } as unknown as AuthSessionRepository["Service"]),
  );
  yield* remote.sweep();
  return service;
});

it.effect.each([
  { host: "a desktop running in the background", desktopBackgroundRunning: true },
  { host: "a desktop that quits with its last window", desktopBackgroundRunning: false },
  {
    host: "a backend its desktop did not launch, in a shell with the desktop's old flag",
    desktopBackgroundRunning: undefined,
    environment: { SCIENT_DESKTOP_BACKGROUND_RUNNING: "true" },
  },
] as const)(
  "the start sweep on $host waits for the person only while Scient may run windowless",
  (host) =>
    Effect.gen(function* () {
      const { keychain, reads } = yield* recordingKeychain(host);
      const waits = host.desktopBackgroundRunning === true;
      const { leases, atWindow } = yield* windowLeases(true);

      // Accounts opened once and left empty: no senders are stored, so no sweep reads the keyring.
      const empty = memoryStore();
      yield* (yield* makeHarness({ storage: empty, keychain, leases })).service.snapshot;
      expect([...empty.blobs.keys()]).toContain("accounts-vault");
      expect([...empty.blobs.keys()]).not.toContain("accounts-state");
      reads.length = 0;
      yield* atWindow(false);
      yield* sweepAfterRestart(empty, keychain, leases);
      expect(reads).toEqual([]);

      // Stored accounts, and a desktop whose session here was revoked since.
      const storage = memoryStore();
      yield* atWindow(true);
      const before = yield* makeHarness({ storage, keychain, leases });
      yield* before.service.save(website());
      const sender = {
        source: MAC,
        label: "MacBook",
        keyHash: "synthetic-key-hash",
        sessionId: desktop.sessionId,
        seenAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* before.service.setRemoteSender(MAC, sender);
      reads.length = 0;
      yield* atWindow(false);
      const service = yield* sweepAfterRestart(storage, keychain, leases);
      // A store that could need the person stays closed with nobody at a window; otherwise the
      // sweep opens it and forgets the revoked desktop, as before background running.
      expect(reads).toHaveLength(waits ? 0 : 1);
      yield* atWindow(true);
      expect(yield* service.remoteSenders).toEqual(waits ? [sender] : []);
    }),
);
