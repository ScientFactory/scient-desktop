import { describe, expect, it } from "vite-plus/test";
import {
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  AccountId,
  defaultAccountControls,
  defaultBrowserProfileRecord,
  type AccountSummary,
} from "@t3tools/contracts";
import {
  accountCatalogue,
  catalogueDetails,
  accountIconUrl,
  capturedSignInInput,
  automaticSignIn,
  writableOnePasswordVaults,
  profilePresentation,
  importProfileName,
  matchingAccounts,
  mergeProfiles,
  mergeSourceProfiles,
  secretFields,
  siteMatchesUrl,
  matchExistingProfile,
} from "./accountsView";

function website(profileId?: string): AccountSummary {
  return {
    accountId: AccountId.make("acc_synthetic01"),
    name: "Example",
    details: { kind: "website", sites: ["example.com"], ...(profileId ? { profileId } : {}) },
    secrets: {},
    controls: defaultAccountControls("website"),
    status: "ready",
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
}

describe("Accounts decisions", () => {
  it("matches only secure origins and domain boundaries", () => {
    expect(siteMatchesUrl("example.com", "https://login.example.com/sign-in")).toBe(true);
    expect(siteMatchesUrl("example.com", "https://notexample.com")).toBe(false);
    expect(siteMatchesUrl("example.com", "http://example.com")).toBe(false);
    expect(siteMatchesUrl("https://example.com:8443", "https://example.com:8443/login")).toBe(true);
    expect(siteMatchesUrl("https://example.com:8443", "https://example.com/login")).toBe(false);
    expect(siteMatchesUrl("example.com", "not a URL")).toBe(false);
  });

  it("offers a site's accounts in any profile, the tab's own profile first", () => {
    const defaultAccount = website();
    const work = website("work");
    const api: AccountSummary = {
      ...website(),
      details: { kind: "api-key", sites: ["example.com"], auth: { type: "bearer" } },
    };
    expect(matchingAccounts([defaultAccount, work, api], "https://example.com", "work")).toEqual([
      work,
      defaultAccount,
    ]);
    expect(matchingAccounts([work], "https://other.example.org", "work")).toEqual([]);
  });

  it("merges server controls by profile id and supplies legacy defaults without incognito", () => {
    const off = { ...defaultBrowserProfileRecord("work"), access: "off" as const };
    const result = mergeProfiles([{ id: "work", name: "Work", kind: "persistent" }], [off]);
    expect(result.find((profile) => profile.id === "work")?.record.access).toBe("off");
    expect(result.find((profile) => profile.id === "default")?.record.scriptSignIn).toBe(true);
    expect(result.some((profile) => profile.kind === "incognito")).toBe(false);
  });

  it("joins import metadata by browser and directory, preserving unmatched and deduplicating sources", () => {
    const result = mergeSourceProfiles(
      [
        {
          id: "chrome",
          name: "Chrome",
          profiles: [
            { directory: "Default", name: "Local" },
            { directory: "Default", name: "Local" },
            { directory: "Profile 1", name: "Other" },
          ],
        },
      ],
      [
        { sourceId: "firefox", directory: "Default", name: "Wrong browser" },
        { sourceId: "chrome", directory: "Default", name: "Work", email: "synthetic@example.com" },
      ],
    );
    expect(result[0]?.profiles.map((profile) => profile.name)).toEqual(["Work", "Other"]);
    expect(result[0]?.profiles[0]?.email).toBe("synthetic@example.com");
  });

  it("names imports after source profiles and resolves collisions within the name limit", () => {
    const taken = ["Work", "Work 2"];
    expect(importProfileName("Work", taken)).toBe("Work 3");
    expect(importProfileName("Personal", taken)).toBe("Personal");
    const long = "x".repeat(BROWSER_PROFILE_NAME_MAX_LENGTH);
    const name = importProfileName(long, [long]);
    expect(name.length).toBeLessThanOrEqual(BROWSER_PROFILE_NAME_MAX_LENGTH);
    expect(name.endsWith(" 2")).toBe(true);
    expect(importProfileName(" ", [])).toBe("Profile");
  });

  it("derives kind-specific forms and secret fields from catalogue choices", () => {
    const forms = accountCatalogue.map((entry) => catalogueDetails(entry));
    expect(forms.find((form) => form.kind === "database")).toMatchObject({
      engine: "postgres",
      port: 5432,
    });
    expect(forms.find((form) => form.kind === "library")).toMatchObject({ proxyUrl: "" });
    const anthropic = forms.find(
      (form) => form.kind === "api-key" && form.envName === "ANTHROPIC_API_KEY",
    );
    expect(anthropic).toMatchObject({ auth: { type: "header", name: "x-api-key" } });
    expect(secretFields(catalogueDetails(null, "example.com"))).toEqual(["password", "totp"]);
    const gh = forms.find((form) => form.kind === "cli-login" && form.tool === "gh");
    expect(gh && secretFields(gh)).toEqual(["GH_TOKEN"]);
    expect(
      secretFields({
        kind: "cli-login",
        tool: "other",
        variables: [{ name: "PUBLIC", secret: false }],
      }),
    ).toEqual([]);
  });
  it("updates the saved sign-in with the same site and username, in any profile", () => {
    const own = {
      ...website("work"),
      details: {
        kind: "website" as const,
        sites: ["example.com"],
        profileId: "work",
        username: "synthetic",
      },
    };
    const capture = {
      tabId: "synthetic-tab",
      profileId: "work",
      url: "https://example.com/login",
      username: "synthetic",
      password: "synthetic-password",
    };
    expect(capturedSignInInput(capture, [own]).accountId).toBe(own.accountId);
    expect(
      capturedSignInInput({ ...capture, username: "someone-else" }, [own]).accountId,
    ).toBeUndefined();
    expect(capturedSignInInput({ ...capture, profileId: "personal" }, [own]).accountId).toBe(
      own.accountId,
    );
  });
  it("accepts only inline profile pictures and validated source colours", () => {
    expect(
      profilePresentation({ picture: "https://example.com/avatar.png", color: "invalid" }),
    ).toEqual({ picture: undefined, color: undefined });
    expect(
      profilePresentation({ picture: "data:image/png;base64,AA==", color: "#abcdef" }),
    ).toEqual({ picture: "data:image/png;base64,AA==", color: "#abcdef" });
    expect(profilePresentation({})).toEqual({ picture: undefined, color: undefined });
  });
});

it("ranks exact-origin sign-ins before recent domain matches and refuses repeated, incognito or edited autofill", () => {
  const recent = {
    ...website("default"),
    accountId: AccountId.make("acc_recent01"),
    lastUsedAt: "2026-10-26T10:00:00.000Z",
  };
  const exact = {
    ...website("default"),
    accountId: AccountId.make("acc_exact001"),
    details: { kind: "website" as const, sites: ["https://example.com"], profileId: "default" },
  };
  const older = {
    ...recent,
    accountId: AccountId.make("acc_older001"),
    lastUsedAt: "2026-10-25T10:00:00.000Z",
  };
  expect(
    matchingAccounts([older, recent, exact], "https://example.com/login", "default").map(
      (account) => account.accountId,
    ),
  ).toEqual([exact.accountId, recent.accountId, older.accountId]);
  const current = { tabId: "tab", profileId: "default", url: "https://example.com/login" };
  const form = {
    ...current,
    url: "https://example.com",
    documentId: "document",
    userEdited: false,
    hasValues: false,
  };
  expect(automaticSignIn(form, current, null)).toBe(true);
  expect(automaticSignIn(form, current, form.documentId)).toBe(false);
  expect(automaticSignIn({ ...form, userEdited: true }, current, null)).toBe(false);
  expect(automaticSignIn({ ...form, hasValues: true }, current, null)).toBe(false);
  expect(
    automaticSignIn(
      { ...form, profileId: "incognito" },
      { ...current, profileId: "incognito" },
      null,
    ),
  ).toBe(false);
  expect(automaticSignIn(form, { ...current, url: "https://other.example.com" }, null)).toBe(false);
});

it("offers connected vaults until a write rejection marks one read-only", () => {
  expect(
    writableOnePasswordVaults({
      state: "connected",
      mode: "desktop",
      label: "Synthetic",
      vaults: [
        { id: "blocked", name: "Blocked", readOnly: true },
        { id: "available", name: "Available", readOnly: false },
      ],
    }).map((vault) => vault.id),
  ).toEqual(["available"]);
  expect(writableOnePasswordVaults({ state: "not-connected" })).toEqual([]);
});

describe("matchExistingProfile", () => {
  const chrome = {
    id: "chrome" as const,
    name: "Chrome",
    profiles: [
      { directory: "Default", name: "Work" },
      { directory: "Profile 1", name: "Personal" },
    ],
  };
  const firefox = {
    id: "firefox" as const,
    name: "Firefox",
    profiles: [{ directory: "a", name: "Main" }],
  };

  it.each([
    ["the only source profile with the same name", "work", [chrome, firefox], "Work"],
    ["the only profile of the browser it was named after", "Firefox 2", [chrome, firefox], "Main"],
    ["nothing when the browser has several profiles", "Chrome", [chrome, firefox], undefined],
    [
      "nothing when the name is ambiguous",
      "Work",
      [chrome, { ...firefox, profiles: [{ directory: "b", name: "Work" }] }],
      undefined,
    ],
  ])("returns %s", (_, name, sources, expected) => {
    expect(matchExistingProfile(name, sources)?.profile.name).toBe(expected);
  });
});

it("finds bundled logos by domain and parent domain, and none for unknown sites", () => {
  expect(accountIconUrl(["github.com"])).toMatch(/^data:image\//);
  expect(accountIconUrl(["api.openai.com"])).toMatch(/^data:image\//);
  expect(accountIconUrl(["https://moodle.huji.ac.il/my"])).toMatch(/^data:image\//);
  expect(accountIconUrl([], "Postgres database")).toMatch(/^data:image\//);
  expect(accountIconUrl(["unknown.example"])).toBeUndefined();
  expect(accountIconUrl([])).toBeUndefined();
});
