import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { AccountRow } from "./AccountsPage";

const state = vi.hoisted(() => ({ open: vi.fn(), external: vi.fn() }));
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
  signedOut: true,
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

it("offers sign-in again in the account profile, then removes the status and action when cookies return", async () => {
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
  await screen.rerender(row({ ...account, signedOut: false }));
  await expect.element(page.getByText("Signed out", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect
    .element(page.getByRole("menuitem", { name: "Sign in again", exact: true }))
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
  await using _screen = await render(row({ ...account, signedOut: undefined }));
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
