import type { EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import type { ServerProvider, ServerProviderUpdatedPayload, WS_METHODS } from "@t3tools/contracts";

export interface ProviderInventoryView {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly phase: "unknown" | "checking" | "ready" | "partial" | "error";
  readonly errors: ReadonlyArray<string>;
}

export const UNKNOWN_PROVIDER_INVENTORY: ProviderInventoryView = {
  providers: [],
  phase: "unknown",
  errors: [],
};

type RefreshInput = EnvironmentRpcInput<typeof WS_METHODS.serverRefreshProviders>;

export function providerInventoryScope(providers: ReadonlyArray<ServerProvider>): string {
  return JSON.stringify(
    providers
      .map(({ instanceId, enabled, installed, nativeInventoryGeneration }) => [
        instanceId,
        enabled,
        installed,
        nativeInventoryGeneration ?? null,
      ])
      .sort(),
  );
}

/** Missing retained snapshots mean eviction, not an authoritative empty plugin list. */
export function mergeProviderInventory(
  previous: ReadonlyArray<ServerProvider>,
  incoming: ReadonlyArray<ServerProvider>,
  roots: ReadonlySet<string>,
): ReadonlyArray<ServerProvider> {
  return incoming.map((provider) => {
    const prior = previous.find((entry) => entry.instanceId === provider.instanceId);
    const snapshots = new Map(
      (provider.workspaceSnapshots?.length &&
      prior?.nativeInventoryGeneration === provider.nativeInventoryGeneration
        ? prior?.workspaceSnapshots
        : []
      )
        ?.filter((snapshot) => roots.has(snapshot.cwd))
        .map((snapshot) => [snapshot.cwd, snapshot]),
    );
    for (const snapshot of provider.workspaceSnapshots ?? []) {
      if (roots.has(snapshot.cwd)) snapshots.set(snapshot.cwd, snapshot);
    }
    return { ...provider, workspaceSnapshots: [...snapshots.values()] };
  });
}

function hasUnknownInventory(providers: ReadonlyArray<ServerProvider>, roots: ReadonlySet<string>) {
  return providers.some(
    (provider) =>
      provider.plugins === undefined ||
      provider.mcpServers === undefined ||
      [...roots].some(
        (cwd) =>
          provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.plugins ===
          undefined,
      ),
  );
}

/** One mounted page's serial request, retaining replies only for its project roots. */
export function createProviderInventoryRequest({
  roots,
  providerScope,
  read,
  publish,
}: {
  readonly roots: ReadonlySet<string>;
  readonly providerScope?: string;
  readonly read: (input: RefreshInput) => Promise<ServerProviderUpdatedPayload>;
  readonly publish: (view: ProviderInventoryView) => void;
}) {
  let providers: ReadonlyArray<ServerProvider> = [];
  let received = false;
  let disposed = false;
  let initial = true;
  let pending = false;
  let lastRevision: number | null | undefined;
  let running: Promise<void> | null = null;
  const errors = new Map<string, string>();

  const emit = (checking: boolean) => {
    if (disposed) return;
    publish({
      providers,
      phase: checking
        ? "checking"
        : !received
          ? "error"
          : errors.size > 0 || hasUnknownInventory(providers, roots)
            ? "partial"
            : "ready",
      errors: [...errors.values()],
    });
  };

  const fetch = async (target: RefreshInput) => {
    if (disposed) return;
    // Any full raw reply also observes revisions received before this request started.
    pending = false;
    const key = JSON.stringify([target.instanceId ?? null, target.cwd ?? null]);
    try {
      const reply = await read({
        ...target,
        workspaceSnapshotsOnDemand: false,
        refreshModels: false,
        refreshManagedRuntimeCatalog: false,
      });
      if (disposed) return;
      // The config stream admits the replacement scope; this request cannot publish across it.
      if (
        providerScope !== undefined &&
        providerInventoryScope(reply.providers) !== providerScope
      ) {
        disposed = true;
        return;
      }
      providers = mergeProviderInventory(providers, reply.providers, roots);
      received = true;
      errors.delete(key);
    } catch (error) {
      if (disposed) return;
      const message = error instanceof Error ? error.message : "Could not read agent extensions.";
      errors.set(key, target.cwd ? `${target.cwd}: ${message}` : message);
    }
    emit(true);
  };

  const drain = async () => {
    emit(true);
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- fetch clears pending and can dispose; refresh/dispose also update these flags while reads await.
    while (pending && !disposed) {
      await fetch({});
      if (initial && received && !disposed) {
        initial = false;
        const instances = providers.filter((provider) => provider.enabled && provider.installed);
        for (const provider of instances) {
          for (const cwd of roots) {
            if (disposed) return;
            await fetch({ instanceId: provider.instanceId, cwd });
          }
        }
      }
    }
    emit(false);
  };

  const start = (): Promise<void> => {
    running ??= Promise.resolve()
      .then(drain)
      .finally(() => {
        running = null;
        if (pending && !disposed) void start();
      });
    return running;
  };

  return {
    refresh(revision: number | null) {
      if (disposed || revision === lastRevision) return running ?? Promise.resolve();
      lastRevision = revision;
      pending = true;
      return start();
    },
    changesFailed(message: string | null) {
      if (message === null) errors.delete("changes");
      else errors.set("changes", message);
      emit(running !== null);
    },
    dispose() {
      disposed = true;
    },
  };
}

export function providerInventoryMessage(view: ProviderInventoryView): string {
  switch (view.phase) {
    case "unknown":
      return "Agent extensions have not been checked yet.";
    case "checking":
      return "Checking agent extensions across your projects…";
    case "error":
      return "Could not load agent extensions.";
    case "partial":
      return "Some agent inventories are unavailable. Showing what agents reported.";
    case "ready":
      return "No agent plugins or MCP servers were reported.";
  }
}
