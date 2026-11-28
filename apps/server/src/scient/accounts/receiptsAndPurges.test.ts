import { describe, expect, it } from "@effect/vitest";
import { AccountsError, BrowserProfileId, ThreadId, type SessionCookie } from "@t3tools/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeHarness, memoryStore } from "./Accounts.testkit.ts";
import type { ProfileStore } from "./AccountsService.ts";

const lab = BrowserProfileId.make("profile-lab");
const home = BrowserProfileId.make("profile-home");

const store = (overrides: Partial<ProfileStore> = {}): ProfileStore => ({
  desktop: false,
  generations: () => Effect.void,
  closeProfile: () => Effect.void,
  signOut: (_profileId, _site, keep) =>
    (keep ? keep([]) : Effect.void).pipe(Effect.as({ cookies: [] })),
  restore: () => Effect.succeed({ restored: 0, refused: 0 }),
  copy: (_from, _into, sites, keep) =>
    keep({ before: [], copied: [] }).pipe(
      Effect.as({ copied: 1, uncovered: [], sites: sites ?? ["example.com"] }),
    ),
  restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
  purge: () => Effect.void,
  ...overrides,
});

describe("retries and purges keep every Undo the hour promises (round 6c, finding 6)", () => {
  it.effect("resumes this browser's part after a restart cut it short", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      const copying = yield* Deferred.make<void>();
      // The server stops while this browser copies.
      yield* first.service.attachProfileStore(
        store({
          copy: () => Deferred.succeed(copying, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );
      const running = yield* first.service
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: lab,
            into: home,
            sites: ["example.com"],
          },
          undefined,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(copying);
      yield* Fiber.interrupt(running);
      const pending = (yield* first.service.snapshot).profileOperations?.[0];
      expect(pending?.server).toEqual({ state: "pending" });
      // Started again: its store goes on with it, and the receipt ends.
      const second = yield* makeHarness({ storage });
      const copies: Array<string> = [];
      yield* second.service.attachProfileStore(
        store({
          copy: (from, into, sites, keep) =>
            keep({ before: [], copied: [] }).pipe(
              Effect.andThen(Effect.sync(() => copies.push(`${from}>${into}`))),
              Effect.as({ copied: 1, uncovered: [], sites: sites ?? [] }),
            ),
        }),
      );
      // Its first read loads Accounts and goes on with what was cut short.
      yield* second.service.snapshot;
      yield* TestClock.adjust("1 millis");
      const done = (yield* second.service.snapshot).profileOperations?.[0];
      expect(copies).toEqual([`${lab}>${home}`]);
      expect(done?.server).toEqual({ state: "done", copied: 1 });
      // The same id again is its receipt, not a second copy.
      yield* second.service.operateProfile(
        {
          operationId: "op-copy",
          kind: "copy",
          profileId: lab,
          into: home,
          sites: ["example.com"],
        },
        undefined,
        [],
      );
      expect(copies).toHaveLength(1);
    }),
  );

  it.effect("keeps every receipt still in its hour, however many there are", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      for (let index = 0; index < 205; index++)
        yield* service.operateProfile(
          {
            operationId: `op-${index}`,
            kind: "sign-out",
            profileId: lab,
            site: `s${index}.example`,
          },
          undefined,
          [],
        );
      expect((yield* service.snapshot).profileOperations).toHaveLength(205);
    }),
  );

  it.effect("tries a failed purge again until it is done", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      const attempts: Array<string> = [];
      let failing = true;
      const purging = store({
        purge: (profileId, generation) =>
          Effect.suspend(() => {
            attempts.push(`${profileId}:${generation ?? "all"}`);
            return failing
              ? Effect.fail(new AccountsError({ reason: "unavailable", message: "synthetic" }))
              : Effect.void;
          }),
      });
      yield* first.service.attachProfileStore(purging);
      yield* first.service.snapshot;
      yield* first.service.operateProfile(
        { operationId: "op-remove", kind: "remove", profileId: lab },
        undefined,
        [],
      );
      yield* TestClock.adjust("61 minutes");
      yield* first.service.purgeProfiles;
      expect(attempts).toEqual([`${lab}:all`]);
      // Authorized: Undo can't bring it back, and the desktop may empty its own copy.
      const removed = (yield* first.service.snapshot).profiles.find(
        ({ profileId }) => profileId === lab,
      )?.removed;
      expect(removed?.purgedAt).toBeDefined();
      // After a restart, the next pass tries it again, and then it is done.
      const second = yield* makeHarness({ storage });
      yield* second.service.attachProfileStore(purging);
      yield* second.service.snapshot;
      failing = false;
      yield* second.service.purgeProfiles;
      yield* second.service.purgeProfiles;
      expect(attempts).toEqual([`${lab}:all`, `${lab}:all`]);
    }),
  );
});

