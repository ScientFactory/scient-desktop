import { describe, expect, it } from "@effect/vitest";
import {
  BrowserProfileId,
  BrowserProfilesReportInput,
  BrowserSourceProfile,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { makeHarness, memoryStore } from "./Accounts.testkit.ts";
import type { ProfileStore } from "./AccountsService.ts";

const by = { threadId: ThreadId.make("thread-import"), projectId: ProjectId.make("project-lab") };
const laptop = { id: "env-laptop", label: "Ada's laptop" };
const work = { browser: "chrome", directory: "Profile 1", name: "Work" } as const;
const home = {
  browser: "chrome",
  directory: "Default",
  name: "Home",
  email: "ada@example.com",
} as const;
const sourceId = (source: { readonly browser: string; readonly directory: string }) =>
  `${laptop.id}/${source.browser}/${source.directory}`;

const decodeReport = Schema.decodeUnknownSync(BrowserProfilesReportInput);

/** The laptop's own server: an import reads only its own desktop's browsers (round 6f). */
const laptopServer: ProfileStore = {
  desktop: true,
  computer: laptop,
  generations: () => Effect.void,
  closeProfile: () => Effect.void,
  signOut: () => Effect.succeed({ cookies: [] }),
  restore: () => Effect.succeed({ restored: 0, refused: 0 }),
  copy: () => Effect.succeed({ copied: 0, uncovered: [], sites: [] }),
  restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
  purge: () => Effect.void,
};

describe("agents import from a browser profile not linked yet (AMENDMENTS 58)", () => {
  it.effect("keeps each desktop's report as it last sent it, a profile gone from it gone", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], { computer: laptop, sources: [work, home] });
      const desk = { id: "env-desk", label: "Lab desk" };
      yield* service.reportProfiles([], {
        computer: desk,
        sources: [{ browser: "edge", directory: "Default", name: "Lab" }],
      });
      // The desk is another computer: its list is kept nowhere here (round 6f).
      expect((yield* service.browserSources).map(({ sourceId }) => sourceId)).toEqual([
        sourceId(work),
        sourceId(home),
      ]);
      // Home was removed from Chrome on the laptop: the laptop's list changes.
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      const sources = yield* service.browserSources;
      expect(sources.map(({ sourceId }) => sourceId)).toEqual([sourceId(work)]);
      expect(sources.every(({ connected }) => connected)).toBe(true);
    }),
  );

  it.effect(
    "imports into a new profile named after the source, then refreshes through the link",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        yield* service.attachProfileStore(laptopServer);
        yield* service.reportProfiles([], { computer: laptop, sources: [work] });
        const made = BrowserProfileId.make("profile-made");
        const started = (yield* service.operateProfile(
          {
            operationId: "op-import",
            kind: "refresh",
            profileId: made,
            sourceId: sourceId(work),
            cookies: true,
          },
          by,
          [],
        )).operation!;
        // Carried out by the laptop's window, on this server too: it holds the browser.
        expect(started).toMatchObject({
          kind: "refresh",
          name: "Chrome · Work",
          computer: laptop,
          madeProfile: true,
          desktop: { state: "pending" },
        });
        const record = (yield* service.snapshot).profiles.find(
          ({ profileId }) => profileId === made,
        );
        expect(record?.name).toBe("Chrome · Work");
        expect((yield* service.snapshot).changes).toContainEqual(
          expect.objectContaining({ change: "refresh", threadId: by.threadId }),
        );
        yield* service.profileStoreDone({
          operationId: "op-import",
          phase: "do",
          outcome: { state: "done", copied: 3 },
        });
        // Linked once it has succeeded.
        expect(
          (yield* service.snapshot).profiles.find(({ profileId }) => profileId === made),
        ).toMatchObject({
          source: { browser: "chrome", profileName: "Work", directory: "Profile 1" },
        });
        expect((yield* service.browserSources)[0]?.source.linkedTo).toBe(made);
        // Linked now: a refresh finds it, and runs on the laptop again.
        const again = (yield* service.operateProfile(
          { operationId: "op-refresh", kind: "refresh", profileId: made, passwords: true },
          by,
          [],
        )).operation!;
        expect(again).toMatchObject({ computer: laptop, desktop: { state: "pending" } });
        expect(again.madeProfile).toBeUndefined();
        // An import has no Undo (round 6m): the profile it made stays, and is the person's.
        const undone = yield* service.undoProfileOperation("op-import", by).pipe(Effect.flip);
        expect(undone.reason).toBe("unsupported");
        const kept = (yield* service.snapshot).profiles.find(({ profileId }) => profileId === made);
        expect(kept?.removed).toBeUndefined();
      }),
  );

  it.effect("refuses a source whose desktop is off, naming it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      const tryImport = (operationId: string) =>
        service.operateProfile(
          {
            operationId,
            kind: "refresh",
            profileId: BrowserProfileId.make(`profile-${operationId}`),
            sourceId: sourceId(work),
            cookies: true,
          },
          by,
          [],
        );
      // Nothing heard for eleven minutes: the laptop is off.
      yield* TestClock.adjust("11 minutes");
      expect((yield* service.browserSources)[0]?.connected).toBe(false);
      const refused = yield* tryImport("off");
      expect(refused.refused?.message).toContain("Ada's laptop");
      expect(refused.refused?.message).toContain("isn't connected");
      // Its next report brings it back.
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      expect((yield* tryImport("on")).operation?.computer).toEqual(laptop);
      // A source no desktop reports is no source.
      const unknown = yield* service
        .operateProfile(
          {
            operationId: "op-unknown",
            kind: "refresh",
            profileId: BrowserProfileId.make("profile-unknown"),
            sourceId: "env-laptop/chrome/Profile 9",
            cookies: true,
          },
          by,
          [],
        )
        .pipe(Effect.flip);
      expect(unknown.reason).toBe("not-found");
    }),
  );

  it("reports names only: never a cookie, password or history", () => {
    expect(Object.keys(BrowserSourceProfile.fields).toSorted()).toEqual([
      "browser",
      "directory",
      "email",
      "linkedTo",
      "name",
    ]);
    const decoded = decodeReport({
      profiles: [],
      computer: laptop,
      sources: [
        { ...work, cookies: [{ name: "sid", value: "synthetic" }], password: "x", history: ["a"] },
      ],
    });
    expect(decoded.sources).toEqual([work]);
  });
});

