import * as Schema from "effect/Schema";

export const ScientProjectState = Schema.Literals([
  "ordinary",
  "initialized",
  "recoverable",
  "conflicting",
]);
export type ScientProjectState = typeof ScientProjectState.Type;

export const ScientProjectIssue = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});
export type ScientProjectIssue = typeof ScientProjectIssue.Type;

export const ScientProjectInspectRequest = Schema.Struct({
  root: Schema.Trimmed.check(Schema.isNonEmpty()),
});
export type ScientProjectInspectRequest = typeof ScientProjectInspectRequest.Type;

export const ScientProjectInspection = Schema.Struct({
  root: Schema.String,
  state: ScientProjectState,
  canInitialize: Schema.Boolean,
  issues: Schema.Array(ScientProjectIssue),
  existingFiles: Schema.Array(Schema.String),
});
export type ScientProjectInspection = typeof ScientProjectInspection.Type;

export const ScientProjectInitializeRequest = Schema.Struct({
  root: Schema.Trimmed.check(Schema.isNonEmpty()),
  title: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
});
export type ScientProjectInitializeRequest = typeof ScientProjectInitializeRequest.Type;

export const ScientProjectInitializationResult = Schema.Struct({
  ...ScientProjectInspection.fields,
  created: Schema.Array(Schema.String),
  preserved: Schema.Array(Schema.String),
});
export type ScientProjectInitializationResult = typeof ScientProjectInitializationResult.Type;
