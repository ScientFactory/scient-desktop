import * as Schema from "effect/Schema";

const identifier = <Brand extends string>(brand: Brand, maximumLength = 256) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximumLength),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  ).pipe(Schema.brand(brand));

export const ArtifactAuthority = identifier("ArtifactAuthority");
export type ArtifactAuthority = typeof ArtifactAuthority.Type;

export const ArtifactId = identifier("ArtifactId");
export type ArtifactId = typeof ArtifactId.Type;

export const ArtifactRevisionId = identifier("ArtifactRevisionId");
export type ArtifactRevisionId = typeof ArtifactRevisionId.Type;

export const LogicalDocumentKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  // eslint-disable-next-line no-control-regex -- Serializable logical keys must reject NUL explicitly.
  Schema.isPattern(/^[^\0]+$/u),
).pipe(Schema.brand("LogicalDocumentKey"));
export type LogicalDocumentKey = typeof LogicalDocumentKey.Type;

export const ProducingOperationId = identifier("ProducingOperationId");
export type ProducingOperationId = typeof ProducingOperationId.Type;

export const ArtifactProducerId = identifier("ArtifactProducerId");
export type ArtifactProducerId = typeof ArtifactProducerId.Type;

export const ContentSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("ContentSha256"),
);
export type ContentSha256 = typeof ContentSha256.Type;

export const BindingGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("BindingGeneration"),
);
export type BindingGeneration = typeof BindingGeneration.Type;

export const ArtifactRevisionRef = Schema.Struct({
  artifactId: ArtifactId,
  revisionId: ArtifactRevisionId,
});
export type ArtifactRevisionRef = typeof ArtifactRevisionRef.Type;

export const ArtifactProvenance = Schema.Struct({
  kind: Schema.Literals(["browser-export", "document-build", "controlled-render", "other"]),
  producerId: ArtifactProducerId,
  operationId: ProducingOperationId,
});
export type ArtifactProvenance = typeof ArtifactProvenance.Type;

export const GeneratedDocumentArtifact = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  authority: ArtifactAuthority,
  logicalDocumentKey: LogicalDocumentKey,
  artifactId: ArtifactId,
  revisionId: ArtifactRevisionId,
  contentHash: ContentSha256,
  mediaType: Schema.Literal("application/pdf"),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  provenance: ArtifactProvenance,
});
export type GeneratedDocumentArtifact = typeof GeneratedDocumentArtifact.Type;

export const DocumentProductionAttempt = Schema.Struct({
  generation: BindingGeneration,
  operationId: ProducingOperationId,
  producerId: ArtifactProducerId,
  state: Schema.Literals(["running", "succeeded", "failed"]),
  failureReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type DocumentProductionAttempt = typeof DocumentProductionAttempt.Type;

export const DocumentArtifactBinding = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  authority: ArtifactAuthority,
  logicalDocumentKey: LogicalDocumentKey,
  artifactId: ArtifactId,
  generation: BindingGeneration,
  status: Schema.Literals(["producing", "current", "stale", "failed-production"]),
  activeRevision: Schema.NullOr(ArtifactRevisionRef),
  lastSuccessfulRevision: Schema.NullOr(ArtifactRevisionRef),
  latestAttempt: DocumentProductionAttempt,
  staleReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  updatedAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type DocumentArtifactBinding = typeof DocumentArtifactBinding.Type;

export const PdfSourceCapabilities = Schema.Struct({
  canSaveCopy: Schema.Boolean,
  canRevealSource: Schema.Boolean,
});
export type PdfSourceCapabilities = typeof PdfSourceCapabilities.Type;

const PdfSourceBase = {
  authority: ArtifactAuthority,
  logicalDocumentKey: LogicalDocumentKey,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  fileName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    // eslint-disable-next-line no-control-regex -- Cross-process filenames must reject NUL explicitly.
    Schema.isPattern(/^[^/\\\0]+\.pdf$/iu),
  ),
  capabilities: PdfSourceCapabilities,
} as const;

const WorkspacePdfLegacyLocator = Schema.Struct({
  threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  absolutePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});

export const PdfSourceDescriptor = Schema.Union([
  Schema.TaggedStruct("workspace-pdf", {
    ...PdfSourceBase,
    workspaceRoot: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
    relativePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
    // Old servers resolve workspace assets through a thread. This compatibility
    // hint never contributes to document identity and can be omitted by producers.
    legacyLocator: Schema.optional(WorkspacePdfLegacyLocator),
  }),
  Schema.TaggedStruct("generated-pdf", {
    ...PdfSourceBase,
    artifactId: ArtifactId,
    revisionId: ArtifactRevisionId,
    bindingGeneration: BindingGeneration,
    bindingStatus: Schema.Literals(["current", "stale"]),
    staleReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  }),
  Schema.TaggedStruct("environment-pdf", {
    ...PdfSourceBase,
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  }),
]);
export type PdfSourceDescriptor = typeof PdfSourceDescriptor.Type;

export interface ResolvedPdfSource {
  readonly url: string;
  readonly expiresAt: number;
  readonly sourcePath?: string;
  readonly refresh: () => void;
}

export type PdfSourceResolution =
  | { readonly _tag: "Loading"; readonly refresh: () => void }
  | { readonly _tag: "Failure"; readonly refresh: () => void }
  | ({ readonly _tag: "Success" } & ResolvedPdfSource);

export interface PdfSourceResolver {
  readonly useResolve: (source: PdfSourceDescriptor) => PdfSourceResolution;
}

export interface PdfSourceActions {
  readonly saveCopy: (source: PdfSourceDescriptor, resolved: ResolvedPdfSource) => void;
  readonly revealSource?: (source: PdfSourceDescriptor, resolved: ResolvedPdfSource) => void;
}