describe("a link names the desktop it was made on (round 6d, Step 8 P1)", () => {
  it.effect("refreshes from that desktop, never another's folder of the same name", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      const made = BrowserProfileId.make("profile-made");
      yield* service.operateProfile(
        {
          operationId: "op-import",
          kind: "refresh",
          profileId: made,
          sourceId: sourceId(work),
          cookies: true,
        },
        by,
        [],
      );
      yield* service.profileStoreDone({
        operationId: "op-import",
        phase: "do",
        outcome: { state: "done", copied: 1 },
      });
      const record = (yield* service.snapshot).profiles.find(({ profileId }) => profileId === made);
      expect(record?.source?.computer).toEqual(laptop);
      // The desk has a Chrome "Profile 1" too, and says it is linked; then the laptop reports.
      const desk = { id: "env-desk", label: "Lab desk" };
      yield* service.reportProfiles([], { computer: desk, sources: [{ ...work, linkedTo: made }] });
      yield* service.reportProfiles([], {
        computer: laptop,
        sources: [{ ...work, linkedTo: made }],
      });
      const again = (yield* service.operateProfile(
        { operationId: "op-refresh", kind: "refresh", profileId: made, cookies: true },
        by,
        [],
      )).operation!;
      // regression: the desk's folder answered first, and its cookies went into Made.
      expect(again.computer).toEqual(laptop);
    }),
  );
});

describe("an import links only once it succeeds, and its Undo restores the link (round 6d, Step 8 P2)", () => {
  it.effect("leaves the profile's link alone when it fails, and moves it once it succeeds", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      const lab = BrowserProfileId.make("profile-lab");
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      // Lab was imported from the laptop's Home before.
      const homeLink = {
        browser: "chrome",
        profileName: "Home",
        directory: "Default",
        computer: laptop,
        importedAt: "2026-11-20T00:00:00.000Z",
      } as const;
      yield* service.updateProfile({ profileId: lab, source: homeLink });
      yield* service.reportProfiles([], {
        computer: laptop,
        sources: [{ ...home, linkedTo: lab }, work],
      });
      const linkOf = () =>
        service.snapshot.pipe(
          Effect.map(({ profiles }) => profiles.find(({ profileId }) => profileId === lab)?.source),
        );
      const importWork = (operationId: string) =>
        service.operateProfile(
          {
            operationId,
            kind: "refresh",
            profileId: lab,
            sourceId: sourceId(work),
            cookies: true,
          },
          by,
          [],
        );
      yield* importWork("op-failed");
      yield* service.profileStoreDone({
        operationId: "op-failed",
        phase: "do",
        outcome: { state: "failed" },
      });
      // regression: admission linked Lab to Work, so a failed import repointed its refresh.
      expect(yield* linkOf()).toEqual(homeLink);
      yield* importWork("op-done");
      yield* service.profileStoreDone({
        operationId: "op-done",
        phase: "do",
        outcome: { state: "done", copied: 2 },
      });
      expect(yield* linkOf()).toMatchObject({ directory: "Profile 1", computer: laptop });
      // The browser's list says so: Work is Lab's now, Home no one's.
      const linked = (yield* service.browserSources).map(({ source }) => [
        source.directory,
        source.linkedTo,
      ]);
      expect(linked).toEqual([
        ["Default", undefined],
        ["Profile 1", lab],
      ]);
    }),
  );
});

