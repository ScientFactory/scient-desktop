import type { ServerConfig, ServerProviderStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { useProviderStatusRefresh } from "./useProviderStatusRefresh";

const runtime = {
  source: "missing" as const,
  managedVersion: null,
  canInstall: true,
  canRepair: false,
  canRollback: false,
  canRemove: false,
  message: "No usable provider runtime was found.",
};

function antigravity(checkedAt: string): ServerProviderStatus {
  return {
    provider: "antigravity",
    status: "error",
    available: false,
    authStatus: "unknown",
    checkedAt,
    runtime,
  };
}

function config(provider: ServerProviderStatus): ServerConfig {
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [provider],
    availableEditors: [],
  };
}

function RefreshHarness() {
  useProviderStatusRefresh({ refreshOnFocus: true });
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useProviderStatusRefresh", () => {
  it("preserves managed-install capability after a window-focus refresh", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      serverQueryKeys.config(),
      config(antigravity("2026-07-20T16:00:00.000Z")),
    );
    const refreshProviders = vi.fn().mockResolvedValue({
      providers: [antigravity("2026-07-20T16:05:00.000Z")],
    });
    const previousNativeApi = window.nativeApi;
    const baseApi = readNativeApi();
    if (!baseApi) throw new Error("Expected browser native API fixture.");
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        ...baseApi,
        server: { ...baseApi.server, refreshProviders },
      },
    });

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RefreshHarness />
      </QueryClientProvider>,
    );

    try {
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledTimes(1));
      expect(
        queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers[0]?.runtime
          ?.canInstall,
      ).toBe(true);
    } finally {
      await screen.unmount();
      queryClient.clear();
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    }
  });
});
