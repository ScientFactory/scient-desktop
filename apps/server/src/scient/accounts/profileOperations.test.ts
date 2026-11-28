import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  AccountsError,
  BrowserProfileId,
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type PreviewEvent,
  type SessionCookie,
} from "@t3tools/contracts";
import { Effect, PubSub } from "effect";
import { TestClock } from "effect/testing";
import { makeHarness, memoryStore, website } from "./Accounts.testkit.ts";
import { AccountsService, type ProfileStore } from "./AccountsService.ts";
import { settleKeptOnClose } from "./agent/guardedSignIn.ts";

const lab = BrowserProfileId.make("profile-lab");
const chat = ThreadId.make("thread-lab");
const scope = { threadId: chat, projectId: ProjectId.make("project-lab"), unattended: false };
const cookie: SessionCookie = {
  name: "session",
  value: "synthetic-session-value",
  domain: ".example.com",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  session: false,
  expires: 2_000_000_000,
} as SessionCookie;

/** This server's browser, as fakes: what it was asked to do. */
const fakeStore = (
  options: {
    readonly failSignOut?: boolean;
    readonly desktop?: boolean;
    readonly uncovered?: ReadonlyArray<string>;
  } = {},
) => {
  const calls: Array<string> = [];
  const restored: Array<ReadonlyArray<SessionCookie>> = [];
  const store: ProfileStore = {
    desktop: options.desktop ?? true,
    copy: (from, into, sites, keep) =>
      // Sealed first, as the store does, then copied.
      keep({ before: [cookie], copied: [cookie] }).pipe(
        Effect.map(() => {
          calls.push(`copy:${from}>${into}:${sites?.join(",") ?? "all"}`);
          return {
            copied: 2,
            uncovered: options.uncovered ?? [],
            sites: sites ?? ["example.com"],
          };
        }),
      ),
    restoreInto: (into, copied, before) =>
      Effect.sync(() => {
        calls.push(`restore-into:${into}:${copied.length}:${before.length}`);
        return { restored: before.length, refused: 0 };
      }),
    generations: (map) =>
      Effect.sync(() => void calls.push(`generations:${JSON.stringify([...map])}`)),
    closeProfile: (profileId) => Effect.sync(() => void calls.push(`close:${profileId}`)),
    signOut: (profileId, site, keep) =>
      options.failSignOut
        ? Effect.fail(new AccountsError({ reason: "unavailable", message: "synthetic failure" }))
        : // Sealed for Undo first, as the store does, then removed.
          (keep ? keep([cookie]) : Effect.void).pipe(
            Effect.map(() => {
              calls.push(`sign-out:${profileId}:${site}`);
              return { cookies: [cookie] };
            }),
          ),
    restore: (_profileId, cookies) =>
      Effect.sync(() => {
        restored.push(cookies);
        return { restored: cookies.length, refused: 0 };
      }),
    purge: (profileId, generation) =>
      Effect.sync(() => void calls.push(`purge:${profileId}:${generation ?? "all"}`)),
  };
  return { store, calls, restored };
};

const signedInRow = (profileId: BrowserProfileId) => ({
  ...website(),
  details: { kind: "website" as const, sites: ["example.com"], username: "ada", profileId },
});

