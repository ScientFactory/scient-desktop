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
  capturedSignInInput,
  profilePresentation,
  importProfileName,
  matchingAccounts,
  mergeProfiles,
  mergeSourceProfiles,
  secretFields,
  siteMatchesUrl,
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

  it("keeps autofill in the account's profile, including the implicit default", () => {
    const defaultAccount = website();
    const work = website("work");
    const api: AccountSummary = {
      ...website(),
      details: { kind: "api-key", sites: ["example.com"], auth: { type: "bearer" } },
    };
    expect(matchingAccounts([defaultAccount, work, api], "https://example.com", "work")).toEqual([
      work,
    ]);
    expect(matchingAccounts([defaultAccount, work], "https://example.com", "default")).toEqual([
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
  it("updates a captured sign-in only for the same profile, site and username", () => {
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
    expect(capturedSignInInput({ ...capture, profileId: "personal" }, [own]).details).toMatchObject(
      { sites: ["https://example.com"], profileId: "personal" },
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
