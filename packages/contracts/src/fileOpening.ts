import * as Schema from "effect/Schema";

export const EnvironmentFilePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  // eslint-disable-next-line no-control-regex -- Host paths must reject NUL before filesystem use.
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

export class EnvironmentFilePrepareError extends Schema.TaggedErrorClass<EnvironmentFilePrepareError>()(
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
