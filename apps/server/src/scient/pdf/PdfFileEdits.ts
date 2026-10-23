// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { SCIENT_PDF_EDIT_MAX_BYTES, ScientPdfEditError } from "@t3tools/contracts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import { KnownWorkspaces } from "../../workspace/KnownWorkspaces.ts";
import { GeneratedDocumentStore } from "../documentArtifacts/GeneratedDocumentStore.ts";
import { revisionForBytes } from "../workspace/WorkspaceFileMutations.ts";
import { PDF_EDIT_PRODUCER, publishEditedPdfCopy } from "./EditedPdfCopy.ts";

const isPdfEditError = Schema.is(ScientPdfEditError);

export const savePdfFileEdit = Effect.fn("PdfFileEdits.save")(
  function* (input: {
    readonly source: PdfSourceDescriptor;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly temporaryPath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    const upload = yield* fs.readFile(input.temporaryPath);
    if (
      !upload.length ||
      upload.length > SCIENT_PDF_EDIT_MAX_BYTES ||
      !new TextDecoder().decode(upload.subarray(0, 1024)).includes("%PDF-")
    ) {
      return yield* new ScientPdfEditError({ message: "Choose a valid PDF smaller than 50 MB." });
    }
    const revision = revisionForBytes(upload);
    const source = input.source;
    if (source._tag === "attachment-pdf")
      return yield* new ScientPdfEditError({
        message: "Save the attachment to your project before editing its pages.",
      });
    if (source._tag === "generated-pdf") {
      const store = yield* GeneratedDocumentStore;
      const original = yield* store.resolveRevision(source);
      const originalBytes = yield* fs.readFile(original.path);
      if (revisionForBytes(originalBytes) !== input.expectedRevision) {
        return yield* new ScientPdfEditError({
          message: "The original PDF changed. Reopen it before editing.",
        });
      }
      const edited = original.artifact.provenance.producerId === PDF_EDIT_PRODUCER;
      return yield* publishEditedPdfCopy({
        operationId: input.operationId,
        bytes: upload,
        title: edited ? original.title : `${original.title} (edited)`,
        ...(edited ? { existingCopy: original.artifact } : {}),
      });
    }
    if (source._tag === "environment-pdf") {
      if (!NodePath.isAbsolute(source.path))
        return yield* new ScientPdfEditError({ message: "The PDF path must be absolute." });
      const known = yield* KnownWorkspaces;
      if (!(yield* known.contains(yield* fs.realPath(source.path)))) {
        const original = yield* fs.readFile(source.path);
        if (revisionForBytes(original) !== input.expectedRevision)
          return yield* new ScientPdfEditError({
            message: "The PDF changed. Reopen it before editing.",
          });
        if (!new TextDecoder().decode(original.subarray(0, 1024)).includes("%PDF-"))
          return yield* new ScientPdfEditError({ message: "The destination is no longer a PDF." });
        return yield* publishEditedPdfCopy({
          operationId: input.operationId,
          bytes: upload,
          title: `${source.title} (edited)`,
        });
      }
    }
    const cwd =
      source._tag === "workspace-pdf" ? source.workspaceRoot : NodePath.dirname(source.path);
    const relativePath =
      source._tag === "workspace-pdf" ? source.relativePath : NodePath.basename(source.path);
    const target = yield* files.inspectWriteTarget({ cwd, relativePath });
    if (target.traversesSymlink) {
      return yield* new ScientPdfEditError({
        message: "This PDF is reached through a symbolic link and cannot be edited here.",
      });
    }
    const path = NodePath.resolve(cwd, target.canonicalRelativePath);
    const header = (yield* Stream.runCollect(fs.stream(path, { bytesToRead: 1024 })))
      .map((chunk) => new TextDecoder().decode(chunk))
      .join("");
    if (!header.includes("%PDF-"))
      return yield* new ScientPdfEditError({ message: "The destination is no longer a PDF." });
    // The shared binary writer selects the publication method supported by this host.
    yield* files.writeBinaryFile({
      cwd,
      relativePath,
      mutationId: input.operationId,
      expectedRevision: input.expectedRevision,
      bytes: upload,
    });
    return { source, revision, path, createdCopy: false };
  },
  Effect.catchTags({
    WorkspaceFileRevisionConflictError: () =>
      Effect.fail(
        new ScientPdfEditError({
          message:
            "The PDF changed outside this view. Your edit was not saved. Reopen the PDF to continue.",
        }),
      ),
  }),
  Effect.catch((error) =>
    Effect.fail(
      isPdfEditError(error)
        ? error
        : new ScientPdfEditError({
            message: "The PDF could not be saved. Reload it before continuing.",
          }),
    ),
  ),
);
