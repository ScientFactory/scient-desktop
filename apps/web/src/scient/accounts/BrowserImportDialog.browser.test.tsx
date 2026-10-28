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
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("./useAccounts", () => ({
  useAccountCommand: () => state.command,
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
it("lists running-browser metadata and imports the selection only after quit and recheck", async () => {
  state.sources = [
    { id: "chrome", name: "Chrome", profiles: [], unavailable: "browserRunning" },
    { id: "edge", name: "Edge", profiles: [], unavailable: "notInstalled" },
    { id: "brave", name: "Brave", profiles: [], unavailable: "notInstalled" },
  ];
  state.importCookies.mockReset().mockResolvedValue({
    kind: "imported",
    imported: 1,
    skipped: 0,
    skippedDomains: [],
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
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(state.importCookies).toHaveBeenCalledOnce();
  expect(state.importCookies.mock.calls[0]?.[3]).toMatchObject({
    sourceProfileDirectory: "Profile 1",
    profileName: "Work",
    target: { kind: "new" },
  });
});

it("imports a Chromium profile's saved passwords through the Accounts importer", async () => {
  state.sources = [
    { id: "chrome", name: "Chrome", profiles: [{ directory: "Default", name: "Personal" }] },
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
  using _bridge = stubGlobal("desktopBridge", {
    getLocalEnvironmentBootstraps: () => [],
    accounts: {
      sourceProfiles: async () => [
        { sourceId: "chrome", directory: "Default", name: "Personal", passwordCount: 7 },
      ],
      readBrowserPasswords: async () => ({ content: "synthetic csv", skipped: 3 }),
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
  await page.getByRole("checkbox", { name: "Personal · Chrome" }).click();
  await expect
    .element(page.getByRole("checkbox", { name: "Also import saved passwords (7)" }))
    .toBeChecked();
  await page.getByRole("button", { name: "Import (1)", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Imported 3 passwords, 4 skipped",
    }),
  );
  expect(state.command).toHaveBeenCalledWith({ format: "chrome", content: "synthetic csv" });
});