describe("a move cut short by a restart keeps every site's backup (round 6d)", () => {
  const session = (site: string, value: string): SessionCookie => ({
    name: "sid",
    value,
    domain: `.${site}`,
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expires: 4_000_000_000,
  });
  it.effect("resumes from what it sealed, and Undo signs the source back in to both sites", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const jar = new Map<string, SessionCookie[]>([
        [lab, [session("a.example", "a-session"), session("b.example", "b-session")]],
        [home, []],
      ]);
      const stopping = yield* Deferred.make<void>();
      let stopAt: string | undefined = "b.example";
      const restored: Array<string> = [];
      /** This server's browser over one in-memory jar per profile; it stops at `stopAt`. */
      const jars = (): ProfileStore =>
        store({
          copy: (from, into, sites, keep) =>
            Effect.gen(function* () {
              const copying = (jar.get(from) ?? []).filter((cookie) =>
                (sites ?? []).some((site) => cookie.domain === `.${site}`),
              );
              // What the destination holds under those cookies now, as the real store reads it.
              const under = (cookie: SessionCookie) =>
                copying.some((copy) => copy.name === cookie.name && copy.domain === cookie.domain);
              yield* keep({ before: (jar.get(into) ?? []).filter(under), copied: copying });
              jar.set(into, [...(jar.get(into) ?? []).filter((c) => !under(c)), ...copying]);
              return { copied: copying.length, uncovered: [], sites: sites ?? [] };
            }),
          signOut: (profileId, site, keep) =>
            site === stopAt
              ? Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.gen(function* () {
                  const cookies = (jar.get(profileId) ?? []).filter(
                    (cookie) => cookie.domain === `.${site}`,
                  );
                  if (keep) yield* keep(cookies);
                  jar.set(
                    profileId,
                    (jar.get(profileId) ?? []).filter((cookie) => !cookies.includes(cookie)),
                  );
                  return { cookies };
                }),
          restore: (_profileId, cookies) =>
            Effect.sync(() => {
              restored.push(...cookies.map(({ value }) => value));
              return { restored: cookies.length, refused: 0 };
            }),
        });
      const first = yield* makeHarness({ storage });
      yield* first.service.attachProfileStore(jars());
      const running = yield* first.service
        .operateProfile(
          {
            operationId: "op-move",
            kind: "move",
            profileId: lab,
            into: home,
            sites: ["a.example", "b.example"],
          },
          undefined,
          [],
        )
        .pipe(Effect.forkChild);
      // Signed out of a.example, its backup sealed; the server stops at b.example.
      yield* Deferred.await(stopping);
      yield* Fiber.interrupt(running);
      stopAt = undefined;
      const second = yield* makeHarness({ storage });
      yield* second.service.attachProfileStore(jars());
      yield* second.service.snapshot;
      yield* TestClock.adjust("1 millis");
      const done = (yield* second.service.snapshot).profileOperations?.[0];
      expect(done?.server?.state).toBe("done");
      yield* second.service.undoProfileOperation("op-move", undefined);
      // regression: the resumed run's seal for b.example replaced a.example's.
      expect(restored.toSorted()).toEqual(["a-session", "b-session"]);
    }),
  );
});

