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
import {
  AccountRow,
  ApiKeysDialog,
  MainSiteChoice,
  SavedPasswordsDialog,
  SignInCodesDialog,
} from "./AccountsPage";
import { browserIconUrl, mergeProfiles } from "./accountsView";
import { BrowserProfiles, googleRecovery, ProfileDetail } from "./BrowserProfiles";
import { RemoteComputers } from "./RemoteComputers";
import { RemovedBand } from "./RemovedBand";

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
  toast: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("~/components/ui/toast", async (original) => ({
  ...(await original<typeof import("~/components/ui/toast")>()),
  toastManager: { add: state.toast },
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
vi.mock("~/scient/sameHost", async () => {
  const { Atom } = await import("effect/reactivity");
  // This desktop runs the "synthetic" server; "remote-primary" is a primary on another computer.
  return { sameHostEnvironmentIdsAtom: Atom.make(new Set(["synthetic"])) };
});
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
  useAccounts: () => ({
    data: { accountsProtocol: state.protocol },
    canWrite: true,
    refresh: state.refresh,
  }),
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
  await expect.element(page.getByText(/^Sign-in failed · /)).toBeVisible();
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
    "a profile from a browser: Sign in again copies its sign-ins again",
    { browser: "chrome", profileName: "Yaacov", importedAt: "2026-11-03T00:00:00.000Z" },
    "refresh",
  ],
  ["a profile with no browser: Sign in again imports one", undefined, "import"],
] as const)("without a Chrome window, %s at once", async (_name, source, ran) => {
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
  // One line: the address shortens, the button stays whole; no explanation text.
  const button = page.getByRole("button", { name: "Sign in to Google again", exact: true });
  await expect.element(button).toBeVisible();
  expect(document.body.textContent).not.toContain("Signed out of Google");
  const line = button.element().parentElement!;
  expect(line.getBoundingClientRect().height).toBeLessThan(24);
  expect(button.element().getBoundingClientRect().right).toBeLessThanOrEqual(
    line.getBoundingClientRect().right + 1,
  );
  await button.click();
  expect(actions.refresh).toHaveBeenCalledTimes(ran === "refresh" ? 1 : 0);
  expect(actions.importProfile).toHaveBeenCalledTimes(ran === "import" ? 1 : 0);
});

it("offers Main a copy of another profile's working Google before an import", async () => {
  const copy = vi.fn();
  const actions = {
    refresh: vi.fn(),
    importProfile: vi.fn(),
    copyFrom: { name: "Yaacov", run: copy },
  };
  await using _screen = await render(
    <ProfileDetail signedOut email={undefined} recover={googleRecovery(undefined, actions)} />,
  );
  await page.getByRole("button", { name: "Sign in to Google again", exact: true }).click();
  expect(copy).toHaveBeenCalledOnce();
  expect(actions.importProfile).not.toHaveBeenCalled();
});

it.each([
  [
    "an imported profile",
    { browser: "chrome", profileName: "Y", importedAt: "2026-11-03T00:00:00.000Z" },
    "Copy again from Chrome",
  ],
  ["Main with a profile to copy from", undefined, "Copy from Work"],
  ["Main with nothing to copy or import", undefined, "Import from a browser…"],
] as const)("gives %s one Sign in again with two named ways", async (name, source, other) => {
  const chromeWindow = vi.fn();
  const actions = {
    refresh: vi.fn(),
    importProfile: vi.fn(),
    chromeWindow,
    ...(name.includes("copy from") ? { copyFrom: { name: "Work", run: vi.fn() } } : {}),
  };
  await using _screen = await render(
    <ProfileDetail
      signedOut
      email={undefined}
      recover={googleRecovery(source as never, actions)}
    />,
  );
  await page.getByRole("button", { name: "Sign in to Google again", exact: true }).click();
  await expect.element(page.getByRole("menuitem", { name: other, exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "New Google sign-in", exact: true }).click();
  expect(chromeWindow).toHaveBeenCalledOnce();
});

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
    .element(page.getByRole("button", { name: "Sign in to Google again", exact: true }))
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
        // Held by this computer's browser until its server starts again (round 6l).
        unavailable: true,
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
  // regression: a held profile looked ready.
  await expect.element(lab.getByText("Unavailable", { exact: true })).toBeVisible();
  expect(
    page.getByRole("button", { name: "Signed-in sites for Personal" }).element().textContent,
  ).not.toContain("Unavailable");
});

