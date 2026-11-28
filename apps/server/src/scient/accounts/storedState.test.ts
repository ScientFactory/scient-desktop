import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import {
  AccountsState,
  decodePrivateJson,
  emptyState,
  withStoredAccountsFolded,
} from "./AccountPersistence.ts";

/** The state file as written, then read the way Accounts opens it. */
const open = (state: object) =>
  decodePrivateJson(
    AccountsState,
    withStoredAccountsFolded(Redacted.make(new TextEncoder().encode(JSON.stringify(state)))),
  );

/** An empty state as Accounts writes it. */
const stored = Schema.encodeSync(AccountsState)(emptyState) as Record<string, unknown>;

const receipt = (operationId: string, extra: object = {}) => ({
  operationId,
  kind: "refresh",
  profileId: "profile-lab",
  at: "2026-11-26T00:00:00.000Z",
  until: "2026-11-26T01:00:00.000Z",
  desktop: { state: "done" },
  ...extra,
});

describe("Accounts opens whatever one stored record says (round 6h, E)", () => {
  it.effect("reads a receipt with a removed cause as a failure with none", () =>
    Effect.gen(function* () {
      const state = yield* open({
        ...stored,
        profileOperations: [
          receipt("op-good"),
          // Written by 6e: a cause 6f removed.
          receipt("op-6e", { desktop: { state: "failed", cause: "notShared" } }),
          // Written before 6m: the refresh's Undo copy, removed with it.
          receipt("op-6l", { desktop: { state: "failed", cause: "noCopy" } }),
        ],
      });
      // regression: the whole state failed to decode, and Accounts didn't open.
      expect(state.profileOperations?.map(({ operationId }) => operationId)).toEqual([
        "op-good",
        "op-6e",
        "op-6l",
      ]);
      expect(state.profileOperations?.[1]?.desktop).toEqual({ state: "failed" });
      expect(state.profileOperations?.[2]?.desktop).toEqual({ state: "failed" });
    }),
  );

  it.effect("settles an old refresh's pending Undo as failed, and keeps one that ended (6n)", () =>
    Effect.gen(function* () {
      const state = yield* open({
        ...stored,
        profileOperations: [
          // Written before 6m: a refresh's Undo still under way on a desktop.
          receipt("op-pending", {
            undone: { at: "2026-11-26T00:30:00.000Z", desktop: { state: "pending" } },
          }),
          receipt("op-ended", {
            undone: { at: "2026-11-26T00:30:00.000Z", desktop: { state: "done", copied: 2 } },
          }),
          // A sign-out's Undo under way is still carried out.
          receipt("op-sign-out", {
            kind: "sign-out",
            site: "example.com",
            undone: { at: "2026-11-26T00:30:00.000Z", desktop: { state: "pending" } },
          }),
        ],
      });
      const undone = (index: number) => state.profileOperations?.[index]?.undone?.desktop;
      // regression: the pending part stayed, and a desktop carried it out as a sign-out restore.
      expect(undone(0)).toEqual({ state: "failed" });
      expect(state.profileOperations?.[0]?.desktop).toEqual({ state: "done" });
      expect(undone(1)).toEqual({ state: "done", copied: 2 });
      expect(undone(2)).toEqual({ state: "pending" });
    }),
  );

  it.effect("drops one unreadable record of a list, never the state", () =>
    Effect.gen(function* () {
      const state = yield* open({
        ...stored,
        profileOperations: [receipt("op-good"), { operationId: 5, kind: "unheard-of" }],
        changes: [{ unheard: "of" }],
        signOutSaves: [{ operationId: "op-x", ref: "not-a-value-name" }],
        pendingPurges: [{ profileId: 7 }],
        sourceProfiles: [{ seenAt: "2026-11-26T00:00:00.000Z", sources: [] }],
      });
      expect(state.profileOperations?.map(({ operationId }) => operationId)).toEqual(["op-good"]);
      expect(state.changes).toEqual([]);
      expect(state.signOutSaves).toEqual([]);
      expect(state.pendingPurges).toEqual([]);
      expect(state.sourceProfiles).toEqual([]);
    }),
  );
});

