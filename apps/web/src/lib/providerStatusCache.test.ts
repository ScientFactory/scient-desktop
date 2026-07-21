import type { ServerConfig, ServerProviderStatus } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { serverQueryKeys } from "./serverReactQuery";
import {
  applyProviderStatusesToCache,
  resetProviderStatusCacheGuardForTests,
} from "./providerStatusCache";

const checkedAt = "2026-07-20T16:00:00.000Z";

function provider(runtime = true): ServerProviderStatus {
  return {
    provider: "antigravity",
    status: "error",
    available: false,
    authStatus: "unknown",
    checkedAt,
    ...(runtime
      ? {
          runtime: {
            source: "missing" as const,
            managedVersion: null,
            canInstall: true,
            canRepair: false,
            canRollback: false,
            canRemove: false,
            message: "No usable provider runtime was found.",
          },
        }
      : {}),
  };
}

function config(status: ServerProviderStatus): ServerConfig {
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [status],
    availableEditors: [],
  };
}

afterEach(() => {
  resetProviderStatusCacheGuardForTests();
  vi.restoreAllMocks();
});

describe("provider status cache invariant", () => {
  it("does not replace a complete status with an incomplete refresh", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(serverQueryKeys.config(), config(provider()));
    const requestSnapshot = vi.fn().mockResolvedValue(config(provider()));

    expect(applyProviderStatusesToCache(queryClient, [provider(false)], { requestSnapshot })).toBe(
      false,
    );
    expect(
      queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers[0]?.runtime
        ?.canInstall,
    ).toBe(true);

    await vi.waitFor(() => expect(requestSnapshot).toHaveBeenCalledTimes(1));
  });

  it("attempts only one bounded resynchronization for repeated incomplete payloads", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(serverQueryKeys.config(), config(provider()));
    const requestSnapshot = vi.fn().mockResolvedValue(config(provider(false)));

    applyProviderStatusesToCache(queryClient, [provider(false)], { requestSnapshot });
    applyProviderStatusesToCache(queryClient, [provider(false)], { requestSnapshot });

    await vi.waitFor(() => expect(requestSnapshot).toHaveBeenCalledTimes(1));
    expect(
      queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers[0]?.runtime
        ?.canInstall,
    ).toBe(true);
  });

  it("accepts a later complete payload and resets the compatibility guard", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(serverQueryKeys.config(), config(provider()));
    const requestSnapshot = vi.fn().mockResolvedValue(config(provider(false)));

    applyProviderStatusesToCache(queryClient, [provider(false)], { requestSnapshot });
    await vi.waitFor(() => expect(requestSnapshot).toHaveBeenCalledTimes(1));

    const connected = {
      ...provider(),
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
    };
    expect(applyProviderStatusesToCache(queryClient, [connected])).toBe(true);
    expect(
      queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.providers[0]?.available,
    ).toBe(true);
  });
});