it("records a sign-out on Main before its cookies go, and counts what Main holds", async () => {
  state.settings = {};
  state.calls = [];
  using _desktop = fixture();
  let held = [{ domain: "github.com", cookies: 3 }];
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      accounts: {
        signedInSites: async () => held,
        signOutSite: async () => true,
        signOutMainSite: async (site: string) => {
          state.calls.push(["remove", site]);
          held = [];
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
  // Main has no sign-in rows here; its row still counts the site its cookies hold.
  const main = page.getByRole("button", { name: "Signed-in sites for Main" });
  await expect.element(main.getByText("1 site ›")).toBeVisible();
  await main.click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await vi.waitFor(() => expect(state.calls).toHaveLength(2));
  expect(state.calls).toEqual([
    ["record", { profileId: "default", site: "github.com" }],
    ["remove", "github.com"],
  ]);
  await expect.element(main.getByText("1 site ›")).not.toBeInTheDocument();
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
  await expect.element(page.getByText("Signed out of Google.", { exact: true })).toBeVisible();
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

it("shows both key consumers and lists their names before removal", async () => {
  await page.viewport(1050, 800);
  const onEdit = vi.fn();
  const value: AccountSummary = {
    ...account,
    name: "Research gateway",
    details: { kind: "api-key", sites: ["https://models.example.test"], auth: { type: "bearer" } },
    secrets: { token: { source: { type: "scient" } } },
  };
  await using _screen = await render(
    <ApiKeysDialog
      rows={[
        {
          id: value.accountId,
          name: value.name,
          account: value,
          service: value.details.kind === "api-key" ? value.details.sites[0] : undefined,
          stored: "accounts",
          files: [],
          uses: [
            {
              label: "Custom models",
              consumerName: "Research chat",
              href: "/settings/custom-models",
            },
            { label: "Voice", consumerName: "Meeting notes", href: "/settings/voice" },
          ],
        },
      ]}
      roots={[]}
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      onEdit={onEdit}
      onActivity={() => undefined}
      onKept={() => undefined}
      onClose={() => undefined}
    />,
  );
  await expect
    .element(page.getByText(/Used by Custom models · Research chat and Voice · Meeting notes/))
    .toBeVisible();
  const directory = import.meta.env.VITE_SCIENT_CREDENTIALS_SCREENSHOTS;
  if (directory) {
    for (const animation of document.getAnimations())
      if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
    await page.screenshot({ path: directory + "/accounts-api-keys-light.png" });
    const background = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "var(--background)";
    document.documentElement.classList.add("dark");
    try {
      await page.screenshot({ path: directory + "/accounts-api-keys-dark.png" });
    } finally {
      document.documentElement.classList.remove("dark");
      document.body.style.backgroundColor = background;
    }
  }
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Replace key…" }).click();
  await expect.element(page.getByText("Custom models · Research chat")).toBeVisible();
  await expect.element(page.getByText("Voice · Meeting notes")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  expect(onEdit).toHaveBeenCalledWith(value);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await expect.element(page.getByText("Custom models · Research chat")).toBeVisible();
  await expect.element(page.getByText("Voice · Meeting notes")).toBeVisible();
});

it("removes a key at once where the server keeps it for Undo, naming what uses it", async () => {
  const value: AccountSummary = {
    ...account,
    name: "Research gateway",
    details: { kind: "api-key", sites: ["https://models.example.test"], auth: { type: "bearer" } },
    secrets: { token: { source: { type: "scient" } } },
  };
  state.protocol = 2;
  state.calls = [];
  state.results["accounts:remove"] = { removalId: "synthetic-removal" };
  state.toast.mockReset();
  try {
    await using _screen = await render(
      <ApiKeysDialog
        rows={[
          {
            id: value.accountId,
            name: value.name,
            account: value,
            service: undefined,
            stored: "accounts",
            files: [],
            uses: [{ label: "Custom models", href: "/settings/custom-models" }],
          },
        ]}
        roots={[]}
        environmentId={EnvironmentId.make("synthetic")}
        canWrite
        onEdit={() => undefined}
        onActivity={() => undefined}
        onKept={() => undefined}
        onClose={() => undefined}
      />,
    );
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
    await vi.waitFor(() => expect(state.toast).toHaveBeenCalledOnce());
    const [toast] = state.toast.mock.calls[0]! as [
      { description: string; timeout: number; actionProps: { onClick: () => void } },
    ];
    expect(toast.description).toBe("Used by Custom models");
    // Long enough to press, past the default five seconds.
    expect(toast.timeout).toBeGreaterThan(5_000);
    toast.actionProps.onClick();
    await vi.waitFor(() =>
      expect(state.calls).toEqual([
        [
          "record",
          {
            accountId: value.accountId,
            updatedAt: value.updatedAt,
            operationId: expect.any(String),
          },
        ],
        ["record", { accountId: value.accountId, removalId: "synthetic-removal" }],
      ]),
    );
  } finally {
    state.protocol = 1;
    delete state.results["accounts:remove"];
  }
});

it("offers Undo on Accounts for the hour, one for a university's rows removed together", async () => {
  state.protocol = 2;
  state.calls = [];
  const entry = (id: string, name: string, at: string, operationId?: string) => ({
    accountId: AccountId.make(`acc_${id}`),
    name,
    removalId: `removal-${id}`,
    ...(operationId ? { operationId } : {}),
    until: at,
  });
  try {
    await using _screen = await render(
      <RemovedBand
        environmentId={EnvironmentId.make("synthetic")}
        canWrite
        snapshot={{
          removed: [
            // One press, rows named apart; then two presses on one name, a moment apart.
            entry("huji0001", "Hebrew University", "2026-11-26T10:00:00.000Z", "press-1"),
            entry("huji0002", "huji.ac.il", "2026-11-26T10:00:00.400Z", "press-1"),
            entry("openai01", "OpenAI", "2026-11-26T10:05:00.000Z", "press-2"),
            entry("openai02", "OpenAI", "2026-11-26T10:05:01.000Z", "press-3"),
          ],
        }}
      />,
    );
    const undo = page.getByRole("button", { name: "Undo" });
    await expect.element(undo.nth(2)).toBeVisible();
    expect(undo.elements()).toHaveLength(3);
    await undo.first().click();
    await vi.waitFor(() =>
      expect(state.calls).toEqual([
        ["record", { accountId: "acc_huji0001", removalId: "removal-huji0001" }],
        ["record", { accountId: "acc_huji0002", removalId: "removal-huji0002" }],
      ]),
    );
  } finally {
    state.protocol = 1;
  }
});

it("opens Full Disk Access in one click, and asks again afresh on return", async () => {
  using _fixture = fixture();
  state.calls = [];
  state.primary = "synthetic";
  const openFullDiskAccess = vi.fn(async () => true);
  const relaunch = vi.fn(async () => true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { openSystemSettings: vi.fn(), accounts: { openFullDiskAccess, relaunch } },
  });
  // The fresh check on return says it's still denied.
  state.results["accounts:checkCodeSources"] = { messagesNeedAccess: true };
  await using _screen = await render(
    <SignInCodesDialog
      sources={{ messages: true }}
      host={{ computer: "Lab Mac", readable: false }}
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      onClose={() => undefined}
    />,
  );
  await page.getByRole("button", { name: "Open Full Disk Access" }).click();
  expect(openFullDiskAccess).toHaveBeenCalledOnce();
  expect(page.getByRole("button", { name: "Restart Scient" }).elements()).toHaveLength(0);
  window.dispatchEvent(new Event("focus"));
  await expect.element(page.getByRole("button", { name: "Restart Scient" })).toBeVisible();
  // It asked afresh, and wrote no switch.
  expect(state.calls).toContainEqual(["record", {}]);
  expect(state.calls).not.toContainEqual(["record", { messages: true }]);
  await page.getByRole("button", { name: "Restart Scient" }).click();
  expect(relaunch).toHaveBeenCalledOnce();
});

it("turns On when the person comes back with access granted, with no restart", async () => {
  using _fixture = fixture();
  state.primary = "synthetic";
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      openSystemSettings: vi.fn(),
      accounts: { openFullDiskAccess: vi.fn(async () => true), relaunch: vi.fn() },
    },
  });
  state.results["accounts:checkCodeSources"] = { messagesNeedAccess: false };
  await using _screen = await render(
    <SignInCodesDialog
      sources={{ messages: true }}
      host={{ computer: "Lab Mac", readable: false }}
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      onClose={() => undefined}
    />,
  );
  await page.getByRole("button", { name: "Open Full Disk Access" }).click();
  window.dispatchEvent(new Event("focus"));
  await expect
    .element(page.getByRole("button", { name: "Open Full Disk Access" }))
    .not.toBeInTheDocument();
  expect(page.getByRole("button", { name: "Restart Scient" }).elements()).toHaveLength(0);
});

it("names the Mac instead of opening Settings on a primary that runs elsewhere", async () => {
  using _fixture = fixture();
  state.primary = "remote-primary";
  const openFullDiskAccess = vi.fn(async () => true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { openSystemSettings: vi.fn(), accounts: { openFullDiskAccess, relaunch: vi.fn() } },
  });
  await using _screen = await render(
    <SignInCodesDialog
      sources={{ messages: true }}
      host={{ computer: "Lab Mac", readable: false }}
      environmentId={EnvironmentId.make("remote-primary")}
      canWrite
      onClose={() => undefined}
    />,
  );
  // regression: a configured remote primary counted as this Mac.
  await expect.element(page.getByText("Allow Scient in Full Disk Access on Lab Mac")).toBeVisible();
  expect(page.getByRole("button", { name: "Open Full Disk Access" }).elements()).toHaveLength(0);
});

