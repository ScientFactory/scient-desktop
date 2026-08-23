import type {
  ProviderManagedRuntimeAction,
  ProviderRuntimeSummary,
  ServerProvider,
} from "@t3tools/contracts";

export interface OptimisticProviderValue<T> {
  readonly baseProvider: ServerProvider;
  readonly value: T;
}

/**
 * A command result may bridge the short delay before the provider-status
 * stream updates. The first replacement provider object is a newer canonical
 * snapshot, even when a fast operation has already disappeared from it.
 */
export function currentOptimisticProviderValue<T>(
  optimistic: OptimisticProviderValue<T> | null,
  provider: ServerProvider,
): T | null {
  return optimistic?.baseProvider === provider ? optimistic.value : null;
}

/**
 * Durable runtime state outranks a locally retained progress operation when
 * the streamed terminal operation is absent. This lets mounted clients settle
 * the same way as a freshly loaded client without guessing from elapsed time.
 */
export function isManagedRuntimeActionDurablySettled(
  action: ProviderManagedRuntimeAction,
  runtime: ProviderRuntimeSummary,
): boolean {
  if (action === "install") return runtime.source === "scient_managed";
  if (action === "remove") return runtime.source !== "scient_managed";
  return false;
}
