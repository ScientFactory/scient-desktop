import { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import * as Schema from "effect/Schema";
import * as Multipart from "effect/http/Multipart";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const SCIENT_PDF_EDIT_MAX_BYTES = 50 * 1024 * 1024;
export const ScientPdfEditSourceJson = Schema.fromJsonString(PdfSourceDescriptor);

export const ScientPdfEditSaveRequest = Schema.Struct({
  source: ScientPdfEditSourceJson,
  expectedRevision: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)),
  operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u)),
  file: Multipart.SingleFileSchema,
}).pipe(
  HttpApiSchema.asMultipart({
    maxParts: 4,
    maxFieldSize: 16 * 1024,
    maxFileSize: SCIENT_PDF_EDIT_MAX_BYTES,
    maxTotalSize: SCIENT_PDF_EDIT_MAX_BYTES + 64 * 1024,
  }),
);

export const ScientPdfEditSaveResult = Schema.Struct({
  source: PdfSourceDescriptor,
  revision: Schema.String,
  path: Schema.String,
  createdCopy: Schema.Boolean,
});
export type ScientPdfEditSaveResult = typeof ScientPdfEditSaveResult.Type;

export class ScientPdfEditError extends Schema.TaggedError<ScientPdfEditError>()(
  "ScientPdfEditError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientPdfEditError)(this, { status: 409 });
  }
}
