import { describe, expect, it } from "@effect/vitest";
import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  defaultBrowserProfileRecord,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { makeHarness, memoryStore } from "./Accounts.testkit.ts";
import { issueUnit, withShared } from "./sendLog.ts";

describe("the send log other computers follow", () => {
  const WORK = BrowserProfileId.make("profile-work");
  const row = (sites: string[], profileId = WORK) => ({
    name: sites[0]!,
    details: { kind: "website" as const, sites, profileId },
    secrets: {},
  });
  const shared = (environmentId: string, applied: number) => ({
    environmentId: EnvironmentId.make(environmentId),
    label: environmentId,
    applied,
    waiting: 0,
    needsYou: [],
  });

  it.effect("writes each action's revision in its own commit, and none for a look", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const log = (profileId = WORK) => service.profileSendLog(profileId);
      for (const profileId of [WORK, DEFAULT_BROWSER_PROFILE_ID])
        yield* service.profileShared(profileId, shared("lab", 0));
      const github = (yield* service.save(row(["github.com"]))).accountId;
      expect((yield* log()).head).toBe(0);
      // A look that sees the session working is not an action.
      yield* service.recordCheck(github, { state: "signed-in" });
      expect((yield* log()).head).toBe(0);
      yield* TestClock.adjust("1 minute");
      yield* service.recordUse({
        target: { type: "account", accountId: github },
        action: "sign-in",
        outcome: "ok",
        signInOutcome: "signed-in",
      });
      yield* Effect.yieldNow;
      yield* service.snapshot;
      expect(yield* log()).toEqual({
        head: 1,
        units: [{ sites: ["github.com"], revision: 1, kind: "copy" }],
      });
      expect(yield* service.profileSignedOut(WORK, "github.com")).toBe(2);
      expect(yield* service.profileResend(WORK)).toBe(3);
      expect(yield* log()).toEqual({
        head: 3,
        jar: 3,
        units: [{ sites: ["github.com"], revision: 2, kind: "delete" }],
      });
      yield* service.mainFilled({ accountId: github, profileName: "Work" });
      expect((yield* log(DEFAULT_BROWSER_PROFILE_ID)).units).toEqual([
        { sites: ["github.com"], revision: 1, kind: "copy" },
      ]);
      // Clients see only the head.
      const record = (yield* service.snapshot).profiles.find((p) => p.profileId === WORK);
      expect(record?.send).toEqual({ head: 3, units: [] });
    }),
  );

  it.effect("takes a revision for a sign-in action seen in a profile, none for an import", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.profileShared(WORK, shared("lab", 0));
      yield* service.sessionsSeen({
        profileId: WORK,
        sessions: [{ site: "overleaf.com", how: "imported", from: "Chrome · Person" }],
      });
      expect((yield* service.profileSendLog(WORK)).head).toBe(0);
      yield* TestClock.adjust("1 minute");
      yield* service.sessionsSeen({
        profileId: WORK,
        sessions: [{ site: "overleaf.com", how: "signed-in" }],
      });
      expect((yield* service.profileSendLog(WORK)).units).toEqual([
        { sites: ["overleaf.com"], revision: 1, kind: "copy" },
      ]);
    }),
  );

  it.effect("keeps a revision when its row is deleted, and across restarts", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      yield* first.service.profileShared(WORK, shared("lab", 0));
      const github = (yield* first.service.save(row(["github.com"]))).accountId;
      yield* first.service.profileSignedOut(WORK, "github.com");
      yield* first.service.remove(github);
      expect((yield* first.service.profileSendLog(WORK)).units).toHaveLength(1);
      const again = yield* makeHarness({ storage });
      expect(yield* again.service.profileResend(WORK)).toBe(2);
    }),
  );

  it.effect("keeps no entries while no other computer follows the profile", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.profileSignedOut(WORK, "github.com");
      expect(yield* service.profileResend(WORK)).toBe(2);
      // The revisions move, so a computer that links later is filled or reconciled whole.
      expect(yield* service.profileSendLog(WORK)).toEqual({ head: 2, jar: 2, units: [] });
    }),
  );

  it.effect("keeps a deletion until every computer it goes to applied it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.profileShared(WORK, shared("laptop", 0));
      yield* service.profileSignedOut(WORK, "github.com");
      yield* service.profileShared(WORK, shared("lab", 1));
      expect((yield* service.profileSendLog(WORK)).units).toHaveLength(1);
      yield* service.profileShared(WORK, shared("laptop", 1));
      expect((yield* service.profileSendLog(WORK)).units).toEqual([]);
    }),
  );

  it.effect(
    "withdraws a profile that turns restricted, and resends its jar when shared again",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const target = { type: "profile" as const, profileId: WORK };
        yield* service.setControls({ target, access: "off" });
        expect(yield* service.profileSendLog(WORK)).toEqual({ head: 1, withdrawn: 1, units: [] });
        yield* service.setControls({ target, access: "ask" });
        expect(yield* service.profileSendLog(WORK)).toEqual({
          head: 2,
          withdrawn: 1,
          jar: 2,
          units: [],
        });
      }),
  );
});

describe("deletions an offline computer still needs", () => {
  it("keeps every deletion past the copy bound, and forgets a computer only when unlinked", () => {
    const shared = (environmentId: string, applied: number) => ({
      environmentId: EnvironmentId.make(environmentId),
      label: environmentId,
      applied,
      waiting: 0,
      needsYou: [],
    });
    // The bound is 5,000 copies; 3 tells the same story.
    let log = issueUnit(undefined, ["signed-out.test"], "delete", 3);
    for (let index = 0; index < 4; index += 1)
      log = issueUnit(log, [`site${index}.test`], "copy", 3);
    // Past the bound, copies fall back to the whole jar; the deletion stays.
    expect(log.jar).toBe(log.head);
    expect(log.units).toEqual([{ sites: ["signed-out.test"], revision: 1, kind: "delete" }]);
    const record = { ...defaultBrowserProfileRecord(BrowserProfileId.make("work")), send: log };
    const offline = withShared(record, EnvironmentId.make("lab"), shared("lab", 0));
    const online = withShared(offline, EnvironmentId.make("laptop"), shared("laptop", log.head));
    expect(online.send?.units).toHaveLength(1);
    expect(withShared(online, EnvironmentId.make("lab"), undefined).send?.units).toEqual([]);
  });
});
