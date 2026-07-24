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
  cancelProviderConnection?: ReturnType<typeof vi.fn>;
  submitProviderConnectionAuthorizationCode?: ReturnType<typeof vi.fn>;
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
        ...(overrides.cancelProviderConnection
          ? { cancelProviderConnection: overrides.cancelProviderConnection }
          : {}),
        ...(overrides.submitProviderConnectionAuthorizationCode
          ? {
              submitProviderConnectionAuthorizationCode:
                overrides.submitProviderConnectionAuthorizationCode,
            }
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
    document.documentElement.style.removeProperty("--app-font-size-ui");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("starts official browser sign-in and shows background progress", async () => {
    const initialProvider = {
      provider: "codex",
      status: "warning",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      runtime: systemRuntime,
    } satisfies ServerProviderStatus;
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
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [initialProvider] });
    const restoreNativeApi = installNativeApi({
      refreshProviders,
      startProviderConnection,
    });
    const queryClient = createQueryClient(initialProvider);
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
      await expect.element(page.getByRole("button", { name: "Cancel sign-in" })).toBeVisible();
      await expect.element(page.getByText(/sign in continues in the background/u)).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("keeps every active sign-in action inside the dialog at the largest UI text size", async () => {
    document.documentElement.style.setProperty("--app-font-size-ui", "18px");
    const activeProvider = {
      provider: "codex",
      status: "warning",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "connect-codex-large-text",
        method: "codex_browser",
        status: "waiting_for_browser",
        startedAt: checkedAt,
        finishedAt: null,
        message: "Finish signing in in the browser window.",
      },
    } satisfies ServerProviderStatus;
    const restoreNativeApi = installNativeApi({});
    const queryClient = createQueryClient(activeProvider);
    useProviderConnectionDialogStore.getState().openDialog("codex", "settings");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await vi.waitFor(() => {
        const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
        const buttons = Array.from(
          popup?.querySelectorAll<HTMLButtonElement>('[data-slot="button"]') ?? [],
        ).filter((button) => button.getAttribute("aria-label") !== "Close");

        expect(popup, "Expected the provider dialog popup.").toBeTruthy();
        expect(buttons).toHaveLength(4);

        const popupRect = popup!.getBoundingClientRect();
        for (const button of buttons) {
          const buttonRect = button.getBoundingClientRect();
          expect(buttonRect.left).toBeGreaterThanOrEqual(popupRect.left);
          expect(buttonRect.right).toBeLessThanOrEqual(popupRect.right);
        }
      });
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("forces a fresh Codex login after a classified runtime auth failure", async () => {
    const authenticatedProvider = {
      provider: "codex",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      requiresProviderAccount: true,
      checkedAt,
      runtime: systemRuntime,
    } satisfies ServerProviderStatus;
    const waitingProvider = {
      ...authenticatedProvider,
      status: "warning",
      authStatus: "unauthenticated",
      connectionState: {
        operationId: "reconnect-codex-1",
        method: "codex_browser",
        status: "waiting_for_browser",
        startedAt: checkedAt,
        finishedAt: null,
        message: "Finish reconnecting Codex in the browser window.",
      },
    } satisfies ServerProviderStatus;
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [authenticatedProvider] });
    const startProviderConnection = vi.fn().mockResolvedValue({ providers: [waitingProvider] });
    const restoreNativeApi = installNativeApi({ refreshProviders, startProviderConnection });
    const queryClient = createQueryClient(authenticatedProvider);
    useProviderConnectionDialogStore.getState().openDialog("codex", "runtime_authentication_error");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Reconnect Codex" })).toBeVisible();
      await page.getByRole("button", { name: "Reconnect Codex" }).click();
      await vi.waitFor(() => {
        expect(startProviderConnection).toHaveBeenCalledWith({
          provider: "codex",
          method: "codex_browser",
          mode: "reauthenticate",
        });
      });
      await expect
        .element(page.getByText("Finish reconnecting Codex in the browser window."))
        .toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("does not mistake a stale connected operation for completion of the new recovery attempt", async () => {
    const staleConnectedProvider = {
      provider: "codex",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      requiresProviderAccount: true,
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "stale-connected-operation",
        method: "codex_browser",
        status: "connected",
        startedAt: checkedAt,
        finishedAt: checkedAt,
        message: "An older sign-in completed.",
      },
    } satisfies ServerProviderStatus;
    const newlyConnectedProvider = {
      ...staleConnectedProvider,
      connectionState: {
        ...staleConnectedProvider.connectionState,
        operationId: "new-connected-operation",
        message: "The new sign-in completed.",
      },
    } satisfies ServerProviderStatus;
    let resolveStartProviderConnection:
      | ((value: { providers: ServerProviderStatus[] }) => void)
      | undefined;
    const startProviderConnection = vi.fn(
      () =>
        new Promise<{ providers: ServerProviderStatus[] }>((resolve) => {
          resolveStartProviderConnection = resolve;
        }),
    );
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [staleConnectedProvider] });
    const restoreNativeApi = installNativeApi({ refreshProviders, startProviderConnection });
    const queryClient = createQueryClient(staleConnectedProvider);
    useProviderConnectionDialogStore.getState().openDialog("codex", "runtime_authentication_error");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Reconnect Codex" }).click();
      await vi.waitFor(() => expect(startProviderConnection).toHaveBeenCalledTimes(1));
      await expect.element(page.getByRole("button", { name: "Done" })).not.toBeInTheDocument();

      resolveStartProviderConnection?.({ providers: [newlyConnectedProvider] });
      await expect.element(page.getByRole("button", { name: "Done" })).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it.each(["failed", "cancelled"] as const)(
    "keeps a %s recovery attempt retryable and forced despite stale authenticated health",
    async (operationStatus) => {
      const terminalProvider = {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        requiresProviderAccount: true,
        checkedAt,
        runtime: systemRuntime,
        connectionState: {
          operationId: `reconnect-codex-${operationStatus}`,
          method: "codex_browser",
          status: operationStatus,
          startedAt: checkedAt,
          finishedAt: checkedAt,
          message: `Codex reconnect ${operationStatus}.`,
        },
      } satisfies ServerProviderStatus;
      const waitingProvider = {
        ...terminalProvider,
        status: "warning",
        authStatus: "unauthenticated",
        connectionState: {
          ...terminalProvider.connectionState,
          operationId: `reconnect-codex-${operationStatus}-retry`,
          status: "waiting_for_browser",
          finishedAt: null,
          message: "Finish reconnecting Codex in the browser window.",
        },
      } satisfies ServerProviderStatus;
      const refreshProviders = vi.fn().mockResolvedValue({ providers: [terminalProvider] });
      const startProviderConnection = vi.fn().mockResolvedValue({ providers: [waitingProvider] });
      const restoreNativeApi = installNativeApi({ refreshProviders, startProviderConnection });
      const queryClient = createQueryClient(terminalProvider);
      useProviderConnectionDialogStore
        .getState()
        .openDialog("codex", "runtime_authentication_error");

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <ProviderConnectionDialog />
        </QueryClientProvider>,
      );

      try {
        await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
        await expect.element(page.getByRole("button", { name: "Done" })).not.toBeInTheDocument();
        await page.getByRole("button", { name: "Try again" }).click();
        await vi.waitFor(() =>
          expect(startProviderConnection).toHaveBeenCalledWith({
            provider: "codex",
            method: "codex_browser",
            mode: "reauthenticate",
          }),
        );
      } finally {
        await screen.unmount();
        queryClient.clear();
        restoreNativeApi();
      }
    },
  );

  it("keeps restart inside an active recovery attempt in forced reauthentication mode", async () => {
    const activeProvider = {
      provider: "codex",
      status: "warning",
      available: true,
      authStatus: "authenticated",
      requiresProviderAccount: true,
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "reconnect-codex-active",
        method: "codex_browser",
        status: "waiting_for_browser",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: "Finish reconnecting Codex.",
      },
    } satisfies ServerProviderStatus;
    const cancelledProvider = {
      ...activeProvider,
      connectionState: {
        ...activeProvider.connectionState,
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        message: "Codex reconnect cancelled.",
      },
    } satisfies ServerProviderStatus;
    const restartedProvider = {
      ...activeProvider,
      connectionState: {
        ...activeProvider.connectionState,
        operationId: "reconnect-codex-restarted",
      },
    } satisfies ServerProviderStatus;
    const cancelProviderConnection = vi.fn().mockResolvedValue({ providers: [cancelledProvider] });
    const startProviderConnection = vi.fn().mockResolvedValue({ providers: [restartedProvider] });
    const restoreNativeApi = installNativeApi({
      cancelProviderConnection,
      startProviderConnection,
    });
    const queryClient = createQueryClient(activeProvider);
    useProviderConnectionDialogStore.getState().openDialog("codex", "runtime_authentication_error");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Restart sign in" }).click();
      await vi.waitFor(() => {
        expect(cancelProviderConnection).toHaveBeenCalledWith({
          provider: "codex",
          operationId: "reconnect-codex-active",
        });
        expect(startProviderConnection).toHaveBeenCalledWith({
          provider: "codex",
          method: "codex_browser",
          mode: "reauthenticate",
        });
      });
      expect(cancelProviderConnection.mock.invocationCallOrder[0]).toBeLessThan(
        startProviderConnection.mock.invocationCallOrder[0]!,
      );
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it.each([
    {
      provider: "claudeAgent",
      method: "claude_account",
      title: "Connect Claude",
      primaryLabel: "Connect Claude",
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
      const initialProvider = {
        provider,
        status: "warning",
        available: true,
        authStatus: "unauthenticated",
        checkedAt,
        runtime: systemRuntime,
      } satisfies ServerProviderStatus;
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
      const refreshProviders = vi.fn().mockResolvedValue({ providers: [initialProvider] });
      const restoreNativeApi = installNativeApi({
        refreshProviders,
        startProviderConnection,
      });
      const queryClient = createQueryClient(initialProvider);
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
    const unavailableProvider = {
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
    } satisfies ServerProviderStatus;
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [unavailableProvider] });
    const restoreNativeApi = installNativeApi({ refreshProviders });
    const queryClient = createQueryClient(unavailableProvider);
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
      await vi.waitFor(() => expect(refreshProviders).toHaveBeenCalledTimes(2));
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("offers Claude SSO and Console as explicit alternative methods", async () => {
    const provider = {
      provider: "claudeAgent",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      runtime: systemRuntime,
    } satisfies ServerProviderStatus;
    const waitingProvider = {
      ...provider,
      connectionState: {
        operationId: "connect-claude-sso-1",
        method: "claude_sso",
        status: "waiting_for_browser",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: "Finish organization sign-in.",
      },
    } satisfies ServerProviderStatus;
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [provider] });
    const startProviderConnection = vi.fn().mockResolvedValue({ providers: [waitingProvider] });
    const restoreNativeApi = installNativeApi({ refreshProviders, startProviderConnection });
    const queryClient = createQueryClient(provider);
    useProviderConnectionDialogStore.getState().openDialog("claudeAgent", "settings");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect
        .element(page.getByRole("button", { name: /Work or organization SSO/u }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: /Anthropic Console \/ API/u }))
        .toBeVisible();
      await page.getByRole("button", { name: /Work or organization SSO/u }).click();
      await vi.waitFor(() =>
        expect(startProviderConnection).toHaveBeenCalledWith({
          provider: "claudeAgent",
          method: "claude_sso",
        }),
      );
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("refreshes on open and never starts sign-in for an existing terminal account", async () => {
    const unauthenticated = {
      provider: "claudeAgent",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      runtime: systemRuntime,
    } satisfies ServerProviderStatus;
    const authenticated = {
      ...unauthenticated,
      status: "ready",
      authStatus: "authenticated",
      authLabel: "Claude Max Subscription",
    } satisfies ServerProviderStatus;
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [authenticated] });
    const startProviderConnection = vi.fn();
    const restoreNativeApi = installNativeApi({ refreshProviders, startProviderConnection });
    const queryClient = createQueryClient(unauthenticated);
    useProviderConnectionDialogStore.getState().openDialog("claudeAgent", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Done" })).toBeVisible();
      expect(startProviderConnection).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("reopens an active attempt with cancel, restart, and timeout controls", async () => {
    const active = {
      provider: "claudeAgent",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "connect-claude-active",
        method: "claude_account",
        status: "waiting_for_browser",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: "Finish signing in to Claude.",
      },
    } satisfies ServerProviderStatus;
    const cancelled = {
      ...active,
      connectionState: {
        ...active.connectionState,
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        message: "Sign in was cancelled.",
      },
    } satisfies ServerProviderStatus;
    const restarted = {
      ...active,
      connectionState: { ...active.connectionState, operationId: "connect-claude-restarted" },
    } satisfies ServerProviderStatus;
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [active] });
    const cancelProviderConnection = vi.fn().mockResolvedValue({ providers: [cancelled] });
    const startProviderConnection = vi.fn().mockResolvedValue({ providers: [restarted] });
    const restoreNativeApi = installNativeApi({
      refreshProviders,
      cancelProviderConnection,
      startProviderConnection,
    });
    const queryClient = createQueryClient(active);
    useProviderConnectionDialogStore.getState().openDialog("claudeAgent", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Cancel sign-in" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Restart sign in" })).toBeVisible();
      await expect.element(page.getByText(/Automatic timeout in/u)).toBeVisible();
      await page.getByRole("button", { name: "Restart sign in" }).click();
      await vi.waitFor(() => {
        expect(cancelProviderConnection).toHaveBeenCalledWith({
          provider: "claudeAgent",
          operationId: "connect-claude-active",
        });
        expect(startProviderConnection).toHaveBeenCalledWith({
          provider: "claudeAgent",
          method: "claude_account",
        });
      });
      expect(cancelProviderConnection.mock.invocationCallOrder[0]).toBeLessThan(
        startProviderConnection.mock.invocationCallOrder[0]!,
      );
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("reopens the validated xAI authorization page without terminal use", async () => {
    const authorizationUrl =
      "https://auth.x.ai/oauth2/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A50418%2Fcallback&state=test-state&code_challenge=test-challenge";
    const active = {
      provider: "grok",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "connect-grok-active",
        method: "grok_browser",
        status: "waiting_for_browser",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: "Finish signing in to Grok.",
        authorizationUrl,
      },
      installationState: {
        operationId: "install-grok-finished",
        operation: "install",
        status: "installed",
        startedAt: checkedAt,
        finishedAt: checkedAt,
        message: "Grok is installed and verified.",
      },
    } satisfies ServerProviderStatus;
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const cancelled = {
      ...active,
      connectionState: {
        ...active.connectionState,
        status: "cancelled",
        finishedAt: checkedAt,
        message: "Sign in was cancelled.",
      },
    } satisfies ServerProviderStatus;
    const cancelProviderConnection = vi.fn().mockResolvedValue({ providers: [cancelled] });
    const restoreNativeApi = installNativeApi({ openExternal, cancelProviderConnection });
    const queryClient = createQueryClient(active);
    useProviderConnectionDialogStore.getState().openDialog("grok", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      const progressActions = page.getByRole("group", { name: "Sign-in progress actions" });
      await progressActions.getByRole("button", { name: "Open browser again" }).click();
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(authorizationUrl));
      await expect
        .element(page.getByPlaceholder("Paste authorization code"))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Cancel installation" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Cancel sign-in" }).click();
      await vi.waitFor(() =>
        expect(cancelProviderConnection).toHaveBeenCalledWith({
          provider: "grok",
          operationId: "connect-grok-active",
        }),
      );
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("keeps a device-code recovery action when normal browser opening fails", async () => {
    const authorizationUrl =
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    const active = {
      provider: "codex",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      requiresProviderAccount: true,
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "connect-codex-active",
        method: "codex_browser",
        status: "waiting_for_browser",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: "Finish signing in to ChatGPT in the browser window.",
        authorizationUrl,
      },
    } satisfies ServerProviderStatus;
    const openExternal = vi.fn().mockRejectedValue(new Error("browser unavailable"));
    const cancelled = {
      ...active,
      connectionState: {
        ...active.connectionState,
        status: "cancelled",
        finishedAt: checkedAt,
        message: "Sign in was cancelled.",
      },
    } satisfies ServerProviderStatus;
    const device = {
      ...active,
      connectionState: {
        operationId: "connect-codex-device",
        method: "codex_device_code",
        status: "waiting_for_browser",
        startedAt: active.connectionState.startedAt,
        finishedAt: null,
        message: "Enter the one-time code shown here.",
      },
    } satisfies ServerProviderStatus;
    const cancelProviderConnection = vi.fn().mockResolvedValue({ providers: [cancelled] });
    const startProviderConnection = vi.fn().mockResolvedValue({ providers: [device] });
    const restoreNativeApi = installNativeApi({
      openExternal,
      cancelProviderConnection,
      startProviderConnection,
    });
    const queryClient = createQueryClient(active);
    useProviderConnectionDialogStore.getState().openDialog("codex", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Open browser again" }).click();
      await expect.element(page.getByText("browser unavailable")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Open browser again" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Use device code instead" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Use device code instead" }).click();
      await vi.waitFor(() => {
        expect(cancelProviderConnection).toHaveBeenCalledWith({
          provider: "codex",
          operationId: "connect-codex-active",
        });
        expect(startProviderConnection).toHaveBeenCalledWith({
          provider: "codex",
          method: "codex_device_code",
        });
      });
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("shows Codex's official device code without exposing provider credentials", async () => {
    const authorizationUrl = "https://auth.openai.com/codex/device";
    const active = {
      provider: "codex",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      requiresProviderAccount: true,
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "connect-codex-device",
        method: "codex_device_code",
        status: "waiting_for_browser",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: "Enter the one-time code shown here.",
        authorizationUrl,
        userCode: "ABCD-EFGH",
      },
    } satisfies ServerProviderStatus;
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const restoreNativeApi = installNativeApi({ openExternal });
    const queryClient = createQueryClient(active);
    useProviderConnectionDialogStore.getState().openDialog("codex", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(authorizationUrl));
      await expect.element(page.getByText("ABCD-EFGH")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Copy code" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Use device code instead" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("reopens the validated Google authorization page without terminal use", async () => {
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    const active = {
      provider: "antigravity",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "connect-antigravity-active",
        method: "antigravity_browser",
        status: "waiting_for_browser",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: "Finish signing in to Google.",
        authorizationUrl,
      },
    } satisfies ServerProviderStatus;
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const restoreNativeApi = installNativeApi({ openExternal });
    const queryClient = createQueryClient(active);
    useProviderConnectionDialogStore.getState().openDialog("antigravity", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Open browser again" }).click();
      await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(authorizationUrl));
      await expect.element(page.getByText(/Automatic timeout in (?:10:00|9:5\d)/u)).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("stops showing the OAuth countdown while Antigravity verifies the account", async () => {
    const verifying = {
      provider: "antigravity",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "connect-antigravity-verifying",
        method: "antigravity_browser",
        status: "verifying",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: "Verifying the connection.",
      },
    } satisfies ServerProviderStatus;
    const restoreNativeApi = installNativeApi({});
    const queryClient = createQueryClient(verifying);
    useProviderConnectionDialogStore.getState().openDialog("antigravity", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByText("Verifying the connection.")).toBeVisible();
      await expect.element(page.getByText(/Automatic timeout in/u)).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "clears Google's one-time code immediately and ignores a late %s after cancellation",
    async (lateSettlement) => {
      const active = {
        provider: "antigravity",
        status: "error",
        available: true,
        authStatus: "unauthenticated",
        checkedAt,
        runtime: systemRuntime,
        connectionState: {
          operationId: "connect-antigravity-code",
          method: "antigravity_browser",
          status: "waiting_for_browser",
          startedAt: new Date().toISOString(),
          finishedAt: null,
          message: "Finish signing in to Google, then paste the code here.",
        },
      } satisfies ServerProviderStatus;
      const cancelled = {
        ...active,
        connectionState: {
          ...active.connectionState,
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          message: "Sign in was cancelled.",
        },
      } satisfies ServerProviderStatus;
      let resolveSubmission!: (result: { providers: ServerProviderStatus[] }) => void;
      let rejectSubmission!: (error: Error) => void;
      const pendingSubmission = new Promise<{ providers: ServerProviderStatus[] }>(
        (resolve, reject) => {
          resolveSubmission = resolve;
          rejectSubmission = reject;
        },
      );
      const submitProviderConnectionAuthorizationCode = vi.fn().mockReturnValue(pendingSubmission);
      const cancelProviderConnection = vi.fn().mockResolvedValue({ providers: [cancelled] });
      const restoreNativeApi = installNativeApi({
        submitProviderConnectionAuthorizationCode,
        cancelProviderConnection,
      });
      const queryClient = createQueryClient(active);
      useProviderConnectionDialogStore.getState().openDialog("antigravity", "provider_picker");

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <ProviderConnectionDialog />
        </QueryClientProvider>,
      );

      try {
        const submitButton = page.getByRole("button", { name: "Submit code" });
        await expect.element(submitButton).toBeDisabled();
        await page.getByPlaceholder("Paste authorization code").fill("4/test-code-123");
        await submitButton.click();
        await vi.waitFor(() =>
          expect(submitProviderConnectionAuthorizationCode).toHaveBeenCalledWith({
            provider: "antigravity",
            operationId: "connect-antigravity-code",
            authorizationCode: "4/test-code-123",
          }),
        );
        await expect.element(page.getByText("Code submitted. Finishing sign in.")).toBeVisible();
        await expect
          .element(page.getByPlaceholder("Paste authorization code"))
          .not.toBeInTheDocument();
        const cancelButton = page.getByRole("button", { name: "Cancel sign-in" });
        const restartButton = page.getByRole("button", { name: "Restart sign in" });
        await expect.element(cancelButton).not.toBeDisabled();
        await expect.element(restartButton).not.toBeDisabled();
        expect(submitProviderConnectionAuthorizationCode).toHaveBeenCalledTimes(1);
        await cancelButton.click();
        await vi.waitFor(() =>
          expect(cancelProviderConnection).toHaveBeenCalledWith({
            provider: "antigravity",
            operationId: "connect-antigravity-code",
          }),
        );
        await expect.element(page.getByText("Sign in was cancelled.")).toBeVisible();

        if (lateSettlement === "resolve") resolveSubmission({ providers: [active] });
        else rejectSubmission(new Error("Stale authorization-code failure."));
        await Promise.resolve();
        await Promise.resolve();

        await expect.element(page.getByText("Sign in was cancelled.")).toBeVisible();
        await expect
          .element(page.getByText("Stale authorization-code failure."))
          .not.toBeInTheDocument();
        expect(
          queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers[0]
            ?.connectionState?.status,
        ).toBe("cancelled");
      } finally {
        await screen.unmount();
        queryClient.clear();
        restoreNativeApi();
      }
    },
  );

  it("retries the same Claude sign-in method after a failed attempt", async () => {
    const failed = {
      provider: "claudeAgent",
      status: "error",
      available: true,
      authStatus: "unauthenticated",
      checkedAt,
      runtime: systemRuntime,
      connectionState: {
        operationId: "connect-claude-failed",
        method: "claude_sso",
        status: "failed",
        startedAt: checkedAt,
        finishedAt: checkedAt,
        message: "Organization sign-in was not completed.",
      },
    } satisfies ServerProviderStatus;
    const restarted = {
      ...failed,
      connectionState: {
        ...failed.connectionState,
        operationId: "connect-claude-retry",
        status: "waiting_for_browser",
        finishedAt: null,
      },
    } satisfies ServerProviderStatus;
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [failed] });
    const startProviderConnection = vi.fn().mockResolvedValue({ providers: [restarted] });
    const restoreNativeApi = installNativeApi({ refreshProviders, startProviderConnection });
    const queryClient = createQueryClient(failed);
    useProviderConnectionDialogStore.getState().openDialog("claudeAgent", "provider_picker");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Try again" }).click();
      await vi.waitFor(() =>
        expect(startProviderConnection).toHaveBeenCalledWith({
          provider: "claudeAgent",
          method: "claude_sso",
        }),
      );
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("requires explicit consent before installing the trusted latest release", async () => {
    const initialProvider = {
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
        message: "Downloading Antigravity 1.1.5.",
        version: "1.1.5",
        bytesDownloaded: 0,
        totalBytes: 46_664_998,
      },
    } satisfies ServerProviderStatus;
    const prepareProviderInstall = vi.fn().mockResolvedValue({
      provider: "antigravity",
      planToken: "trusted-plan-1",
      version: "1.1.5",
      target: "darwin-arm64",
      sourceHost: "storage.googleapis.com",
      downloadBytes: 46_664_998,
      expiresAt: "2026-07-19T12:10:00.000Z",
    });
    const installProvider = vi.fn().mockResolvedValue({ providers: [installingProvider] });
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [initialProvider] });
    const restoreNativeApi = installNativeApi({
      refreshProviders,
      prepareProviderInstall,
      installProvider,
    });
    const queryClient = createQueryClient(initialProvider);
    useProviderConnectionDialogStore.getState().openDialog("antigravity", "settings");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await page.getByRole("button", { name: "Install Antigravity" }).click();
      await expect.element(page.getByText("Ready to install version 1.1.5")).toBeVisible();
      expect(installProvider).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Download, install and sign in" }).click();
      await vi.waitFor(() => {
        expect(installProvider).toHaveBeenCalledWith({
          provider: "antigravity",
          planToken: "trusted-plan-1",
          connectionMethod: "antigravity_browser",
        });
      });
      await expect.element(page.getByText("Downloading Antigravity 1.1.5.")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Cancel installation" })).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("updates a managed runtime through the verified install lifecycle", async () => {
    const currentProvider = {
      provider: "antigravity",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      version: "1.1.4",
      checkedAt,
      runtime: {
        source: "managed",
        managedVersion: "1.1.4",
        canInstall: false,
        canRepair: true,
        canRollback: false,
        canRemove: true,
        message: null,
      },
      versionAdvisory: {
        status: "unknown",
        currentVersion: "1.1.4",
        latestVersion: null,
        updateCommand: null,
        canUpdate: false,
        checkedAt,
        message: "Updates for this runtime are managed by Scient.",
      },
    } satisfies ServerProviderStatus;
    const updatingProvider = {
      ...currentProvider,
      installationState: {
        operationId: "update-antigravity-1",
        operation: "install",
        status: "downloading",
        startedAt: checkedAt,
        finishedAt: null,
        message: "Downloading Antigravity 1.1.5.",
        version: "1.1.5",
        bytesDownloaded: 0,
        totalBytes: null,
      },
    } satisfies ServerProviderStatus;
    const prepareProviderInstall = vi.fn().mockResolvedValue({
      provider: "antigravity",
      planToken: "managed-update-plan-1",
      version: "1.1.5",
      target: "darwin-arm64",
      sourceHost: "storage.googleapis.com",
      downloadBytes: null,
      expiresAt: "2026-07-21T12:10:00.000Z",
    });
    const installProvider = vi.fn().mockResolvedValue({ providers: [updatingProvider] });
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [currentProvider] });
    const restoreNativeApi = installNativeApi({
      refreshProviders,
      prepareProviderInstall,
      installProvider,
    });
    const queryClient = createQueryClient(currentProvider);
    useProviderConnectionDialogStore.getState().openDialog("antigravity", "managed_update");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByRole("heading", { name: "Update Antigravity" })).toBeVisible();
      await page.getByRole("button", { name: "Check latest version" }).click();
      await expect.element(page.getByText("Ready to update from 1.1.4 to 1.1.5")).toBeVisible();
      expect(installProvider).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Download and update" }).click();
      await vi.waitFor(() => {
        expect(installProvider).toHaveBeenCalledWith({
          provider: "antigravity",
          planToken: "managed-update-plan-1",
        });
      });
      await expect.element(page.getByText("Downloading Antigravity 1.1.5.")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Cancel installation" })).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
      restoreNativeApi();
    }
  });

  it("shows a persisted installation failure after restart and keeps retry available", async () => {
    const failureMessage =
      "Installation failed while downloading the provider: the connection was reset.";
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
      installationState: {
        operationId: "install-antigravity-failed",
        operation: "install",
        status: "failed",
        startedAt: checkedAt,
        finishedAt: "2026-07-19T12:01:00.000Z",
        message: failureMessage,
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
      await expect.element(page.getByText(failureMessage)).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Try installation again" }))
        .toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("retries sign-in instead of reinstalling after an automatic handoff failure", async () => {
    const failureMessage = "Installation succeeded, but sign in could not start.";
    const codex = {
      provider: "codex",
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt,
      runtime: {
        source: "managed",
        managedVersion: "0.145.0",
        canInstall: false,
        canRepair: true,
        canRollback: false,
        canRemove: true,
        message: null,
      },
      installationState: {
        operationId: "install-codex-1",
        operation: "install",
        status: "installed",
        startedAt: checkedAt,
        finishedAt: "2026-07-19T12:01:00.000Z",
        message: "Codex is installed and verified.",
      },
      connectionState: {
        operationId: "handoff-install-codex-1",
        method: "codex_browser",
        status: "failed",
        startedAt: "2026-07-19T12:01:00.000Z",
        finishedAt: "2026-07-19T12:01:01.000Z",
        message: failureMessage,
      },
    } satisfies ServerProviderStatus;
    const retrying = {
      ...codex,
      connectionState: {
        operationId: "connect-codex-retry",
        method: "codex_browser",
        status: "waiting_for_browser",
        startedAt: "2026-07-19T12:02:00.000Z",
        finishedAt: null,
        message: "Finish the provider sign-in in your browser.",
      },
    } satisfies ServerProviderStatus;
    const startProviderConnection = vi.fn().mockResolvedValue({ providers: [retrying] });
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [codex] });
    const restoreNativeApi = installNativeApi({ refreshProviders, startProviderConnection });
    const queryClient = createQueryClient(codex);
    useProviderConnectionDialogStore.getState().openDialog("codex", "settings");

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ProviderConnectionDialog />
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByText(failureMessage)).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Open installation guide" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Try again" }).click();
      await vi.waitFor(() =>
        expect(startProviderConnection).toHaveBeenCalledWith({
          provider: "codex",
          method: "codex_browser",
        }),
      );
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
