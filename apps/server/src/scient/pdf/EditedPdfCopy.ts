import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
  type ArtifactRevisionId,
} from "@scientfactory/document-artifacts";
import * as Effect from "effect/Effect";
import { ScientPdfEditError } from "@t3tools/contracts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { GeneratedDocumentStore } from "../documentArtifacts/GeneratedDocumentStore.ts";
import { revisionForBytes } from "../workspace/WorkspaceFileMutations.ts";

export const PDF_EDIT_PRODUCER = ArtifactProducerId.make("scient.pdf-page-editor");

/** Immutable inputs and files outside writable projects get their own document binding. */
export const publishEditedPdfCopy = Effect.fn("PdfFileEdits.publishCopy")(function* (input: {
  readonly operationId: string;
  readonly bytes: Uint8Array;
  readonly title: string;
  readonly existingCopy?: {
    readonly logicalDocumentKey: LogicalDocumentKey;
    readonly revisionId: ArtifactRevisionId;
  };
}) {
  const store = yield* GeneratedDocumentStore;
  const key =
    input.existingCopy?.logicalDocumentKey ??
    LogicalDocumentKey.make(`pdf-edit:${input.operationId}`);
  const operationId = ProducingOperationId.make(input.operationId);
  const revision = revisionForBytes(input.bytes);
  // Keep the binding revision check and publication together across concurrent saves.
  return yield* withWorkspaceLease(
    `pdf-edit-binding:${key}`,
    Effect.gen(function* () {
      const existing = yield* store.getDescriptor(key).pipe(
        Effect.catchTags({
          GeneratedDocumentStoreError: (error) =>
            error.reason === "missing-binding" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (existing?._tag === "generated-pdf") {
        const saved = yield* store.resolveRevision(existing);
        if (
          saved.artifact.provenance.operationId === operationId &&
          `sha256:${saved.artifact.contentHash}` === revision
        )
          return { source: existing, revision, path: saved.path, createdCopy: !input.existingCopy };
        if (!input.existingCopy || existing.revisionId !== input.existingCopy.revisionId)
          return yield* new ScientPdfEditError({
            message: "The edited PDF changed outside this view. Reopen it before continuing.",
          });
      } else if (input.existingCopy) {
        return yield* new ScientPdfEditError({ message: "The edited PDF is no longer available." });
      }
      const production = yield* store.beginProduction({
        logicalDocumentKey: key,
        operationId,
        producerId: PDF_EDIT_PRODUCER,
      });
      const source = yield* store
        .publishPdf({
          ...production,
          bytes: input.bytes,
          title: input.title,
          provenanceKind: "other",
        })
        .pipe(
          Effect.tapError((error) =>
            store.failProduction({ ...production, reason: error.message }).pipe(Effect.ignore),
          ),
        );
      if (source._tag !== "generated-pdf")
        return yield* new ScientPdfEditError({ message: "The edited PDF could not be published." });
      const saved = yield* store.resolveRevision(source);
      return { source, revision, path: saved.path, createdCopy: !input.existingCopy };
    }),
  );
});
