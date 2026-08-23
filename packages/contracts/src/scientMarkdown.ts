import * as Schema from "effect/Schema";
import * as Multipart from "effect/unstable/http/Multipart";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SCIENT_MARKDOWN_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const WorkspacePath = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));

export const ScientMarkdownImageUploadRequest = Schema.Struct({
  cwd: WorkspacePath,
  documentRelativePath: WorkspacePath,
  assetDirectory: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  file: Multipart.SingleFileSchema,
}).pipe(
  HttpApiSchema.asMultipart({
    maxParts: 4,
    maxFieldSize: 4 * 1024,
    maxFileSize: SCIENT_MARKDOWN_IMAGE_MAX_BYTES,
    maxTotalSize: SCIENT_MARKDOWN_IMAGE_MAX_BYTES + 16 * 1024,
  }),
);
export type ScientMarkdownImageUploadRequest = typeof ScientMarkdownImageUploadRequest.Type;

export const ScientMarkdownImageUploadResult = Schema.Struct({
  relativePath: WorkspacePath,
  markdownSource: WorkspacePath,
  mediaType: TrimmedNonEmptyString,
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  revision: TrimmedNonEmptyString,
});
export type ScientMarkdownImageUploadResult = typeof ScientMarkdownImageUploadResult.Type;

export const ScientMarkdownImageInvalidReason = Schema.Literals([
  "invalid_document_path",
  "invalid_asset_directory",
  "empty_file",
  "unsupported_media",
  "media_extension_mismatch",
]);
export type ScientMarkdownImageInvalidReason = typeof ScientMarkdownImageInvalidReason.Type;

export class ScientMarkdownImageInvalidError extends Schema.TaggedErrorClass<ScientMarkdownImageInvalidError>()(
  "ScientMarkdownImageInvalidError",
  {
    reason: ScientMarkdownImageInvalidReason,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientMarkdownImageInvalidError)(this, { status: 400 });
  }
}

export class ScientMarkdownImageTooLargeError extends Schema.TaggedErrorClass<ScientMarkdownImageTooLargeError>()(
  "ScientMarkdownImageTooLargeError",
  {
    byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
    maxBytes: Schema.Int.check(Schema.isGreaterThan(0)),
    message: Schema.String,
  },
  { httpApiStatus: 413 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientMarkdownImageTooLargeError)(this, { status: 413 });
  }
}

export class ScientMarkdownImageConflictError extends Schema.TaggedErrorClass<ScientMarkdownImageConflictError>()(
  "ScientMarkdownImageConflictError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientMarkdownImageConflictError)(this, { status: 409 });
  }
}
