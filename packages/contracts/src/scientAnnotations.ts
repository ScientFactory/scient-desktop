import * as Schema from "effect/Schema";
import {
  AnnotationCommand,
  AnnotationMutation,
  AnnotationRecord,
  DocumentResource,
  Hash,
  Id,
} from "@scientfactory/annotations";

const Root = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const AnnotationDocumentTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file"), relativePath: Root }),
  Schema.Struct({
    kind: Schema.Literal("source"),
    sourceId: Id,
    attachmentId: Schema.optionalKey(Id),
  }),
  Schema.Struct({ kind: Schema.Literal("resource"), resourceId: Id }),
]);
export type AnnotationDocumentTarget = typeof AnnotationDocumentTarget.Type;

export const AnnotationDocumentRequest = Schema.Struct({
  root: Root,
  target: AnnotationDocumentTarget,
});
export type AnnotationDocumentRequest = typeof AnnotationDocumentRequest.Type;
export const AnnotationDocumentBinding = Schema.Struct({
  workspaceBinding: Hash,
  generation: Hash,
});
export const AnnotationDocumentResult = Schema.Struct({
  enabled: Schema.Boolean,
  needsMigration: Schema.Boolean,
  binding: Schema.NullOr(AnnotationDocumentBinding),
  resource: Schema.NullOr(DocumentResource),
  annotations: Schema.Array(AnnotationRecord),
});
export type AnnotationDocumentResult = typeof AnnotationDocumentResult.Type;
export const AnnotationPrepareRequest = Schema.Struct({
  ...AnnotationDocumentRequest.fields,
  binding: AnnotationDocumentBinding,
});
export type AnnotationPrepareRequest = typeof AnnotationPrepareRequest.Type;
export const AnnotationMutationRequest = Schema.Struct({
  ...AnnotationPrepareRequest.fields,
  command: AnnotationCommand,
});
export type AnnotationMutationRequest = typeof AnnotationMutationRequest.Type;
export const AnnotationMaterialRequest = Schema.Struct({
  root: Root,
  binding: AnnotationDocumentBinding,
  annotationId: Id,
});
export type AnnotationMaterialRequest = typeof AnnotationMaterialRequest.Type;
/** A verified retained document. Existing asset resolution owns URLs and refresh. */
export const AnnotationMaterialResult = Schema.Struct({
  workspaceRoot: Root,
  relativePath: Root,
  resourceId: Id,
});
export type AnnotationMaterialResult = typeof AnnotationMaterialResult.Type;
export { AnnotationMutation };