describe("a retried copy keeps that a cookie was absent before it (round 6e, new P1)", () => {
  it.effect("removes on Undo the session a copy cut short by a restart brought", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const sid: SessionCookie = {
        name: "sid",
        value: "lab-session",
        domain: ".example.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expires: 4_000_000_000,
      };
      // Home has no session for the site.
      const jar = new Map<string, SessionCookie[]>([
        [lab, [sid]],
        [home, []],
      ]);
      const stopping = yield* Deferred.make<void>();
      let stop = true;
      const undone: Array<{ copied: string[]; before: string[] }> = [];
      const jars = (): ProfileStore =>
        store({
          copy: (from, into, sites, keep) =>
            Effect.gen(function* () {
              const copying = jar.get(from) ?? [];
              const before = (jar.get(into) ?? []).filter((cookie) =>
                copying.some((copy) => copy.name === cookie.name),
              );
              yield* keep({ before, copied: copying });
              jar.set(into, [...copying]);
              // Written, then the app stopped before it reported.
              if (stop)
                return yield* Deferred.succeed(stopping, undefined).pipe(
                  Effect.andThen(Effect.never),
                );
              return { copied: copying.length, uncovered: [], sites: sites ?? [] };
            }),
          restoreInto: (_into, copied, before) =>
            Effect.sync(() => {
              undone.push({
                copied: copied.map(({ value }) => value),
                before: before.map(({ value }) => value),
              });
              return { restored: before.length, refused: 0 };
            }),
        });
      const first = yield* makeHarness({ storage });
      yield* first.service.attachProfileStore(jars());
      const running = yield* first.service
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: lab,
            into: home,
            sites: ["example.com"],
          },
          undefined,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(stopping);
      yield* Fiber.interrupt(running);
      stop = false;
      const second = yield* makeHarness({ storage });
      yield* second.service.attachProfileStore(jars());
      yield* second.service.snapshot;
      yield* TestClock.adjust("1 millis");
      expect((yield* second.service.snapshot).profileOperations?.[0]?.server?.state).toBe("done");
      yield* second.service.undoProfileOperation("op-copy", undefined);
      // regression: the retry sealed the copy as Home's "before", so Undo set it back.
      expect(undone).toEqual([{ copied: ["lab-session"], before: [] }]);
    }),
  );
});

describe("the Undo hour starts once the work has ended (round 6d)", () => {
  it.effect("gives a full hour after an offline desktop finally does its part", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store({ desktop: true }));
      yield* service.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: lab, site: "example.com" },
        undefined,
        [],
      );
      // The desktop was off for an hour and a half: the receipt is still there, pending.
      yield* TestClock.adjust("90 minutes");
      yield* service.purgeProfiles;
      expect((yield* service.snapshot).profileOperations?.[0]?.desktop).toEqual({
        state: "pending",
      });
      yield* service.profileStoreDone({
        operationId: "op-out",
        phase: "do",
        outcome: { state: "done", saved: 1 },
      });
      // Fifty minutes later, Undo still works: its hour began when the desktop was done.
      yield* TestClock.adjust("50 minutes");
      const undone = yield* service.undoProfileOperation("op-out", undefined);
      expect(undone.undone).toBeDefined();
    }),
  );
});

describe("a merge finished after a restart still sees the tabs open now (round 6e, row 1)", () => {
  it.effect("keeps its source when a tab is open in it, though the caller's lookup is gone", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      yield* first.service.attachProfileStore(store({ desktop: true }));
      yield* first.service.reportProfiles([
        { profileId: lab, name: "Lab" },
        { profileId: home, name: "Home" },
      ]);
      yield* first.service.operateProfile(
        { operationId: "op-merge", kind: "merge", profileId: lab, into: home },
        undefined,
        [],
      );
      // Restarted while the desktop's part was still under way; a chat opened a tab in Lab since.
      const second = yield* makeHarness({ storage });
      yield* second.service.attachProfileStore(
        store({
          desktop: true,
          openTabs: (profileId) =>
            Effect.succeed(profileId === lab ? [ThreadId.make("thread-open")] : []),
        }),
      );
      yield* second.service.snapshot;
      yield* second.service.profileStoreDone({
        operationId: "op-merge",
        phase: "do",
        outcome: { state: "done", copied: 1 },
      });
      const after = yield* second.service.snapshot;
      // regression: with the caller's lookup gone, Lab retired under the open tab.
      expect(after.profiles.find(({ profileId }) => profileId === lab)?.removed).toBeUndefined();
      expect(
        after.profileOperations?.find(({ operationId }) => operationId === "op-merge")?.stopped,
      ).toContain("tabs are open");
    }),
  );
});

