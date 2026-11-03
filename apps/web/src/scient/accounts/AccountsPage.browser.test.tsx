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
import { AccountRow } from "./AccountsPage";
import { browserIconUrl } from "./accountsView";
import { BrowserProfiles, ProfileDetail } from "./BrowserProfiles";

const state = vi.hoisted(() => ({
  open: vi.fn(),
  external: vi.fn(),
  settings: {} as Partial<ClientSettings>,
}));
vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  useClientSettings: (select?: (settings: ClientSettings) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, ...state.settings };
    return select ? select(settings) : settings;
  },
  useClientSettingsHydrated: () => true,
}));
vi.mock("~/browser/openFileInPreview", () => ({ openUrlInPreview: state.open }));
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
  useAccounts: () => ({ data: null, canWrite: true }),
  useAccountCommand: () => async () => ({ ok: true, value: {} }),
  usePasswordStorePermission: () => true,
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

it("offers sign-in again in the account profile, then removes the status and action once signed in", async () => {
  using _fixture = fixture();
  await using screen = await render(row());
  await expect.element(page.getByText("Signed out", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign in again", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/login", profileId: "work" }),
    ),
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

it("offers Sign in beside a Google sign-out, without leaving the row or clipping", async () => {
  const onSignIn = vi.fn();
  await using _screen = await render(
    <div style={{ width: 220 }}>
      <ProfileDetail
        email="a-very-long-address-that-cannot-fit@example.com"
        signedOut
        onSignIn={onSignIn}
      />
    </div>,
  );
  await expect.element(page.getByText("· Signed out of Google", { exact: true })).toBeVisible();
  const button = page.getByRole("button", { name: "Sign in", exact: true });
  await expect.element(button).toBeVisible();
  expect(button.element().getBoundingClientRect().right).toBeLessThanOrEqual(
    button.element().closest("div")!.getBoundingClientRect().right,
  );
  const status = page.getByText("· Signed out of Google", { exact: true }).element();
  expect(status.scrollWidth).toBeLessThanOrEqual(status.clientWidth);
  await button.click();
  expect(onSignIn).toHaveBeenCalledOnce();
});

it("shows only the address while Google accepts the profile", async () => {
  await using _screen = await render(
    <ProfileDetail email="a@example.com" signedOut={false} onSignIn={vi.fn()} />,
  );
  await expect.element(page.getByText("a@example.com", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Sign in", exact: true }))
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
    browserProfiles: [{ id: "profile-safari", name: "Personal", kind: "persistent" }],
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
    ],
    accounts: [],
  } as unknown as AccountsSnapshot;
  await using _screen = await render(
    <BrowserProfiles
      environmentId={EnvironmentId.make("synthetic")}
      snapshot={snapshot}
      canWrite
      onImport={() => undefined}
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
});
