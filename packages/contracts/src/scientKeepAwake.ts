import * as Schema from "effect/Schema";

const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const KeepAwakeChoice = Schema.Literals(["app", "once"]);
export type KeepAwakeChoice = typeof KeepAwakeChoice.Type;
export const KeepAwakeSettings = Schema.Struct({
  mode: Schema.Literals(["system", "running"]),
});
export type KeepAwakeSettings = typeof KeepAwakeSettings.Type;
export const DEFAULT_KEEP_AWAKE_SETTINGS: KeepAwakeSettings = { mode: "system" };
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
    work: Schema.optional(
      Schema.Struct({ latestRunId: Schema.NullOr(Schema.String), unfinished: Schema.Boolean }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("report"),
    observations: Schema.Array(KeepAwakeObservation).check(Schema.isMaxLength(2000)),
  }),
]);
export type KeepAwakeRequest = typeof KeepAwakeRequest.Type;
export const KeepAwakeState = Schema.Struct({
  settings: KeepAwakeSettings,
  blocking: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
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
