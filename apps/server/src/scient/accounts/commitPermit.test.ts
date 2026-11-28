import { describe, expect, it } from "@effect/vitest";
import { BrowserProfileId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { makeHarness, memoryStore, syntheticValue, website } from "./Accounts.testkit.ts";
import type { AccountsServiceShape, ProfileStore } from "./AccountsService.ts";

const lab = BrowserProfileId.make("profile-lab");
const home = BrowserProfileId.make("profile-home");
const project = ProjectId.make("project-lab");
const agent = { threadId: ThreadId.make("thread-permit"), projectId: project };

const store = (overrides: Partial<ProfileStore> = {}): ProfileStore => ({
  desktop: true,
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

describe("each write checks, where it commits, that what it was decided on stands (round 6d)", () => {
  it.effect("keeps a merge's source while a tab opens in it, though the copy ended", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store());
      // A tab opens after the merge was decided, and is still opening as it settles.
      const opening = yield* Deferred.make<void>();
      const opened = yield* Deferred.make<void>();
      const tab = yield* service
        .admitProfileTab(
          lab,
          agent.threadId,
          Deferred.succeed(opening, undefined).pipe(Effect.andThen(Deferred.await(opened))),
        )
        .pipe(Effect.forkChild);
      const merged = (yield* service.operateProfile(
        { operationId: "op-merge", kind: "merge", profileId: lab, into: home },
        undefined,
        Effect.succeed([]),
      )).operation!;
      expect(merged.kind).toBe("merge");
      yield* Deferred.await(opening);
      yield* service.profileStoreDone({
        operationId: "op-merge",
        phase: "do",
        outcome: { state: "done", copied: 1 },
      });
      const settled = (yield* service.snapshot).profileOperations?.find(
        ({ operationId }) => operationId === "op-merge",
      );
      expect(settled?.retiredSource).toBeUndefined();
      expect(settled?.stopped).toBe("Its tabs are open: it was kept.");
      yield* Deferred.succeed(opened, undefined);
      yield* Fiber.join(tab);
    }),
  );

  it.effect("writes no login when the destination was turned Off while the cookies copied", () =>
    Effect.gen(function* () {
      const ref: { service?: AccountsServiceShape } = {};
      const { service } = yield* makeHarness();
      ref.service = service;
      yield* service.save({ ...website(), details: { ...website().details, profileId: lab } });
      yield* service.attachProfileStore(
        store({
          desktop: false,
          // The person turns Home Off while this server's browser copies.
          copy: (_from, _into, sites, keep) =>
            keep({ before: [], copied: [] }).pipe(
              Effect.andThen(
                ref.service!.setControls({
                  target: { type: "profile", profileId: home },
                  access: "off",
                }),
              ),
              Effect.as({ copied: 1, uncovered: [], sites: sites ?? [] }),
            ),
        }),
      );
      const copied = (yield* service.operateProfile(
        {
          operationId: "op-copy",
          kind: "copy",
          profileId: lab,
          into: home,
          sites: ["example.com"],
        },
        agent,
        [],
      )).operation!;
      expect(copied.rowsAdded).toBeUndefined();
      expect(copied.stopped).toBe("The profile changed since; nothing was done.");
    }),
  );

  it.effect("puts no password in when the profile was turned Off while they were read", () =>
    Effect.gen(function* () {
      const ref: { service?: AccountsServiceShape; armed: boolean } = { armed: false };
      const storage = memoryStore();
      const reading = {
        ...storage,
        // The first value read after the import starts: the person turns the profile Off then.
        store: ServerSecretStore.of({
          ...storage.store,
          get: (name) =>
            Effect.suspend(() =>
              ref.armed && name.startsWith("accounts-value-")
                ? ((ref.armed = false),
                  ref.service!.setControls({
                    target: { type: "profile", profileId: lab },
                    access: "off",
                  })).pipe(Effect.ignore, Effect.andThen(storage.store.get(name)))
                : storage.store.get(name),
            ),
        }),
      };
      const { service } = yield* makeHarness({ storage: reading });
      ref.service = service;
      yield* service.updateProfile({
        profileId: lab,
        source: {
          browser: "chrome",
          profileName: "Work",
          directory: "Profile 1",
          importedAt: "2026-11-26T00:00:00.000Z",
        },
      });
      yield* service.attachProfileStore(store());
      // A login there already, so the import reads its password before it writes.
      yield* service.save({
        ...website(),
        details: { kind: "website", sites: ["example.com"], username: "ada", profileId: lab },
      });
      yield* service.operateProfile(
        { operationId: "op-refresh", kind: "refresh", profileId: lab, passwords: true },
        agent,
        [],
      );
      ref.armed = true;
      const refused = yield* service
        .importPasswords({
          format: "auto",
          content: `name,url,username,password\nSite,https://example.com/login,ada,${syntheticValue()}\nNew,https://other.example/login,ada,${syntheticValue()}`,
          profileId: lab,
          origin: "browser",
          refresh: true,
          operationId: "op-refresh",
        })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("denied");
      expect((yield* service.snapshot).accounts).toHaveLength(1);
    }),
  );

  it.effect("refuses a desktop's Undo once the profile was cleared after it was asked for", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(store());
      yield* service.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: lab, site: "example.com" },
        undefined,
        [],
      );
      yield* service.profileStoreDone({
        operationId: "op-out",
        phase: "do",
        outcome: { state: "done", saved: 1 },
      });
      yield* service.undoProfileOperation("op-out", undefined);
      // Cleared before the desktop took the Undo up: its cookies would go into the new data.
      yield* service.operateProfile(
        { operationId: "op-clear", kind: "clear", profileId: lab },
        undefined,
        [],
      );
      expect(yield* service.claimProfileStore({ operationId: "op-out", phase: "undo" })).toEqual({
        ok: false,
        message: "It was cleared since; it can no longer be undone.",
      });
      const undone = (yield* service.snapshot).profileOperations?.find(
        ({ operationId }) => operationId === "op-out",
      )?.undone;
      expect(undone?.desktop).toEqual({ state: "failed" });
    }),
  );
});
