// FILE: useProviderStatusRefresh.ts
// Purpose: Shared provider-status refresh hooks — scheduled version checks plus an
//          imperative refresh callback for UI affordances (voice auth retry, banners).
// Layer: Web hooks
// Exports: useProviderStatusRefresh, useRefreshProviderStatusesNow

import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerProviderStatus } from "@synara/contracts";
import { readNativeApi } from "../nativeApi";
import { applyProviderStatusesToCache } from "../lib/providerStatusCache";
import { activityManager } from "../notifications/activityStore";

const PROVIDER_REFRESH_ACTIVITY_KEY = "provider:status-refresh";

function clearResolvedProviderActivities(providers: readonly ServerProviderStatus[]): void {
  activityManager.remove(PROVIDER_REFRESH_ACTIVITY_KEY);
  for (const provider of providers) {
    if (
      provider.versionAdvisory?.status === "current" ||
      provider.updateState?.status === "succeeded"
    ) {
      activityManager.remove(`provider:update:${provider.provider}`);
    }
  }
}

export type RefreshProviderStatusesOptions = {
  readonly silent?: boolean;
};

export type RefreshProviderStatusesNow = (
  options?: RefreshProviderStatusesOptions,
) => Promise<readonly ServerProviderStatus[] | null>;

/**
 * Imperative one-shot provider-status refresh: re-checks providers on the server
 * and folds the result into the cached server config. Non-silent failures are
 * retained in Activity so they stay reviewable without interrupting the current task.
 */
export function useRefreshProviderStatusesNow(): RefreshProviderStatusesNow {
  const queryClient = useQueryClient();
  return useCallback(
    async (options?: RefreshProviderStatusesOptions) => {
      const api = readNativeApi();
      if (!api) return null;
      try {
        const result = await api.server.refreshProviders();
        applyProviderStatusesToCache(queryClient, result.providers);
        clearResolvedProviderActivities(result.providers);
        return result.providers;
      } catch (error) {
        if (!options?.silent) {
          activityManager.publish({
            dedupeKey: PROVIDER_REFRESH_ACTIVITY_KEY,
            source: "provider",
            status: "needs_attention",
            tone: "error",
            title: "Unable to refresh provider status",
            description:
              error instanceof Error ? error.message : "Unknown error refreshing provider status.",
            destination: { type: "settings", section: "providers" },
          });
        }
        return null;
      }
    },
    [queryClient],
  );
}

type ProviderStatusRefreshOptions = {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
};

export function useProviderStatusRefresh(options: ProviderStatusRefreshOptions): void {
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const initialDelayMs = options.initialDelayMs;
  const intervalMs = options.intervalMs;

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    let disposed = false;
    const refreshProviderStatuses = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }
      void api.server
        .refreshProviders()
        .then((result) => {
          if (disposed) {
            return;
          }
          applyProviderStatusesToCache(queryClient, result.providers);
          clearResolvedProviderActivities(result.providers);
        })
        .catch(() => undefined);
    };

    const initialRefreshId =
      typeof initialDelayMs === "number" && initialDelayMs >= 0
        ? window.setTimeout(refreshProviderStatuses, initialDelayMs)
        : null;
    const refreshIntervalId =
      typeof intervalMs === "number" && intervalMs > 0
        ? window.setInterval(refreshProviderStatuses, intervalMs)
        : null;

    return () => {
      disposed = true;
      if (initialRefreshId !== null) {
        window.clearTimeout(initialRefreshId);
      }
      if (refreshIntervalId !== null) {
        window.clearInterval(refreshIntervalId);
      }
    };
  }, [enabled, initialDelayMs, intervalMs, queryClient]);
}
