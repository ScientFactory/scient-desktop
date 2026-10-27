import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type BrowserProfile } from "@t3tools/contracts";
import { importBrowserCookiesIntoTarget } from "~/components/settings/IntegrationsSettings";

const state = vi.hoisted(() => ({ profiles: [] as ReadonlyArray<BrowserProfile> }));
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
