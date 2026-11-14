import { describe, expect, it } from "vite-plus/test";
import {
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  AccountId,
  BrowserProfileId,
  defaultAccountControls,
  defaultBrowserProfileRecord,
  type AccountSummary,
  type ConnectorSummary,
  ConnectorId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  accountStatusLabel,
  fillableAccounts,
  isBrowserSignIn,
  renamedSourceLabel,
  signedOutOfGoogle,
  sitesToKeep,
  activityLine,
  apiKeyRows,
  onlyIn,
  keptAgentKeys,
  agentMayUse,
  libraryLinkTemplate,
  githubIdentities,
  providerManagedAccounts,
  steadyProviderRows,
  type ProviderRowsCache,
  accountCatalogue,
  catalogueDetails,
  accountIconUrl,
  profileAddressDomain,
  profileSignInSites,
  accountManagePage,
  capturedSignInInput,
  automaticSignIn,
  fillChoice,
  writableOnePasswordVaults,
  profilePresentation,
  importProfileName,
  importedLabel,
  matchingAccounts,
  mergeProfiles,
  mergeSourceProfiles,
  secretFields,
  matchExistingProfile,
  foldedNotice,
  unlistedProfiles,
  changedSourceProfile,
  toggleScope,
} from "./accountsView";
import { keptAgentOf } from "@t3tools/contracts";
import { siteMatchesUrl } from "@t3tools/shared/scientSiteMatch";

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

  it("fills from saved sign-ins, a username saved by hand included, never a browser sign-in", () => {
    const google = {
      ...website("work"),
      details: {
        kind: "website" as const,
        sites: ["google.com"],
        username: "a@example.com",
        profileId: "work",
        origin: "browser-session" as const,
      },
    };
    const byHand = (profileId?: string) => ({
      ...website(profileId),
      details: {
        kind: "website" as const,
        sites: ["google.com"],
        username: "b@example.com",
        ...(profileId ? { profileId } : {}),
      },
    });
    const saved = {
      ...website(),
      details: {
        kind: "website" as const,
        sites: ["accounts.google.com"],
        username: "a@example.com",
      },
      secrets: { password: { source: { type: "scient" as const } } },
    };
    expect(
      fillableAccounts(
        [google, saved, byHand(), byHand("work")],
        "https://accounts.google.com/",
        "work",
      ),
    ).toEqual([byHand("work"), saved, byHand()]);
  });

  it("groups rows recorded from sessions with browser sign-ins, and says when a profile lost Google", () => {
    const google = (state: "signed-in" | "signed-out", profileId = "work") => ({
      ...website(profileId),
      details: {
        kind: "website" as const,
        sites: ["google.com"],
        username: "a@example.com",
        profileId,
        origin: "browser-session" as const,
      },
      signIn: { state, at: "2026-10-31T00:00:00.000Z" },
    });
    expect(isBrowserSignIn(google("signed-in"))).toBe(true);
    expect(
      isBrowserSignIn({
        ...website("work"),
        details: { ...website("work").details, username: "a" },
      } as AccountSummary),
    ).toBe(false);
    expect(signedOutOfGoogle([google("signed-out")], "work")).toBe(true);
    expect(signedOutOfGoogle([google("signed-out"), google("signed-in")], "work")).toBe(false);
    expect(signedOutOfGoogle([google("signed-out", "home")], "work")).toBe(false);
    expect(signedOutOfGoogle([], "work")).toBe(false);
  });

  it("keeps working sign-ins and a working Google session out of a refresh, per profile", () => {
    const row = (site: string, profileId: string, state?: "signed-in" | "signed-out") => ({
      ...website(profileId),
      details: { kind: "website" as const, sites: [site], profileId },
      ...(state ? { signIn: { state, at: "2026-10-31T00:00:00.000Z" } } : {}),
    });
    expect(
      sitesToKeep(
        [
          row("github.com", "work", "signed-in"),
          row("overleaf.com", "work", "signed-out"),
          row("nature.com", "work"),
          row("google.com", "work"),
          row("arxiv.org", "home", "signed-in"),
        ],
        "work",
      ),
    ).toEqual(["github.com", "google.com"]);
    // Google signed this profile out: the browser's sign-in replaces it.
    expect(
      sitesToKeep(
        [row("github.com", "work", "signed-in"), row("google.com", "work", "signed-out")],
        "work",
      ),
    ).toEqual(["github.com"]);
    // What Google says now wins over what Accounts last saw.
    expect(sitesToKeep([row("google.com", "work")], "work", false)).toEqual([]);
    expect(sitesToKeep([row("google.com", "work", "signed-in")], "work", false)).toEqual([]);
    expect(sitesToKeep([row("google.com", "work", "signed-out")], "work", true)).toEqual([
      "google.com",
    ]);
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

  it("keeps running-browser profiles discoverable from desktop metadata without treating them as importable", () => {
    const result = mergeSourceProfiles(
      [{ id: "chrome", name: "Chrome", profiles: [], unavailable: "browserRunning" }],
      [
        {
          sourceId: "chrome",
          directory: "Profile 1",
          name: "Work",
          email: "synthetic@example.invalid",
        },
      ],
    );
    expect(result[0]?.profiles.map((profile) => profile.name)).toEqual(["Work"]);
    expect(result[0]?.unavailable).toBe("browserRunning");
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

  it("says an empty import brought nothing, and counts cookies when sites can't be read", () => {
    expect(importedLabel(0, 0)).toBe("nothing to import");
    expect(importedLabel(3, undefined)).toBe("3 cookies");
    expect(importedLabel(3, 0)).toBe("3 cookies");
  });

  it("derives kind-specific forms and secret fields from catalogue choices", () => {
    const forms = accountCatalogue.map((entry) => catalogueDetails(entry));
    expect(forms.find((form) => form.kind === "database")).toMatchObject({
      engine: "postgres",
      port: 5432,
    });
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
      path: "/login",
      step: "password" as const,
      username: "synthetic",
      password: "synthetic-password",
      usernameFrom: "form" as const,
    };
    expect(capturedSignInInput(capture, []).details).toEqual({
      kind: "website",
      sites: ["https://example.com"],
      username: "synthetic",
      profileId: "work",
    });
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
  const form = {
    tabId: "tab",
    profileId: "default",
    url: "https://example.com",
    documentId: "document",
    userEdited: false,
    hasPassword: true,
    hasValues: false,
    boxes: [],
  };
  expect(automaticSignIn(form)).toBe(true);
  expect(automaticSignIn({ ...form, userEdited: true })).toBe(false);
  expect(automaticSignIn({ ...form, hasValues: true })).toBe(false);
  expect(automaticSignIn({ ...form, profileId: "incognito" })).toBe(false);
  expect(automaticSignIn({ ...form, url: "http://example.com" })).toBe(false);
});

it("fills each login box with a saved username that fits it", () => {
  const signIn = (username: string) => ({
    details: { kind: "website" as const, sites: ["idp.example.edu"], username },
    secrets: {},
  });
  const id = signIn("123456789");
  const email = signIn("person@example.edu");
  const emailBox = { email: true, minLength: -1, maxLength: -1, pattern: "" };
  const idBox = { email: false, minLength: 9, maxLength: 9, pattern: "" };
  const textBox = { email: false, minLength: -1, maxLength: -1, pattern: "" };
  // An ID beside an email: both, whichever row comes first.
  expect(fillChoice([id, email], [emailBox, idBox])).toEqual({
    account: email,
    otherUsername: "123456789",
  });
  // Only IDs saved: the ID goes to its box, the email box stays empty.
  expect(fillChoice([id], [emailBox, idBox])).toEqual({ account: id, otherUsername: undefined });
  // A box for a 9-digit ID takes the ID row even when an email row comes first.
  expect(fillChoice([email, id], [{ ...textBox, pattern: "[0-9]{9}" }]).account).toBe(id);
  expect(fillChoice([email, id], [textBox]).account).toBe(email);
});

it("fills the newest saved password of the username, and never one the site refused", () => {
  const row = (changedAt?: string, signIn?: AccountSummary["signIn"]) => ({
    details: { kind: "website" as const, sites: ["idp.example.edu"], username: "a@example.edu" },
    secrets: {
      password: {
        source: { type: "scient" as const },
        ...(changedAt ? { changedAt } : {}),
      },
    },
    ...(signIn ? { signIn } : {}),
  });
  const box = [{ email: true, minLength: -1, maxLength: -1, pattern: "" }];
  const older = row("2023-01-01T00:00:00.000Z");
  const newer = row("2025-01-01T00:00:00.000Z");
  expect(fillChoice([older, newer], box).account).toBe(newer);
  // Imported before dates were kept: the one that last worked, never a refused one.
  const worked = row(undefined, { state: "signed-in", at: "2025-02-01T00:00:00.000Z" });
  const refused = row(undefined, { state: "password-rejected", at: "2025-03-01T00:00:00.000Z" });
  expect(fillChoice([row(), refused, worked], box).account).toBe(worked);
  expect(fillChoice([refused], box).account).toBeUndefined();
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

describe("a profile merged into Main", () => {
  it("is named for a week for Undo, and listed nowhere, its rows' entry included", () => {
    const at = "2026-11-07T10:00:00.000Z";
    const retired = (id: string, name: string) => ({
      ...defaultBrowserProfileRecord(BrowserProfileId.make(id)),
      retired: { at, into: "main" as const, name },
    });
    const snapshot = {
      profiles: [retired("personal", "Personal"), retired("research", "Research")],
      accounts: [website("research")],
    };
    const now = Date.parse(at);
    expect(foldedNotice(snapshot, now)?.text).toBe("Merged into Main: Personal, Research.");
    expect(foldedNotice(snapshot, now + 8 * 24 * 60 * 60 * 1000)).toBeUndefined();
    expect(foldedNotice({ profiles: [] }, now)).toBeUndefined();
    // Still in this client's list while the merge finishes: hidden all the same.
    const listed = mergeProfiles(
      [{ id: "personal", name: "Personal", kind: "persistent" }],
      snapshot.profiles,
    );
    expect(listed.map(({ id }) => id)).toEqual(["default"]);
    expect(unlistedProfiles(snapshot, listed)).toEqual([]);
  });
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

describe("changedSourceProfile", () => {
  const record = {
    ...defaultBrowserProfileRecord("profile-work"),
    picture: "data:image/png;base64,AAAA",
    source: {
      browser: "chrome" as const,
      profileName: "Work",
      directory: "Profile 4",
      importedAt: "2026-10-28T00:00:00.000Z",
    },
  };
  const chrome = (profile: { name: string; picture?: string; directory?: string }) => [
    {
      id: "chrome" as const,
      name: "Chrome",
      profiles: [{ directory: "Profile 4", ...profile }],
    },
  ];

  it.each([
    ["a new picture", { name: "Work", picture: "data:image/png;base64,BBBB" }, "Work"],
    ["a rename in the source browser, by folder", { name: "HUJI" }, "HUJI"],
    ["nothing when unchanged", { name: "Work", picture: record.picture }, undefined],
    ["nothing when the folder is gone", { name: "Work", directory: "Profile 9" }, undefined],
  ])("returns %s", (_, profile, expected) => {
    expect(changedSourceProfile(record, chrome(profile))?.name).toBe(expected);
  });
});

it("finds bundled logos by domain and parent domain, and none for unknown sites", () => {
  expect(accountIconUrl(["github.com"])).toMatch(/^data:image\//);
  expect(accountIconUrl(["api.openai.com"])).toMatch(/^data:image\//);
  expect(accountIconUrl(["https://moodle.huji.ac.il/my"])).toMatch(/^data:image\//);
  expect(accountIconUrl([], "Postgres database")).toMatch(/^data:image\//);
  expect(accountIconUrl(["unknown.example"])).toBeUndefined();
  expect(accountIconUrl([])).toBeUndefined();
  expect(accountManagePage(["api.openai.com"])).toEqual({
    domain: "openai.com",
    url: "https://platform.openai.com/api-keys",
  });
  expect(accountManagePage(["huggingface.co.attacker.test"])).toBeUndefined();
});

describe("toggleScope", () => {
  const a = "project-a" as ProjectId;
  const b = "project-b" as ProjectId;
  it.each([
    [
      "all → untick a keeps b",
      { type: "all-projects" },
      { type: "project", projectId: a },
      false,
      { type: "projects", projectIds: [b] },
    ],
    [
      "selected → tick b adds it",
      { type: "projects", projectIds: [a] },
      { type: "project", projectId: b },
      true,
      { type: "projects", projectIds: [a, b] },
    ],
    [
      "untick All projects leaves none",
      { type: "all-projects" },
      { type: "all" },
      false,
      { type: "projects", projectIds: [] },
    ],
    [
      "tick All projects",
      { type: "projects", projectIds: [a] },
      { type: "all" },
      true,
      { type: "all-projects" },
    ],
  ] as const)("%s", (_, scope, entry, checked, expected) => {
    expect(toggleScope(scope, [a, b], entry, checked)).toEqual(expected);
  });
});

it("lists only signed-in provider connections, deduplicating apps across plugins", () => {
  const base: ServerProvider = {
    instanceId: ProviderInstanceId.make("synthetic-claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-27T00:00:00.000Z",
    version: null,
    models: [],
    slashCommands: [],
    skills: [],
    mcpServers: [
      { name: "Signed in", status: "connected", scope: "claudeai" },
      { name: "Sign in required", status: "needs-auth", scope: "claudeai" },
      { name: "Local server", status: "connected", scope: "local" },
      { name: "Unknown", status: "unknown", scope: "claudeai" },
    ],
  };
  const apps = [
    { name: "Connected app", connected: true, enabled: false },
    { name: "Available app", connected: false, enabled: true },
  ];
  const codex = {
    ...base,
    instanceId: ProviderInstanceId.make("synthetic-codex"),
    driver: ProviderDriverKind.make("codex"),
    plugins: [
      { id: "first", name: "First", source: "local" as const, enabled: true, apps },
      { id: "second", name: "Second", source: "local" as const, enabled: false, apps },
    ],
  };
  const rows = (
    providers: ReadonlyArray<ServerProvider>,
    previous = new Map() as Parameters<typeof providerManagedAccounts>[2],
    inventory = providers,
  ) => providerManagedAccounts(providers, inventory, previous);
  const droid = {
    ...base,
    instanceId: ProviderInstanceId.make("synthetic-droid"),
    driver: ProviderDriverKind.make("droid"),
    mcpServers: [
      { name: "Linear", status: "connected" as const, signedIn: true },
      { name: "Local tools", status: "connected" as const },
      { name: "Notion", status: "needs-auth" as const },
    ],
  };
  const first = rows([base, codex]);
  expect(first.rows.map((row) => [row.kind, row.name, row.instanceId])).toEqual([
    ["codex", "Connected app", codex.instanceId],
    ["claude", "Signed in", base.instanceId],
  ]);
  // Droid's own word that it holds the sign-in; a local server or one asking to sign in is not.
  expect(rows([droid]).rows.map((row) => [row.kind, row.name, row.instanceId])).toEqual([
    ["droid", "Linear", droid.instanceId],
  ]);
  // Scient Agent's own ChatGPT sign-in reports the ChatGPT apps it reaches; its MCP settings do not count.
  const scient = {
    ...base,
    instanceId: ProviderInstanceId.make("synthetic-scient"),
    driver: ProviderDriverKind.make("scient"),
    mcpServers: [
      { name: "Gmail", status: "connected" as const, scope: "chatgpt", signedIn: true },
      { name: "local-files", status: "unknown" as const, scope: "user" },
    ],
  };
  expect(rows([scient]).rows.map((row) => [row.kind, row.name, row.instanceId])).toEqual([
    ["scient", "Gmail", scient.instanceId],
  ]);
  expect(
    rows([
      { ...base, mcpServers: [] },
      { ...codex, plugins: [] },
    ]).rows,
  ).toEqual([]);
  // Uninstalling or disabling an instance removes its rows, even from the kept list.
  expect(
    rows(
      [
        { ...base, enabled: false },
        { ...codex, installed: false },
      ],
      first.next,
    ).rows,
  ).toEqual([]);
  // A reset inventory (scope change) or Codex not yet reporting keeps the last known rows.
  expect(rows([base, codex], first.next, []).rows).toEqual(first.rows);
  expect(
    rows([base, codex], first.next, [base, (({ plugins: _, ...rest }) => rest)(codex)]).rows,
  ).toEqual(first.rows);
  // A Claude server still starting keeps its place; one that asks to sign in again leaves.
  const restarting = (status: "pending" | "needs-auth") => ({
    ...base,
    mcpServers: [{ name: "Signed in", status, scope: "claudeai" as const }],
  });
  expect(rows([restarting("pending"), codex], first.next).rows).toEqual(first.rows);
  expect(rows([restarting("pending"), codex]).rows.map((row) => row.kind)).toEqual(["codex"]);
  expect(rows([restarting("needs-auth"), codex], first.next).rows.map((row) => row.kind)).toEqual([
    "codex",
  ]);
});

it("shows a connector once when agents signed in to one account both report it", () => {
  const claude = (id: string, email?: string): ServerProvider => ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: email ? { status: "authenticated", email } : { status: "authenticated" },
    checkedAt: "2026-10-27T00:00:00.000Z",
    version: null,
    models: [],
    slashCommands: [],
    skills: [],
    mcpServers: [{ name: "claude.ai Claude Docs", status: "connected", scope: "claudeai" }],
  });
  const names = (providers: ReadonlyArray<ServerProvider>) =>
    providerManagedAccounts(providers, providers, new Map()).rows.map((row) => row.name);
  expect(names([claude("claude", "a@example.com"), claude("work", "a@example.com")])).toEqual([
    "Claude Docs",
  ]);
  expect(names([claude("claude", "a@example.com"), claude("work", "b@example.com")])).toEqual([
    "Claude Docs",
    "Claude Docs",
  ]);
  // No account reported: nothing says they are one connection.
  expect(names([claude("claude"), claude("work")])).toEqual(["Claude Docs", "Claude Docs"]);
});

it("keeps provider rows only under the connection and permission that read them", () => {
  const claude: ServerProvider = {
    instanceId: ProviderInstanceId.make("synthetic-claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-27T00:00:00.000Z",
    version: null,
    models: [],
    slashCommands: [],
    skills: [],
    mcpServers: [{ name: "Drive", status: "connected", scope: "claudeai" }],
  };
  const cache: ProviderRowsCache = new Map();
  const live = {
    connection: {} as object | null,
    canRead: true,
    permitted: true,
    providers: [claude],
  };
  const read = (change: Partial<typeof live> & { inventory?: ReadonlyArray<ServerProvider> }) =>
    steadyProviderRows(cache, "env", { ...live, inventory: [], ...change }).map((row) => row.name);
  expect(read({ inventory: [claude] })).toEqual(["Drive"]);
  expect(read({})).toEqual(["Drive"]);
  expect(read({ connection: {} })).toEqual([]);
  expect(read({ inventory: [claude] })).toEqual(["Drive"]);
  expect(read({ permitted: false })).toEqual([]);
  expect(read({})).toEqual([]);
  read({ inventory: [claude] });
  expect(read({ canRead: false })).toEqual([]);
  read({ inventory: [claude] });
  expect(read({ connection: null })).toEqual([]);
  expect(read({})).toEqual([]);
});

it("recognizes key prefixes without retaining values or guessing unknown keys", async () => {
  const { recognizeAccountKey } = await import("./accountsView");
  for (const [key, name] of [
    ["sk-ant-synthetic", "Anthropic"],
    ["sk-or-synthetic", "OpenRouter"],
    ["sk-proj-synthetic", "OpenAI"],
    ["sk-synthetic", "OpenAI"],
    ["hf_synthetic", "Hugging Face"],
    ["ghp_synthetic", "GitHub token"],
    ["github_pat_synthetic", "GitHub token"],
    ["gho_synthetic", "GitHub token"],
    ["glpat-synthetic", "GitLab token"],
    ["AIzaSynthetic", "Google Gemini"],
  ])
    expect(recognizeAccountKey(key!)?.name).toBe(name);
  expect(recognizeAccountKey("unknown")).toBeUndefined();
  expect(recognizeAccountKey("sk-")).toBeUndefined();
  expect(recognizeAccountKey("sk-synthetic extra")).toBeUndefined();
});

it("turns a link from the library into its pattern", () => {
  expect(
    libraryLinkTemplate(
      "https://go.openathens.net/redirector/huji.ac.il?url=https%3A%2F%2Fwww.nature.com%2Farticles%2Fx",
    ),
  ).toBe("https://go.openathens.net/redirector/huji.ac.il?url={url}");
  expect(libraryLinkTemplate("https://ezproxy.example.edu/login?url=https://doi.org/10.1/x")).toBe(
    "https://ezproxy.example.edu/login?url={url}",
  );
  expect(libraryLinkTemplate("https://proxy.example.edu/{url}")).toBe(
    "https://proxy.example.edu/{url}",
  );
});

it("lets an agent's tab fill only sign-ins that agent may use", () => {
  const project = "project-a" as ProjectId;
  const controls = defaultAccountControls("website");
  expect(agentMayUse(controls, true, project)).toBe(true);
  expect(agentMayUse(controls, false, project)).toBe(false);
  expect(agentMayUse({ ...controls, access: "off" }, true, project)).toBe(false);
  expect(agentMayUse({ ...controls, access: "ask" }, true, project)).toBe(false);
  expect(
    agentMayUse({ ...controls, access: "ask", allowedProjects: [project] }, true, project),
  ).toBe(true);
});

describe("account status", () => {
  const at = "2026-10-30T10:00:00.000Z";
  const relative = () => "2h ago";
  it("puts what needs the user first, then the last check", () => {
    // A refusal outlasts a session seen working (the server keeps it), so the row says so.
    expect(accountStatusLabel({ signIn: { state: "password-rejected", at } }, relative)).toBe(
      "Password rejected",
    );
    expect(accountStatusLabel({ signIn: { state: "signed-out", at } }, relative)).toBe(
      "Signed out",
    );
    expect(accountStatusLabel({ signIn: { state: "signed-in", at } }, relative)).toBe(
      "Signed in · 2h ago",
    );
    const session = (username?: string) => ({
      kind: "website" as const,
      sites: ["github.com"],
      ...(username ? { username } : {}),
    });
    expect(
      accountStatusLabel(
        { details: session("octo"), signIn: { state: "signed-in", at } },
        relative,
      ),
    ).toBe("Signed in as octo · 2h ago");
    // An imported or copied session was never seen working; anything else unknown wasn't read.
    expect(
      accountStatusLabel(
        { details: session(), signIn: { state: "unknown", at, from: "copy" } },
        relative,
      ),
    ).toBe("Copied");
    expect(
      accountStatusLabel(
        { details: session(), signIn: { state: "unknown", at, detail: "No answer." } },
        relative,
      ),
    ).toBe("Couldn't check");
    expect(
      accountStatusLabel(
        { signIn: { state: "unknown", at, detail: "Password changed", by: "action" } },
        relative,
      ),
    ).toBe("Password changed");
    expect(accountStatusLabel({ signIn: { state: "needs-you", at } }, relative)).toBe("Needs you");
    // A failed attempt holds automatic sign-ins: the row says what the person can do.
    expect(accountStatusLabel({ signIn: { state: "failed", at } }, relative)).toBe(
      "Sign in needed",
    );
    expect(accountStatusLabel({}, relative)).toBeNull();
    expect(
      accountStatusLabel(
        {
          details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
          signIn: { state: "failed", at, detail: "The service refused this key." },
        },
        relative,
      ),
    ).toBe("Key refused");
  });

  it("reads activity as what happened and where", () => {
    const entry = {
      at,
      target: { type: "account", accountId: AccountId.make("acc_fixture1") },
      action: "request",
      decision: "allowed",
      outcome: "ok",
    } as const;
    expect(activityLine(entry, "Data cleanup")).toBe("Made a request · Data cleanup");
    expect(activityLine({ ...entry, decision: "denied" }, undefined)).toBe(
      "Denied: made a request",
    );
    expect(
      activityLine({ ...entry, action: "sign-in", signInOutcome: "password-rejected" }, undefined),
    ).toBe("Password rejected");
    expect(activityLine({ ...entry, action: "sign-in", keptTyped: "kept" }, undefined)).toBe(
      "Kept the password you typed",
    );
  });
});

describe("API keys", () => {
  const key = (id: string, name: string, token: AccountSummary["secrets"][string]["source"]) =>
    ({
      accountId: AccountId.make(id),
      name,
      details: { kind: "api-key", sites: [], auth: { type: "bearer" }, envName: "OPENAI_API_KEY" },
      secrets: { token: { source: token } },
    }) as never as AccountSummary;
  const rows = apiKeyRows({
    accounts: [
      key("acc_openai01", "OpenAI", { type: "scient" }),
      key("acc_groq0001", "Groq", { type: "custom-model", connectionId: "groq" }),
      {
        accountId: AccountId.make("acc_site0001"),
        details: { kind: "website", sites: [] },
      } as never,
    ],
    keyLinks: [
      {
        accountId: AccountId.make("acc_openai01"),
        instanceId: "codex",
        variable: "OPENAI_API_KEY",
      },
      { accountId: AccountId.make("acc_gone0001"), instanceId: "work", variable: "HF_TOKEN" },
    ],
    instances: {
      codex: {
        driver: "codex",
        environment: [
          { name: "OPENAI_API_KEY", sensitive: true },
          { name: "CODEX_HOME", sensitive: false },
        ],
      },
      work: {
        driver: "omp",
        displayName: "Work",
        environment: [
          { name: "HF_TOKEN", sensitive: true },
          { name: "OPENAI_API_KEY", sensitive: true },
        ],
      },
    },
    customModelKeys: [
      { connectionId: "groq", name: "Groq" },
      { connectionId: "local", name: "Local", origin: "https://models.example" },
    ],
    plainKeys: [
      { file: "/p/.env", name: "WANDB_API_KEY", kept: false },
      { file: "/home/.zshrc", name: "WANDB_API_KEY", kept: false },
      { file: "/p/.env", name: "OPENAI_API_KEY", kept: true },
    ],
    driverName: () => "Codex",
  });

  it("shows each key once, with what uses it, and where a key not kept here lives", () => {
    expect(rows.map((row) => [row.name, row.uses.map((use) => use.label), onlyIn(row)])).toEqual([
      // Custom models keep their keys in Accounts' sealed store: kept, even without an account.
      ["Groq", ["Custom models"], undefined],
      ["Local", ["Custom models"], undefined],
      ["OpenAI", ["Codex"], undefined],
      // Its account was removed, so the variable's last key is only in the agent.
      ["HF_TOKEN", ["Work"], "Only in Work settings"],
      // Linked by agent and variable: Work's variable of the same name is its own key.
      ["OPENAI_API_KEY", ["Work"], "Only in Work settings"],
      // Each file's copy is its own row (their values may differ); one already in Accounts has none.
      ["WANDB_API_KEY", [], "Only in /p/.env"],
      ["WANDB_API_KEY", [], "Only in /home/.zshrc"],
    ]);
    expect(rows.find((row) => row.name === "OpenAI")?.uses[0]?.link).toEqual({
      instanceId: "codex",
      variable: "OPENAI_API_KEY",
    });
  });
});

describe("profileAddressDomain and profileSignInSites", () => {
  const signIn = (profileId: string, sites: string[], username?: string) =>
    ({ details: { kind: "website", profileId, sites, username } }) as never;
  const profile = (profileId: string, email?: string) =>
    ({ profileId, ...(email ? { source: { email } } : {}) }) as never;

  it("reads the imported address's domain and the profile's own sign-ins", () => {
    const snapshot = {
      profiles: [profile("work", "a@mail.huji.ac.il")],
      accounts: [
        signIn("work", ["google.com"], "b@cs.huji.ac.il"),
        signIn("work", ["moodle.huji.ac.il"]),
      ],
    };
    expect(profileAddressDomain(snapshot, "work")).toBe("mail.huji.ac.il");
    expect(profileSignInSites(snapshot, "work")).toEqual(["google.com", "moodle.huji.ac.il"]);
  });

  it("leaves out other profiles and passwords saved without a profile", () => {
    const snapshot = {
      profiles: [profile("work", "a@mail.huji.ac.il"), profile("home")],
      accounts: [
        signIn("work", ["huji.ac.il"]),
        { details: { kind: "website", sites: ["moodle.huji.ac.il"], username: "b" } } as never,
      ],
    };
    expect(profileAddressDomain(snapshot, "home")).toBeUndefined();
    expect(profileSignInSites(snapshot, "home")).toEqual([]);
  });

  it("has nothing to read before accounts load", () => {
    expect(profileAddressDomain(null, "work")).toBeUndefined();
    expect(profileSignInSites(null, "work")).toEqual([]);
  });
});

describe("a university's status", () => {
  const university = {
    details: {
      kind: "website",
      sites: ["huji.ac.il"],
      institution: { name: "HUJI", entityId: "https://idp.huji.ac.il/x", domain: "huji.ac.il" },
    },
  } as const;
  const when = () => "2h ago";

  it("speaks about the account, from never signed in to last seen", () => {
    expect(accountStatusLabel(university, when)).toBe("Not signed in yet");
    const check = (state: "signed-in" | "signed-out") => ({
      ...university,
      signIn: { state, at: "2026-01-01T00:00:00.000Z" },
    });
    // Also a session gone from the browser's cookies, which the server records as signed out.
    expect(accountStatusLabel(check("signed-out"), when)).toBe("Sign in needed");
    expect(accountStatusLabel(check("signed-in"), when)).toBe("Signed in · 2h ago");
  });
});

describe("githubIdentities", () => {
  const connector = (
    connectorId: string,
    auth: ConnectorSummary["auth"],
    status: ConnectorSummary["status"],
  ): ConnectorSummary => ({
    connectorId: ConnectorId.make(connectorId),
    serverName: "github",
    displayName: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    source: { type: "url" },
    auth,
    status,
    enabled: true,
    authRevision: 0,
    availability: { type: "all-projects" },
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
  });
  const borrowed = (account: string) =>
    ({ type: "source-control", host: "github.com", account }) as const;

  it("joins each observed login's uses, each with its own state, and leaves token rows apart", () => {
    const missing = connector("con_octo0001", borrowed("octo"), "needs-credential");
    const orphan = connector("con_gone0001", borrowed("gone"), "needs-credential");
    const identities = githubIdentities(
      [
        {
          kind: "github",
          id: "github.com:octo",
          name: "Octo",
          detail: "github.com",
          href: "/settings/source-control",
          via: "app",
        },
        {
          kind: "github",
          id: "github.com:second",
          name: "second",
          detail: "github.com",
          href: "/settings/source-control",
          via: "gh",
        },
        { kind: "custom-model", id: "m", name: "Model", href: "/settings/custom-models" },
      ],
      [
        missing,
        orphan,
        connector(
          "con_token001",
          { type: "credential", strategy: "bearer", storage: "owned" },
          "connected",
        ),
      ],
    );
    expect(identities).toEqual([
      {
        id: "github.com:octo",
        host: "github.com",
        login: "Octo",
        sourceControl: { via: "app" },
        connector: missing,
      },
      {
        id: "github.com:second",
        host: "github.com",
        login: "second",
        sourceControl: { via: "gh" },
      },
      { id: "github.com:gone", host: "github.com", login: "gone", connector: orphan },
    ]);
  });
});

describe("renamedSourceLabel", () => {
  it("names the source of an imported profile renamed here, and nothing otherwise", () => {
    const source = { browser: "chrome" as const, profileName: "Yaacov" };
    expect(renamedSourceLabel("Lab", source)).toBe("Chrome · Yaacov");
    expect(renamedSourceLabel("Yaacov", source)).toBeUndefined();
    expect(renamedSourceLabel("Lab", undefined)).toBeUndefined();
    expect(renamedSourceLabel("Work", { browser: "edge", profileName: "Profile 1" })).toBe(
      "Microsoft Edge · Profile 1",
    );
  });
});

it("offers back the latest key kept for each setting of this kind of agent", () => {
  const kept = (id: string, agent: string, setting: string, createdAt: string): AccountSummary => ({
    ...website(),
    accountId: AccountId.make(`acc_kept_${id}`),
    details: { kind: "api-key", sites: [], auth: { type: "bearer" }, keptFrom: { agent, setting } },
    createdAt,
  });
  const gemini = keptAgentOf({ driver: "acpRegistry", config: { agentId: "gemini" } });
  const older = kept("older01", gemini, "GEMINI_API_KEY", "2026-01-01T00:00:00.000Z");
  const newer = kept("newer01", gemini, "GEMINI_API_KEY", "2026-02-01T00:00:00.000Z");
  const field = kept("field01", gemini, "config.apiKey", "2026-01-01T00:00:00.000Z");
  const otherAgent = kept(
    "other01",
    "acpRegistry:qwen",
    "GEMINI_API_KEY",
    "2026-03-01T00:00:00.000Z",
  );
  expect(keptAgentKeys([newer, otherAgent, older, field, website()], gemini)).toEqual([
    newer,
    field,
  ]);
});