describe("a retried copy never takes a cookie set since for its own write (round 6f)", () => {
  it.effect("stops a copy resumed over a cookie the destination got after its intent", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const sid = (value: string): SessionCookie => ({
        name: "sid",
        value,
        domain: ".example.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expires: 4_000_000_000,
      });
      const jar = new Map<string, SessionCookie[]>([
        [lab, [sid("lab-session")]],
        [home, []],
      ]);
      const stopping = yield* Deferred.make<void>();
      let stop = true;
      const jars = (): ProfileStore =>
        store({
          copy: (from, into, sites, keep) =>
            Effect.gen(function* () {
              const copying = jar.get(from) ?? [];
              const before = (jar.get(into) ?? []).filter((cookie) =>
                copying.some((copy) => copy.name === cookie.name),
              );
              yield* keep({ before, copied: copying });
              // Its intent kept; stopped before it wrote.
              if (stop)
                return yield* Deferred.succeed(stopping, undefined).pipe(
                  Effect.andThen(Effect.never),
                );
              jar.set(into, [...copying]);
              return { copied: copying.length, uncovered: [], sites: sites ?? [] };
            }),
        });
      const first = yield* makeHarness({ storage });
      yield* first.service.attachProfileStore(jars());
      const running = yield* first.service
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: lab,
            into: home,
            sites: ["example.com"],
          },
          undefined,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(stopping);
      yield* Fiber.interrupt(running);
      // The site signs Home in on its own meanwhile.
      jar.set(home, [sid("home-own")]);
      stop = false;
      const second = yield* makeHarness({ storage });
      yield* second.service.attachProfileStore(jars());
      yield* second.service.snapshot;
      yield* TestClock.adjust("1 millis");
      // regression: the retry sealed Home's own cookie as the copy's write, for Undo to remove.
      expect((yield* second.service.snapshot).profileOperations?.[0]?.server?.state).toBe("failed");
      expect(jar.get(home)?.map(({ value }) => value)).toEqual(["home-own"]);
    }),
  );
});

describe("a retried copy never overwrites a prior cookie changed since (round 6h, G)", () => {
  it.effect("stops when the destination's own cookie was replaced after the intent", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const sid = (value: string): SessionCookie => ({
        name: "sid",
        value,
        domain: ".example.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expires: 4_000_000_000,
      });
      const jar = new Map<string, SessionCookie[]>([
        [lab, [sid("lab-session")]],
        // Home had its own session before the copy.
        [home, [sid("home-old")]],
      ]);
      const stopping = yield* Deferred.make<void>();
      let stop = true;
      const jars = (): ProfileStore =>
        store({
          copy: (from, into, sites, keep) =>
            Effect.gen(function* () {
              const copying = jar.get(from) ?? [];
              const before = (jar.get(into) ?? []).filter((cookie) =>
                copying.some((copy) => copy.name === cookie.name),
              );
              yield* keep({ before, copied: copying });
              // Its intent kept; stopped before it wrote.
              if (stop)
                return yield* Deferred.succeed(stopping, undefined).pipe(
                  Effect.andThen(Effect.never),
                );
              jar.set(into, [...copying]);
              return { copied: copying.length, uncovered: [], sites: sites ?? [] };
            }),
        });
      const first = yield* makeHarness({ storage });
      yield* first.service.attachProfileStore(jars());
      const running = yield* first.service
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: lab,
            into: home,
            sites: ["example.com"],
          },
          undefined,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(stopping);
      yield* Fiber.interrupt(running);
      // The site signs Home in again after the copy's intent was kept.
      jar.set(home, [sid("home-own")]);
      stop = false;
      const second = yield* makeHarness({ storage });
      yield* second.service.attachProfileStore(jars());
      yield* second.service.snapshot;
      yield* TestClock.adjust("1 millis");
      // regression: the retry took Home's replaced cookie for its prior one and overwrote it.
      expect((yield* second.service.snapshot).profileOperations?.[0]?.server?.state).toBe("failed");
      expect(jar.get(home)?.map(({ value }) => value)).toEqual(["home-own"]);
    }),
  );
});

