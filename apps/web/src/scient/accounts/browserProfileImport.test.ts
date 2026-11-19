import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type BrowserImportResult, type BrowserProfile } from "@t3tools/contracts";
import { importBrowserCookiesIntoTarget } from "~/components/settings/IntegrationsSettings";
import { addBrowserProfile } from "./addBrowserProfile";

const state = vi.hoisted(() => ({
  profiles: [] as ReadonlyArray<BrowserProfile>,
  defaultProfileId: "default",
  records: [] as unknown[],
  filledFrom: [] as string[],
  importedIntoMain: [] as string[],
  googleCopies: [] as Array<[string, string]>,
  observed: [] as Array<[string, object]>,
  mainUnits: [
    { sites: ["github.com"], outcome: "copied" },
    { sites: ["gitlab.com"], outcome: "conflict" },
  ] as ReadonlyArray<{ sites: ReadonlyArray<string>; outcome: string }>,
  mainSummary: undefined as
    | {
        imported: number;
        skipped: number;
        skippedByReason: Record<
          "appBoundEncryption" | "decryptFailed" | "partitionUnsupported" | "writeFailed",
          number
        >;
      }
    | undefined,
}));
vi.mock("./accountsState", () => ({
  accountsState: {
    updateProfile: { run: async (_registry: unknown, input: unknown) => state.records.push(input) },
  },
}));
vi.mock("../analytics/accountBrowserAnalytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../analytics/accountBrowserAnalytics")>()),
  beginAccountBrowserObservation: () => ({
    context: "consent",
    record: (feature: string, fields: object) => void state.observed.push([feature, fields]),
  }),
}));
vi.mock("./googleCopyObservation", () => ({
  noteGoogleCopy: (_environmentId: string, profileId: string, source: string) =>
    void state.googleCopies.push([profileId, source]),
}));
vi.mock("./mainFill", () => ({
  fillMainFromProfile: async (_environmentId: string, profileId: string) =>
    void state.filledFrom.push(profileId),
  importIntoMain: async (_environmentId: string, _source: string, directory: string) => {
    state.importedIntoMain.push(directory);
    return {
      units: state.mainUnits,
      unsupported: 1,
      ...(state.mainSummary ? { importSummary: state.mainSummary } : {}),
    };
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ browserProfiles: state.profiles }),
  persistClientSettingsUpdate: async (
    update: (current: {
      browserProfiles: ReadonlyArray<BrowserProfile>;
      browserDefaultProfileId: string;
    }) => { browserProfiles: ReadonlyArray<BrowserProfile>; browserDefaultProfileId: string },
  ) => {
    const next = update({
      browserProfiles: state.profiles,
      browserDefaultProfileId: state.defaultProfileId,
    });
    state.profiles = next.browserProfiles;
    state.defaultProfileId = next.browserDefaultProfileId;
    return next;
  },
}));

it("registers each selected source profile by its own name even without transferable cookies", async () => {
  state.profiles = [];
  const bridge = {
    importBrowserCookies: async () => ({ imported: 0, skipped: 0, skippedDomains: [] }),
    clearCookies: async () => undefined,
    clearCache: async () => undefined,
  };
  const source = {
    id: "chrome" as const,
    name: "Chrome",
    profiles: [
      { directory: "Default", name: "Work" },
      { directory: "Profile 1", name: "Personal" },
    ],
  };
  for (const [index, profile] of source.profiles.entries()) {
    const result = await importBrowserCookiesIntoTarget(
      bridge,
      source,
      EnvironmentId.make("synthetic"),
      {
        sourceProfileDirectory: profile.directory,
        target: { kind: "new", profileId: `profile-synthetic-${index}` },
        profileName: profile.name,
      },
    );
    expect(result.kind).toBe("imported");
  }
  expect(state.profiles.map((profile) => profile.name)).toEqual(["Work", "Personal"]);
});

it("fills Main after an import elsewhere, and imports into Main only through the coordinator", async () => {
  state.profiles = [];
  state.filledFrom = [];
  state.importedIntoMain = [];
  state.observed = [];
  const importBrowserCookies = vi.fn(async () => ({ imported: 2, skipped: 0, skippedDomains: [] }));
  const bridge = {
    importBrowserCookies,
    clearCookies: async () => undefined,
    clearCache: async () => undefined,
  };
  const source = {
    id: "chrome" as const,
    name: "Chrome",
    profiles: [{ directory: "Default", name: "Work" }],
  };
  const environmentId = EnvironmentId.make("synthetic");
  await importBrowserCookiesIntoTarget(bridge, source, environmentId, {
    sourceProfileDirectory: "Default",
    target: { kind: "new", profileId: "profile-synthetic" },
    profileName: "Work",
  });
  expect(state.filledFrom).toEqual(["profile-synthetic"]);
  const intoMain = await importBrowserCookiesIntoTarget(bridge, source, environmentId, {
    sourceProfileDirectory: "Default",
    target: { kind: "existing", profileId: "default", name: "Main" },
  });
  expect(importBrowserCookies).toHaveBeenCalledTimes(1);
  expect(state.importedIntoMain).toEqual(["Default"]);
  // One sign-in copied, Main's own gitlab.com kept: partial, counted in sign-ins, never cookies.
  expect(intoMain).toEqual({
    kind: "imported",
    imported: 1,
    importedUnit: "signIns",
    importedSites: 1,
    skipped: 1,
    skippedDomains: ["gitlab.com"],
    targetName: "Main",
    partial: true,
  });
  expect(state.observed.at(-1)).toEqual([
    "accounts.browser_import",
    expect.objectContaining({
      variant: "partial",
      importedUnit: "sign_ins",
      importedBucket: "1_10",
    }),
  ]);
});

