import type { ComputeOperationError } from "@scientfactory/compute";
import type { WorkspaceScope } from "@scientfactory/operations";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Host-resolved authority, captured before asynchronous native work. Never decoded from RPC. */
export interface ComputeWorkspaceReceipt {
  readonly scope: WorkspaceScope;
  readonly assertCurrent: Effect.Effect<void, ComputeOperationError>;
}

/** Unscoped callers are internal lifecycle/tests; they cannot attach to a bound live session. */
export class ComputeWorkspaceAdmission extends Context.Reference<ComputeWorkspaceReceipt | null>(
  "scient/compute/WorkspaceAdmission",
  { defaultValue: () => null },
) {}
