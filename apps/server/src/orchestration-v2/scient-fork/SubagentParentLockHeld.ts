import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

/**
 * The thread whose dispatch lock the caller already holds. Thread locks are not reentrant, so
 * a Stop of that thread's delegated child, which locks its parent first, runs under the
 * caller's lock instead of waiting for it forever.
 */
export const SubagentParentLockHeld = Context.Reference<ThreadId | undefined>(
  "scient/orchestration-v2/SubagentParentLockHeld",
  { defaultValue: () => undefined },
);