describe("A profile's Remove, Clear and sign-out, with Undo", () => {
  it.effect(
    "removes by hiding it, refuses Main and open tabs, and brings it back after a restart",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const { service } = yield* makeHarness({ storage });
        yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
        const operate = (
          kind: "remove" | "clear" | "sign-out",
          operationId: string,
          openIn: ThreadId[] = [],
        ) => service.operateProfile({ operationId, kind, profileId: lab }, undefined, openIn);
        expect(
          (yield* service.operateProfile(
            { operationId: "op-main", kind: "remove", profileId: BrowserProfileId.make("default") },
            undefined,
            [],
          )).refused?.reason,
        ).toBe("not-allowed");
        // A chat has a tab open in it: nothing changes, and the chat is named.
        expect((yield* operate("remove", "op-open", [chat])).refused).toEqual({
          reason: "open-tabs",
          message: "Close its tabs first.",
          threadIds: [chat],
        });
        const removed = (yield* operate("remove", "op-remove")).operation!;
        expect(removed).toMatchObject({ kind: "remove", name: "Lab", server: { state: "done" } });
        // A retry with the same id is the same receipt; nothing is removed twice.
        expect((yield* operate("remove", "op-remove")).operation).toEqual(removed);
        // Gone for agents, even an older client still listing it.
        expect(
          (yield* service.forSession(scope, [lab])).profiles.some(
            ({ profileId }) => profileId === lab,
          ),
        ).toBe(false);
        expect((yield* service.snapshot).profileOperations).toEqual([removed]);
        const restarted = yield* makeHarness({ storage });
        const undone = yield* restarted.service.undoProfileOperation("op-remove", undefined);
        expect(undone.undone).toBeDefined();
        const record = (yield* restarted.service.snapshot).profiles.find(
          ({ profileId }) => profileId === lab,
        );
        expect(record?.removed).toBeUndefined();
        expect(record?.name).toBe("Lab");
      }),
  );

  it.effect("purges a removed profile after the hour, and Undo then can't bring it back", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { store, calls } = fakeStore();
      yield* service.attachProfileStore(store);
      yield* service.save(signedInRow(lab));
      yield* service.operateProfile(
        { operationId: "op-remove", kind: "remove", profileId: lab },
        undefined,
        [],
      );
      yield* service.purgeProfiles;
      expect(calls.filter((call) => call.startsWith("purge"))).toEqual([]);
      yield* TestClock.adjust("61 minutes");
      yield* service.purgeProfiles;
      expect(calls.filter((call) => call.startsWith("purge"))).toEqual([`purge:${lab}:all`]);
      const snapshot = yield* service.snapshot;
      expect(
        snapshot.profiles.find(({ profileId }) => profileId === lab)?.removed?.purgedAt,
      ).toBeDefined();
      // Its sign-ins went with it; a saved password stays, free of the profile.
      expect(
        snapshot.accounts.map(({ details }) => "profileId" in details && details.profileId),
      ).toEqual([false]);
      expect(
        (yield* service.undoProfileOperation("op-remove", undefined).pipe(Effect.flip)).reason,
      ).toBe("not-found");
    }),
  );

  it.effect("clears into a new generation, and Undo goes back, listing sign-ins made since", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { store, calls } = fakeStore();
      yield* service.attachProfileStore(store);
      const cleared = (yield* service.operateProfile(
        { operationId: "op-clear", kind: "clear", profileId: lab },
        undefined,
        // Open tabs don't stop a Clear: they reload in the new generation.
        [chat],
      )).operation!;
      expect(cleared).toMatchObject({ from: 0, to: 1, server: { state: "done" } });
      // The new generation first, then its tabs reopen there (round 6c, 13).
      expect(calls.slice(-2)).toEqual([
        `generations:${JSON.stringify([[lab, 1]])}`,
        `close:${lab}`,
      ]);
      // Someone signs in in the new generation, then the person undoes the Clear.
      yield* TestClock.adjust("1 minute");
      const { accountId } = yield* service.save(signedInRow(lab));
      yield* service.recordUse({
        target: { type: "account", accountId },
        action: "sign-in",
        outcome: "ok",
        signInOutcome: "signed-in",
      });
      yield* TestClock.adjust("1 second");
      const undone = yield* service.undoProfileOperation("op-clear", undefined);
      expect(undone.undone).toMatchObject({
        conflicts: ["Synthetic website"],
        server: { state: "done" },
      });
      const record = (yield* service.snapshot).profiles.find(({ profileId }) => profileId === lab)!;
      expect(record.generation).toBe(0);
      // Both are kept: the new generation waits out its own hour.
      expect(record.retained?.map(({ generation }) => generation)).toEqual([1]);
      yield* TestClock.adjust("61 minutes");
      yield* service.purgeProfiles;
      expect(calls).toContain(`purge:${lab}:1`);
    }),
  );

  it.effect("keeps a site's cookies on sign-out, and Undo sets them back", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { store, calls, restored } = fakeStore();
      yield* service.attachProfileStore(store);
      const signedOut = (yield* service.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: lab, site: "example.com" },
        undefined,
        [],
      )).operation!;
      expect(calls).toContain(`sign-out:${lab}:example.com`);
      expect(signedOut).toMatchObject({
        server: { state: "done", saved: 1 },
        // The desktop's partitions take part too: its window carries that out.
        desktop: { state: "pending" },
      });
      expect((yield* service.signedOut).map(({ site }) => site)).toEqual(["example.com"]);
      // The desktop's part ends first: Undo waits for it.
      yield* service.profileStoreDone({
        operationId: "op-out",
        phase: "do",
        outcome: { state: "done", saved: 1 },
      });
      const undone = yield* service.undoProfileOperation("op-out", undefined);
      expect(restored.map((cookies) => cookies.map(({ name, value }) => [name, value]))).toEqual([
        [["session", "synthetic-session-value"]],
      ]);
      expect(undone.undone).toMatchObject({
        server: { state: "done", restored: 1, refused: 0 },
        desktop: { state: "pending" },
      });
      expect(yield* service.signedOut).toEqual([]);
      yield* service.profileStoreDone({
        operationId: "op-out",
        phase: "undo",
        outcome: { state: "done", restored: 2, refused: 0 },
      });
      expect((yield* service.snapshot).profileOperations?.[0]?.undone?.desktop).toEqual({
        state: "done",
        restored: 2,
        refused: 0,
      });
    }),
  );

  it.effect("records a store that failed, and leaves the rest of the operation as it is", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { store } = fakeStore({ failSignOut: true });
      yield* service.attachProfileStore(store);
      const signedOut = (yield* service.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: lab, site: "example.com" },
        undefined,
        [],
      )).operation!;
      expect(signedOut.server).toEqual({ state: "failed" });
      expect(signedOut.desktop).toEqual({ state: "pending" });
      // The desktop's part ends first: Undo waits for it.
      yield* service.profileStoreDone({
        operationId: "op-out",
        phase: "do",
        outcome: { state: "done", saved: 1 },
      });
      // Undo has no cookies of this server's to set back, only the desktop's part.
      const undone = yield* service.undoProfileOperation("op-out", undefined);
      expect(undone.undone?.server).toBeUndefined();
      expect(undone.undone?.desktop).toEqual({ state: "pending" });
    }),
  );

  it.effect("an agent's operation is its own, recorded, and refused on an Off profile", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const by = { threadId: chat, projectId: scope.projectId };
      yield* service.setControls({ target: { type: "profile", profileId: lab }, access: "off" });
      expect(
        (yield* service
          .operateProfile({ operationId: "op-agent", kind: "clear", profileId: lab }, by, [])
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      yield* service.setControls({
        target: { type: "profile", profileId: lab },
        access: "allowed",
      });
      yield* service.operateProfile(
        { operationId: "op-agent", kind: "clear", profileId: lab },
        by,
        [],
      );
      expect((yield* service.snapshot).changes).toEqual([
        expect.objectContaining({ change: "clear", threadId: chat }),
      ]);
      expect(AccountId.make("acc_synthetic01")).toBeTruthy();
    }),
  );

  it.effect("copies a profile's sites and logins, refuses to widen, and Undo takes it back", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { store, calls } = fakeStore();
      yield* service.attachProfileStore(store);
      const home = BrowserProfileId.make("profile-home");
      yield* service.save(signedInRow(lab));
      // Lab is for one project; Home for all: copying would widen where its sign-ins go.
      yield* service.setControls({
        target: { type: "profile", profileId: lab },
        scope: { type: "projects", projectIds: [scope.projectId] },
      });
      const widening = yield* service.operateProfile(
        {
          operationId: "op-wide",
          kind: "copy",
          profileId: lab,
          into: home,
          sites: ["example.com"],
        },
        undefined,
        [],
      );
      expect(widening.refused?.reason).toBe("widens");
      yield* service.setControls({
        target: { type: "profile", profileId: home },
        scope: { type: "projects", projectIds: [scope.projectId] },
      });
      const copied = (yield* service.operateProfile(
        {
          operationId: "op-copy",
          kind: "copy",
          profileId: lab,
          into: home,
          sites: ["example.com"],
        },
        undefined,
        [],
      )).operation!;
      expect(calls).toContain(`copy:${lab}>${home}:example.com`);
      expect(copied).toMatchObject({ server: { state: "done", copied: 2 }, into: home });
      expect(copied.rowsAdded).toHaveLength(1);
      const rows = () =>
        Effect.map(service.snapshot, ({ accounts }) =>
          accounts.map(({ details }) => ("profileId" in details ? details.profileId : undefined)),
        );
      expect((yield* rows()).toSorted()).toEqual([home, lab]);
      yield* service.profileStoreDone({
        operationId: "op-copy",
        phase: "do",
        outcome: { state: "done", copied: 2 },
      });
      const undone = yield* service.undoProfileOperation("op-copy", undefined);
      expect(calls).toContain(`restore-into:${home}:1:1`);
      expect(undone.undone?.server).toMatchObject({ state: "done", restored: 1 });
      expect(yield* rows()).toEqual([lab]);
    }),
  );

  it.effect("merges: the source goes only once every site and store came over", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const home = BrowserProfileId.make("profile-home");
      const { store } = fakeStore({ desktop: true });
      yield* service.attachProfileStore(store);
      const merged = (yield* service.operateProfile(
        { operationId: "op-merge", kind: "merge", profileId: lab, into: home },
        undefined,
        [],
      )).operation!;
      // The desktop hasn't copied its part yet: the source is kept.
      expect(merged.retiredSource).toBeUndefined();
      yield* service.profileStoreDone({
        operationId: "op-merge",
        phase: "do",
        outcome: { state: "done", copied: 3 },
      });
      const record = () =>
        Effect.map(service.snapshot, ({ profiles }) =>
          profiles.find(({ profileId }) => profileId === lab),
        );
      expect((yield* record())?.removed?.operationId).toBe("op-merge");
      // Undo brings the source back.
      yield* service.undoProfileOperation("op-merge", undefined);
      expect((yield* record())?.removed).toBeUndefined();
      // A site that couldn't be copied: copied, source kept, the site named.
      const partial = yield* makeHarness();
      yield* partial.service.attachProfileStore(
        fakeStore({ desktop: false, uncovered: ["bank.example"] }).store,
      );
      const kept = (yield* partial.service.operateProfile(
        { operationId: "op-partial", kind: "merge", profileId: lab, into: home },
        undefined,
        [],
      )).operation!;
      expect(kept).toMatchObject({ uncovered: ["bank.example"] });
      expect(kept.retiredSource).toBeUndefined();
    }),
  );

  it.effect("moves: the source is signed out of what it copied, and Undo signs it back in", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const home = BrowserProfileId.make("profile-home");
      const { store, calls, restored } = fakeStore({ desktop: false });
      yield* service.attachProfileStore(store);
      yield* service.operateProfile(
        {
          operationId: "op-move",
          kind: "move",
          profileId: lab,
          into: home,
          sites: ["example.com"],
        },
        undefined,
        [],
      );
      expect(calls).toContain(`sign-out:${lab}:example.com`);
      expect((yield* service.signedOut).map(({ profileId }) => profileId)).toEqual([lab]);
      yield* service.undoProfileOperation("op-move", undefined);
      expect(restored.flat().map(({ name }) => name)).toEqual(["session"]);
      expect(yield* service.signedOut).toEqual([]);
    }),
  );

  it.effect("folds into Main only when Main reaches no further than the profile", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.setControls({
        target: { type: "profile", profileId: lab },
        scope: { type: "projects", projectIds: [scope.projectId] },
      });
      const folded = yield* service.operateProfile(
        { operationId: "op-fold", kind: "fold", profileId: lab },
        undefined,
        [],
      );
      expect(folded.refused?.reason).toBe("widens");
      // Main can't be folded or merged away itself.
      expect(
        (yield* service.operateProfile(
          {
            operationId: "op-main",
            kind: "merge",
            profileId: BrowserProfileId.make("default"),
            into: lab,
          },
          undefined,
          [],
        )).refused?.reason,
      ).toBe("not-allowed");
    }),
  );

  it.effect("refreshes from the linked browser on this desktop only, with no Undo (round 6m)", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const refresh = (operationId: string, extra: object = {}) =>
        service.operateProfile(
          { operationId, kind: "refresh", profileId: lab, cookies: true, ...extra },
          { threadId: chat, projectId: scope.projectId },
          [],
        );
      // Not linked: the user imports it first. Sources are found by their link only.
      expect((yield* refresh("op-unlinked")).refused?.reason).toBe("not-allowed");
      yield* service.updateProfile({
        profileId: lab,
        source: {
          browser: "chrome",
          profileName: "Person",
          directory: "Profile 1",
          importedAt: "2026-11-26T00:00:00.000Z",
        } as never,
      });
      // No desktop here: the browser is read where it is.
      yield* service.attachProfileStore(fakeStore({ desktop: false }).store);
      expect((yield* refresh("op-elsewhere")).refused?.message).toMatch(/refresh it there/);
      const desktop = yield* makeHarness();
      yield* desktop.service.updateProfile({
        profileId: lab,
        source: {
          browser: "chrome",
          profileName: "Person",
          directory: "Profile 1",
          importedAt: "2026-11-26T00:00:00.000Z",
        } as never,
      });
      yield* desktop.service.attachProfileStore(fakeStore({ desktop: true }).store);
      // Sign-ins and passwords are explicit choices.
      expect(
        (yield* desktop.service
          .operateProfile(
            { operationId: "op-none", kind: "refresh", profileId: lab },
            { threadId: chat, projectId: scope.projectId },
            [],
          )
          .pipe(Effect.flip)).reason,
      ).toBe("invalid-input");
      const started = (yield* desktop.service.operateProfile(
        {
          operationId: "op-refresh",
          kind: "refresh",
          profileId: lab,
          cookies: true,
          passwords: true,
        },
        { threadId: chat, projectId: scope.projectId },
        [],
      )).operation!;
      // The agent's call returns at once; this desktop's window carries it out.
      expect(started).toMatchObject({
        cookies: true,
        passwords: true,
        desktop: { state: "pending" },
      });
      yield* desktop.service.profileStoreDone({
        operationId: "op-refresh",
        phase: "do",
        outcome: { state: "done", copied: 4, saved: 9 },
      });
      // regression (6m): a refresh's Undo restored cookies a page or sign-out had changed since.
      const undone = yield* desktop.service
        .undoProfileOperation("op-refresh", undefined)
        .pipe(Effect.flip);
      expect(undone.reason).toBe("unsupported");
    }),
  );

  it.effect("a sign-in kept in a tab that closed no longer holds its profile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
        const tabId = PreviewTabId.make("tab-kept");
        const accountId = AccountId.make("acc_kept_in_tab");
        yield* service.setAttempt({
          attemptId: "attempt-kept",
          threadId: chat,
          tabId,
          accountId,
          state: "pending",
          profileId: lab,
        });
        const { pending } = yield* service.signInAttempts;
        pending.set("kept", {
          attemptId: "attempt-kept",
          accountId,
          tabId,
          invocation: {
            ...scope,
            environmentId: EnvironmentId.make("env-lab"),
            providerSessionId: "session-lab",
            providerInstanceId: ProviderInstanceId.make("scient"),
            capabilities: new Set(),
            issuedAt: 0,
          },
          // A code the site may still have: nothing but the person or the tab's end settles it.
          submissions: [
            {
              origin: "https://example.com",
              fields: ["otp"],
              otpPeriod: undefined,
              unanswered: true,
            },
          ],
        });
        const remove = (operationId: string) =>
          service.operateProfile({ operationId, kind: "remove", profileId: lab }, undefined, []);
        expect((yield* remove("op-held")).refused?.reason).toBe("signing-in");
        const events = yield* PubSub.unbounded<PreviewEvent>();
        yield* settleKeptOnClose(yield* PubSub.subscribe(events)).pipe(
          Effect.provideService(AccountsService, service),
          Effect.forkScoped,
        );
        // regression: closing the tab left the attempt's record, and the profile stayed held.
        yield* PubSub.publish(events, {
          type: "closed",
          threadId: chat,
          tabId,
          createdAt: "2026-11-27T00:00:00.000Z",
          serverEpoch: "epoch-lab",
          revision: 1,
        });
        yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => pending.size === 0, times: 100 }));
        expect(pending.size).toBe(0);
        expect(yield* service.attempts).toEqual([]);
        expect((yield* remove("op-after")).refused).toBeUndefined();
      }),
    ),
  );
});
