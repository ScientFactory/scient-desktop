import { describe, expect, it } from "@effect/vitest";
import { BrowserProfileId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { makeHarness } from "./Accounts.testkit.ts";
import type { ProfileStore } from "./AccountsService.ts";

const main = BrowserProfileId.make("default");
const lab = BrowserProfileId.make("profile-lab");
const store: ProfileStore = {
  desktop: false,
  generations: () => Effect.void,
  closeProfile: () => Effect.void,
  signOut: (_profileId, _site, keep) =>
    (keep ? keep([]) : Effect.void).pipe(Effect.as({ cookies: [] })),
  restore: () => Effect.succeed({ restored: 0, refused: 0 }),
  copy: (_from, _into, sites, keep) =>
    keep({ before: [], copied: [] }).pipe(
      Effect.as({ copied: 0, uncovered: ["bank.example"], sites: sites ?? [] }),
    ),
  restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
  purge: () => Effect.void,
};

describe("Main's sign-out has its hour of Undo too (round 6c, finding 9)", () => {
  it.effect("keeps the site out of Main's copies until Undo, as its own sign-out did", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store);
      yield* service.operateProfile(
        { operationId: "op-main", kind: "sign-out", profileId: main, site: "example.com" },
        undefined,
        [],
      );
      const signedOutSites = () =>
        Effect.map(
          service.snapshot,
          ({ profiles }) =>
            profiles.find(({ profileId }) => profileId === main)?.main?.signedOutSites ?? [],
        );
      expect(yield* signedOutSites()).toEqual(["example.com"]);
      yield* service.undoProfileOperation("op-main", undefined);
      expect(yield* signedOutSites()).toEqual([]);
    }),
  );

  it.effect("tells the computers a profile is sent to that it signed out", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store);
      yield* service.profileShared(lab, {
        environmentId: EnvironmentId.make("env-remote"),
        label: "Lab server",
        applied: 0,
        waiting: 0,
        needsYou: [],
      });
      yield* service.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: lab, site: "example.com" },
        undefined,
        [],
      );
      const log = yield* service.profileSendLog(lab);
      expect(log.units).toContainEqual(
        expect.objectContaining({ sites: ["example.com"], kind: "delete", revision: log.head }),
      );
    }),
  );
});

describe("an agent's sign-out stays on this computer (round 6h, D)", () => {
  it.effect("sends no delete to the computers the profile is shared with; the person's does", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store);
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      // Lab is sent to another computer.
      yield* service.profileShared(lab, {
        environmentId: EnvironmentId.make("env-remote"),
        label: "Lab server",
        applied: 0,
        waiting: 0,
        needsYou: [],
      });
      const agent = {
        threadId: ThreadId.make("thread-agent"),
        projectId: ProjectId.make("project-lab"),
      };
      yield* service.operateProfile(
        { operationId: "op-agent", kind: "sign-out", profileId: lab, site: "agent.example" },
        agent,
        [],
      );
      yield* service.operateProfile(
        { operationId: "op-person", kind: "sign-out", profileId: lab, site: "person.example" },
        undefined,
        [],
      );
      const deletes = (yield* service.profileSendLog(lab)).units.filter(
        ({ kind }) => kind === "delete",
      );
      // regression: the agent's sign-out cleared the receivers' jars, though no part went there.
      expect(deletes.map(({ sites }) => sites)).toEqual([["person.example"]]);
    }),
  );
});
