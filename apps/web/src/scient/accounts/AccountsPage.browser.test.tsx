import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  defaultAccountControls,
  defaultBrowserProfileRecord,
  type AccountSummary,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { render } from "../../../test/render";
import { AccountRow, MainSiteChoice } from "./AccountsPage";
import { browserIconUrl, mergeProfiles } from "./accountsView";
import { BrowserProfiles, googleRecovery, ProfileDetail } from "./BrowserProfiles";
import { RemoteComputers } from "./RemoteComputers";

const state = vi.hoisted(() => ({
  open: vi.fn(),
  external: vi.fn(),
  settings: {} as Partial<ClientSettings>,
  calls: [] as unknown[],
  protocol: 1 as number | undefined,
  primary: "synthetic" as string | null,
  results: {} as Record<string, unknown>,
  environments: [] as unknown[],
  copy: vi.fn(),
}));
vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  useClientSettings: (select?: (settings: ClientSettings) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, ...state.settings };
    return select ? select(settings) : settings;
  },
  useClientSettingsHydrated: () => true,
  persistClientSettingsUpdate: async (update: (current: ClientSettings) => ClientSettings) => {
    state.settings = update({ ...DEFAULT_CLIENT_SETTINGS, ...state.settings });
    return state.settings;
  },
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => state.primary,
  useEnvironment: () => ({ label: "Lab server" }),
  useEnvironments: () => ({ environments: state.environments, isReady: true }),
}));

vi.mock("~/browser/openFileInPreview", () => ({ openUrlInPreview: state.open }));
vi.mock("./mainFill", async (original) => ({
  ...(await original<typeof import("./mainFill")>()),
  copySignInIntoMain: state.copy,
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.external } }),
  ensureLocalApi: () => ({ shell: { openExternal: state.external } }),
}));
vi.mock("~/hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    openScratchProject: async (environmentId: string) => ({
      environmentId,
      id: ProjectId.make("synthetic-project"),
    }),
  }),
}));
vi.mock("~/hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => ({ threadId: ThreadId.make("synthetic-thread") }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: {} }),
}));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({ data: { accountsProtocol: state.protocol }, canWrite: true }),
  useAccountCommand: (command: { label: string }) => async (input: unknown) => {
    state.calls.push(["record", input]);
    return { ok: true, value: state.results[command.label] ?? {} };
  },
  usePasswordStorePermission: () => true,
  toastAccountFailure: () => undefined,
}));

