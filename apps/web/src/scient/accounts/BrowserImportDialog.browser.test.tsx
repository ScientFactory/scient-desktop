import "~/index.css";
import "./accounts.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  EnvironmentId,
  type AccountsSnapshot,
  type BrowserImportSource,
} from "@t3tools/contracts";
import { render, stubGlobal } from "../../../test/render";
import { BrowserImportDialog } from "./BrowserProfiles";

const state = vi.hoisted(() => ({
  sources: [] as BrowserImportSource[],
  importCookies: vi.fn(),
  toast: vi.fn(),
  command: vi.fn(async () => ({ ok: true, value: { created: 2, updated: 1, skipped: 1 } })),
  intoMain: vi.fn(),
}));
vi.mock("./mainFill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mainFill")>()),
  chromeSignInIntoMain: state.intoMain,
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { listBrowserImportSources: async () => state.sources },
}));
vi.mock("~/components/settings/IntegrationsSettings", () => ({
  importBrowserCookiesIntoTarget: state.importCookies,
  clearBrowserProfileData: vi.fn(),
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => PRIMARY_LOCAL_ENVIRONMENT_ID,
}));
vi.mock("~/components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/ui/toast")>()),
  toastManager: { add: state.toast },
}));
vi.mock("./useAccounts", () => ({
  useAccountCommand: () => state.command,
  toastAccountFailure: () => undefined,
}));
const snapshot: AccountsSnapshot = {
  agentAccess: true,
  accounts: [],
  profiles: [],
  approvals: [],
  recentActivity: [],
  customModelKeys: [],
  stores: {
    scient: { protection: "keychain" },
    keychain: { available: false, platform: "linux" },
    onePassword: { state: "not-connected" },
  },
};
it("lists running-browser metadata, imports the selection only after quit and recheck, and says what it brought", async () => {
  state.sources = [
    { id: "chrome", name: "Chrome", profiles: [], unavailable: "browserRunning" },
    { id: "edge", name: "Edge", profiles: [], unavailable: "notInstalled" },
    { id: "brave", name: "Brave", profiles: [], unavailable: "notInstalled" },
  ];
  state.importCookies.mockReset().mockResolvedValue({
    kind: "imported",
    imported: 4,
    skipped: 0,
    skippedDomains: [],
    importedSites: 2,
    targetName: "Work",
  });
  using _bridge = stubGlobal("desktopBridge", {
    getLocalEnvironmentBootstraps: () => [],
    accounts: {
      sourceProfiles: async () => [
        {
          sourceId: "chrome",
          directory: "Profile 1",
          name: "Work",
          email: "synthetic@example.invalid",
        },
      ],
    },
  });
  const close = vi.fn();
  await using _screen = await render(
    <BrowserImportDialog
      environmentId={EnvironmentId.make("synthetic")}
      snapshot={snapshot}
      canWrite
      onClose={close}
    />,
  );
  await expect
    .element(page.getByText("Chrome · open, quit to import", { exact: true }))
    .toBeVisible();
  const moreBrowsers = page.getByRole("button", { name: "More browsers" });
  await expect.element(moreBrowsers).toHaveAttribute("aria-expanded", "false");
  await expect.element(page.getByText("Edge", { exact: true })).not.toBeInTheDocument();
  await moreBrowsers.click();
  await expect.element(moreBrowsers).toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("Edge", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Brave", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("checkbox")).toHaveLength(1);
  await moreBrowsers.click();
  await expect.element(page.getByText("Edge", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("checkbox", { name: "Work · Chrome" }).click();
  await page.getByRole("button", { name: "Import (1)", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Quit Chrome to import" })).toBeVisible();
  expect(state.importCookies).not.toHaveBeenCalled();
  state.sources = [
    { id: "chrome", name: "Chrome", profiles: [{ directory: "Profile 1", name: "Work" }] },
  ];
  await page.getByRole("button", { name: "I’ve quit it" }).click();
  await expect
    .element(page.getByText("Chrome · synthetic@example.invalid · cookies for 2 sites"))
    .toBeVisible();
  expect(close).not.toHaveBeenCalled();
  expect(state.importCookies).toHaveBeenCalledOnce();
  expect(state.importCookies.mock.calls[0]?.[3]).toMatchObject({
    sourceProfileDirectory: "Profile 1",
    profileName: "Work",
    target: { kind: "new" },
  });
});

it("imports a Chromium profile's saved passwords through the Accounts importer, saying so meanwhile", async () => {
  state.sources = [
    {
      id: "chrome",
      name: "Chrome",
      profiles: [{ directory: "Default", name: "Personal", cookieCount: 1200 }],
    },
  ];
  state.importCookies.mockReset().mockResolvedValue({
    kind: "imported",
    imported: 1,
    skipped: 0,
    skippedDomains: [],
    targetName: "Personal",
  });
  state.toast.mockReset();
  state.command.mockClear();
  const passwords = Promise.withResolvers<{ content: string; skipped: number }>();
  using _bridge = stubGlobal("desktopBridge", {
    getLocalEnvironmentBootstraps: () => [],
    accounts: {
      sourceProfiles: async () => [
        { sourceId: "chrome", directory: "Default", name: "Personal", passwordCount: 7 },
      ],
      readBrowserPasswords: () => passwords.promise,
    },
  });
  await using _screen = await render(
    <BrowserImportDialog
      environmentId={EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID)}
      snapshot={snapshot}
      canWrite
      onClose={() => {}}
    />,
  );
  await expect.element(page.getByText("Chrome · 1,200 cookies", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Personal · Chrome" }).click();
  await expect
    .element(page.getByRole("checkbox", { name: "Also import saved passwords (7)" }))
    .toBeChecked();
  await page.getByRole("button", { name: "Import (1)", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Importing saved passwords…");
  passwords.resolve({ content: "synthetic csv", skipped: 3 });
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Imported 3 passwords, 4 skipped",
    }),
  );
  expect(state.command).toHaveBeenCalledWith({
    format: "chrome",
    content: "synthetic csv",
    profileId: expect.stringMatching(/^profile-/),
  });
});

it("lists Chrome and Edge on Windows as protected, each offering a window of the installed browser", async () => {
  state.sources = [
    { id: "chrome", name: "Chrome", profiles: [], unavailable: "appBoundEncryption" },
    { id: "edge", name: "Microsoft Edge", profiles: [], unavailable: "appBoundEncryption" },
    { id: "brave", name: "Brave", profiles: [], unavailable: "notInstalled" },
  ];
  state.intoMain.mockReset().mockReturnValue(new Promise(() => {}));
  state.importCookies.mockReset();
  using _bridge = stubGlobal("desktopBridge", {
    getLocalEnvironmentBootstraps: () => [],
    getClientPlatform: () => "win32",
    accounts: {
      sourceProfiles: async () => [],
      chromeSignIn: vi.fn(),
      chromeSignInBrowser: async () => ({ name: "Edge", canQuit: true }),
    },
  });
  const environmentId = EnvironmentId.make("synthetic");
  await using _screen = await render(
    <BrowserImportDialog
      environmentId={environmentId}
      snapshot={snapshot}
      canWrite
      onClose={vi.fn()}
    />,
  );
  await expect
    .element(page.getByText("Windows protects this browser's saved sign-ins from other apps."))
    .toHaveLength(2);
  await expect.element(page.getByText("No browsers found")).not.toBeInTheDocument();
  // Nothing to select: a protected browser is never imported from.
  await expect.element(page.getByRole("checkbox")).toHaveLength(0);
  const windowActions = page.getByRole("button", { name: "Sign in in an Edge window" });
  await expect.element(windowActions).toHaveLength(2);
  await windowActions.first().click();
  await expect.element(page.getByRole("heading", { name: "Sign in in Edge" })).toBeVisible();
  expect(state.intoMain).toHaveBeenCalledWith(environmentId, "https://accounts.google.com/");
  expect(state.importCookies).not.toHaveBeenCalled();
});