const reasons = (appBoundEncryption: number, decryptFailed = 0) => ({
  appBoundEncryption,
  decryptFailed,
  partitionUnsupported: 0,
  writeFailed: 0,
});

const bridgeReturning = (result: BrowserImportResult) => ({
  importBrowserCookies: async () => result,
  clearCookies: async () => undefined,
  clearCache: async () => undefined,
});

it("keeps an import into Main's cookie rows apart from the sites it copied", async () => {
  const importIntoMain = () =>
    importBrowserCookiesIntoTarget(
      bridgeReturning({ imported: 0, skipped: 0, skippedDomains: [] }),
      { id: "helium", name: "Helium", profiles: [] },
      EnvironmentId.make("synthetic"),
      {
        sourceProfileDirectory: "Default",
        target: { kind: "existing", profileId: "default", name: "Main" },
      },
    );
  state.mainSummary = { imported: 9, skipped: 6, skippedByReason: reasons(6) };
  state.mainUnits = [
    { sites: ["google.com", "youtube.com"], outcome: "copied" },
    { sites: ["gitlab.com"], outcome: "conflict" },
  ];
  state.googleCopies = [];
  // One site copied; skipped counts the six protected cookies and the one Scient can't carry.
  expect(await importIntoMain()).toMatchObject({
    kind: "imported",
    imported: 1,
    importedSites: 1,
    skipped: 7,
    protectedSkipped: 6,
  });
  expect(state.googleCopies).toEqual([["default", "browser_import"]]);

  state.mainSummary = { imported: 0, skipped: 6, skippedByReason: reasons(6) };
  state.mainUnits = [];
  state.googleCopies = [];
  expect(await importIntoMain()).toMatchObject({ kind: "blocked", reason: "appBoundEncryption" });
  expect(state.googleCopies).toEqual([]);
  state.mainSummary = undefined;
});

it("refuses an import that left every cookie behind instead of making an empty profile", async () => {
  state.profiles = [];
  state.googleCopies = [];
  const source = { id: "helium" as const, name: "Helium", profiles: [] };
  const environmentId = EnvironmentId.make("synthetic");
  const importAll = (result: BrowserImportResult) =>
    importBrowserCookiesIntoTarget(bridgeReturning(result), source, environmentId, {
      sourceProfileDirectory: "Default",
      target: { kind: "new", profileId: "profile-protected" },
      profileName: "Work",
    });
  const blocked = await importAll({
    imported: 0,
    skipped: 5,
    skippedDomains: ["google.com"],
    skippedByReason: reasons(4, 1),
  });
  expect(blocked).toMatchObject({
    kind: "blocked",
    reason: "appBoundEncryption",
    protectedSkipped: 4,
  });
  expect(state.profiles).toEqual([]);
  // Nothing could be written into the profile, or keyed for it: a failure too.
  for (const skippedByReason of [
    { ...reasons(0), writeFailed: 3 },
    { ...reasons(0), partitionUnsupported: 3 },
  ])
    expect(
      await importAll({ imported: 0, skipped: 3, skippedDomains: [], skippedByReason }),
    ).toMatchObject({ kind: "blocked", reason: "writeFailed" });
  expect(state.profiles).toEqual([]);

  const partial = await importAll({
    imported: 3,
    skipped: 2,
    skippedDomains: ["bound.example"],
    importedSites: 1,
    skippedByReason: reasons(2),
    importedGoogle: true,
  });
  expect(partial).toMatchObject({ kind: "imported", imported: 3, protectedSkipped: 2 });
  expect(state.profiles.map((profile) => profile.id)).toEqual(["profile-protected"]);
  expect(state.googleCopies).toEqual([["profile-protected", "browser_import"]]);
});

it("adds a profile marked as made in Scient, and leaves the new-tab default alone", async () => {
  state.profiles = [];
  state.defaultProfileId = "default";
  state.records = [];
  const environmentId = EnvironmentId.make("synthetic");
  const id = await addBrowserProfile(environmentId);
  expect(state.profiles.map((profile) => profile.id)).toEqual([id]);
  expect(state.defaultProfileId).toBe("default");
  expect(state.records).toEqual([
    { environmentId, input: { profileId: id, madeInScient: expect.any(String) } },
  ]);
});

it("leaves the fill to Accounts' import, which makes the rows first", async () => {
  state.profiles = [];
  state.filledFrom = [];
  const bridge = {
    importBrowserCookies: async () => ({ imported: 2, skipped: 0, skippedDomains: [] }),
    clearCookies: async () => undefined,
    clearCache: async () => undefined,
  };
  const source = { id: "chrome" as const, name: "Chrome", profiles: [] };
  await importBrowserCookiesIntoTarget(bridge, source, EnvironmentId.make("synthetic"), {
    sourceProfileDirectory: "Default",
    target: { kind: "new", profileId: "profile-accounts" },
    profileName: "Personal",
    fillMain: false,
  });
  expect(state.filledFrom).toEqual([]);
});
