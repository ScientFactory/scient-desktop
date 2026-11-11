import {
  ScientReferenceCheckReport,
  ScientReferenceCheckTarget,
  ScientReferenceFix,
  ScientReferenceResolution,
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());
const FindingIds = Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(500)));

export const ScientReferenceCheckRequest = Schema.Struct({
  root: NonEmptyString,
  target: ScientReferenceCheckTarget,
});
export type ScientReferenceCheckRequest = typeof ScientReferenceCheckRequest.Type;

export const ScientReferenceCheckResult = ScientReferenceCheckReport;
export type ScientReferenceCheckResult = typeof ScientReferenceCheckResult.Type;

export const ScientReferenceResolveRequest = Schema.Struct({
  root: NonEmptyString,
  apply: Schema.optionalKey(
    Schema.Array(ScientReferenceFix).pipe(Schema.check(Schema.isMaxLength(200))),
  ),
  ignore: Schema.optionalKey(FindingIds),
  restore: Schema.optionalKey(FindingIds),
});
export type ScientReferenceResolveRequest = typeof ScientReferenceResolveRequest.Type;

export const ScientReferenceResolveResult = ScientReferenceResolution;
export type ScientReferenceResolveResult = typeof ScientReferenceResolveResult.Type;

export const ScientReferenceDocumentsRequest = Schema.Struct({ root: NonEmptyString });
export type ScientReferenceDocumentsRequest = typeof ScientReferenceDocumentsRequest.Type;

export const ScientReferenceDocumentsResult = Schema.Struct({
  paths: Schema.Array(NonEmptyString),
  truncated: Schema.Boolean,
});
export type ScientReferenceDocumentsResult = typeof ScientReferenceDocumentsResult.Type;

/** A check that could not run, with a message that names project paths only. */
export class ScientReferenceCheckError extends Schema.TaggedError<ScientReferenceCheckError>()(
  "ScientReferenceCheckError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientReferenceCheckError)(this, { status: 409 });
  }
}
