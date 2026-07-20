// FILE: ProviderConnectionDialog.browser.tsx
// Purpose: Browser-level coverage for the guided provider connection flow.
// Layer: Vitest browser tests

import "../index.css";

import type {
  ProviderKind,
  ServerConfig,
  ServerProviderConnectionMethod,
  ServerProviderStatus,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { applyProviderStatusesToCache } from "~/lib/providerStatusCache";
import { readNativeApi } from "~/nativeApi";
import { useProviderConnectionDialogStore } from "~/providerConnectionDialogStore";
import { ProviderConnectionDialog } from "./ProviderConnectionDialog";

const checkedAt = "2026-07-19T12:00:00.000Z";
const systemRuntime = {
  source: "system" as const,
  managedVersion: null,
  canInstall: false,
  canRepair: false,
  canRollback: false,
  canRemove: false,
  message: null,
};

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
  refreshProviders?: ReturnType<typeof vi.fn>;
  startProviderConnection?: ReturnType<typeof vi.fn>;
  prepareProviderInstall?: ReturnType<typeof vi.fn>;
  installProvider?: ReturnType<typeof vi.fn>;
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
        ...(overrides.refreshProviders ? { refreshProviders: overrides.refreshProviders } : {}),
        ...(overrides.startProviderConnection
          ? { startProviderConnection: overrides.startProviderConnection }
          : {}),
        ...(overrides.prepareProviderInstall
          ? { prepareProviderInstall: overrides.prepareProviderInstall }
          : {}),
        ...(overrides.installProvider ? { installProvider: overrides.installProvider } : {}),
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
      runtime: systemRuntime,
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
      runtime: systemRuntime,
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

  it.each([
    {
      provider: "claudeAgent",
      method: "claude_console",
      title: "Connect Claude",
      primaryLabel: "Connect Anthropic Console",
    },
    {
      provider: "antigravity",
      method: "antigravity_browser",
      title: "Connect Antigravity",
      primaryLabel: "Continue in browser",
    },
    {
      provider: "grok",
      method: "grok_browser",
      title: "Connect Grok",
      primaryLabel: "Continue in browser",
    },
    {
      provider: "droid",
      method: "droid_device_pairing",
      title: "Connect Droid",
      primaryLabel: "Continue in browser",
    },
  ] satisfies ReadonlyArray<{
    provider: ProviderKind;
    method: ServerProviderConnectionMethod;
    title: string;
    primaryLabel: string;
  }>)(
    "starts the guided $provider connection flow",
    async ({ provider, method, title, primaryLabel }) => {
      const waitingProvider = {
        provider,
        status: "warning",
        available: true,
        authStatus: "unauthenticated",
        checkedAt,
        runtime: systemRuntime,
        connectionState: {
          operationId: `connect-${provider}-1`,
          method,
          status: "waiting_for_browser",
          startedAt: checkedAt,
          finishedAt: null,
          message: "Finish the provider sign-in in your browser.",
        },
      } satisfies ServerProviderStatus;
      const startProviderConnection = vi.fn().mockResolvedValue({ providers: [waitingProvider] });
      const restoreNativeApi = installNativeApi({ startProviderConnection });
      const queryClient = createQueryClient({
        provider,
        status: "warning",
        available: true,
        authStatus: "unauthenticated",
        checkedAt,
        runtime: systemRuntime,
      });
      useProviderConnectionDialogStore.getState().openDialog(provider, "settings");

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <ProviderConnectionDialog />
        </QueryClientProvider>,
      );

      try {
        await expect.element(page.getByRole("heading", { name: title })).toBeVisible();
        await page.getByRole("button", { name: primaryLabel }).click();
        await vi.waitFor(() => {
          expect(startProviderConnection).toHaveBeenCalledWith({ provider, method });
        });
        await expect
          .element(page.getByText("Finish the provider sign-in in your browser."))
          .toBeVisible();
      } finally {
        await screen.unmount();
        queryClient.clear();
        restoreNativeApi();
      }
    },
  );

  it("preserves an invalid custom executable choice instead of replacing it", async () => {
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [] });
    const restoreNativeApi = installNativeApi({ refreshProviders });
    const queryClient = createQueryClient({
      provider: "claudeAgent",
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt,
      runtime: {
        ...systemRuntime,
        source: "custom",
        message: "The configured executable is unavailable.",
      },
    });
    useProviderConnectionDialogStore.getState().openDialog("claudeAgent", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect
        .element(page.getByText("The configured executable is unavailable."))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Open installation guide" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Check again" }).click();
      await vi.waitFor(() => {
        expect(refreshProviders).toHaveBeenCalledTimes(1);
      });
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("requires reviewed consent before starting a managed installation", async () => {
    const installingProvider = {
      provider: "antigravity",
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt,
      runtime: {
        source: "missing",
        managedVersion: null,
        canInstall: false,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: "No usable provider runtime was found.",
      },
      installationState: {
        operationId: "install-antigravity-1",
        operation: "install",
        status: "downloading",
        startedAt: checkedAt,
        finishedAt: null,
        message: "Downloading Antigravity 1.1.4.",
        version: "1.1.4",
        bytesDownloaded: 0,
        totalBytes: 46_664_998,
      },
    } satisfies ServerProviderStatus;
    const prepareProviderInstall = vi.fn().mockResolvedValue({
      provider: "antigravity",
      planToken: "reviewed-plan-1",
      version: "1.1.4",
      target: "darwin-arm64",
      sourceHost: "storage.googleapis.com",
      downloadBytes: 46_664_998,
      expiresAt: "2026-07-19T12:10:00.000Z",
    });
    const installProvider = vi.fn().mockResolvedValue({ providers: [installingProvider] });
    const restoreNativeApi = installNativeApi({ prepareProviderInstall, installProvider });
    const queryClient = createQueryClient({
      provider: "antigravity",
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt,
      runtime: {
        source: "missing",
        managedVersion: null,
        canInstall: true,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: "No usable provider runtime was found.",
      },
    });
    useProviderConnectionDialogStore.getState().openDialog("antigravity", "settings");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Install Antigravity" }).click();
      await expect.element(page.getByText("Ready to install version 1.1.4")).toBeVisible();
      expect(installProvider).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Download and install" }).click();
      await vi.waitFor(() => {
        expect(installProvider).toHaveBeenCalledWith({
          provider: "antigravity",
          planToken: "reviewed-plan-1",
        });
      });
      await expect.element(page.getByText("Downloading Antigravity 1.1.4.")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Cancel installation" })).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("keeps managed installation available after a complete provider refresh", async () => {
    const antigravity = {
      provider: "antigravity",
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt,
      runtime: {
        source: "missing",
        managedVersion: null,
        canInstall: true,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: "No usable provider runtime was found.",
      },
    } satisfies ServerProviderStatus;
    const queryClient = createQueryClient(antigravity);
    useProviderConnectionDialogStore.getState().openDialog("antigravity", "settings");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Install Antigravity" })).toBeVisible();
      applyProviderStatusesToCache(queryClient, [
        { ...antigravity, checkedAt: "2026-07-20T16:05:00.000Z" },
      ]);
      await expect.element(page.getByRole("button", { name: "Install Antigravity" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Open installation guide" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});
