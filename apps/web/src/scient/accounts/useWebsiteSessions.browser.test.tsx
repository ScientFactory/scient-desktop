import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  EnvironmentId,
  defaultAccountControls,
  type AccountsSnapshot,
  type AccountBrowserSessions,
} from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { useWebsiteSessions } from "./useWebsiteSessions";

const state = vi.hoisted(() => ({
  metadata: vi.fn(),
  requests: [] as Array<{
    environmentId: string;
    input: { browserSessions: AccountBrowserSessions };
  }>,
}));
vi.mock("./accountsState", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const family = Atom.family((key: string) => {
    const target = JSON.parse(key) as {
      environmentId: string;
      input: { browserSessions: AccountBrowserSessions };
    };
    state.requests.push(target);
    const name = `${target.input.browserSessions.length ? "Observed" : "Unknown"} ${target.environmentId}`;
    return Atom.make(
      AsyncResult.success({
        ...snapshot,
        accounts: snapshot.accounts.map((account) => ({ ...account, name })),
      }),
    );
  });
  return {
    accountsState: { websiteSnapshot: (target: unknown) => family(JSON.stringify(target)) },
  };
});
const snapshot: AccountsSnapshot = {
  agentAccess: true,
  accounts: [
    {
      accountId: AccountId.make("acc_synthetic01"),
      name: "Original",
      details: { kind: "website", sites: ["example.com"], profileId: "work" },
      secrets: {},
      controls: defaultAccountControls("website"),
      status: "ready",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
    },
  ],
  profiles: [],
  approvals: [],
  recentActivity: [],
  customModelKeys: [],
  stores: {
    scient: { protection: "file" },
    keychain: { available: false, platform: "linux" },
    onePassword: { state: "not-connected" },
  },
};
function View({ environmentId }: { environmentId: string }) {
  const result = useWebsiteSessions(EnvironmentId.make(environmentId), snapshot);
  return <div>{result?.accounts[0]?.name}</div>;
}
function fixture() {
  state.metadata.mockReset();
  state.requests = [];
  const bridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: { cookieMetadata: state.metadata } },
  });
  return {
    [Symbol.dispose]() {
      if (bridge) Object.defineProperty(window, "desktopBridge", bridge);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
}
it("drops an old environment read and refreshes on focus and explicit sign-out, preserving unknown failures", async () => {
  using _fixture = fixture();
  const first = Promise.withResolvers<[]>();
  state.metadata.mockReturnValueOnce(first.promise).mockResolvedValue([]);
  await using screen = await render(<View environmentId="first" />);
  await vi.waitFor(() => expect(state.metadata).toHaveBeenCalledWith("work", "first"));
  await screen.rerender(<View environmentId="second" />);
  await expect.element(page.getByText("Observed second", { exact: true })).toBeVisible();
  await act(async () => {
    first.resolve([]);
    await first.promise;
  });
  expect(state.requests.some((request) => request.environmentId === "first")).toBe(false);
  state.metadata.mockRejectedValueOnce(new Error("Synthetic unavailable profile"));
  await act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await expect.element(page.getByText("Unknown second", { exact: true })).toBeVisible();
  await act(() => {
    window.dispatchEvent(new Event("scient-accounts-session-changed"));
  });
  await expect.element(page.getByText("Observed second", { exact: true })).toBeVisible();
  expect(state.metadata).toHaveBeenCalledTimes(4);
});