describe("a bound link, and a catalog that goes stale (round 6e, Step 8)", () => {
  it.effect(
    "never refreshes from this desktop's same-named folder when the link's desktop is off",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        // This server is the desk's: it has a Chrome "Profile 1" of its own.
        yield* service.attachProfileStore({
          ...laptopServer,
          desktop: true,
          computer: { id: "env-desk", label: "Lab desk" },
        });
        const lab = BrowserProfileId.make("profile-lab");
        yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
        yield* service.updateProfile({
          profileId: lab,
          source: {
            browser: "chrome",
            profileName: "Work",
            directory: "Profile 1",
            computer: laptop,
            importedAt: "2026-11-26T00:00:00.000Z",
          },
        });
        // The laptop sends no report.
        const result = yield* service.operateProfile(
          { operationId: "op-refresh", kind: "refresh", profileId: lab, cookies: true },
          by,
          [],
        );
        // regression: it ran here, reading the desk's own "Profile 1".
        expect(result.operation).toBeUndefined();
        expect(result.refused?.message).toContain("Ada's laptop");
      }),
  );

  it.effect("drops a desktop's sources an hour after its last report, failed reports or not", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      yield* TestClock.adjust("30 minutes");
      expect((yield* service.browserSources).map(({ connected }) => connected)).toEqual([false]);
      yield* TestClock.adjust("31 minutes");
      // regression: the laptop's last list stayed on offer for good.
      expect(yield* service.browserSources).toEqual([]);
      const gone = yield* service
        .operateProfile(
          {
            operationId: "op-stale",
            kind: "refresh",
            profileId: BrowserProfileId.make("profile-stale"),
            sourceId: sourceId(work),
            cookies: true,
          },
          by,
          [],
        )
        .pipe(Effect.flip);
      expect(gone.reason).toBe("not-found");
    }),
  );
});

describe("a list saved from another desktop is never offered (round 6h, F)", () => {
  it.effect("filters saved lists by this server's own desktop, and drops a foreign one", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      yield* first.service.attachProfileStore(laptopServer);
      yield* first.service.reportProfiles([], { computer: laptop, sources: [work] });
      expect(yield* first.service.browserSources).toHaveLength(1);
      // The same state, opened on the desk's own server: the laptop's saved list is foreign.
      const second = yield* makeHarness({ storage });
      yield* second.service.snapshot;
      // Before any browser store says whose it is, no saved list is anyone's to offer.
      expect(yield* second.service.browserSources).toEqual([]);
      yield* second.service.attachProfileStore({
        ...laptopServer,
        computer: { id: "env-desk", label: "Lab desk" },
      });
      // regression: the saved list still offered the laptop's browsers here.
      expect(yield* second.service.browserSources).toEqual([]);
      const refused = yield* second.service
        .operateProfile(
          {
            operationId: "op-foreign",
            kind: "refresh",
            profileId: BrowserProfileId.make("profile-foreign"),
            sourceId: sourceId(work),
            cookies: true,
          },
          by,
          [],
        )
        .pipe(Effect.flip);
      expect(refused.reason).toBe("not-found");
      // And it is gone from the state, not kept for a store that names the laptop again.
      yield* second.service.attachProfileStore(laptopServer);
      expect(yield* second.service.browserSources).toEqual([]);
    }),
  );

  it.effect("drops a foreign list when the store attaches before Accounts' first read (6i)", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      yield* first.service.attachProfileStore(laptopServer);
      yield* first.service.reportProfiles([], { computer: laptop, sources: [work] });
      // The desk's server: its store attaches as it starts, before anything reads Accounts.
      const second = yield* makeHarness({ storage });
      yield* second.service.attachProfileStore({
        ...laptopServer,
        computer: { id: "env-desk", label: "Lab desk" },
      });
      yield* second.service.snapshot;
      // Opened again as the laptop's own: the list was dropped, not just hidden on the desk.
      const third = yield* makeHarness({ storage });
      yield* third.service.snapshot;
      yield* third.service.attachProfileStore(laptopServer);
      // regression: attached first, the desk kept the laptop's list, offered again here.
      expect(yield* third.service.browserSources).toEqual([]);
    }),
  );
});

