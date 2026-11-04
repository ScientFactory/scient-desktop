import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  EnvironmentId,
  ThreadId,
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
        secrets: { password: { source: { type: "scient" } } },
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
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
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
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
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
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
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

it("offers to save a typed sign-in, except on a tab where Scient's sign-in keeps it", async () => {
  setup();
  state.request = async () => ({ ok: true, value: { result: "new" } }) as never;
  const listeners = new Set<
    (capture: Parameters<Parameters<DesktopAccountsBridge["onSignInCaptured"]>[0]>[0]) => void
  >();
  const bridge: DesktopAccountsBridge = {
    sourceProfiles: async () => [],
    signedInSites: async () => [],
    fill: async () => false,
    onSignInCaptured: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
  const snapshot = (attempts: AccountsSnapshot["attempts"]): AccountsSnapshot => ({
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
    features: { keepTyped: true },
    attempts,
  });
  const environmentId = EnvironmentId.make("synthetic");
  const controls = (key: string) => (
    <BrowserAccountControls
      key={key}
      environmentId={environmentId}
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
      tabId="synthetic-tab"
      previewTabId="preview-tab"
      profileId="default"
      url="https://example.com/login"
    />
  );
  const capture = () =>
    act(async () => {
      for (const listener of listeners)
        listener({
          tabId: "synthetic-tab",
          profileId: "default",
          url: "https://example.com",
          path: "/login",
          step: "password",
          username: "synthetic",
          password: "synthetic-password",
          usernameFrom: "form",
        });
    });
  state.snapshot = snapshot([
    {
      attemptId: "attempt-1",
      threadId: ThreadId.make("synthetic-thread"),
      tabId: "preview-tab",
      accountId: AccountId.make("acc_synthetic01"),
      state: "person",
    },
  ]);
  await using screen = await render(controls("attempt"));
  await capture();
  await expect.element(page.getByText("Save sign-in?").first()).not.toBeInTheDocument();
  state.snapshot = snapshot([]);
  await screen.rerender(controls("no-attempt"));
  await capture();
  await expect.element(page.getByText("Save sign-in?").first()).toBeInTheDocument();
});
