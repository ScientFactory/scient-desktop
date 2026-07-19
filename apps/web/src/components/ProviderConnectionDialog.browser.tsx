// FILE: ProviderConnectionDialog.browser.tsx
// Purpose: Browser-level coverage for the guided provider connection flow.
// Layer: Vitest browser tests

import "../index.css";

import type { ServerConfig, ServerProviderStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { readNativeApi } from "~/nativeApi";
import { useProviderConnectionDialogStore } from "~/providerConnectionDialogStore";
import { ProviderConnectionDialog } from "./ProviderConnectionDialog";

const checkedAt = "2026-07-19T12:00:00.000Z";

function createConfig(provider: ServerProviderStatus): ServerConfig {
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/project/.synara-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [provider],
    availableEditors: [],
  };
}

function createQueryClient(provider: ServerProviderStatus) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(serverQueryKeys.config(), createConfig(provider));
  return queryClient;
}

function installNativeApi(overrides: {
  startProviderConnection?: ReturnType<typeof vi.fn>;
  openExternal?: ReturnType<typeof vi.fn>;
}) {
  const previousNativeApi = window.nativeApi;
  const baseApi = readNativeApi();
  if (!baseApi) throw new Error("Expected browser native API fixture.");

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...baseApi,
      server: {
        ...baseApi.server,
        ...(overrides.startProviderConnection
          ? { startProviderConnection: overrides.startProviderConnection }
          : {}),
      },
      shell: {
        ...baseApi.shell,
        ...(overrides.openExternal ? { openExternal: overrides.openExternal } : {}),
      },
    },
  });

  return () => {
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: previousNativeApi,
    });
  };
}

describe("ProviderConnectionDialog", () => {
  afterEach(() => {
    useProviderConnectionDialogStore.getState().setOpen(false);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("starts official browser sign-in and shows background progress", async () => {
    const waitingProvider = {
      provider: "codex",
      status: "warning",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      connectionState: {
        operationId: "connect-codex-1",
        method: "codex_browser",
        status: "waiting_for_browser",
        startedAt: checkedAt,
        finishedAt: null,
        message: "Finish signing in in the browser window.",
      },
    } satisfies ServerProviderStatus;
    const startProviderConnection = vi.fn().mockResolvedValue({ providers: [waitingProvider] });
    const restoreNativeApi = installNativeApi({ startProviderConnection });
    const queryClient = createQueryClient({
      provider: "codex",
      status: "warning",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
    });
    useProviderConnectionDialogStore.getState().openDialog("codex", "settings");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByRole("heading", { name: "Connect Codex" })).toBeVisible();
      await page.getByRole("button", { name: "Continue in browser" }).click();

      await vi.waitFor(() => {
        expect(startProviderConnection).toHaveBeenCalledWith({
          provider: "codex",
          method: "codex_browser",
        });
      });
      await expect
        .element(page.getByText("Finish signing in in the browser window."))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "Cancel sign in" })).toBeVisible();
      await expect.element(page.getByText(/sign in continues in the background/u)).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("opens official installation guidance when the provider is missing", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const restoreNativeApi = installNativeApi({ openExternal });
    const queryClient = createQueryClient({
      provider: "claudeAgent",
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt,
    });
    useProviderConnectionDialogStore.getState().openDialog("claudeAgent", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Open installation guide" }).click();
      await vi.waitFor(() => {
        expect(openExternal).toHaveBeenCalledWith("https://code.claude.com/docs/en/installation");
      });
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });
});
