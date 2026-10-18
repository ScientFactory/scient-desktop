import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

/** Only the live native owner grants invocation authority, never above the thread's current modes. */
export const requireInvocationPolicy = Effect.fn("mcp.requireInvocationPolicy")(function* (
  scope: McpThreadInvocationScope,
) {
  const manager = yield* ProviderSessionManagerV2;
  const policy = yield* manager.resolveMcpInvocationPolicy({ ...scope.thread }).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The calling provider's execution policy could not be resolved.",
        }),
    ),
  );
  if (Option.isNone(policy))
    return yield* new OrchestratorMcpFailure({
      code: "parent_not_active",
      message: "This credential no longer has a live run or background subagent on its thread.",
    });
  return policy.value;
});
