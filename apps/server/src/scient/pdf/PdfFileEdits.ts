// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { LogicalDocumentKey } from "@scientfactory/document-artifacts";
import { SCIENT_PDF_EDIT_MAX_BYTES, ScientPdfEditError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as ServerConfig from "../../config.ts";
import { GeneratedDocumentStore } from "../documentArtifacts/GeneratedDocumentStore.ts";
import { revisionForBytes } from "../workspace/WorkspaceFileMutations.ts";

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
    let source = input.source;
    if (source._tag === "generated-pdf") {
      const store = yield* GeneratedDocumentStore;
      const original = yield* store.resolveRevision(source);
      const originalBytes = yield* fs.readFile(original.path);
      if (revisionForBytes(originalBytes) !== input.expectedRevision) {
        return yield* new ScientPdfEditError({
          message: "The original PDF changed. Reopen it before editing.",
        });
      }
      const config = yield* ServerConfig.ServerConfig;
      const cwd = NodePath.join(config.stateDir, "pdf-edits");
      yield* fs.makeDirectory(cwd, { recursive: true });
      const fileName = `${input.operationId}-edited.pdf`;
      const path = NodePath.join(cwd, fileName);
      const platform = yield* HostProcess.Platform;
      // Generated revisions are immutable; edited PDFs have an independent durable file.
      const exists = yield* fs.exists(path);
      if (exists) {
        if (revisionForBytes(yield* fs.readFile(path)) !== revision) {
          return yield* new ScientPdfEditError({
            message: "An edited PDF already exists with different contents.",
          });
        }
      } else yield* files.createBinaryFile({ cwd, relativePath: fileName, bytes: upload });
      return {
        source: {
          _tag: "environment-pdf" as const,
          authority: source.authority,
          logicalDocumentKey: LogicalDocumentKey.make(
            `environment:${NodeCrypto.createHash("sha256")
              .update(platform === "win32" ? path.toLowerCase() : path)
              .digest("hex")}`,
          ),
          title: fileName,
          fileName,
          path,
          capabilities: { canSaveCopy: true, canRevealSource: false },
        },
        revision,
        path,
        createdCopy: true,
      };
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
