import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const KEEP_AWAKE_REMOTE_OBSERVER = "__scientObserveKeepAwake";
export const KEEP_AWAKE_OBSERVE_PATH = "/api/scient/keep-awake/observe";
export const KeepAwakeObserveRequest = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(2000)),
  includeLocalWork: Schema.Boolean,
});
export type KeepAwakeObserveRequest = typeof KeepAwakeObserveRequest.Type;
export const KeepAwakeWork = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  latestRunId: Schema.NullOr(Schema.String),
  removed: Schema.Boolean,
  unfinished: Schema.Boolean,
  runnable: Schema.Boolean,
  blockingInput: Schema.Boolean,
  finalizing: Schema.Boolean,
  ownership: Schema.Literals(["connected", "unowned", "unknown"]),
  progress: Schema.String,
  reason: Schema.String,
});
export type KeepAwakeWork = typeof KeepAwakeWork.Type;
export const KeepAwakeWorkBatch = Schema.Struct({
  environmentId: Schema.String,
  groups: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      members: Schema.Array(KeepAwakeWork),
    }),
  ),
});
export type KeepAwakeWorkBatch = typeof KeepAwakeWorkBatch.Type;

const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const KeepAwakeChoice = Schema.Literals(["app", "once"]);
export type KeepAwakeChoice = typeof KeepAwakeChoice.Type;
export const KeepAwakeSettings = Schema.Struct({
  mode: Schema.Literals(["system", "running"]),
});
export type KeepAwakeSettings = typeof KeepAwakeSettings.Type;
export const DEFAULT_KEEP_AWAKE_SETTINGS: KeepAwakeSettings = { mode: "system" };
export const KeepAwakeExecutionHealth = Schema.Literals(["connected", "unowned", "unknown"]);
export type KeepAwakeExecutionHealth = typeof KeepAwakeExecutionHealth.Type;
export const KeepAwakeExecution = Schema.Struct({
  key: Schema.String,
  progressToken: Schema.String,
  health: KeepAwakeExecutionHealth,
  needsAwake: Schema.Boolean,
});
export type KeepAwakeExecution = typeof KeepAwakeExecution.Type;
export const KeepAwakeThread = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  once: Schema.Boolean,
  startedAt: Schema.NullOr(Timestamp),
  armedAfterRunId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type KeepAwakeThread = typeof KeepAwakeThread.Type;
export const KeepAwakeDocument = Schema.Struct({
  settings: KeepAwakeSettings,
  threads: Schema.Array(KeepAwakeThread),
});
export type KeepAwakeDocument = typeof KeepAwakeDocument.Type;
export const KeepAwakeObservation = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  observedAt: Timestamp,
  latestRunId: Schema.optional(Schema.NullOr(Schema.String)),
  unfinished: Schema.Boolean,
  needsAwake: Schema.Boolean,
  execution: Schema.optional(Schema.Array(KeepAwakeExecution).check(Schema.isMaxLength(2000))),
  reason: Schema.String,
});
export type KeepAwakeObservation = typeof KeepAwakeObservation.Type;
export const KeepAwakeRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("get") }),
  Schema.Struct({
    type: Schema.Literal("configure"),
    settings: Schema.Struct({
      mode: Schema.optional(KeepAwakeSettings.fields.mode),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("choose"),
    key: Schema.String,
    title: Schema.String,
    choice: KeepAwakeChoice,
  }),
]);
export type KeepAwakeRequest = typeof KeepAwakeRequest.Type;
export const KeepAwakeState = Schema.Struct({
  settings: KeepAwakeSettings,
  blocking: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  platformNotice: Schema.optional(Schema.String),
  threads: Schema.Array(
    Schema.Struct({
      ...KeepAwakeThread.fields,
      status: Schema.Literals(["off", "idle", "awake", "paused", "unknown"]),
      reason: Schema.String,
    }),
  ),
});
export type KeepAwakeState = typeof KeepAwakeState.Type;
export const keepAwakeThreadKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);
export const KEEP_AWAKE_LEASE_MS = 120_000;
