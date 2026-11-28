import { describe, expect, it } from "@effect/vitest";
import {
  BrowserProfileId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { Effect, Fiber, Stream } from "effect";
import { makeHarness, website } from "./Accounts.testkit.ts";
import type { ProfileStore } from "./AccountsService.ts";

const lab = BrowserProfileId.make("profile-lab");
const home = BrowserProfileId.make("profile-home");
const project = ProjectId.make("project-lab");

/** This server's browser, done at once; the desktop has its own part. */
const store: ProfileStore = {
  desktop: true,
  generations: () => Effect.void,
  closeProfile: () => Effect.void,
  signOut: () => Effect.succeed({ cookies: [] }),
  restore: () => Effect.succeed({ restored: 0, refused: 0 }),
  copy: (_from, _into, sites) =>
    Effect.succeed({ copied: 1, uncovered: [], sites: sites ?? ["example.com"] }),
  restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
  purge: () => Effect.void,
};

const copy = (operationId: string) => ({
  operationId,
  kind: "copy" as const,
  profileId: lab,
  into: home,
  sites: ["example.com"],
});

describe("a transfer never widens, decided or carried out (round 6c, finding 3)", () => {
  it.effect("counts a project approval the destination alone has", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      // Both Ask, for every project; Home is "Always in this project" for one of them.
      for (const profileId of [lab, home])
        yield* service.setControls({ target: { type: "profile", profileId }, access: "ask" });
      // The person answers an agent's ask in Home with "Always in this project".
      const asking = yield* service
        .authorize(
          { threadId: ThreadId.make("thread-ask"), projectId: project, unattended: false },
          { type: "profile", profileId: home },
          "open-profile",
        )
        .pipe(Effect.forkChild);
      const approval = yield* service.changes.pipe(
        Stream.filter((snapshot) => snapshot.approvals.length > 0),
        Stream.take(1),
        Stream.runCollect,
        Effect.map(([snapshot]) => snapshot!.approvals[0]!),
      );
      yield* service.respondApproval(approval.approvalId, "project");
      yield* Fiber.join(asking);
      expect(
        (yield* service.snapshot).profiles.find(({ profileId }) => profileId === home)
          ?.allowedProjects,
      ).toEqual([project]);
      const decided = yield* service.operateProfile(copy("op-wide"), undefined, []);
      expect(decided.refused?.reason).toBe("widens");
      // The other way round reaches no further.
      const back = yield* service.operateProfile(
        { ...copy("op-back"), profileId: home, into: lab },
        undefined,
        [],
      );
      expect(back.refused).toBeUndefined();
    }),
  );

  it.effect("stops the desktop's part when the destination changed after it was decided", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store);
      yield* service.reportProfiles([
        { profileId: lab, name: "Lab" },
        { profileId: home, name: "Home" },
      ]);
      yield* service.operateProfile(copy("op-copy"), undefined, []);
      // Home is sent to another computer now: its sign-ins would reach it.
      yield* service.profileShared(home, {
        environmentId: EnvironmentId.make("env-remote"),
        label: "Lab server",
        applied: 0,
        waiting: 0,
        needsYou: [],
      });
      const claimed = yield* service.claimProfileStore({
        operationId: "op-copy",
        phase: "do",
        computer: "env-laptop",
      });
      expect(claimed).toEqual({
        ok: false,
        message: "The profile changed since; nothing was done.",
      });
      const operation = (yield* service.snapshot).profileOperations?.find(
        ({ operationId }) => operationId === "op-copy",
      );
      expect(operation).toMatchObject({ desktop: { state: "failed" } });
    }),
  );

  it.effect("is carried out by one desktop only, which may ask again before it writes", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store);
      yield* service.operateProfile(copy("op-copy"), undefined, []);
      const claim = (computer: string) =>
        service.claimProfileStore({ operationId: "op-copy", phase: "do", computer });
      expect((yield* claim("env-laptop")).ok).toBe(true);
      expect(yield* claim("env-desk")).toEqual({
        ok: false,
        message: "Another desktop is carrying it out.",
      });
      expect((yield* claim("env-laptop")).ok).toBe(true);
    }),
  );

  it.effect("saves copied logins with their own controls in one commit", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore({ ...store, desktop: false });
      const { accountId } = yield* service.save({
        ...website(),
        details: { ...website().details, profileId: lab },
      });
      yield* service.setControls({
        target: { type: "account", accountId },
        access: "ask",
        scope: { type: "projects", projectIds: [project] },
      });
      const seen: Array<AccountsSnapshot> = [];
      const watching = yield* service.changes.pipe(
        Stream.runForEach((snapshot) => Effect.sync(() => seen.push(snapshot))),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* service.operateProfile(copy("op-copy"), undefined, []);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(watching);
      const copies = seen.flatMap(({ accounts }) =>
        accounts.filter(({ details }) => details.kind === "website" && details.profileId === home),
      );
      expect(copies.length).toBeGreaterThan(0);
      // Never published with the defaults, not even for a moment.
      expect(
        copies.every(
          ({ controls }) => controls.access === "ask" && controls.scope.type === "projects",
        ),
      ).toBe(true);
    }),
  );
});
