import * as Schema from "effect/Schema";

export const EnvironmentFilePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^[^\0]+$/u),
).pipe(Schema.brand("EnvironmentFilePath"));
export type EnvironmentFilePath = typeof EnvironmentFilePath.Type;

export const EnvironmentFilePresentationKind = Schema.Literals([
  "image",
  "pdf",
  "html",
  "markdown",
  "text",
  "audio",
  "video",
  "binary",
]);
export type EnvironmentFilePresentationKind = typeof EnvironmentFilePresentationKind.Type;

export const EnvironmentFileTextEncoding = Schema.Literals(["utf-8", "utf-16le", "utf-16be"]);
export type EnvironmentFileTextEncoding = typeof EnvironmentFileTextEncoding.Type;

export const EnvironmentFilePresentation = Schema.Struct({
  kind: EnvironmentFilePresentationKind,
  mediaType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  textEncoding: Schema.optional(EnvironmentFileTextEncoding),
});
export type EnvironmentFilePresentation = typeof EnvironmentFilePresentation.Type;

export const EnvironmentFilePrepareInput = Schema.Struct({
  path: EnvironmentFilePath,
});
export type EnvironmentFilePrepareInput = typeof EnvironmentFilePrepareInput.Type;

/** Exact-file invalidation hints; consumers always reinspect after a hint. */
export const EnvironmentFileChangeEvent = Schema.Union([
  Schema.TaggedStruct("watch-ready", {
    path: EnvironmentFilePath,
  }),
  Schema.TaggedStruct("file-changed", {
    path: EnvironmentFilePath,
  }),
]);
export type EnvironmentFileChangeEvent = typeof EnvironmentFileChangeEvent.Type;

export const EnvironmentFilePrepareResult = Schema.Struct({
  canonicalPath: EnvironmentFilePath,
  fileName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mtimeMs: Schema.NullOr(Schema.Number),
  presentation: EnvironmentFilePresentation,
});
export type EnvironmentFilePrepareResult = typeof EnvironmentFilePrepareResult.Type;

export const EnvironmentFilePrepareFailure = Schema.Literals([
  "path_not_absolute",
  "not_found",
  "not_a_file",
  "unreadable",
  "inspection_failed",
]);
export type EnvironmentFilePrepareFailure = typeof EnvironmentFilePrepareFailure.Type;

export class EnvironmentFilePrepareError extends Schema.TaggedError<EnvironmentFilePrepareError>()(
  "EnvironmentFilePrepareError",
  {
    path: EnvironmentFilePath,
    failure: EnvironmentFilePrepareFailure,
  },
) {
  override get message(): string {
    switch (this.failure) {
      case "path_not_absolute":
        return "The file path must be absolute in the selected environment.";
      case "not_found":
        return "The file no longer exists.";
      case "not_a_file":
        return "The selected path is not a regular file.";
      case "unreadable":
        return "The file cannot be read.";
      case "inspection_failed":
        return "Scient could not inspect the file.";
    }
  }
}

const LINK_RESOLVE_MAX_CHANGED_PATHS = 2_000;
const LINK_RESOLVE_MAX_TIE_PATHS = 20;

/**
 * A chat link to resolve on the environment that owns the files. The link is
 * taken exactly as written; only that environment can say what it names.
 */
export const EnvironmentFileLinkResolveInput = Schema.Struct({
  /** The workspace the link belongs to. Relative links resolve against it. */
  workspaceRoot: EnvironmentFilePath,
  /** The link's path as written: absolute, or relative to `workspaceRoot`. */
  path: EnvironmentFilePath,
  /** Workspace-relative files the link's turn changed. They only break a tie. */
  changedPaths: Schema.optional(
    Schema.Array(EnvironmentFilePath).check(Schema.isMaxLength(LINK_RESOLVE_MAX_CHANGED_PATHS)),
  ),
});
export type EnvironmentFileLinkResolveInput = typeof EnvironmentFileLinkResolveInput.Type;

/**
 * What a link names.
 *
 * - `literal`: the link's own location exists, or fails for a reason other
 *   than absence (a denied read, a folder); open it as written.
 * - `recovered`: nothing exists at the link's location, and exactly one
 *   workspace file best matches how the link's path ends.
 * - `tie`: several workspace files match equally well; the user chooses.
 * - `none`: no workspace file has the link's file name.
 * - `incomplete`: the workspace could not be searched completely, so no match
 *   can be called unique; `paths` holds what was found, as choices only.
 *
 * `missingPath` is the absolute location the link named. Other paths are
 * workspace-relative with `/` separators.
 */
export const EnvironmentFileLinkResolution = Schema.Union([
  Schema.TaggedStruct("literal", { path: EnvironmentFilePath }),
  Schema.TaggedStruct("recovered", {
    path: EnvironmentFilePath,
    missingPath: EnvironmentFilePath,
  }),
  Schema.TaggedStruct("tie", {
    paths: Schema.Array(EnvironmentFilePath).check(Schema.isMaxLength(LINK_RESOLVE_MAX_TIE_PATHS)),
    missingPath: EnvironmentFilePath,
  }),
  Schema.TaggedStruct("none", { missingPath: EnvironmentFilePath }),
  Schema.TaggedStruct("incomplete", {
    paths: Schema.Array(EnvironmentFilePath).check(Schema.isMaxLength(LINK_RESOLVE_MAX_TIE_PATHS)),
    missingPath: EnvironmentFilePath,
  }),
]);
export type EnvironmentFileLinkResolution = typeof EnvironmentFileLinkResolution.Type;