it("never turns reading back on from a view another client has since changed", async () => {
  using _fixture = fixture();
  state.calls = [];
  state.results["accounts:checkCodeSources"] = { messagesNeedAccess: false };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      openSystemSettings: vi.fn(),
      accounts: { openFullDiskAccess: vi.fn(async () => true), relaunch: vi.fn() },
    },
  });
  await using _screen = await render(
    <SignInCodesDialog
      sources={{ messages: true }}
      host={{ computer: "Lab Mac", readable: false }}
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      onClose={() => undefined}
    />,
  );
  await page.getByRole("button", { name: "Open Full Disk Access" }).click();
  // Another client turns codes off; this view still says On when the window comes back.
  state.refresh.mockClear();
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(state.refresh).toHaveBeenCalled());
  // regression: the stale On went back to the server as a write.
  expect(state.calls).not.toContainEqual(["record", { messages: true }]);
  expect(state.calls).toContainEqual(["record", {}]);
});

const savedLogin = (accountId: string, username: string, extra: Partial<AccountSummary> = {}) =>
  ({
    ...account,
    accountId: AccountId.make(accountId),
    name: "tss2.ada.huji.ac.il",
    details: { kind: "website", sites: ["tss2.ada.huji.ac.il"], username },
    secrets: { password: { source: { type: "scient" } } },
    signIn: undefined,
    ...extra,
  }) as AccountSummary;

