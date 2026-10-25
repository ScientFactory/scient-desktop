import * as Schema from "effect/Schema";

import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeOutput,
  ComputeSessionGeneration,
  ComputeSessionId,
} from "./contract.ts";
import { Count, Label, ShortText, StreamText } from "./primitives.ts";
import { ComputeExecutionSource, ComputeProjectId } from "./record.ts";

/**
 * Commands bind project/session and expected generation so stale clients cannot mutate replacement
 * namespaces. Decode schemas once at the RPC edge rather than asking every caller to validate
 * fields.
 */

export class ComputeOperationError extends Schema.TaggedError<ComputeOperationError>()(
  "ComputeOperationError",
  {
    operation: Schema.Literals([
      "start",
      "submit",
      "cancel",
      "interrupt",
      "restart",
      "stop",
      "list",
      "get",
      "outputs",
      "resolve",
      "subscribe",
      "inspect",
      "verify",
      "manage",
      "variables",
    ]),
    reason: Schema.Literals([
      // The session is not there, or is not in a state that can run code.
      "session-not-found",
      "session-not-running",
      "session-terminal",
      "session-conflict",
      // The caller is talking about a namespace that has been replaced.
      "generation-stale",
      "workspace-changed",
      // The session is there and healthy but has nowhere to put the work.
      "queue-full",
      "capacity-reached",
      // No usable runtime for the language, in terms a user can act on.
      "runtime-missing",
      "runtime-unusable",
      "capability-missing",
      "source-not-runnable",
      // The execution is not there, or has already ended.
      "execution-not-found",
      "execution-already-finished",
      "execution-conflict",
      // Something underneath failed.
      "transport-failed",
      "persistence-failed",
      "operation-failed",
    ]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Caller-chosen session IDs make retried start idempotent. Project resolution belongs to the RPC
 * edge, not cwd inference inside the coordinator.
 */
export const ComputeStartSessionInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  languageId: ComputeLanguageId,
  label: Label,
  workingDirectory: ShortText,
  configuredExecutable: Schema.NullOr(ShortText),
  /** An explicit per-session choice, distinct from the environment's default preference. */
  requestedExecutable: Schema.optional(ShortText),
  /** One execution in a new runtime lifetime; the coordinator retains results and closes it. */
  runOnce: Schema.optional(
    Schema.Struct({
      executionId: ComputeExecutionId,
      code: StreamText,
      source: ComputeExecutionSource,
    }),
  ),
});
export type ComputeStartSessionInput = typeof ComputeStartSessionInput.Type;

/** The caller names the execution too, for the same reason it names the session. */
export const ComputeSubmitExecutionInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  expectedGeneration: ComputeSessionGeneration,
  code: StreamText,
  source: ComputeExecutionSource,
});
export type ComputeSubmitExecutionInput = typeof ComputeSubmitExecutionInput.Type;

/** Interrupt, restart, and stop all address a session at a known generation. */
export const ComputeSessionCommandInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  expectedGeneration: ComputeSessionGeneration,
});
export type ComputeSessionCommandInput = typeof ComputeSessionCommandInput.Type;

/** Replacement admission; ordinary Stop still interrupts running and queued work. */
export const ComputeStopSessionInput = Schema.Struct({
  ...ComputeSessionCommandInput.fields,
  onlyIfIdle: Schema.optional(Schema.Boolean),
});
export type ComputeStopSessionInput = typeof ComputeStopSessionInput.Type;

export const ComputeExecutionCommandInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  expectedGeneration: ComputeSessionGeneration,
});
export type ComputeExecutionCommandInput = typeof ComputeExecutionCommandInput.Type;

export const ComputeListSessionsInput = Schema.Struct({
  projectId: ComputeProjectId,
});
export type ComputeListSessionsInput = typeof ComputeListSessionsInput.Type;

export const ComputeGetSessionInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
});
export type ComputeGetSessionInput = typeof ComputeGetSessionInput.Type;

export const ComputeListExecutionsInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
});
export type ComputeListExecutionsInput = typeof ComputeListExecutionsInput.Type;

/** A null `executionId` asks for the output that belongs to the session itself. */
export const ComputeListOutputsInput = Schema.Struct({
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  executionId: Schema.NullOr(ComputeExecutionId),
});
export type ComputeListOutputsInput = typeof ComputeListOutputsInput.Type;

export const ComputeSubscribeSessionsInput = Schema.Struct({
  projectId: ComputeProjectId,
});
export type ComputeSubscribeSessionsInput = typeof ComputeSubscribeSessionsInput.Type;

/**
 * A transcript as it could be read back, with the damage stated rather than
 * hidden: a line that could not be decoded is counted, not silently skipped, so
 * a client can say the transcript is incomplete instead of implying it is whole.
 */
export const ComputeExecutionOutputs = Schema.Struct({
  outputs: Schema.Array(ComputeOutput),
  corruptLineCount: Count,
});
export type ComputeExecutionOutputs = typeof ComputeExecutionOutputs.Type;
