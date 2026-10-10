import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ControlledHtmlPdfRenderRequest, ControlledPdfPresentRequest } from "./htmlPdfBuild.ts";
import { ControlledLatexPresentRequest } from "./latexPdfBuild.ts";
import { ScientDocumentPageRenderRequest } from "./scientDocumentExport.ts";

/** The controlled document renderer has no browser-tab or arbitrary-action capability. */
export const SCIENT_DOCUMENT_HOST_OPERATIONS = [
  "documentPdfRender",
  "documentPagePdfRender",
  "documentPdfPresent",
  "documentLatexPresent",
] as const;
export const ScientDocumentHostOperation = Schema.Literals(SCIENT_DOCUMENT_HOST_OPERATIONS);
export type ScientDocumentHostOperation = typeof ScientDocumentHostOperation.Type;
export const ScientDocumentHost = Schema.Struct({
  clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  environmentId: EnvironmentId,
  supportedOperations: Schema.optional(Schema.Array(ScientDocumentHostOperation)),
});
export type ScientDocumentHost = typeof ScientDocumentHost.Type;
const requestFields = {
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
};
export const ScientDocumentHostRequest = Schema.Union([
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal("documentPdfRender"),
    input: ControlledHtmlPdfRenderRequest,
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal("documentPagePdfRender"),
    input: ScientDocumentPageRenderRequest,
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal("documentPdfPresent"),
    input: ControlledPdfPresentRequest,
  }),
  Schema.Struct({
    ...requestFields,
    operation: Schema.Literal("documentLatexPresent"),
    input: ControlledLatexPresentRequest,
  }),
]);
export type ScientDocumentHostRequest = typeof ScientDocumentHostRequest.Type;
const ConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export const ScientDocumentHostStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: ConnectionId }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: ConnectionId,
    request: ScientDocumentHostRequest,
  }),
]);
export type ScientDocumentHostStreamEvent = typeof ScientDocumentHostStreamEvent.Type;
/** The leased request determines the response codec; the broker validates it before completing. */
export const ScientDocumentHostResponse = Schema.Struct({
  clientId: ScientDocumentHost.fields.clientId,
  connectionId: ConnectionId,
  requestId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      _tag: TrimmedNonEmptyString,
      message: Schema.String,
      detail: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type ScientDocumentHostResponse = typeof ScientDocumentHostResponse.Type;
