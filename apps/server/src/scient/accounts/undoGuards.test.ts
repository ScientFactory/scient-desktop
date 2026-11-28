import { describe, expect, it } from "@effect/vitest";
import { BrowserProfileId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import {
  makeHarness,
  memoryStore,
  secretEquals,
  syntheticValue,
  website,
} from "./Accounts.testkit.ts";
import type { ProfileStore } from "./AccountsService.ts";

const lab = BrowserProfileId.make("profile-lab");
const home = BrowserProfileId.make("profile-home");
const projectId = ProjectId.make("project-lab");
const mine = { threadId: ThreadId.make("thread-mine"), projectId };
const other = { threadId: ThreadId.make("thread-other"), projectId };

/** This server's browser, done at once. */
const store: ProfileStore = {
  desktop: false,
  generations: () => Effect.void,
  closeProfile: () => Effect.void,
  signOut: () => Effect.succeed({ cookies: [] }),
  restore: () => Effect.succeed({ restored: 0, refused: 0 }),
  copy: (_from, _into, sites) =>
    Effect.succeed({ copied: 1, uncovered: [], sites: sites ?? ["example.com"] }),
  restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
  purge: () => Effect.void,
};

describe("Undo stays within its grant and its data (round 6c, finding 2)", () => {
  it.effect("is an agent's only for its own chat's change, while it may still act there", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store);
      const clear = (operationId: string) =>
        service.operateProfile({ operationId, kind: "clear", profileId: lab }, mine, []);
      yield* clear("op-clear");
      const undo = (by: typeof mine) =>
        service.undoProfileOperation("op-clear", by).pipe(
          Effect.flip,
          Effect.map((e) => e.reason),
        );
      // Another chat can't, even in the same project.
      expect(yield* undo(other)).toBe("denied");
      // Off for agents since: the user undoes it.
      yield* service.setControls({ target: { type: "profile", profileId: lab }, access: "off" });
      expect(yield* undo(mine)).toBe("denied");
      yield* service.setControls({
        target: { type: "profile", profileId: lab },
        access: "allowed",
      });
      expect((yield* service.undoProfileOperation("op-clear", mine)).undone).toBeDefined();
    }),
  );

  it.effect("never undoes a refresh, under way or ended (round 6m)", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.updateProfile({
        profileId: lab,
        source: {
          browser: "chrome",
          profileName: "Work",
          directory: "Profile 1",
          importedAt: "2026-11-26T00:00:00.000Z",
        } as never,
      });
      yield* service.attachProfileStore({ ...store, desktop: true });
      yield* service.operateProfile(
        { operationId: "op-refresh", kind: "refresh", profileId: lab, cookies: true },
        undefined,
        [],
      );
      const undo = service.undoProfileOperation("op-refresh", undefined).pipe(Effect.flip);
      expect((yield* undo).reason).toBe("unsupported");
      yield* service.profileStoreDone({
        operationId: "op-refresh",
        phase: "do",
        outcome: { state: "done", copied: 2 },
      });
      expect((yield* undo).reason).toBe("unsupported");
    }),
  );

  it.effect("keeps a copied login the person edited since, and names it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store);
      yield* service.save({
        ...website(),
        name: "Lab login",
        details: { ...website().details, profileId: lab },
      });
      const copied = (yield* service.operateProfile(
        { operationId: "op-copy", kind: "copy", profileId: lab, into: home },
        undefined,
        [],
      )).operation!;
      expect(copied.rowsAdded).toHaveLength(1);
      // The person edits the copy in Home.
      yield* service.setControls({
        target: { type: "account", accountId: copied.rowsAdded![0]! },
        access: "ask",
      });
      const undone = yield* service.undoProfileOperation("op-copy", undefined);
      expect(undone.undone?.conflicts).toEqual(["Lab login"]);
      const rows = (yield* service.snapshot).accounts.filter(
        ({ details }) => details.kind === "website",
      );
      expect(rows).toHaveLength(2);
    }),
  );

  it.effect("never deletes a copy's value when its Undo couldn't be written", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      yield* service.attachProfileStore(store);
      const value = syntheticValue();
      yield* service.save({
        ...website(value),
        name: "Lab login",
        details: { ...website().details, profileId: lab },
      });
      const copied = (yield* service.operateProfile(
        { operationId: "op-copy", kind: "copy", profileId: lab, into: home },
        undefined,
        [],
      )).operation!;
      const copy = copied.rowsAdded![0]!;
      // The Undo's write fails: the copy stays, and so must its value.
      storage.failWritesTo("accounts-state");
      yield* service.undoProfileOperation("op-copy", undefined).pipe(Effect.ignore);
      storage.failWritesTo(undefined);
      const { service: reopened } = yield* makeHarness({ storage });
      const values = yield* reopened.resolveSecrets(copy, ["password"]);
      expect(secretEquals(values.password, value)).toBe(true);
    }),
  );

  it.effect("brings back a removed account only for the chat that removed it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      const row = (yield* service.snapshot).accounts.find((item) => item.accountId === accountId)!;
      const { removalId } = yield* service.agentRemove(accountId, row.updatedAt, mine);
      // Its receipt names the chat that removed it, for the Removed band (round 6c, 12).
      expect((yield* service.snapshot).removed?.[0]?.threadId).toBe(mine.threadId);
      expect(
        (yield* service.agentRestore(accountId, removalId, other).pipe(Effect.flip)).reason,
      ).toBe("denied");
      yield* service.agentRestore(accountId, removalId, mine);
      expect((yield* service.snapshot).accounts.some((item) => item.accountId === accountId)).toBe(
        true,
      );
      expect((yield* service.snapshot).changes).toContainEqual(
        expect.objectContaining({ change: "restore", threadId: mine.threadId }),
      );
      // A removal by the person is the person's to undo.
      const again = (yield* service.snapshot).accounts.find(
        (item) => item.accountId === accountId,
      )!;
      yield* service.remove(accountId, again.updatedAt);
      const theirs = (yield* service.snapshot).removed?.find(
        (entry) => entry.accountId === accountId,
      );
      expect(theirs).toBeDefined();
      expect(theirs?.threadId).toBeUndefined();
      expect(
        (yield* service.agentRestore(accountId, theirs!.removalId, mine).pipe(Effect.flip)).reason,
      ).toBe("denied");
    }),
  );
});
