import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const PapiLabProjectFolderState = Schema.Literals([
  "empty-uninitialized",
  "existing-uninitialized",
  "initialized-compatible",
  "partially-initialized",
  "invalid-or-conflicting",
  "unavailable",
]);
export type PapiLabProjectFolderState = typeof PapiLabProjectFolderState.Type;

export const PapiLabProjectInitializationRequest = Schema.Struct({
  title: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
  scopeIncluded: Schema.optional(Schema.String),
  scopeExcluded: Schema.optional(Schema.String),
});
export type PapiLabProjectInitializationRequest = typeof PapiLabProjectInitializationRequest.Type;

export const PapiLabProjectInitializationPreviewInput = Schema.Struct({
  root: TrimmedNonEmptyString,
  request: Schema.optional(PapiLabProjectInitializationRequest),
});
export type PapiLabProjectInitializationPreviewInput =
  typeof PapiLabProjectInitializationPreviewInput.Type;

export const PapiLabProjectInitializationOperation = Schema.Struct({
  kind: Schema.Literals(["create", "preserve", "propose", "conflict"]),
  path: TrimmedNonEmptyString,
  reason: Schema.String,
  contents: Schema.optional(Schema.String),
  observedKind: Schema.optional(
    Schema.Literals(["missing", "file", "directory", "symlink", "other"]),
  ),
});
export type PapiLabProjectInitializationOperation =
  typeof PapiLabProjectInitializationOperation.Type;

export const PapiLabProjectInitializationIssue = Schema.Struct({
  code: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  message: Schema.String,
});
export type PapiLabProjectInitializationIssue = typeof PapiLabProjectInitializationIssue.Type;

export const PapiLabProjectInitializationPreviewResult = Schema.Struct({
  previewId: Schema.NullOr(TrimmedNonEmptyString),
  expiresAt: Schema.NullOr(TrimmedNonEmptyString),
  root: TrimmedNonEmptyString,
  folderState: PapiLabProjectFolderState,
  status: Schema.Literals(["ready", "blocked", "already-initialized", "recovery-required"]),
  projectId: Schema.NullOr(TrimmedNonEmptyString),
  canApply: Schema.Boolean,
  canRecover: Schema.Boolean,
  canRollback: Schema.Boolean,
  operations: Schema.Array(PapiLabProjectInitializationOperation),
  issues: Schema.Array(PapiLabProjectInitializationIssue),
});
export type PapiLabProjectInitializationPreviewResult =
  typeof PapiLabProjectInitializationPreviewResult.Type;

export const PapiLabProjectInitializationActionInput = Schema.Struct({
  previewId: TrimmedNonEmptyString,
});
export type PapiLabProjectInitializationActionInput =
  typeof PapiLabProjectInitializationActionInput.Type;

export const PapiLabProjectInitializationApplyResult = Schema.Struct({
  root: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  created: Schema.Array(TrimmedNonEmptyString),
  preserved: Schema.Array(TrimmedNonEmptyString),
  proposed: Schema.Array(TrimmedNonEmptyString),
  recovered: Schema.Boolean,
});
export type PapiLabProjectInitializationApplyResult =
  typeof PapiLabProjectInitializationApplyResult.Type;

export const PapiLabProjectInitializationRollbackResult = Schema.Struct({
  root: TrimmedNonEmptyString,
  complete: Schema.Boolean,
  removed: Schema.Array(TrimmedNonEmptyString),
  preserved: Schema.Array(TrimmedNonEmptyString),
});
export type PapiLabProjectInitializationRollbackResult =
  typeof PapiLabProjectInitializationRollbackResult.Type;
