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
  const sites = page.getByRole("textbox", { name: "Sites", exact: true });
  await sites.fill("example.com,");
  await expect.element(sites).toHaveValue("example.com,");
  await sites.fill("example.com, login.example.org");
  await expect.element(sites).toHaveValue("example.com, login.example.org");
});
