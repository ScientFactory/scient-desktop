import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type BrowserProfile } from "@t3tools/contracts";
import { importBrowserCookiesIntoTarget } from "~/components/settings/IntegrationsSettings";

const state = vi.hoisted(() => ({
  profiles: [] as ReadonlyArray<BrowserProfile>,
  filledFrom: [] as string[],
  importedIntoMain: [] as string[],
}));
vi.mock("./mainFill", () => ({
  fillMainFromProfile: async (_environmentId: string, profileId: string) =>
    void state.filledFrom.push(profileId),
  importIntoMain: async (_environmentId: string, _source: string, directory: string) => {
    state.importedIntoMain.push(directory);
    return {
      units: [
        { sites: ["github.com"], outcome: "copied" },
        { sites: ["gitlab.com"], outcome: "conflict" },
      ],
      unsupported: 1,
    };
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ browserProfiles: state.profiles }),
  persistClientSettingsUpdate: async (
    update: (current: { browserProfiles: ReadonlyArray<BrowserProfile> }) => {
      browserProfiles: ReadonlyArray<BrowserProfile>;
    },
  ) => {
    state.profiles = update({ browserProfiles: state.profiles }).browserProfiles;
    return { browserProfiles: state.profiles };
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
  expect(intoMain).toEqual({
    kind: "imported",
    imported: 1,
    importedSites: 1,
    skipped: 2,
    skippedDomains: ["gitlab.com"],
    targetName: "Main",
  });
});
