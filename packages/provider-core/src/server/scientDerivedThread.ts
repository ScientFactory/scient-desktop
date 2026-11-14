import type { OrchestrationV2AppThread } from "@t3tools/contracts";

/**
 * Facts about one thread's own history that a thread derived from it must not copy: how it was
 * imported or forked, its rollback receipt (cleared as a whole) and its usage-limit recovery.
 */
export const SCIENT_DERIVED_THREAD_RESETS = {
  conversationFork: null,
  conversationImport: null,
  forkLineage: null,
  rollbackRequestId: undefined,
  rollbackCompletedRequestId: null,
  rollbackFailure: null,
  limitRecovery: null,
  unsettledAt: null,
} as const satisfies Partial<OrchestrationV2AppThread>;
