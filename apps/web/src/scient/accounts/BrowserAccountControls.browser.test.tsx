import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  EnvironmentId,
  defaultAccountControls,
  type AccountsSnapshot,
  type DesktopAccountsBridge,
} from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { BrowserAccountControls } from "./BrowserAccountControls";

const state = vi.hoisted(() => ({
  snapshot: null as AccountsSnapshot | null,
  request: null as (() => Promise<{ ok: true; value: { username: string } }>) | null,
}));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({ data: state.snapshot, canWrite: true }),
  useAccountCommand: () => state.request,
}));

function setup() {
  state.snapshot = null;
  state.request = null;
}

it("withholds autofill from an older bridge and drops values after the tab navigates", async () => {
  setup();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<{ ok: true; value: { username: string } }>();
  state.request = () => {
    entered.resolve();
    return response.promise;
  };
  state.snapshot = {
    agentAccess: true,
    accounts: [
      {
        accountId: AccountId.make("acc_synthetic01"),
        name: "Synthetic",
        details: { kind: "website", sites: ["example.com"] },
        secrets: {},
        controls: defaultAccountControls("website"),
        status: "ready",
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
      },
    ],
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
  let filled = false;
  const bridge: DesktopAccountsBridge = {
    sourceProfiles: async () => [],
    signedInSites: async () => [],
    fill: async () => {
      filled = true;
      return true;
    },
    onSignInCaptured: () => () => undefined,
  };
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  using _bridge = {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: bridge },
  });
  const environmentId = EnvironmentId.make("synthetic");
  await using screen = await render(
    <BrowserAccountControls
      environmentId={environmentId}
      tabId="synthetic-tab"
      profileId="default"
      url="https://example.com/login"
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Fill sign-in", exact: true }))
    .not.toBeInTheDocument();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: { ...bridge, originBoundFill: true } },
  });
  await screen.rerender(
    <BrowserAccountControls
      key="current-bridge"
      environmentId={environmentId}
      tabId="synthetic-tab"
      profileId="default"
      url="https://example.com/login"
    />,
  );
  await page.getByRole("button", { name: "Fill sign-in", exact: true }).click();
  await entered.promise;
  await screen.rerender(
    <BrowserAccountControls
      environmentId={environmentId}
      tabId="synthetic-tab"
      profileId="default"
      url="https://other.example.org"
    />,
  );
  await act(async () => {
    response.resolve({ ok: true, value: { username: "synthetic" } });
    await response.promise;
  });
  expect(filled).toBe(false);
});