it("opens a saved login in place with its password, status, Edit and Remove", async () => {
  using _fixture = fixture();
  state.calls = [];
  state.protocol = 2;
  state.results["accounts:reveal"] = { value: "synthetic-saved-pass" };
  const onEdit = vi.fn();
  const logins = [
    savedLogin("acc_savedyaacov", "cc\\yaacovc", {
      secrets: { password: { source: { type: "scient" }, verifiedAt: "2026-11-24T00:00:00.000Z" } },
    }),
    savedLogin("acc_savedother1", "other@example.org", {
      name: "example.org",
      details: { kind: "website", sites: ["example.org"], username: "other@example.org" },
    }),
  ];
  await using _screen = await render(
    <SavedPasswordsDialog
      accounts={logins}
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      agentAccess
      grouped
      onEdit={onEdit}
      onActivity={() => undefined}
      onClose={() => undefined}
    />,
  );
  // A click opens it in place: no editor, no dialog.
  await page.getByRole("button", { name: "Details for tss2.ada.huji.ac.il" }).click();
  expect(onEdit).not.toHaveBeenCalled();
  await expect.element(page.getByText(/^Worked /)).toBeVisible();
  await page.getByRole("button", { name: "Show password" }).click();
  await expect.element(page.getByText("synthetic-saved-pass")).toBeVisible();
  expect(state.calls).toContainEqual([
    "record",
    { accountId: "acc_savedyaacov", field: "password" },
  ]);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  expect(onEdit).toHaveBeenCalledWith(logins[0]);
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.calls).toContainEqual([
      "record",
      expect.objectContaining({ accountId: "acc_savedyaacov" }),
    ]),
  );
});