describe("one browser profile links to one Scient profile (round 6h, C)", () => {
  const lab = BrowserProfileId.make("profile-lab");
  const workLink = {
    browser: "chrome",
    profileName: "Work",
    directory: "Profile 1",
    computer: laptop,
    importedAt: "2026-11-20T00:00:00.000Z",
  } as const;
  it.effect("refuses an import of a browser profile linked elsewhere; that profile refreshes", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      yield* service.updateProfile({ profileId: lab, source: workLink });
      yield* service.reportProfiles([], {
        computer: laptop,
        sources: [{ ...work, linkedTo: lab }],
      });
      const into = (profileId: BrowserProfileId, operationId: string) =>
        service.operateProfile(
          { operationId, kind: "refresh", profileId, sourceId: sourceId(work), cookies: true },
          by,
          [],
        );
      const elsewhere = yield* into(BrowserProfileId.make("profile-new"), "op-new");
      // regression: a second link to Work escaped Lab's controls, Off or scoped.
      expect(elsewhere.operation).toBeUndefined();
      expect(elsewhere.refused?.message).toContain("Lab");
      // Into Lab itself: its own link, under its own controls.
      expect((yield* into(lab, "op-lab")).operation).toBeDefined();
    }),
  );

  it.effect("refuses a second import while one of the same browser profile is under way", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      const into = (profileId: string, operationId: string) =>
        service.operateProfile(
          {
            operationId,
            kind: "refresh",
            profileId: BrowserProfileId.make(profileId),
            sourceId: sourceId(work),
            cookies: true,
          },
          by,
          [],
        );
      expect((yield* into("profile-a", "op-a")).operation).toBeDefined();
      expect((yield* into("profile-b", "op-b")).refused).toBeDefined();
    }),
  );

  it.effect("gives the person's link the browser profile; another profile's link goes", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const other = BrowserProfileId.make("profile-other");
      yield* service.reportProfiles([
        { profileId: lab, name: "Lab" },
        { profileId: other, name: "Other" },
      ]);
      yield* service.updateProfile({ profileId: lab, source: workLink });
      yield* service.updateProfile({
        profileId: other,
        source: { ...workLink, importedAt: "2026-11-27T00:00:00.000Z" },
      });
      const sources = (yield* service.snapshot).profiles.map(({ profileId, source }) => [
        profileId,
        source?.importedAt,
      ]);
      expect(sources).toContainEqual([lab, undefined]);
      expect(sources).toContainEqual([other, "2026-11-27T00:00:00.000Z"]);
    }),
  );

  it.effect("stops a refresh at its commit once its browser profile is linked elsewhere", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      yield* service.operateProfile(
        {
          operationId: "op-import",
          kind: "refresh",
          profileId: lab,
          sourceId: sourceId(work),
          cookies: true,
        },
        by,
        [],
      );
      yield* service.claimProfileStore({
        operationId: "op-import",
        phase: "do",
        computer: laptop.id,
      });
      const check = service.desktopWriteCheck({ operationId: "op-import", phase: "do" });
      expect((yield* check).ok).toBe(true);
      // The person links Work to another profile while the browser asks.
      const other = BrowserProfileId.make("profile-other");
      yield* service.reportProfiles([{ profileId: other, name: "Other" }]);
      yield* service.updateProfile({
        profileId: other,
        source: { ...workLink, directory: work.directory, importedAt: "2026-11-27T00:00:00.000Z" },
      });
      // regression: the import wrote on, a second link to Work under Lab's controls.
      expect(yield* check).toMatchObject({ ok: false });
    }),
  );

  it.effect("lets an agent refresh Main, and stops it at Main's turn after a sign-out (6i)", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      const main = BrowserProfileId.make("default");
      const result = yield* service.operateProfile(
        {
          operationId: "op-main",
          kind: "refresh",
          profileId: main,
          sourceId: sourceId(work),
          passwords: true,
        },
        by,
        [],
      );
      // regression: an agent's refresh of Main, password-only too, was refused (round 6h).
      expect(result.refused).toBeUndefined();
      expect(result.operation?.desktop?.state).toBe("pending");
      yield* service.claimProfileStore({
        operationId: "op-main",
        phase: "do",
        computer: laptop.id,
      });
      const check = service.desktopWriteCheck({ operationId: "op-main", phase: "do" });
      expect(yield* check).toEqual({ ok: true });
      // The person signs Main out of a site while the browser asks: Main's turn writes nothing.
      yield* service.profileSignedOut(main, "github.com");
      expect(yield* check).toMatchObject({ ok: false });
    }),
  );

  it.effect("stops a refresh of an existing Main signed out of a site again meanwhile (6j)", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      const main = BrowserProfileId.make("default");
      // Main has its record, a site signed out before.
      yield* service.profileSignedOut(main, "github.com");
      yield* service.operateProfile(
        {
          operationId: "op-main",
          kind: "refresh",
          profileId: main,
          sourceId: sourceId(work),
          cookies: true,
        },
        by,
        [],
      );
      yield* service.claimProfileStore({
        operationId: "op-main",
        phase: "do",
        computer: laptop.id,
      });
      const check = service.desktopWriteCheck({ operationId: "op-main", phase: "do" });
      expect(yield* check).toEqual({ ok: true });
      // Signed in there since, then signed out again while the browser asks.
      yield* service.profileSignedOut(main, "github.com");
      // regression: Main's version ignored its sign-outs, so the check stayed green.
      expect(yield* check).toEqual({
        ok: false,
        message: "Main was signed out of a site since; nothing was done.",
      });
      // Its send to other computers is checked as it is recorded, too (round 6k).
      const sent = yield* service.profileResend(main, "op-main").pipe(Effect.flip);
      // regression: a refresh that no longer stood still sent Main's whole jar.
      expect(sent.message).toBe("Main was signed out of a site since; nothing was done.");
    }),
  );
});

