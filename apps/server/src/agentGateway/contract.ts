/**
 * Contracts for the Scient agent-control gateway (read surface).
 *
 * The gateway serves thread-scoped `scient_*` MCP tools that let an agent in
 * one Scient thread observe sibling threads in the same project. This slice
 * ships the read/coordination tools only (context, list, read, wait); the
 * creation and drive tools land in later, separately-reviewed slices.
 *
 * Keeping the limits and result shapes here ensures the MCP surface, the server
 * implementation, and the tests all share one definition of a valid request.
 *
 * These types live inside the server subsystem rather than `@synara/contracts`
 * because the gateway has no client/renderer consumer: everything that reads
 * them is server-side, and the shared barrel is a frozen released-migration
 * dependency (adding an export to it trips the migration-lineage guard). If a
 * renderer consumer ever appears, promote these to `@synara/contracts` as part
 * of a change that rebaselines the migration closure.
 *
 * @module agentGateway/contract
 */
import { ProjectId, ProviderKind, ThreadId, TurnId } from "@synara/contracts";
import { Schema } from "effect";

export const SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION = 20;
export const SYNARA_GATEWAY_MAX_WAIT_MS = 60_000;

/**
 * Stable machine-readable error codes surfaced by gateway tools. Slice 1 emits
 * the read/authority subset; later slices extend this union (idempotency,
 * creation limits, ...) without breaking existing consumers.
 */
export const SynaraGatewayErrorCode = Schema.Literals([
  "caller_session_inactive",
  "caller_turn_inactive",
  "capability_denied",
  "thread_not_found",
  "wait_timed_out",
  "idempotency_conflict",
  "gateway_busy",
  "operation_outcome_uncertain",
  "operation_failed",
]);
export type SynaraGatewayErrorCode = typeof SynaraGatewayErrorCode.Type;

export const SynaraGatewayError = Schema.Struct({
  code: SynaraGatewayErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type SynaraGatewayError = typeof SynaraGatewayError.Type;

export const SynaraGatewayErrorResult = Schema.Struct({
  error: SynaraGatewayError,
});
export type SynaraGatewayErrorResult = typeof SynaraGatewayErrorResult.Type;

export const SynaraContextResult = Schema.Struct({
  harness: Schema.Struct({
    name: Schema.Literal("Scient"),
    policyVersion: Schema.String,
  }),
  caller: Schema.Struct({
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    provider: ProviderKind,
    projectId: ProjectId,
  }),
  capabilities: Schema.Struct({
    threadRead: Schema.Boolean,
    threadDrive: Schema.Boolean,
    threadWait: Schema.Boolean,
    automations: Schema.Boolean,
  }),
});
export type SynaraContextResult = typeof SynaraContextResult.Type;

export const SynaraWaitForThreadsInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION)),
  runIds: Schema.optional(
    Schema.Array(Schema.NullOr(TurnId)).check(
      Schema.isMaxLength(SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION),
    ),
  ),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(SYNARA_GATEWAY_MAX_WAIT_MS),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SynaraWaitForThreadsInput = typeof SynaraWaitForThreadsInput.Type;

export const SynaraWaitedThreadResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(TurnId),
  state: Schema.Literals(["idle", "pending", "running", "completed", "error", "interrupted"]),
  terminal: Schema.Boolean,
  timedOut: Schema.Boolean,
  summary: Schema.NullOr(Schema.String),
  summaryTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  readThread: Schema.Struct({
    tool: Schema.Literal("scient_read_thread"),
    arguments: Schema.Struct({ threadId: ThreadId }),
  }),
});
export type SynaraWaitedThreadResult = typeof SynaraWaitedThreadResult.Type;

export const SynaraWaitForThreadsResult = Schema.Struct({
  callerThreadId: ThreadId,
  runIds: Schema.Array(Schema.NullOr(TurnId)),
  allTerminal: Schema.Boolean,
  timedOut: Schema.Boolean,
  threads: Schema.Array(SynaraWaitedThreadResult),
});
export type SynaraWaitForThreadsResult = typeof SynaraWaitForThreadsResult.Type;
