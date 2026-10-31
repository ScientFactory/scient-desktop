import { describe, expect, it } from "vite-plus/test";
import {
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  AccountId,
  defaultAccountControls,
  defaultBrowserProfileRecord,
  type AccountSummary,
  type ProjectId,
} from "@t3tools/contracts";
import {
  accountStatusLabel,
  fillableAccounts,
  isBrowserSignIn,
  signedOutOfGoogle,
  sitesToKeep,
  activityLine,
  keysInUse,
  agentMayUse,
  libraryLinkTemplate,
  accountListRows,
  providerManagedAccounts,
  accountCatalogue,
  catalogueDetails,
  accountIconUrl,
  accountManagePage,
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
  changedSourceProfile,
  toggleScope,
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

  it("fills from saved sign-ins only, never a browser sign-in with nothing to type", () => {
    const google = {
      ...website("work"),
      details: {
        kind: "website" as const,
        sites: ["google.com"],
        username: "a@example.com",
        profileId: "work",
      },
    };
    const saved = {
      ...website(),
      details: {
        kind: "website" as const,
        sites: ["accounts.google.com"],
        username: "a@example.com",
      },
      secrets: { password: { source: { type: "scient" as const } } },
    };
    expect(fillableAccounts([google, saved], "https://accounts.google.com/", "work")).toEqual([
      saved,
    ]);
  });

  it("groups Google rows with browser sign-ins, and says when a profile lost Google", () => {
    const google = (state: "signed-in" | "signed-out", profileId = "work") => ({
      ...website(profileId),
      details: {
        kind: "website" as const,
        sites: ["google.com"],
        username: "a@example.com",
        profileId,
      },
      lastCheck: { state, at: "2026-10-31T00:00:00.000Z" },
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

  it("keeps working sign-ins and any Google session out of a refresh, per profile", () => {
    const row = (site: string, profileId: string, state?: "signed-in" | "signed-out") => ({
      ...website(profileId),
      details: { kind: "website" as const, sites: [site], profileId },
      ...(state ? { lastCheck: { state, at: "2026-10-31T00:00:00.000Z" } } : {}),
    });
    expect(
      sitesToKeep(
        [
          row("github.com", "work", "signed-in"),
          row("overleaf.com", "work", "signed-out"),
          row("nature.com", "work"),
          row("google.com", "work", "signed-out"),
          row("arxiv.org", "home", "signed-in"),
        ],
        "work",
      ),
    ).toEqual(["github.com", "google.com"]);
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
  };
  expect(automaticSignIn(form)).toBe(true);
  expect(automaticSignIn({ ...form, userEdited: true })).toBe(false);
  expect(automaticSignIn({ ...form, hasValues: true })).toBe(false);
  expect(automaticSignIn({ ...form, profileId: "incognito" })).toBe(false);
  expect(automaticSignIn({ ...form, url: "http://example.com" })).toBe(false);
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
  expect(
    providerManagedAccounts([base, codex]).map((row) => [row.kind, row.name, row.instanceId]),
  ).toEqual([
    ["claude", "Signed in", base.instanceId],
    ["codex", "Connected app", codex.instanceId],
  ]);
  expect(
    providerManagedAccounts([
      { ...base, mcpServers: [] },
      { ...codex, plugins: [] },
    ]),
  ).toEqual([]);
  expect(
    providerManagedAccounts([
      { ...base, enabled: false },
      { ...codex, installed: false },
    ]),
  ).toEqual([]);
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

it("lists one row per site for sign-ins kept only as profile sessions", () => {
  const signIn = (id: string, site: string, profileId: string) => ({
    ...website(profileId),
    accountId: AccountId.make(`acc_${id}`.padEnd(12, "0")),
    name: site,
    details: { kind: "website" as const, sites: [site], profileId },
  });
  const docs = signIn("docs1", "https://docs.google.com", "yaacov");
  const password = { ...website(), secrets: { password: { source: { type: "scient" as const } } } };
  const rows = accountListRows([
    docs,
    password,
    signIn("docs2", "docs.google.com", "work"),
    signIn("ovl", "overleaf.com", "work"),
  ]);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveLength(2);
  expect(rows[1]).toBe(password);
  expect(rows[2]).toMatchObject({ name: "overleaf.com" });
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
    expect(
      accountStatusLabel(
        { lastSignInOutcome: "password-rejected", lastCheck: { state: "signed-in", at } },
        relative,
      ),
    ).toBe("Password rejected");
    expect(
      accountStatusLabel({ signedOut: true, lastCheck: { state: "signed-in", at } }, relative),
    ).toBe("Signed out");
    expect(accountStatusLabel({ lastCheck: { state: "signed-in", at } }, relative)).toBe(
      "Signed in · 2h ago",
    );
    expect(accountStatusLabel({ lastCheck: { state: "needs-you", at } }, relative)).toBe(
      "Needs you",
    );
    expect(accountStatusLabel({}, relative)).toBeNull();
    expect(
      accountStatusLabel(
        {
          details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
          lastCheck: { state: "rejected", at },
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
  });
});

describe("keys used by Scient", () => {
  it("lists secret variables by name, one row per name, and never ordinary settings", () => {
    const keys = keysInUse(
      {
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
          environment: [{ name: "OPENAI_API_KEY", sensitive: true }],
        },
      },
      [{ name: "Groq" }],
      () => "Codex",
    );
    expect(keys.map((key) => [key.name, key.usedBy])).toEqual([
      ["OPENAI_API_KEY", ["Codex", "Work"]],
      ["Groq", ["Custom models"]],
    ]);
    expect(keys[0]?.variables).toHaveLength(2);
  });
});