describe("two links to one browser profile, as stored before round 6h (C)", () => {
  it.effect("keeps the newest link and drops the other", () =>
    Effect.gen(function* () {
      const link = (importedAt: string) => ({
        browser: "chrome",
        profileName: "Work",
        directory: "Profile 1",
        importedAt,
      });
      const profile = (profileId: string, importedAt: string) => ({
        profileId,
        access: "allowed",
        scope: { type: "all-projects" },
        scriptSignIn: true,
        source: link(importedAt),
      });
      const state = yield* open({
        ...stored,
        profiles: [
          profile("profile-old", "2026-11-01T00:00:00.000Z"),
          profile("profile-new", "2026-11-20T00:00:00.000Z"),
        ],
      });
      expect(
        state.profiles.map(({ profileId, source }) => [profileId, source?.importedAt ?? null]),
      ).toEqual([
        ["profile-old", null],
        ["profile-new", "2026-11-20T00:00:00.000Z"],
      ]);
      // The newest link on a removed profile: the profile still in use keeps it (round 6i).
      const kept = yield* open({
        ...stored,
        profiles: [
          profile("profile-in-use", "2026-11-01T00:00:00.000Z"),
          {
            ...profile("profile-gone", "2026-11-20T00:00:00.000Z"),
            removed: {
              at: "2026-11-21T00:00:00.000Z",
              operationId: "op-remove",
              until: "2026-11-21T01:00:00.000Z",
            },
          },
        ],
      });
      // regression: the only link went to the removed profile.
      expect(
        kept.profiles.map(({ profileId, source }) => [profileId, source?.importedAt ?? null]),
      ).toEqual([
        ["profile-in-use", "2026-11-01T00:00:00.000Z"],
        ["profile-gone", null],
      ]);
    }),
  );
});

describe("every list drops a record that no longer reads, alone (round 6i)", () => {
  const LISTS = [
    "accounts",
    "profiles",
    "detachedKeyLinks",
    "customModelEscrows",
    "needsYou",
    "signedOut",
    "keyLinks",
    "removedLogins",
    "keptKeys",
    "changes",
    "sourceProfiles",
    "profileOperations",
    "pendingPurges",
    "signOutSaves",
    "keyRefusals",
    "senders",
    "neverAsk",
    "senderKeys",
    "universitySignOuts",
  ];
  const lab = {
    profileId: "profile-lab",
    access: "allowed",
    scope: { type: "all-projects" },
    scriptSignIn: true,
  };
  const work = { browser: "chrome", directory: "Profile 1", name: "Work" };
  const laptop = {
    computer: { id: "env-laptop", label: "Ada's laptop" },
    seenAt: "2026-11-26T00:00:00.000Z",
    sources: [work, { browser: "chrome", directory: 7 }],
  };
  it.effect("opens with one bad record in each list, and with lists that aren't lists", () =>
    Effect.gen(function* () {
      const bad = { unheard: { of: [1] } };
      const state = yield* open({
        ...stored,
        ...Object.fromEntries(LISTS.map((key) => [key, [bad]])),
        profiles: [lab, bad],
        sourceProfiles: [laptop, bad],
        profileOperations: [receipt("op-good"), bad],
        signedOut: [{ profileId: "profile-lab", site: "example.com" }, bad],
        neverAsk: ["example.com", 7],
      });
      // regression: one bad record in any of these lists kept Accounts from opening.
      for (const key of LISTS)
        expect(
          (state as unknown as Record<string, ReadonlyArray<unknown> | undefined>)[key],
        ).not.toContain(bad);
      expect(state.accounts).toEqual([]);
      expect(state.profiles.map(({ profileId }) => profileId)).toEqual(["profile-lab"]);
      // A bad browser profile in a desktop's report goes on its own; the report stays.
      expect(state.sourceProfiles?.map(({ sources }) => sources)).toEqual([[work]]);
      expect(state.profileOperations?.map(({ operationId }) => operationId)).toEqual(["op-good"]);
      expect(state.signedOut).toEqual([{ profileId: "profile-lab", site: "example.com" }]);
      expect(state.neverAsk).toEqual(["example.com"]);
      // Not lists at all: the required ones read as empty, the rest as absent.
      const shapeless = yield* open({
        ...stored,
        ...Object.fromEntries(LISTS.map((key) => [key, { not: "a list" }])),
      });
      expect([shapeless.accounts, shapeless.profiles]).toEqual([[], []]);
      for (const key of LISTS.filter((key) => key !== "accounts" && key !== "profiles"))
        expect((shapeless as unknown as Record<string, unknown>)[key]).toBeUndefined();
    }),
  );
});