describe("a retried copy expects exactly its confirmed write there (round 6i, G)", () => {
  const sid = (value: string, expires = 4_000_000_000): SessionCookie => ({
    name: "sid",
    value,
    domain: ".example.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expires,
  });
  it.effect.each([
    // The site renews its cookie at the same value, with a later expiry.
    ["renewed", [sid("lab-session", 4_100_000_000)]],
    // The person signs Home out of the site.
    ["signed out", []],
  ] as const)("stops when the copied cookie was %s since", ([, since]) =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const jar = new Map<string, SessionCookie[]>([
        [lab, [sid("lab-session")]],
        [home, []],
      ]);
      const stopping = yield* Deferred.make<void>();
      let stop = true;
      let copies = 0;
      const jars = (): ProfileStore =>
        store({
          copy: (from, into, sites, keep, write) =>
            Effect.gen(function* () {
              const copying = jar.get(from) ?? [];
              const before = (jar.get(into) ?? []).filter((cookie) =>
                copying.some((copy) => copy.name === cookie.name),
              );
              yield* keep({ before, copied: copying });
              copies++;
              jar.set(into, [...copying]);
              // As this server's browser does: each cookie set, told while the jar is held.
              if (write?.wrote) yield* write.wrote(copying);
              return { copied: copying.length, uncovered: [], sites: sites ?? [] };
            }),
          // A move: the copy is written and confirmed, then a restart cuts the sign-out short.
          signOut: () =>
            stop
              ? Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed({ cookies: [] }),
        });
      const first = yield* makeHarness({ storage });
      yield* first.service.attachProfileStore(jars());
      const running = yield* first.service
        .operateProfile(
          {
            operationId: "op-move",
            kind: "move",
            profileId: lab,
            into: home,
            sites: ["example.com"],
          },
          undefined,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(stopping);
      yield* Fiber.interrupt(running);
      jar.set(home, [...since]);
      stop = false;
      const second = yield* makeHarness({ storage });
      yield* second.service.attachProfileStore(jars());
      yield* second.service.snapshot;
      yield* TestClock.adjust("1 millis");
      // regression: same value, or nothing there, passed for the copy's own write.
      expect((yield* second.service.snapshot).profileOperations?.[0]?.server?.state).toBe("failed");
      expect(copies).toBe(1);
      expect(jar.get(home)).toEqual(since);
    }),
  );
});

