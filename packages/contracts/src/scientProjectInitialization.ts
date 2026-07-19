import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const ScientProjectFolderState = Schema.Literals([
  "empty-uninitialized",
  "existing-uninitialized",
  "legacy-papilab-compatible",
  "initialized-compatible",
  "partially-initialized",
  "invalid-or-conflicting",
  "unavailable",
]);
export type ScientProjectFolderState = typeof ScientProjectFolderState.Type;

export const ScientProjectInitializationRequest = Schema.Struct({
  title: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
  scopeIncluded: Schema.optional(Schema.String),
  scopeExcluded: Schema.optional(Schema.String),
  skillIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type ScientProjectInitializationRequest = typeof ScientProjectInitializationRequest.Type;

export const ScientProjectInitializationPreviewInput = Schema.Struct({
  root: TrimmedNonEmptyString,
  request: Schema.optional(ScientProjectInitializationRequest),
});
export type ScientProjectInitializationPreviewInput =
  typeof ScientProjectInitializationPreviewInput.Type;

export const ScientProjectInitializationOperation = Schema.Struct({
  kind: Schema.Literals(["create", "preserve", "propose", "conflict"]),
  path: TrimmedNonEmptyString,
  reason: Schema.String,
  contents: Schema.optional(Schema.String),
  observedKind: Schema.optional(
    Schema.Literals(["missing", "file", "directory", "symlink", "other"]),
  ),
});
export type ScientProjectInitializationOperation = typeof ScientProjectInitializationOperation.Type;

export const ScientBuiltInSkillActivation = Schema.Struct({
  id: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  digest: TrimmedNonEmptyString,
  origin: Schema.Literal("scient:builtin"),
});
export type ScientBuiltInSkillActivation = typeof ScientBuiltInSkillActivation.Type;

export const ScientBuiltInSkillChoice = Schema.Struct({
  ...ScientBuiltInSkillActivation.fields,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  role: Schema.Literals(["constructive", "review", "orientation"]),
  selected: Schema.Boolean,
  defaultSelected: Schema.Boolean,
  readiness: Schema.Literals(["available", "latent"]),
  prerequisites: Schema.Array(TrimmedNonEmptyString),
  capabilities: Schema.Struct({
    network: Schema.Boolean,
    codeExecution: Schema.Boolean,
    projectWrites: Schema.Literals(["none", "proposal-only"]),
  }),
});
export type ScientBuiltInSkillChoice = typeof ScientBuiltInSkillChoice.Type;

export const ScientProjectInitializationIssue = Schema.Struct({
  code: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  message: Schema.String,
});
export type ScientProjectInitializationIssue = typeof ScientProjectInitializationIssue.Type;

export const ScientProjectInitializationPreviewResult = Schema.Struct({
  previewId: Schema.NullOr(TrimmedNonEmptyString),
  expiresAt: Schema.NullOr(TrimmedNonEmptyString),
  root: TrimmedNonEmptyString,
  folderState: ScientProjectFolderState,
  status: Schema.Literals(["ready", "blocked", "already-initialized", "recovery-required"]),
  projectId: Schema.NullOr(TrimmedNonEmptyString),
  canApply: Schema.Boolean,
  canRecover: Schema.Boolean,
  canRollback: Schema.Boolean,
  operations: Schema.Array(ScientProjectInitializationOperation),
  skills: Schema.Array(ScientBuiltInSkillChoice),
  issues: Schema.Array(ScientProjectInitializationIssue),
});
export type ScientProjectInitializationPreviewResult =
  typeof ScientProjectInitializationPreviewResult.Type;

export const ScientProjectInitializationActionInput = Schema.Struct({
  previewId: TrimmedNonEmptyString,
});
export type ScientProjectInitializationActionInput =
  typeof ScientProjectInitializationActionInput.Type;

export const ScientProjectInitializationApplyResult = Schema.Struct({
  root: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  created: Schema.Array(TrimmedNonEmptyString),
  preserved: Schema.Array(TrimmedNonEmptyString),
  proposed: Schema.Array(TrimmedNonEmptyString),
  activatedSkills: Schema.Array(ScientBuiltInSkillActivation),
  recovered: Schema.Boolean,
});
export type ScientProjectInitializationApplyResult =
  typeof ScientProjectInitializationApplyResult.Type;

export const ScientProjectInitializationRollbackResult = Schema.Struct({
  root: TrimmedNonEmptyString,
  complete: Schema.Boolean,
  removed: Schema.Array(TrimmedNonEmptyString),
  preserved: Schema.Array(TrimmedNonEmptyString),
});
export type ScientProjectInitializationRollbackResult =
  typeof ScientProjectInitializationRollbackResult.Type;
