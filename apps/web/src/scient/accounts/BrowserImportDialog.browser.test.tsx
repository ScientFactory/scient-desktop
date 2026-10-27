import "~/index.css";
import "./accounts.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { EnvironmentId, type AccountsSnapshot, type BrowserImportSource } from "@t3tools/contracts";
import { render, stubGlobal } from "../../../test/render";
import { BrowserImportDialog } from "./BrowserProfiles";

const state = vi.hoisted(() => ({
  sources: [] as BrowserImportSource[],
  importCookies: vi.fn(),
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { listBrowserImportSources: async () => state.sources },
}));
vi.mock("~/components/settings/IntegrationsSettings", () => ({
  importBrowserCookiesIntoTarget: state.importCookies,
  clearBrowserProfileData: vi.fn(),
}));
vi.mock("./useAccounts", () => ({
  useAccountCommand: () => async () => ({ ok: true, value: {} }),
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
  await expect.element(page.getByText("Not found: Edge, Brave", { exact: true })).toBeVisible();
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
