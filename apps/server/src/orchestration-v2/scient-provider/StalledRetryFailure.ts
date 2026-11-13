import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";

/**
 * The failure of a retry the host stopped because it never resumed. It keeps the provider's own
 * code, which recovery and its UI may read, and otherwise names the stall, so the turn's failure
 * says more than the last retry's error.
 */
export function stalledRetryFailure(
  failure: OrchestrationV2ProviderFailure,
): OrchestrationV2ProviderFailure {
  return { ...failure, code: failure.code ?? "retry_stalled", retryable: false };
}
