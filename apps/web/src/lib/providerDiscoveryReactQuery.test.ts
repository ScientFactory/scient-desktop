// FILE: providerDiscoveryReactQuery.test.ts
// Purpose: Locks provider model discovery query semantics — retry policy,
//          stale-catalog preservation, and initial-vs-background pending (#103).
// Layer: Web data fetching tests

import type { NativeApi } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isInitialModelDiscoveryPending,
  providerAgentsQueryOptions,
  providerCommandsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerModelsQueryOptions,
  providerPluginsQueryOptions,
  providerReadPluginQueryOptions,
  providerSkillsQueryOptions,
  skillsCatalogQueryOptions,
} from "./providerDiscoveryReactQuery";
import * as nativeApi from "../nativeApi";
import { setProviderDiscoveryGeneration } from "./providerDiscoveryInvalidation";

function mockListModels(listModels: ReturnType<typeof vi.fn>) {
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    provider: { listModels },
  } as unknown as NativeApi);
  return listModels;
}

function mockListAgents(listAgents: ReturnType<typeof vi.fn>) {
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    provider: { listAgents },
  } as unknown as NativeApi);
  return listAgents;
}

afterEach(() => {
  setProviderDiscoveryGeneration("initial");
  vi.restoreAllMocks();
});

describe("isInitialModelDiscoveryPending", () => {
  it("is pending only for the first fetch (loading or placeholder fetch)", () => {
    expect(
      isInitialModelDiscoveryPending({
        isLoading: true,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    // Settled catalog + background refetch must not blank the picker (#103).
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: false,
      }),
    ).toBe(false);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: false,
        isPlaceholderData: false,
      }),
    ).toBe(false);
  });
});

describe("providerModelsQueryOptions", () => {
  it("scopes Claude discovery and its cache identity to the configured executable", async () => {
    setProviderDiscoveryGeneration("auth-generation-a");
    const listModels = mockListModels(vi.fn().mockResolvedValue({ models: [] }));
    const configuredOptions = providerModelsQueryOptions({
      provider: "claudeAgent",
      binaryPath: "/opt/claude-custom",
    });
    const pathOptions = providerModelsQueryOptions({ provider: "claudeAgent" });

    expect(configuredOptions.queryKey).not.toEqual(pathOptions.queryKey);
    expect(configuredOptions.placeholderData).toBeUndefined();

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(configuredOptions);
    expect(listModels).toHaveBeenCalledWith({
      provider: "claudeAgent",
      binaryPath: "/opt/claude-custom",
      discoveryGeneration: "auth-generation-a",
    });

    setProviderDiscoveryGeneration("auth-generation-b");
    const nextGenerationOptions = providerModelsQueryOptions({
      provider: "claudeAgent",
      binaryPath: "/opt/claude-custom",
    });
    expect(nextGenerationOptions.queryKey).not.toEqual(configuredOptions.queryKey);
  });

  it("discards a Claude model catalog that resolves after the provider generation changes", async () => {
    let resolveModels: ((result: { models: [] }) => void) | undefined;
    const listModels = mockListModels(
      vi.fn(
        () =>
          new Promise<{ models: [] }>((resolve) => {
            resolveModels = resolve;
          }),
      ),
    );
    setProviderDiscoveryGeneration("signed-out");
    const options = providerModelsQueryOptions({ provider: "claudeAgent" });
    setProviderDiscoveryGeneration("signed-in");
    const queryClient = new QueryClient();
    const pending = queryClient.fetchQuery({ ...options, retry: false });

    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    expect(listModels).toHaveBeenCalledWith({
      provider: "claudeAgent",
      discoveryGeneration: "signed-out",
    });
    resolveModels?.({ models: [] });

    await expect(pending).rejects.toThrow(/stale Claude model catalog/u);
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
  });

  it("fails fast for Cursor so a missing CLI settles instead of spinning (#103)", async () => {
    const listModels = mockListModels(
      vi.fn().mockRejectedValue(new Error("Cursor CLI is not installed or not on PATH")),
    );
    const options = providerModelsQueryOptions({
      provider: "cursor",
      enabled: true,
    });
    expect(options.retry).toBe(0);

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).rejects.toThrow(
      "Cursor CLI is not installed or not on PATH",
    );
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(options.queryKey)?.status).toBe("error");
  });

  it("keeps retrying transient failures for other providers", () => {
    expect(providerModelsQueryOptions({ provider: "codex" }).retry).toBe(3);
    expect(providerModelsQueryOptions({ provider: "droid" }).retry).toBe(0);
  });

  it("never re-runs provider discovery just because the window regained focus", () => {
    const options = [
      providerComposerCapabilitiesQueryOptions("codex"),
      providerModelsQueryOptions({ provider: "codex" }),
      providerAgentsQueryOptions({ provider: "codex" }),
      providerCommandsQueryOptions({ provider: "codex", cwd: "/repo" }),
      providerSkillsQueryOptions({ provider: "codex", cwd: "/repo" }),
      providerPluginsQueryOptions({ provider: "codex", cwd: "/repo" }),
      providerReadPluginQueryOptions({
        provider: "codex",
        marketplacePath: "/marketplace",
        pluginName: "example",
        cwd: "/repo",
      }),
      skillsCatalogQueryOptions({ cwd: "/repo" }),
    ];

    for (const option of options) {
      expect(option.refetchOnWindowFocus).toBe(false);
    }
  });

  it("surfaces real errors instead of masking them as empty catalogs", async () => {
    mockListModels(vi.fn().mockRejectedValue(new Error("discovery exploded")));
    const options = providerModelsQueryOptions({
      provider: "cursor",
      enabled: true,
    });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).rejects.toThrow("discovery exploded");
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
  });

  it("preserves the cached catalog when a background refetch fails", async () => {
    const catalog = {
      models: [{ slug: "auto", name: "Auto" }],
      source: "cursor.cli",
      cached: false,
    };
    const listModels = mockListModels(
      vi.fn().mockResolvedValueOnce(catalog).mockRejectedValue(new Error("cursor went away")),
    );
    const options = providerModelsQueryOptions({
      provider: "cursor",
      enabled: true,
    });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).resolves.toEqual(catalog);
    await queryClient.refetchQueries({ queryKey: options.queryKey });

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(options.queryKey)).toEqual(catalog);
  });

  it("returns successful catalogs unchanged", async () => {
    const catalog = {
      models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      source: "codex",
      cached: false,
    };
    mockListModels(vi.fn().mockResolvedValue(catalog));
    const options = providerModelsQueryOptions({
      provider: "codex",
      enabled: true,
    });

    const queryClient = new QueryClient();
    await expect(queryClient.fetchQuery(options)).resolves.toEqual(catalog);
  });
});

