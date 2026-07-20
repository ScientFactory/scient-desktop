import type {
  ServerConfig,
  ServerProviderClientStatus,
  ServerProviderStatus,
} from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";
import { serverQueryKeys } from "./serverReactQuery";

type ProviderStatusResyncState = {
  attempted: boolean;
  reported: boolean;
};

let resyncStateByQueryClient = new WeakMap<QueryClient, ProviderStatusResyncState>();

export function areProviderStatusesComplete(
  providers: ReadonlyArray<ServerProviderStatus>,
): providers is ReadonlyArray<ServerProviderClientStatus> {
  return providers.every((provider) => provider.runtime !== undefined);
}

function stateFor(queryClient: QueryClient): ProviderStatusResyncState {
  const existing = resyncStateByQueryClient.get(queryClient);
  if (existing) return existing;
  const created = { attempted: false, reported: false };
  resyncStateByQueryClient.set(queryClient, created);
  return created;
}

function writeProviders(queryClient: QueryClient, providers: ReadonlyArray<ServerProviderStatus>) {
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) =>
    current ? { ...current, providers } : current,
  );
}

export function applyProviderStatusesToCache(
  queryClient: QueryClient,
  providers: ReadonlyArray<ServerProviderStatus>,
  options?: {
    readonly requestSnapshot?: () => Promise<ServerConfig>;
  },
): boolean {
  const state = stateFor(queryClient);
  if (areProviderStatusesComplete(providers)) {
    writeProviders(queryClient, providers);
    state.attempted = false;
    state.reported = false;
    return true;
  }

  const current = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
  if (!current || !areProviderStatusesComplete(current.providers)) {
    writeProviders(queryClient, providers);
  }

  if (!state.reported) {
    state.reported = true;
    console.error(
      "Provider status invariant violated: received a legacy/incomplete provider snapshot. Requesting one complete resynchronization.",
    );
  }

  if (state.attempted) return false;
  state.attempted = true;
  const requestSnapshot = options?.requestSnapshot ?? (() => ensureNativeApi().server.getConfig());
  void requestSnapshot()
    .then((snapshot) => {
      if (!areProviderStatusesComplete(snapshot.providers)) {
        console.error(
          "Provider status resynchronization remained incomplete; preserving the last complete snapshot.",
        );
        return;
      }
      queryClient.setQueryData(serverQueryKeys.config(), snapshot);
      state.attempted = false;
      state.reported = false;
    })
    .catch((error) => {
      console.error("Provider status resynchronization failed.", error);
    });
  return false;
}

export function resetProviderStatusCacheGuardForTests() {
  resyncStateByQueryClient = new WeakMap();
}
