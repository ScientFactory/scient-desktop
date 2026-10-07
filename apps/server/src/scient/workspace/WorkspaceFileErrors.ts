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
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' already exists in '${this.workspaceRoot}'.`;
  }
}