it("opens every login of the site a key's Edit in Accounts named", async () => {
  using _fixture = fixture();
  state.protocol = 2;
  await using _screen = await render(
    <SavedPasswordsDialog
      site="tss2.ada.huji.ac.il"
      accounts={[
        savedLogin("acc_savedcorcosy", "cc\\corcosy"),
        savedLogin("acc_savedyaacov", "yaacovc"),
      ]}
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      agentAccess
      grouped
      onEdit={() => undefined}
      onActivity={() => undefined}
      onClose={() => undefined}
    />,
  );
  await expect.element(page.getByRole("searchbox")).toHaveValue("tss2.ada.huji.ac.il");
  expect(page.getByRole("button", { name: "Show password" }).elements()).toHaveLength(2);
});

it("opens the logins the key offered on the page, by its origin and the key's site rule", async () => {
  using _fixture = fixture();
  state.protocol = 2;
  const at = (accountId: string, username: string, sites: string[]) =>
    savedLogin(accountId, username, {
      name: sites[0]!,
      details: { kind: "website", sites, username },
    });
  await using _screen = await render(
    <SavedPasswordsDialog
      site="https://login.example.com"
      accounts={[
        // regression: a login for the parent domain, offered by the key, was left out.
        at("acc_savedparent", "parent", ["example.com"]),
        at("acc_savedexact", "exact", ["https://login.example.com"]),
        // Another port is another page: the key offers neither of these there.
        at("acc_savedport", "port", ["https://login.example.com:8443"]),
        at("acc_savedother", "other", ["other.example.org"]),
      ]}
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      agentAccess
      grouped
      onEdit={() => undefined}
      onActivity={() => undefined}
      onClose={() => undefined}
    />,
  );
  await expect.element(page.getByRole("searchbox")).toHaveValue("login.example.com");
  expect(page.getByRole("button", { name: "Show password" }).elements()).toHaveLength(2);
  expect(document.body.textContent).toContain("parent");
  expect(document.body.textContent).not.toContain("port");
});

it("shows a login saved with and without its domain side by side, each removable in one click", async () => {
  using _fixture = fixture();
  state.calls = [];
  state.protocol = 2;
  await using _screen = await render(
    <SavedPasswordsDialog
      accounts={[
        savedLogin("acc_saveddomain", "cc\\yaacovc"),
        savedLogin("acc_savedcorcos", "cc\\corcosy"),
        savedLogin("acc_savedplain1", "yaacovc"),
      ]}
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      agentAccess
      grouped
      onEdit={() => undefined}
      onActivity={() => undefined}
      onClose={() => undefined}
    />,
  );
  // Next to each other, both marked; the other login isn't.
  await expect.element(page.getByText("Possible duplicate").first()).toBeVisible();
  expect(page.getByText("Possible duplicate").elements()).toHaveLength(2);
  const rows = page.getByRole("button", { name: /^Details for / }).elements();
  const order = rows.map((row) => row.textContent ?? "");
  const domain = order.findIndex((text) => text.includes("cc\\yaacovc"));
  const plain = order.findIndex((text) => text.includes("yaacovc") && !text.includes("cc\\"));
  expect(Math.abs(domain - plain)).toBe(1);
  // Never merged: removing one is the person's press, with Undo.
  await page.getByRole("button", { name: "Remove yaacovc" }).click();
  await vi.waitFor(() =>
    expect(state.calls).toContainEqual([
      "record",
      expect.objectContaining({ accountId: "acc_savedplain1" }),
    ]),
  );
});

it("offers no one-click Remove on a server that can't undo it", async () => {
  using _fixture = fixture();
  state.calls = [];
  // regression: an older server removed a login for good from the one-click Remove.
  state.protocol = 1;
  await using _screen = await render(
    <SavedPasswordsDialog
      site="tss2.ada.huji.ac.il"
      accounts={[
        savedLogin("acc_saveddomain", "cc\\yaacovc"),
        savedLogin("acc_savedplain1", "yaacovc"),
      ]}
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      agentAccess
      grouped={false}
      onEdit={() => undefined}
      onActivity={() => undefined}
      onClose={() => undefined}
    />,
  );
  await expect.element(page.getByText("Possible duplicate").first()).toBeVisible();
  // Each login opened in place still has Edit, where removing asks first.
  expect(page.getByRole("button", { name: "Edit", exact: true }).elements()).toHaveLength(2);
  expect(page.getByRole("button", { name: /^Remove/ }).elements()).toHaveLength(0);
});
