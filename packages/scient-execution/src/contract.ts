import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

const EntityId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const BoundedText = Schema.String.check(Schema.isMaxLength(1024 * 1024));

export const ExecutionRunId = EntityId.pipe(Schema.brand("ExecutionRunId"));
export type ExecutionRunId = typeof ExecutionRunId.Type;

export const ExecutionStatus = Schema.Literals([
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);
export type ExecutionStatus = typeof ExecutionStatus.Type;

export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);

export const ExecutionOutputStream = Schema.Literals(["stdout", "stderr", "system"]);
export type ExecutionOutputStream = typeof ExecutionOutputStream.Type;

export const ExecutionOutputChunk = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stream: ExecutionOutputStream,
  text: BoundedText,
  observedAt: Schema.String,
});
export type ExecutionOutputChunk = typeof ExecutionOutputChunk.Type;

export const ExecutionReceiptSummary = Schema.Struct({
  runId: ExecutionRunId,
  status: ExecutionStatus,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  failureMessage: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  cancellationRequested: Schema.Boolean,
  outputTruncated: Schema.Boolean,
  outputByteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputContentHash: Schema.NullOr(Schema.NonEmptyString.check(Schema.isMaxLength(256))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
export type ExecutionReceiptSummary = typeof ExecutionReceiptSummary.Type;

export const ExecutionReceipt = Schema.Struct({
  ...ExecutionReceiptSummary.fields,
  output: Schema.Array(ExecutionOutputChunk),
});
export type ExecutionReceipt = typeof ExecutionReceipt.Type;

export const ExecutionEvent = Schema.Union([
  Schema.TaggedStruct("status", {
    status: ExecutionStatus,
    observedAt: Schema.String,
  }),
  Schema.TaggedStruct("output", {
    chunk: ExecutionOutputChunk,
  }),
  Schema.TaggedStruct("output-truncated", {
    observedAt: Schema.String,
    maximumBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export type ExecutionEvent = typeof ExecutionEvent.Type;

export interface ExecutionProcessRequest {
  readonly runId: ExecutionRunId;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export class ExecutionProcessError extends Schema.TaggedErrorClass<ExecutionProcessError>()(
  "ExecutionProcessError",
  {
    operation: Schema.Literals(["spawn", "output", "exit", "cancel"]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ExecutionProcessOutput {
  readonly stream: Extract<ExecutionOutputStream, "stdout" | "stderr">;
  readonly text: string;
}

export interface ExecutionProcessHandle {
  readonly output: Stream.Stream<ExecutionProcessOutput, ExecutionProcessError>;
  readonly exitCode: Effect.Effect<number, ExecutionProcessError>;
  readonly cancel: Effect.Effect<void, ExecutionProcessError>;
}

export interface ExecutionProcessPort {
  readonly start: (
    request: ExecutionProcessRequest,
  ) => Effect.Effect<ExecutionProcessHandle, ExecutionProcessError, Scope.Scope>;
}