describe("links are made one per browser profile from records that read (round 6j)", () => {
  const profile = (profileId: string, source: object, extra: object = {}) => ({
    profileId,
    access: "allowed",
    scope: { type: "all-projects" },
    scriptSignIn: true,
    source: { browser: "chrome", profileName: "Work", ...source },
    ...extra,
  });
  const links = (state: { profiles: ReadonlyArray<{ profileId: string; source?: unknown }> }) =>
    state.profiles.map(({ profileId, source }) => [profileId, source !== undefined]);
  it.effect("keeps a valid link over an unreadable newer one, and never stops on a bad date", () =>
    Effect.gen(function* () {
      const state = yield* open({
        ...stored,
        profiles: [
          profile("profile-valid", {
            directory: "Profile 1",
            importedAt: "2026-11-01T00:00:00.000Z",
          }),
          // Newer, but the record doesn't read: it never takes the link.
          profile(
            "profile-unreadable",
            { directory: "Profile 1", importedAt: "2026-11-20T00:00:00.000Z" },
            { access: "sometimes" },
          ),
          // A date stored as an object that can't be made a string.
          profile("profile-bad-date", { directory: "Profile 2", importedAt: { toString: 1 } }),
        ],
        // A receipt whose fold throws: it alone goes.
        profileOperations: [
          receipt("op-good"),
          receipt("op-throws", { desktop: { state: "failed", cause: { toString: 1 } } }),
        ],
        // A report whose list of browser profiles isn't a list.
        sourceProfiles: [
          {
            computer: { id: "env-laptop", label: "Ada's laptop" },
            seenAt: "2026-11-26T00:00:00.000Z",
            sources: { not: "a list" },
          },
        ],
      });
      // regression: the unreadable newer profile took the link, then was dropped with it; the
      // bad date made the whole state unreadable.
      expect(links(state)).toEqual([["profile-valid", true]]);
      expect(state.profileOperations?.map(({ operationId }) => operationId)).toEqual(["op-good"]);
      // regression: the report went with its malformed list.
      expect(state.sourceProfiles?.map(({ sources }) => sources)).toEqual([[]]);
    }),
  );

  it.effect("matches a link made before folders and desktops were kept with its newer form", () =>
    Effect.gen(function* () {
      const state = yield* open({
        ...stored,
        profiles: [
          profile("profile-legacy", { importedAt: "2026-11-01T00:00:00.000Z" }),
          profile("profile-modern", {
            directory: "Profile 1",
            computer: { id: "env-laptop", label: "Ada's laptop" },
            importedAt: "2026-11-20T00:00:00.000Z",
          }),
        ],
      });
      // regression: their keys differed, so both kept a link to the one browser profile.
      expect(links(state)).toEqual([
        ["profile-legacy", false],
        ["profile-modern", true],
      ]);
    }),
  );

  it.effect("matches links as they read: a folder stored with spaces is the same folder (6k)", () =>
    Effect.gen(function* () {
      const state = yield* open({
        ...stored,
        profiles: [
          profile("profile-padded", {
            directory: " Profile 1 ",
            importedAt: "2026-11-01T00:00:00.000Z",
          }),
          profile("profile-plain", {
            directory: "Profile 1",
            importedAt: "2026-11-20T00:00:00.000Z",
          }),
        ],
      });
      // regression: compared as stored, they differed, and both kept a link once read.
      expect(links(state)).toEqual([
        ["profile-padded", false],
        ["profile-plain", true],
      ]);
    }),
  );
});
