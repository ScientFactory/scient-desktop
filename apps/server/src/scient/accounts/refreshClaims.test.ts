import { describe, expect, it } from "@effect/vitest";
import { BrowserProfileId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { makeHarness, syntheticValue } from "./Accounts.testkit.ts";
import type { ProfileStore } from "./AccountsService.ts";

const lab = BrowserProfileId.make("profile-lab");
const project = ProjectId.make("project-lab");
const agent = { threadId: ThreadId.make("thread-refresh"), projectId: project };
const laptop = { id: "env-laptop", label: "Ada's laptop" };

/** The laptop's own server: its window does the desktop's part. */
const laptopStore: ProfileStore = {
  desktop: true,
  computer: laptop,
  generations: () => Effect.void,
  closeProfile: () => Effect.void,
  signOut: (_profileId, _site, keep) =>
    (keep ? keep([]) : Effect.void).pipe(Effect.as({ cookies: [] })),
  restore: () => Effect.succeed({ restored: 0, refused: 0 }),
  copy: (_from, _into, sites, keep) =>
    keep({ before: [], copied: [] }).pipe(
      Effect.as({ copied: 0, uncovered: [], sites: sites ?? [] }),
    ),
  restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
  purge: () => Effect.void,
};
const linked = {
  profileId: lab,
  source: {
    browser: "chrome",
    profileName: "Work",
    directory: "Profile 1",
    importedAt: "2026-11-26T00:00:00.000Z",
  },
} as never;
const csv = `name,url,username,password\nSite,https://example.com/login,ada,${syntheticValue()}`;

describe("a refresh runs on its desktop, only while it stands (round 6c, finding 5)", () => {
  it.effect("names this desktop on every desktop part, so another desktop never does it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopStore);
      yield* service.updateProfile(linked);
      const refresh = (yield* service.operateProfile(
        { operationId: "op-refresh", kind: "refresh", profileId: lab, cookies: true },
        undefined,
        [],
      )).operation!;
      const signOut = (yield* service.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: lab, site: "example.com" },
        undefined,
        [],
      )).operation!;
      for (const operation of [refresh, signOut]) {
        expect(operation.computer).toEqual(laptop);
        // A second desktop linked to this computer watches it too: it is refused.
        expect(
          yield* service.claimProfileStore({
            operationId: operation.operationId,
            phase: "do",
            computer: "env-desk",
          }),
        ).toEqual({ ok: false, message: "It is for Ada's laptop." });
        expect(
          (yield* service.claimProfileStore({
            operationId: operation.operationId,
            phase: "do",
            computer: laptop.id,
          })).ok,
        ).toBe(true);
      }
    }),
  );

  it.effect("stops when the profile is removed or turned off while the OS asks", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopStore);
      yield* service.updateProfile(linked);
      yield* service.operateProfile(
        { operationId: "op-refresh", kind: "refresh", profileId: lab, passwords: true },
        agent,
        [],
      );
      const claim = service.claimProfileStore({
        operationId: "op-refresh",
        phase: "do",
        computer: laptop.id,
      });
      expect((yield* claim).ok).toBe(true);
      // The person turns the profile Off while Chrome's prompt is open.
      yield* service.setControls({ target: { type: "profile", profileId: lab }, access: "off" });
      // The passwords it then read are refused, and so is its next claim before cookies are kept.
      const refused = yield* service
        .importPasswords({
          format: "auto",
          content: csv,
          profileId: lab,
          origin: "browser",
          refresh: true,
          operationId: "op-refresh",
        })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("denied");
      expect((yield* service.snapshot).accounts).toEqual([]);
      expect((yield* claim).ok).toBe(false);
    }),
  );

  it.effect("saves the logins an agent's import brings no wider than the profile", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopStore);
      yield* service.updateProfile(linked);
      yield* service.setControls({
        target: { type: "profile", profileId: lab },
        access: "ask",
        scope: { type: "projects", projectIds: [project] },
      });
      yield* service.operateProfile(
        { operationId: "op-refresh", kind: "refresh", profileId: lab, passwords: true },
        agent,
        [],
      );
      expect(
        yield* service.importPasswords({
          format: "auto",
          content: csv,
          profileId: lab,
          origin: "browser",
          refresh: true,
          operationId: "op-refresh",
        }),
      ).toMatchObject({ created: 1 });
      const [login] = (yield* service.snapshot).accounts;
      expect(login?.controls).toMatchObject({
        access: "ask",
        scope: { type: "projects", projectIds: [project] },
      });
    }),
  );
});