describe("one rule for which profile a browser profile is linked to (round 6i)", () => {
  const legacy = BrowserProfileId.make("profile-legacy");
  const lab = BrowserProfileId.make("profile-lab");
  const into = (
    service: Effect.Success<ReturnType<typeof makeHarness>>["service"],
    operationId: string,
  ) =>
    service.operateProfile(
      { operationId, kind: "refresh", profileId: lab, sourceId: sourceId(work), cookies: true },
      by,
      [],
    );
  it.effect("keeps a name-only legacy link to an Off profile from an import elsewhere", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([
        { profileId: legacy, name: "Legacy" },
        { profileId: lab, name: "Lab" },
      ]);
      // Linked before folders and desktops were kept: by the browser's name for it only.
      yield* service.setControls({ target: { type: "profile", profileId: legacy }, access: "off" });
      yield* service.updateProfile({
        profileId: legacy,
        source: { browser: "chrome", profileName: "Work", importedAt: "2026-11-01T00:00:00.000Z" },
      });
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      const refused = yield* into(service, "op-legacy");
      // regression: admission matched folders only, so Work's Off sign-ins went into Lab.
      expect(refused.operation).toBeUndefined();
      expect(refused.refused?.message).toContain("Legacy");
    }),
  );

  it.effect("goes by the link the desktop's own report resolved", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([
        { profileId: legacy, name: "Legacy" },
        { profileId: lab, name: "Lab" },
      ]);
      yield* service.setControls({ target: { type: "profile", profileId: legacy }, access: "off" });
      yield* service.reportProfiles([], {
        computer: laptop,
        sources: [{ ...work, linkedTo: legacy }],
      });
      // regression: the report said Work was Legacy's; admission read only its own records.
      expect((yield* into(service, "op-reported")).refused?.message).toContain("Legacy");
    }),
  );

  it.effect("stops a refresh at its commit once a legacy link to its browser profile appears", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([
        { profileId: legacy, name: "Legacy" },
        { profileId: lab, name: "Lab" },
      ]);
      yield* service.reportProfiles([], { computer: laptop, sources: [work] });
      expect((yield* into(service, "op-commit")).operation).toBeDefined();
      yield* service.claimProfileStore({
        operationId: "op-commit",
        phase: "do",
        computer: laptop.id,
      });
      const check = service.desktopWriteCheck({ operationId: "op-commit", phase: "do" });
      expect((yield* check).ok).toBe(true);
      yield* service.updateProfile({
        profileId: legacy,
        source: { browser: "chrome", profileName: "Work", importedAt: "2026-11-27T00:00:00.000Z" },
      });
      // regression: a link with no desktop never matched one with a desktop.
      expect(yield* check).toMatchObject({ ok: false });
    }),
  );
});