function fixture(platform = "MacIntel", desktop = true) {
  state.open.mockReset().mockResolvedValue({ _tag: "Success" });
  state.external.mockReset().mockResolvedValue(undefined);
  const bridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: desktop ? {} : undefined,
  });
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  return {
    [Symbol.dispose]() {
      if (bridge) Object.defineProperty(window, "desktopBridge", bridge);
      else Reflect.deleteProperty(window, "desktopBridge");
      if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
      else Reflect.deleteProperty(navigator, "platform");
    },
  };
}
const account: AccountSummary = {
  accountId: AccountId.make("acc_synthetic01"),
  name: "Synthetic",
  details: {
    kind: "website",
    sites: ["example.com"],
    loginUrl: "https://example.com/login",
    profileId: "work",
  },
  secrets: {
    password: { source: { type: "1password", reference: "op://Synthetic/Example/password" } },
    totp: { source: { type: "keychain", service: "synthetic", account: "synthetic" } },
  },
  controls: defaultAccountControls("website"),
  status: "ready",
  signIn: { state: "signed-out", at: "2026-10-26T00:00:00.000Z" },
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const row = (value = account) => (
  <AccountRow
    account={value}
    environmentId={EnvironmentId.make("synthetic")}
    canWrite
    onEdit={() => undefined}
    onActivity={() => undefined}
  />
);

it("signs in again through Scient, then removes the status and action once signed in", async () => {
  using _fixture = fixture();
  state.calls = [];
  state.protocol = 1;
  await using screen = await render(row());
  await expect.element(page.getByText("Signed out", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign in again", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.calls).toContainEqual([
      "record",
      { accountId: account.accountId, threadId: "synthetic-thread" },
    ]),
  );
  await screen.rerender(
    row({ ...account, signIn: { state: "signed-in", at: "2026-10-26T00:00:00.000Z" } }),
  );
  await expect.element(page.getByText("Signed out", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Sign in again", exact: true }))
    .not.toBeInTheDocument();
});

it("says once that new tabs now open in Main, until dismissed", async () => {
  using _fixture = fixture();
  state.settings = { mainDefaultNotice: true };
  const line = "New tabs now open in Main, which has your sign-ins. You can change this here.";
  const view = () => (
    <BrowserProfiles
      environmentId={EnvironmentId.make("synthetic")}
      snapshot={{ profiles: [], accounts: [] } as unknown as AccountsSnapshot}
      canWrite
      onImport={() => undefined}
      renderSignIn={() => null}
    />
  );
  try {
    await using screen = await render(view());
    await expect.element(page.getByText(line)).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await vi.waitFor(() => expect(state.settings.mainDefaultNotice).toBe(false));
    await screen.rerender(view());
    await expect.element(page.getByText(line)).not.toBeInTheDocument();
  } finally {
    state.settings = {};
  }
});

it("hides a profile merged into Main though this client lists it, and Undo brings it back", async () => {
  using _fixture = fixture();
  const personal = { id: "personal", name: "Personal", kind: "persistent" as const };
  state.settings = { browserProfiles: [personal] };
  state.calls = [];
  const merged = {
    ...defaultBrowserProfileRecord("personal"),
    color: "#2563eb",
    // Ahead of any clock this runs on, so always within the week the line is shown.
    retired: { at: "2100-01-01T00:00:00.000Z", into: "main" as const, name: "Personal" },
  };
  try {
    await using _screen = await render(
      <BrowserProfiles
        environmentId={EnvironmentId.make("synthetic")}
        snapshot={{ profiles: [merged], accounts: [] } as unknown as AccountsSnapshot}
        canWrite
        onImport={() => undefined}
        renderSignIn={() => null}
      />,
    );
    await expect.element(page.getByText("Merged into Main: Personal.")).toBeVisible();
    // Hidden while merged, though its record and jar are kept.
    await expect
      .element(page.getByRole("button", { name: "Signed-in sites for Personal" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Undo" }).click();
    await vi.waitFor(() =>
      expect(state.calls).toEqual([["record", { profileId: "personal", undo: true }]]),
    );
    // The server's mark alone hid it: this client's list never changed.
    expect(state.settings.browserProfiles).toEqual([personal]);
  } finally {
    state.settings = {};
  }
});

it("says a held sign-in needs the person, with its Sign in on the row", async () => {
  using _fixture = fixture();
  state.calls = [];
  state.protocol = 1;
  // An overnight attempt that met a slow page: Scient stops trying until the person signs in.
  await using _screen = await render(
    row({ ...account, signIn: { state: "failed", at: "2026-11-04T02:00:00.000Z" } }),
  );
  await expect.element(page.getByText("Sign in needed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.calls).toContainEqual([
      "record",
      { accountId: account.accountId, threadId: "synthetic-thread" },
    ]),
  );
});

it("says an older server can't sign in to a website row from here", async () => {
  using _fixture = fixture();
  state.protocol = undefined;
  await using _screen = await render(row());
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect
    .element(
      page.getByRole("menuitem", {
        name: "Update Scient on this computer to sign in from here",
        exact: true,
      }),
    )
    .toBeVisible();
});

it.each([
  [
    "a profile from a browser there to sign in, then refreshes it",
    { browser: "chrome", profileName: "Yaacov", importedAt: "2026-11-03T00:00:00.000Z" },
    "Google blocks signing in here. Sign in in Chrome, then Refresh from Chrome",
    "Refresh from Chrome",
    "refresh",
  ],
  [
    "a profile with no source to a browser, then to import that profile",
    undefined,
    "Google blocks signing in here. Sign in in your browser, then import that profile",
    "Import from a browser…",
    "import",
  ],
] as const)(
  "sends %s, never to a Google sign-in here",
  async (_name, source, message, action, ran) => {
    const actions = { refresh: vi.fn(), importProfile: vi.fn() };
    await using _screen = await render(
      <div style={{ width: 220 }}>
        <ProfileDetail
          email="a-very-long-address-that-cannot-fit@example.com"
          signedOut
          recover={googleRecovery(source as never, actions)}
        />
      </div>,
    );
    await expect.element(page.getByText(message, { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Sign in", exact: true }))
      .not.toBeInTheDocument();
    // The line wraps in a narrow row: nothing is cut off, and the action stays inside it.
    const line = page.getByText(message, { exact: true }).element();
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    const button = page.getByRole("button", { name: action, exact: true });
    expect(button.element().getBoundingClientRect().right).toBeLessThanOrEqual(
      button.element().closest("div")!.getBoundingClientRect().right,
    );
    await button.click();
    expect(actions.refresh).toHaveBeenCalledTimes(ran === "refresh" ? 1 : 0);
    expect(actions.importProfile).toHaveBeenCalledTimes(ran === "import" ? 1 : 0);
  },
);

it("shows only the address while Google accepts the profile", async () => {
  await using _screen = await render(
    <ProfileDetail
      email="a@example.com"
      signedOut={false}
      recover={googleRecovery(undefined, { refresh: vi.fn(), importProfile: vi.fn() })}
    />,
  );
  await expect.element(page.getByText("a@example.com", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Import from a browser…", exact: true }))
    .not.toBeInTheDocument();
});

it("opens linked stores through the shell and gates Keychain by the local platform", async () => {
  using _fixture = fixture();
  await using screen = await render(row());
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Open in 1Password", exact: true }).click();
  expect(state.external).toHaveBeenLastCalledWith("onepassword://");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Open Keychain Access", exact: true }).click();
  expect(state.external).toHaveBeenLastCalledWith("scient-accounts://keychain");
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  await screen.rerender(row());
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Open Keychain Access", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("menuitem", { name: "Open in 1Password", exact: true }))
    .toBeVisible();
});

it("withholds native store links in a browser client", async () => {
  using _fixture = fixture("MacIntel", false);
  const { signIn: _signIn, ...unchecked } = account;
  await using _screen = await render(row(unchecked));
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Open Keychain Access", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("menuitem", { name: "Open in 1Password", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("menuitem", { name: "Sign in again", exact: true }))
    .not.toBeInTheDocument();
});

it("lists Main beside imported profiles, each showing where it came from", async () => {
  state.settings = {
    browserProfiles: [
      { id: "profile-safari", name: "Personal", kind: "persistent" },
      { id: "profile-lab", name: "Lab", kind: "persistent" },
    ],
    browserDefaultProfileId: "profile-safari",
  };
  const snapshot = {
    profiles: [
      {
        ...defaultBrowserProfileRecord("profile-safari"),
        source: {
          browser: "safari",
          profileName: "Personal",
          directory: ".",
          importedAt: "2026-11-03T00:00:00.000Z",
        },
      },
      {
        ...defaultBrowserProfileRecord("profile-lab"),
        source: {
          browser: "chrome",
          profileName: "Yaacov",
          directory: "Profile 1",
          importedAt: "2026-11-03T00:00:00.000Z",
        },
      },
    ],
    accounts: [],
  } as unknown as AccountsSnapshot;
  await using _screen = await render(
    <BrowserProfiles
      environmentId={EnvironmentId.make("synthetic")}
      snapshot={snapshot}
      canWrite
      onImport={() => undefined}
      renderSignIn={() => null}
    />,
  );
  const picture = (name: string) =>
    page
      .getByRole("button", { name: `Signed-in sites for ${name}` })
      .element()
      .querySelector("img");
  await expect
    .element(page.getByRole("button", { name: "Signed-in sites for Main" }))
    .toBeVisible();
  expect(picture("Main")?.getAttribute("src")).toContain("scient-symbol");
  expect(picture("Personal")?.getAttribute("src")).toBe(browserIconUrl("safari"));
  // Renamed here, the row names its source; a name that matches its source needs nothing more.
  const lab = page.getByRole("button", { name: "Signed-in sites for Lab" });
  await expect.element(lab.getByText("· Chrome · Yaacov")).toBeVisible();
  const label = lab.getByText("Lab", { exact: true }).element() as HTMLElement;
  expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
  expect(
    page.getByRole("button", { name: "Signed-in sites for Personal" }).element().textContent,
  ).not.toContain("Safari");
});

it("records a sign-out on Main before its cookies go", async () => {
  state.settings = {};
  state.calls = [];
  using _desktop = fixture();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      accounts: {
        signedInSites: async () => [{ domain: "github.com", cookies: 3 }],
        signOutSite: async () => true,
        signOutMainSite: async (site: string) => {
          state.calls.push(["remove", site]);
          return true;
        },
      },
    },
  });
  await using _screen = await render(
    <BrowserProfiles
      environmentId={EnvironmentId.make("synthetic")}
      snapshot={{ profiles: [], accounts: [] } as unknown as AccountsSnapshot}
      canWrite
      onImport={() => undefined}
      renderSignIn={() => null}
    />,
  );
  await page.getByRole("button", { name: "Signed-in sites for Main" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await vi.waitFor(() => expect(state.calls).toHaveLength(2));
  expect(state.calls).toEqual([
    ["record", { profileId: "default", site: "github.com" }],
    ["remove", "github.com"],
  ]);
});

it("says on Main's row which profile a site uses when Main's copy doesn't work, and copies Google into Main", async () => {
  using _fixture = fixture();
  const signIn = (profileId: string, sites: string[], patch: Partial<AccountSummary> = {}) => ({
    ...account,
    accountId: AccountId.make(`acc_group${profileId}${sites[0]!.length}`),
    name: sites[0]!,
    details: {
      kind: "website" as const,
      sites,
      profileId,
      username: "person@example.com",
      origin: "browser-session" as const,
    },
    secrets: {},
    ...patch,
  });
  const profiles = mergeProfiles([{ id: "work", name: "Work", kind: "persistent" }], []);
  const work = (sites: string[]) =>
    signIn("work", sites, { signIn: { state: "signed-in", at: "2026-11-03T00:00:00.000Z" } });
  const group = (sites: string[]) => {
    const main = signIn("default", sites, {
      signIn: { state: "unknown", at: "2026-11-04T00:00:00.000Z", from: "copy" },
    });
    return (
      <MainSiteChoice
        environmentId={EnvironmentId.make("synthetic")}
        account={main}
        accounts={[main, work(sites)]}
        profiles={profiles}
      />
    );
  };
  state.copy.mockReset().mockResolvedValue("copied");
  state.open.mockClear();
  await using screen = await render(group(["github.com"]));
  await expect.element(page.getByText("Using Work")).toBeVisible();
  await page.getByRole("button", { name: "Who Main uses on github.com" }).click();
  await page.getByRole("menuitem", { name: "Open in Work" }).click();
  await vi.waitFor(() =>
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://github.com", profileId: "work" }),
    ),
  );
  await screen.rerender(group(["google.com"]));
  await page.getByRole("button", { name: "Who Main uses on google.com" }).click();
  // Google refuses a sign-in here: Main gets Work's session through the copy, never a sign-in page.
  await page.getByRole("menuitem", { name: "Copy from Work" }).click();
  await vi.waitFor(() =>
    expect(state.copy).toHaveBeenCalledWith(EnvironmentId.make("synthetic"), work(["google.com"])),
  );
  expect(state.open).toHaveBeenCalledTimes(1);
});

it("offers importing a browser profile when no profile here holds a working Google sign-in", async () => {
  const onImport = vi.fn();
  const google: AccountSummary = {
    ...account,
    name: "google.com",
    details: { kind: "website", sites: ["google.com"], profileId: "default" },
    secrets: {},
    signIn: { state: "signed-out", at: "2026-11-04T00:00:00.000Z" },
  };
  await using _screen = await render(
    <MainSiteChoice
      environmentId={EnvironmentId.make("synthetic")}
      account={google}
      accounts={[google]}
      profiles={mergeProfiles([], [])}
      onImport={onImport}
    />,
  );
  await page.getByRole("button", { name: "Who Main uses on google.com" }).click();
  await expect
    .element(
      page.getByText(
        "Google blocks signing in here. Sign in in your browser, then import that profile",
      ),
    )
    .toBeVisible();
  await page.getByRole("menuitem", { name: "Import from a browser…" }).click();
  expect(onImport).toHaveBeenCalledOnce();
});

it("on another computer, shows received controls as set on the desktop and signs out there only", async () => {
  state.settings = { browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }] };
  state.calls = [];
  state.primary = "desktop";
  state.results = { "accounts:sessionsList": { sites: [{ site: "github.com", cookies: 2 }] } };
  using _desktop = fixture();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: { signedInSites: async () => [], signOutSite: async () => true } },
  });
  const received = {
    ...defaultBrowserProfileRecord("work"),
    received: [
      {
        source: EnvironmentId.make("macbook"),
        sessionId: "session-desktop",
        label: "MacBook",
        sentAt: "2026-11-04T10:14:00.000Z",
        units: [],
      },
    ],
  };
  try {
    await using _screen = await render(
      <BrowserProfiles
        environmentId={EnvironmentId.make("lab")}
        snapshot={{ profiles: [received], accounts: [] } as unknown as AccountsSnapshot}
        canWrite
        onImport={() => undefined}
        renderSignIn={() => null}
      />,
    );
    await expect.element(page.getByText("Set on MacBook")).toBeVisible();
    // Main is this computer's own; Work's controls are set on the desktop.
    await expect.element(page.getByRole("button", { name: "Allowed" }).nth(0)).toBeEnabled();
    await expect.element(page.getByRole("button", { name: "Allowed" }).nth(1)).toBeDisabled();
    await page.getByRole("button", { name: "Signed-in sites for Work" }).click();
    await expect.element(page.getByText("github.com")).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Signs out on Lab server. MacBook's next sign-in to this site copies it again.",
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await vi.waitFor(() =>
      expect(state.calls).toContainEqual(["record", { profileId: "work", site: "github.com" }]),
    );
  } finally {
    state.primary = "synthetic";
    state.results = {};
  }
});

it("lets the owner of a computer that receives sign-ins forget the desktop sending them", async () => {
  state.calls = [];
  state.primary = "desktop";
  try {
    await using _screen = await render(
      <RemoteComputers
        environmentId={EnvironmentId.make("lab")}
        snapshot={{
          profiles: [
            {
              ...defaultBrowserProfileRecord("work"),
              received: [
                {
                  source: EnvironmentId.make("macbook"),
                  label: "MacBook",
                  sentAt: "2026-11-04T10:14:00.000Z",
                  units: [],
                },
              ],
            },
          ],
          accounts: [],
        }}
        canWrite
      />,
    );
    await page.getByRole("button", { name: "Forget this computer" }).click();
    await vi.waitFor(() => expect(state.calls).toEqual([["record", { source: "macbook" }]]));
  } finally {
    state.primary = "synthetic";
  }
});

it("signs in once on the computer that refused a copy, in that computer's own browser", async () => {
  state.calls = [];
  state.primary = "desktop";
  state.protocol = 1;
  state.results = { "accounts:save": { accountId: "acc_lab" } };
  state.environments = [
    {
      environmentId: EnvironmentId.make("lab"),
      label: "Lab server",
      connection: { phase: "connected" },
    },
  ];
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: { readSessions: async () => null } },
  });
  try {
    await using _screen = await render(
      <RemoteComputers
        environmentId={EnvironmentId.make("desktop")}
        snapshot={{
          profiles: [
            {
              ...defaultBrowserProfileRecord("work"),
              sharedWith: [
                {
                  environmentId: EnvironmentId.make("lab"),
                  label: "Lab server",
                  applied: 3,
                  waiting: 0,
                  needsYou: ["github.com"],
                },
              ],
            },
          ],
          accounts: [],
        }}
        canWrite
      />,
    );
    await page.getByRole("button", { name: "Sign in there" }).click();
    await vi.waitFor(() =>
      expect(state.calls).toEqual([
        [
          "record",
          {
            name: "github.com",
            details: {
              kind: "website",
              sites: ["github.com"],
              profileId: "work",
              origin: "browser-session",
            },
            secrets: {},
          },
        ],
        ["record", expect.objectContaining({ accountId: "acc_lab", discardIfUnfinished: true })],
      ]),
    );
  } finally {
    state.primary = "synthetic";
    state.results = {};
    state.environments = [];
    Reflect.deleteProperty(window, "desktopBridge");
  }
});