describe("a sign-out reaches every desktop's own jar (round 6d, verdict 3)", () => {
  it.effect("signs each desktop on now out, ends once all have, and Undo reaches each", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const desk = { id: "env-desk", label: "Lab desk" };
      yield* service.attachProfileStore({ ...laptopStore, computer: desk });
      // The laptop is on too, linked to this computer, with its own jar of the profile.
      yield* service.reportProfiles([], { computer: laptop, sources: [] });
      const out = (yield* service.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: lab, site: "example.com" },
        undefined,
        [],
      )).operation!;
      expect(out.computer).toEqual(desk);
      expect(out.others).toEqual([{ computer: laptop, outcome: { state: "pending" } }]);
      // The desk has signed its own jar out; the laptop not yet: it hasn't ended.
      yield* service.profileStoreDone({
        operationId: "op-out",
        phase: "do",
        outcome: { state: "done", saved: 1 },
      });
      expect(
        (yield* service.undoProfileOperation("op-out", undefined).pipe(Effect.flip)).reason,
      ).toBe("conflict");
      // The laptop's part is its own: it claims it and says how it went.
      expect(
        (yield* service.claimProfileStore({
          operationId: "op-out",
          phase: "do",
          computer: laptop.id,
        })).ok,
      ).toBe(true);
      yield* service.profileStoreDone({
        operationId: "op-out",
        phase: "do",
        computer: laptop.id,
        outcome: { state: "done", saved: 2 },
      });
      const undone = yield* service.undoProfileOperation("op-out", undefined);
      expect(undone.undone?.desktop).toEqual({ state: "pending" });
      expect(undone.undone?.others).toEqual([{ computer: laptop, outcome: { state: "pending" } }]);
    }),
  );
});

describe("each desktop claims its own part (round 6e, new P1)", () => {
  it.effect(
    "lets the desk and the laptop each carry out their part of a sign-out and its Undo",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const desk = { id: "env-desk", label: "Lab desk" };
        yield* service.attachProfileStore({ ...laptopStore, computer: desk });
        yield* service.reportProfiles([], { computer: laptop, sources: [] });
        yield* service.operateProfile(
          { operationId: "op-out", kind: "sign-out", profileId: lab, site: "example.com" },
          undefined,
          [],
        );
        const claim = (phase: "do" | "undo", computer: string) =>
          service
            .claimProfileStore({ operationId: "op-out", phase, computer })
            .pipe(Effect.map(({ ok }) => ok));
        // regression: the desk's claim held the one key, so the laptop's own part was refused.
        expect(yield* claim("do", desk.id)).toBe(true);
        expect(yield* claim("do", laptop.id)).toBe(true);
        for (const computer of [desk.id, laptop.id])
          yield* service.profileStoreDone({
            operationId: "op-out",
            phase: "do",
            ...(computer === laptop.id ? { computer } : {}),
            outcome: { state: "done", saved: 1 },
          });
        yield* service.undoProfileOperation("op-out", undefined);
        expect(yield* claim("undo", desk.id)).toBe(true);
        expect(yield* claim("undo", laptop.id)).toBe(true);
        // A part is still one desktop's: a third can't take the desk's.
        expect(yield* claim("undo", "env-third")).toBe(false);
      }),
  );
});

describe("a desktop's write asks its own backend as it writes (round 6f)", () => {
  it.effect("answers yes only while its claimed part still stands", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopStore);
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      yield* service.operateProfile(
        { operationId: "op-out", kind: "sign-out", profileId: lab, site: "example.com" },
        agent,
        [],
      );
      const check = service.desktopWriteCheck({ operationId: "op-out", phase: "do" });
      // Never claimed: no part's write.
      expect((yield* check).ok).toBe(false);
      yield* service.claimProfileStore({ operationId: "op-out", phase: "do", computer: laptop.id });
      expect((yield* check).ok).toBe(true);
      // The person turns Lab off for agents between the claim and the write.
      yield* service.setControls({ target: { type: "profile", profileId: lab }, access: "off" });
      // regression: only the claim, before the write, was ever asked.
      expect(yield* check).toMatchObject({ ok: false });
    }),
  );

  it.effect("gives an agent's sign-out no part on another desktop", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore({
        ...laptopStore,
        computer: { id: "env-desk", label: "Lab desk" },
      });
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      // The laptop is on too, with its own jar.
      yield* service.reportProfiles([], { computer: laptop, sources: [] });
      const byAgent = (yield* service.operateProfile(
        { operationId: "op-agent", kind: "sign-out", profileId: lab, site: "example.com" },
        agent,
        [],
      )).operation!;
      // regression: the laptop wrote an agent's sign-out its own backend can't check.
      expect(byAgent.others).toBeUndefined();
      const byPerson = (yield* service.operateProfile(
        { operationId: "op-person", kind: "sign-out", profileId: lab, site: "example.org" },
        undefined,
        [],
      )).operation!;
      expect(byPerson.others).toEqual([{ computer: laptop, outcome: { state: "pending" } }]);
    }),
  );
});
