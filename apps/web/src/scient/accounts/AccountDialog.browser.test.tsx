import "~/index.css";
import "./accounts.css";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  defaultAccountControls,
  EnvironmentId,
  type AccountsSnapshot,
  type AccountSummary,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { AccountDialog } from "./AccountDialog";

it("opens the add-account picker outside the Extensions page", async () => {
  const snapshot: AccountsSnapshot = {
    agentAccess: true,
    accounts: [],
    profiles: [],
    stores: {
      scient: { protection: "keychain" },
      keychain: { available: false, platform: "linux" },
      onePassword: { state: "not-connected" },
    },
    approvals: [],
    recentActivity: [],
    customModelKeys: [],
  };
  await using _screen = await render(
    <AccountDialog
      environmentId={EnvironmentId.make("synthetic")}
      snapshot={snapshot}
      account={null}
      canWrite
      onClose={() => undefined}
    />,
  );
  // regression: extension icons once required the Extensions page and crashed this dialog.
  await expect.element(page.getByText("Any website")).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Find an account" });
  await search.fill("aistudio.google.com");
  await expect.element(page.getByText("Google Gemini", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Research", { exact: true })).not.toBeInTheDocument();
  await page.getByText("Google Gemini", { exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Name", exact: true }))
    .toHaveValue("Google Gemini");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await search.fill("");
  await page.getByText("Google", { exact: true }).click();
  await expect.element(page.getByRole("textbox", { name: "Username", exact: true })).toHaveFocus();
  await page.getByLabelText("Password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByText("Google", { exact: true }).click();
  await expect.element(page.getByLabelText("Password", { exact: true })).toHaveValue("");
});

it("preserves a site separator while the user enters another allowed site", async () => {
  const account: AccountSummary = {
    accountId: AccountId.make("acc_synthetic01"),
    name: "Synthetic",
    details: { kind: "website", sites: ["example.com"] },
    secrets: {},
    controls: defaultAccountControls("website"),
    status: "ready",
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
  const snapshot: AccountsSnapshot = {
    agentAccess: true,
    accounts: [account],
    profiles: [],
    stores: {
      scient: { protection: "keychain" },
      keychain: { available: false, platform: "linux" },
      onePassword: { state: "not-connected" },
    },
    approvals: [],
    recentActivity: [],
    customModelKeys: [],
  };
  await using _screen = await render(
    <AccountDialog
      environmentId={EnvironmentId.make("synthetic")}
      snapshot={snapshot}
      account={account}
      canWrite
      onClose={() => undefined}
    />,
  );
  await expect.element(page.getByRole("textbox", { name: "Username", exact: true })).toHaveFocus();
  const sites = page.getByRole("textbox", { name: "Site", exact: true });
  await sites.fill("example.com,");
  await expect.element(sites).toHaveValue("example.com,");
  await sites.fill("example.com, login.example.org");
  await expect.element(sites).toHaveValue("example.com, login.example.org");
});
