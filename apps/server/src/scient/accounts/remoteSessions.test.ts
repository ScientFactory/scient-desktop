import { describe, expect, it } from "@effect/vitest";
import {
  BrowserProfileId,
  EnvironmentId,
  type AccountSessionsReceiveInput,
  type SessionCookie,
} from "@t3tools/contracts";
import { unitCookies } from "@t3tools/shared/scientSessionCookies";
import { DateTime, Effect, Redacted } from "effect";

import { SessionStore } from "../../auth/SessionStore.ts";
import { ServerConfig } from "../../config.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { ServerBrowser } from "../../preview/ServerBrowser.ts";
import { makeHarness } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import { siteOf, type ProfileCookieJar } from "./profileCookieJar.ts";
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
  const hooks: { afterSet?: ((profileId: string) => void) | undefined } = {};
  const jarOf = (profileId: string) => jars.get(profileId) ?? [];
  const jar = (profileId: string): ProfileCookieJar => ({
    readAll: async () => jarOf(profileId),
    readUnit: async (unit) => unitCookies(unit, jarOf(profileId), siteOf),
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
    independent: { names: async () => [], pages: () => 1 },
  });
  const browser = {
    profileCookies: (profileId: string) => Effect.succeed(jar(profileId)),
    clearProfile: () => Effect.void,
  } as unknown as ServerBrowser["Service"];
  return { jars, tabs, hooks, browser };
}

const setup = Effect.fn("RemoteSessionsTest.setup")(function* (
  options: { active?: string[]; revoked?: string[] } = {},
) {
  const { service } = yield* makeHarness();
  const fixture = browserFixture();
  const active = new Set(options.active ?? [desktop.sessionId]);
  const revoked = new Set(options.revoked ?? []);
  const remote = yield* makeRemoteSessions.pipe(
    Effect.provideService(AccountsService, service),
    Effect.provideService(ServerBrowser, fixture.browser),
    Effect.provideService(ServerConfig, { devUrl: undefined } as ServerConfig["Service"]),
    Effect.provideService(SessionStore, {
      listActive: () => Effect.succeed([...active].map((sessionId) => ({ sessionId }))),
    } as unknown as SessionStore["Service"]),
    Effect.provideService(AuthSessionRepository, {
      getById: ({ sessionId }: { sessionId: string }) =>
        Effect.succeedSome({ revokedAt: revoked.has(sessionId) ? DateTime.nowUnsafe() : null }),
    } as unknown as AuthSessionRepository["Service"]),
  );
  return { ...fixture, active, revoked, remote, accounts: service };
});

const batch = (
  units: AccountSessionsReceiveInput["units"],
  overrides: Partial<AccountSessionsReceiveInput> = {},
): AccountSessionsReceiveInput => ({
  source: MAC,
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
      const applied = yield* remote.applied(desktop, { source: MAC, profileId: WORK });
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
      expect((yield* remote.applied(desktop, { source: MAC, profileId: WORK })).units).toEqual([]);
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
      expect((yield* remote.applied(desktop, { source: MAC, profileId: WORK })).units).toEqual([]);
    }),
  );

  it.effect(
    "binds the sender to its session, and lets another take over only after revocation",
    () =>
      Effect.gen(function* () {
        const { remote, active, accounts } = yield* setup();
        yield* remote.receive(desktop, batch([copy(1)]));
        const other = { sessionId: "session-other", subject: "desktop" };
        const refused = yield* remote.receive(other, batch([copy(2)])).pipe(Effect.flip);
        expect(refused.message).toBe("Another connection already sends as MacBook.");
        // Expired: the desktop's next session takes over and keeps the copies.
        active.delete(desktop.sessionId);
        expect(outcomes(yield* remote.receive(other, batch([copy(2)])))).toEqual(["same"]);
        const record = (yield* accounts.snapshot).profiles.find((p) => p.profileId === WORK);
        expect(record?.received?.map(({ sessionId }) => sessionId)).toEqual(["session-other"]);
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
      expect(yield* remote.withdraw(desktop, { source: MAC, all: true })).toEqual({ deleted: 1 });
      // A unit this computer kept with its own sign-in is its own; it stays.
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["synthetic-own"]);
      const received = (yield* accounts.snapshot).profiles.flatMap((p) => p.received ?? []);
      expect(received).toEqual([]);

      yield* remote.receive(desktop, batch([copy(2)]));
      revoked.add(desktop.sessionId);
      yield* remote.sweep();
      expect(jars.get(WORK)?.map(({ value }) => value)).toEqual(["synthetic-own"]);
    }),
  );

  it.effect("returns names and numbers only", () =>
    Effect.gen(function* () {
      const { remote } = yield* setup();
      const result = yield* remote.receive(desktop, batch([copy(1)]));
      const applied = yield* remote.applied(desktop, { source: MAC, profileId: WORK });
      const listed = yield* remote.list(WORK);
      for (const value of [result, applied, listed])
        expect(JSON.stringify(value)).not.toContain("synthetic-desktop");
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
