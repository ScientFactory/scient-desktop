/**
 * Errors for Scient's workspace file mutations: a save whose file changed
 * since it was opened, and a create or rename whose destination exists.
 */
import * as Schema from "effect/Schema";

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export class WorkspaceFileRevisionConflictError extends Schema.TaggedError<WorkspaceFileRevisionConflictError>()(
  "WorkspaceFileRevisionConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    currentRevision: Schema.String,
    publicationOutcome: Schema.optionalKey(Schema.Literals(["unchanged", "retained-attention"])),
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' changed after it was opened. Reload it before saving.`;
  }
}

export class WorkspaceFileExistsError extends Schema.TaggedError<WorkspaceFileExistsError>()(
  "WorkspaceFileExistsError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    publicationOutcome: Schema.optionalKey(Schema.Literals(["unchanged", "retained-attention"])),
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' already exists in '${this.workspaceRoot}'.`;
  }
}

export class WorkspaceFileTargetChangedError extends Schema.TaggedError<WorkspaceFileTargetChangedError>()(
  "WorkspaceFileTargetChangedError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    publicationOutcome: Schema.optionalKey(Schema.Literals(["unchanged", "retained-attention"])),
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' no longer has its authorized target binding.`;
  }
}

export class WorkspaceFileRecoveryRequiredError extends Schema.TaggedError<WorkspaceFileRecoveryRequiredError>()(
  "WorkspaceFileRecoveryRequiredError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    recoveryId: Schema.String,
    retainedPaths: Schema.Array(Schema.String),
    publicationOutcome: Schema.optionalKey(Schema.Literals(["unchanged", "retained-attention"])),
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' has retained versions requiring explicit recovery.`;
  }
}

export class WorkspaceFileMutationUnavailableError extends Schema.TaggedError<WorkspaceFileMutationUnavailableError>()(
  "WorkspaceFileMutationUnavailableError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    publicationOutcome: Schema.optionalKey(Schema.Literals(["unchanged", "retained-attention"])),
  },
) {
  override get message(): string {
    return `Safe native publication is unavailable for workspace file '${this.relativePath}'. Your input has not been discarded.`;
  }
}

export class WorkspaceFileMutationIntentConflictError extends Schema.TaggedError<WorkspaceFileMutationIntentConflictError>()(
  "WorkspaceFileMutationIntentConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    publicationOutcome: Schema.optionalKey(Schema.Literals(["unchanged", "retained-attention"])),
  },
) {
  override get message(): string {
    return `The mutation identity for workspace file '${this.relativePath}' was reused for a different intent.`;
  }
}