describe("a seal reads and writes Accounts under one permit (round 6j)", () => {
  it.effect("keeps a write that landed while the seal waited for the permit", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const cookie: SessionCookie = {
        name: "sid",
        value: "lab-session",
        domain: ".example.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expires: 4_000_000_000,
      };
      yield* service.attachProfileStore(
        store({
          copy: (_from, _into, sites, keep) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(gate);
              yield* keep({ before: [], copied: [cookie] });
              return { copied: 1, uncovered: [], sites: sites ?? [] };
            }),
        }),
      );
      yield* service.reportProfiles([
        { profileId: lab, name: "Lab" },
        { profileId: home, name: "Home" },
      ]);
      const copying = yield* service
        .operateProfile(
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: lab,
            into: home,
            sites: ["example.com"],
          },
          undefined,
          [],
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(reached);
      let revoking: Fiber.Fiber<unknown, AccountsError> | undefined;
      // Accounts busy: a revoke waits for the permit, then the seal does.
      yield* service.unlessSignedOutSince(
        { details: { kind: "website", sites: ["held.test"] } } as never,
        0,
        Effect.gen(function* () {
          revoking = yield* service
            .setControls({ target: { type: "profile", profileId: home }, access: "off" })
            .pipe(Effect.forkChild);
          for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
          yield* Deferred.succeed(gate, undefined);
          for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
        }),
      );
      yield* Fiber.join(revoking!);
      yield* Fiber.join(copying);
      const homeNow = (yield* service.snapshot).profiles.find(
        ({ profileId }) => profileId === home,
      );
      // regression: the seal wrote back the state it took before the permit, and Home was on again.
      expect(homeNow?.access).toBe("off");
    }),
  );

  it.effect("keeps a write that landed while a purge's record waited for the permit", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      yield* service.attachProfileStore(
        store({
          purge: () =>
            Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        }),
      );
      yield* service.reportProfiles([
        { profileId: lab, name: "Lab" },
        { profileId: home, name: "Home" },
      ]);
      yield* service.operateProfile(
        { operationId: "op-remove", kind: "remove", profileId: lab },
        undefined,
        [],
      );
      yield* TestClock.adjust("61 minutes");
      const purging = yield* service.purgeProfiles.pipe(Effect.forkChild);
      yield* Deferred.await(reached);
      let revoking: Fiber.Fiber<unknown, AccountsError> | undefined;
      yield* service.unlessSignedOutSince(
        { details: { kind: "website", sites: ["held.test"] } } as never,
        0,
        Effect.gen(function* () {
          revoking = yield* service
            .setControls({ target: { type: "profile", profileId: home }, access: "off" })
            .pipe(Effect.forkChild);
          for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
          yield* Deferred.succeed(gate, undefined);
          for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
        }),
      );
      yield* Fiber.join(revoking!);
      yield* Fiber.join(purging);
      const homeNow = (yield* service.snapshot).profiles.find(
        ({ profileId }) => profileId === home,
      );
      // regression: the purge's record wrote back the state it took before the permit.
      expect(homeNow?.access).toBe("off");
    }),
  );
});

describe("a profile its browser holds until a restart shows as unavailable (round 6l)", () => {
  it.effect("marks it in the snapshot, never in the stored record", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      yield* service.attachProfileStore(store({ unavailable: () => [lab] }));
      yield* service.reportProfiles([
        { profileId: lab, name: "Lab" },
        { profileId: home, name: "Home" },
      ]);
      const shown = (yield* service.snapshot).profiles.map(({ profileId, unavailable }) => [
        profileId,
        unavailable ?? false,
      ]);
      // regression: a quarantined profile looked ready, and its writes failed one by one.
      expect(shown).toContainEqual([lab, true]);
      expect(shown).toContainEqual([home, false]);
      // Opened again without that store: the mark was never kept.
      const again = yield* makeHarness({ storage });
      const stored = (yield* again.service.snapshot).profiles.find(
        ({ profileId }) => profileId === lab,
      );
      expect(stored?.unavailable).toBeUndefined();
    }),
  );
});

describe("a Clear of a fenced profile is refused, and leaves it as it is (round 6q)", () => {
  it.effect("moves it to no new generation and reports no success", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const closed: string[] = [];
      yield* service.attachProfileStore(
        store({
          unavailable: () => [lab],
          closeProfile: (profileId) => Effect.sync(() => void closed.push(profileId)),
        }),
      );
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      const before = (yield* service.snapshot).profiles.find(({ profileId }) => profileId === lab);
      const result = yield* service.operateProfile(
        { operationId: "op-clear-fenced", kind: "clear", profileId: lab },
        undefined,
        [],
      );
      // regression: it moved to a new generation and the server's part reported done.
      expect(result.refused?.message).toBe(
        "This profile is unavailable until the server restarts.",
      );
      expect(result.operation).toBeUndefined();
      expect(closed).toEqual([]);
      const after = (yield* service.snapshot).profiles.find(({ profileId }) => profileId === lab);
      expect(after?.generation).toBe(before?.generation);
      expect(after?.retained).toEqual(before?.retained);
      expect(after?.unavailable).toBe(true);
      expect((yield* service.snapshot).profileOperations ?? []).toEqual([]);
    }),
  );
});