describe("providerAgentsQueryOptions", () => {
  it("preserves non-Claude agent cache identity and placeholder behavior across generations", () => {
    setProviderDiscoveryGeneration("generation-a");
    const first = providerAgentsQueryOptions({ provider: "codex" });
    setProviderDiscoveryGeneration("generation-b");
    const second = providerAgentsQueryOptions({ provider: "codex" });

    expect(second.queryKey).toEqual(first.queryKey);
    expect(first.placeholderData).toBeTypeOf("function");
  });

  it("scopes Claude subagents and their cache identity to the configured executable", async () => {
    setProviderDiscoveryGeneration("auth-generation-b");
    const listAgents = mockListAgents(vi.fn().mockResolvedValue({ agents: [] }));
    const configuredOptions = providerAgentsQueryOptions({
      provider: "claudeAgent",
      binaryPath: "/opt/claude-custom",
    });
    const pathOptions = providerAgentsQueryOptions({ provider: "claudeAgent" });

    expect(configuredOptions.queryKey).not.toEqual(pathOptions.queryKey);
    expect(configuredOptions.placeholderData).toBeUndefined();

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(configuredOptions);
    expect(listAgents).toHaveBeenCalledWith({
      provider: "claudeAgent",
      binaryPath: "/opt/claude-custom",
      discoveryGeneration: "auth-generation-b",
    });

    setProviderDiscoveryGeneration("auth-generation-c");
    const nextGenerationOptions = providerAgentsQueryOptions({
      provider: "claudeAgent",
      binaryPath: "/opt/claude-custom",
    });
    expect(nextGenerationOptions.queryKey).not.toEqual(configuredOptions.queryKey);
  });

  it("discards a Claude agent catalog that resolves after the provider generation changes", async () => {
    let resolveAgents: ((result: { agents: [] }) => void) | undefined;
    const listAgents = mockListAgents(
      vi.fn(
        () =>
          new Promise<{ agents: [] }>((resolve) => {
            resolveAgents = resolve;
          }),
      ),
    );
    setProviderDiscoveryGeneration("signed-out");
    const options = providerAgentsQueryOptions({ provider: "claudeAgent" });
    setProviderDiscoveryGeneration("signed-in");
    const queryClient = new QueryClient();
    const pending = queryClient.fetchQuery({ ...options, retry: false });

    await vi.waitFor(() => expect(listAgents).toHaveBeenCalledTimes(1));
    expect(listAgents).toHaveBeenCalledWith({
      provider: "claudeAgent",
      discoveryGeneration: "signed-out",
    });
    resolveAgents?.({ agents: [] });

    await expect(pending).rejects.toThrow(/stale Claude agent catalog/u);
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
  });
});
