// @effect-diagnostics nodeBuiltinImport:off -- Content hashes name the generated PDF binding.
import * as NodeCrypto from "node:crypto";

import {
  ArtifactProducerId,
  LogicalDocumentKey,
  ProducingOperationId,
} from "@scientfactory/document-artifacts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as GeneratedDocumentStore from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import {
  checkedFileIdentity,
  readCappedFile,
  readVerifiedWorkspaceFile,
} from "../../../scient/documentExport/verifiedWorkspaceRead.ts";
import * as DocumentHostBroker from "../../../scient/documents/DocumentHostBroker.ts";
import * as DocumentOfficeToolchain from "../../../scient/documents/docxJob/DocumentOfficeToolchain.ts";
import {
  MAX_DOCX_JOB_INPUT_BYTES,
  runDocxTrackedReplacement,
  type DocxJobError,
} from "../../../scient/documents/docxJob/DocxTrackedReplacementJob.ts";
import type { WorkspaceMutationError } from "../../../scient/workspace/WorkspaceFileMutations.ts";
import { bytesRevision } from "../../../scient/workspace/RetainedFileMutation.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import type { WorkspacePathsError } from "../../../workspace/WorkspacePaths.ts";
import {
  ScientDocumentJobsToolkit,
  ScientDocxTrackedReplaceToolError,
  type ScientDocxTrackedReplaceInput,
  type ScientDocxTrackedReplaceResult,
} from "./docxTrackedReplaceTool.ts";
import {
  assertCurrentDocumentBuildProject,
  type ProjectDocumentBuildBoundaryError,
  resolveDocumentBuildProject,
  resolveProjectDocxOutput,
  resolveProjectPdfOutput,
  resolveProjectSourceFile,
} from "./projectDocumentBuild.ts";

type Code = ScientDocxTrackedReplaceToolError["code"];
type Receipt = Omit<
  ConstructorParameters<typeof ScientDocxTrackedReplaceToolError>[0],
  "code" | "message"
>;

const toolError = (code: Code, message: string, receipt: Receipt = {}) =>
  new ScientDocxTrackedReplaceToolError({
    code,
    message,
    ...Object.fromEntries(Object.entries(receipt).filter(([, value]) => value !== undefined)),
  });

const boundaryError = (cause: ProjectDocumentBuildBoundaryError) =>
  toolError(cause.code, cause.message, {
    publicationOutcome: cause.publicationOutcome,
    recoveryId: cause.recoveryId,
    retainedPaths: cause.retainedPaths,
    mutationId: cause.mutationId,
  });

const workspaceReceipt = (cause: WorkspaceMutationError | WorkspacePathsError): Receipt => ({
  ...("publicationOutcome" in cause ? { publicationOutcome: cause.publicationOutcome } : {}),
  ...("recoveryId" in cause ? { recoveryId: cause.recoveryId } : {}),
  ...("retainedPaths" in cause ? { retainedPaths: cause.retainedPaths } : {}),
  ...("mutationId" in cause ? { mutationId: cause.mutationId } : {}),
});

const PRODUCER_ID = ArtifactProducerId.make("scient.docx-tracked-replace");

const REFUSALS: Readonly<Record<string, string>> = {
  "not-a-package": "The file is not a Word package.",
  "not-a-word-document": "The file is not a plain .docx document.",
  "macro-enabled": "Macro-enabled Word files are not supported.",
  "external-resources":
    "The file links to resources outside it, which the renderer would read; it is not supported.",
  "external-fields":
    "The file has fields that include or link outside content; it is not supported.",
  "embedded-documents":
    "The file embeds other documents (altChunk or subDoc); it is not supported.",
  "malformed-part": "A part of the file is not supported XML.",
  "unsafe-entry": "The package has an unsafe or encrypted entry.",
  "too-large": "The file is larger than this operation accepts (32 MiB of input).",
  "text-not-found": "The text was not found in the document.",
  "text-ambiguous": "The text occurs more than once; pass a longer, unique passage.",
  "text-spans-runs": "The text crosses formatting runs or other markup; pass text inside one run.",
  "unsupported-run":
    "The text is inside a field, an existing revision, or a run with other content; it is not supported.",
};

const jobToolError = (cause: DocxJobError) => {
  switch (cause.code) {
    case "unsupported-input":
    case "unsupported-edit":
      return toolError(
        cause.code,
        REFUSALS[cause.reason] ?? "The Word file or edit is not supported.",
        {
          reason: cause.reason,
        },
      );
    case "render-failed":
      return toolError("render-failed", "LibreOffice did not produce the PDFs.", {
        reason: cause.reason,
      });
    case "integrity-failed":
      return toolError(
        "integrity-failed",
        "A check of the edited copy or its PDF failed, so nothing was saved. The checks list says which.",
        { reason: cause.reason, checks: cause.checks },
      );
  }
};

/** The source's bytes as the server can vouch for them, and their revision. */
const captureSource = Effect.fn("ScientDocxTrackedReplace.captureSource")(function* (source: {
  readonly canonicalRoot: string;
  readonly canonicalPath: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem
    .stat(source.canonicalPath)
    .pipe(Effect.mapError(() => toolError("source-not-found", "The Word file could not be read.")));
  if (Number(info.size) > MAX_DOCX_JOB_INPUT_BYTES)
    return yield* toolError("unsupported-input", REFUSALS["too-large"]!, { reason: "too-large" });
  const checked = checkedFileIdentity(source.canonicalPath, info);
  const platform = yield* HostProcess.Platform;
  // Windows cannot bind a read to the checked file. As for other unbound workspace reads, only
  // bytes equal to the revision the caller already holds are used; the caller compares next.
  const read =
    platform === "win32"
      ? yield* readCappedFile(checked, MAX_DOCX_JOB_INPUT_BYTES)
      : yield* readVerifiedWorkspaceFile(
          checked,
          source.canonicalRoot,
          platform,
          MAX_DOCX_JOB_INPUT_BYTES,
        );
  if (read._tag === "too-large")
    return yield* toolError("unsupported-input", REFUSALS["too-large"]!, { reason: "too-large" });
  if (read._tag === "unsupported-platform")
    return yield* toolError(
      "toolchain-unavailable",
      "This platform cannot read the Word file through a verified handle.",
    );
  if (read._tag !== "bytes")
    return yield* toolError(
      "source-changed",
      "The Word file changed or was replaced while Scient read it. Read its revision again.",
    );
  return { bytes: read.bytes, revision: bytesRevision(read.bytes) };
});

const titleOf = (relativePath: string) =>
  relativePath
    .slice(relativePath.lastIndexOf("/") + 1)
    .replace(/\.[^.]+$/u, "")
    .slice(0, 512) || "Document";

export const replaceDocxTextForInvocation = Effect.fn("ScientDocxTrackedReplace.run")(function* (
  input: ScientDocxTrackedReplaceInput,
) {
  const toolchain = yield* (yield* DocumentOfficeToolchain.DocumentOfficeToolchain).status;
  if (toolchain.status !== "ready")
    return yield* toolError(
      "toolchain-unavailable",
      "The pinned LibreOffice for Document Lab jobs is not set up in this app.",
      { reason: toolchain.reason },
    );
  if (input.find === input.replace)
    return yield* toolError("unsupported-edit", "The replacement must differ from the text.");

  const authority = yield* resolveDocumentBuildProject().pipe(Effect.mapError(boundaryError));
  const { root, invocation } = authority;
  const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const located = yield* resolveProjectSourceFile(root, input.sourcePath, {
    label: "Word",
    extensions: [".docx"],
  }).pipe(Effect.mapError((cause) => toolError(cause.code, cause.message)));
  const docxOutput = yield* resolveProjectDocxOutput(root, input.outputPath).pipe(
    Effect.mapError(boundaryError),
  );
  const pdfOutput = yield* resolveProjectPdfOutput(root, input.pdfOutputPath).pipe(
    Effect.mapError(boundaryError),
  );
  if (docxOutput.outputPath.toLowerCase() === located.sourcePath.toLowerCase())
    return yield* toolError(
      "invalid-output-path",
      "outputPath must be a new copy, not the source file.",
    );

  const epoch = workspace
    .getMutationEpoch({ cwd: root })
    .pipe(
      Effect.mapError((cause) =>
        toolError("source-changed", cause.message, workspaceReceipt(cause)),
      ),
    );
  const mutationEpoch = yield* epoch;
  const captured = yield* workspace
    .withSettledFileRead({ cwd: root, relativePath: located.sourcePath }, (attention) =>
      attention === null
        ? captureSource(located)
        : Effect.fail(toolError("source-changed", attention.message)),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ScientDocxTrackedReplaceToolError"
          ? cause
          : toolError("source-changed", cause.message, workspaceReceipt(cause)),
      ),
    );
  if (captured.revision !== input.sourceRevision)
    return yield* toolError(
      "source-changed",
      "The Word file is not at the revision you named. Hash its current bytes and try again.",
    );
  if ((yield* epoch) !== mutationEpoch)
    return yield* toolError(
      "source-changed",
      "The workspace changed while the Word file was read. Try again.",
    );

  const job = yield* runDocxTrackedReplacement(captured.bytes, input).pipe(
    Effect.mapError(jobToolError),
  );

  const store = yield* GeneratedDocumentStore.GeneratedDocumentStore;
  const handle = yield* store
    .beginProduction({
      logicalDocumentKey: LogicalDocumentKey.make(
        `docx-tracked:${NodeCrypto.createHash("sha256").update(pdfOutput.absolutePath).digest("hex")}`,
      ),
      operationId: ProducingOperationId.make(`docx-tracked-${NodeCrypto.randomUUID()}`),
      producerId: PRODUCER_ID,
    })
    .pipe(
      Effect.mapError(() => toolError("publication-failed", "Scient could not start the PDF.")),
    );
  const abandon = (reason: string) =>
    store.abandonProduction({ ...handle, reason }).pipe(Effect.ignore);

  const pdf = yield* workspace
    .withWorkspacePublicationFence({ cwd: root, expectedEpoch: mutationEpoch }, () =>
      Effect.gen(function* () {
        yield* assertCurrentDocumentBuildProject(authority).pipe(Effect.mapError(boundaryError));
        const current = yield* captureSource(located);
        if (current.revision !== captured.revision)
          return yield* toolError(
            "source-changed",
            "The Word file changed while the copy was made. Nothing was saved.",
          );
        return yield* store
          .publishPdf({
            ...handle,
            bytes: job.candidatePdf,
            title: titleOf(docxOutput.outputPath),
            provenanceKind: "document-build",
          })
          .pipe(
            Effect.mapError(() =>
              toolError("publication-failed", "Scient rejected or could not store the PDF."),
            ),
          );
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ScientDocxTrackedReplaceToolError"
          ? cause
          : toolError("source-changed", cause.message, workspaceReceipt(cause)),
      ),
      Effect.tapError(() => abandon("Publication admission failed.")),
    );

  const write = (
    output: typeof docxOutput,
    bytes: Uint8Array,
    expectedMutationEpoch: string | undefined,
  ) =>
    assertCurrentDocumentBuildProject(authority).pipe(
      Effect.mapError(boundaryError),
      Effect.andThen(
        workspace
          .writeBinaryFile({
            cwd: output.canonicalRoot,
            relativePath: output.outputPath,
            bytes,
            mutationId: `docx-tracked-output:${handle.operationId}:${output.outputPath}`,
            ...(expectedMutationEpoch === undefined ? {} : { expectedMutationEpoch }),
            ...(output.expectedRevision === null
              ? { createOnly: true as const }
              : { expectedRevision: output.expectedRevision }),
          })
          .pipe(
            Effect.mapError((cause) =>
              toolError("output-write-failed", cause.message, workspaceReceipt(cause)),
            ),
          ),
      ),
    );
  const partial =
    (published: ReadonlyArray<string>) => (cause: ScientDocxTrackedReplaceToolError) =>
      toolError(
        "partial-publication",
        published.length === 0
          ? "Scient stored the PDF revision, but could not save the Word copy. The publishedSource receipt identifies the PDF; inspect the publication outcome before retrying."
          : "Scient saved the Word copy but not its PDF. The publishedSource receipt identifies the PDF revision; inspect the publication outcome before retrying.",
        {
          publicationOutcome: cause.publicationOutcome,
          recoveryId: cause.recoveryId,
          retainedPaths: cause.retainedPaths,
          mutationId: cause.mutationId,
          publishedSource: pdf,
          publishedPaths: published,
          reason: cause.code,
        },
      );
  const docxWritten = yield* write(docxOutput, job.candidateDocx, mutationEpoch).pipe(
    Effect.mapError(partial([])),
  );
  yield* write(pdfOutput, job.candidatePdf, docxWritten.publicationEpoch).pipe(
    Effect.mapError(partial([docxOutput.outputPath])),
  );

  const broker = yield* DocumentHostBroker.DocumentHostBroker;
  const presented = yield* broker
    .invoke({
      scope: invocation,
      operation: "documentPdfPresent",
      input: { source: pdf },
      timeoutMs: 10_000,
    })
    .pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  return {
    sourcePath: located.sourcePath,
    sourceRevision: captured.revision,
    outputPath: docxOutput.outputPath,
    outputRevision: bytesRevision(job.candidateDocx),
    pdfOutputPath: pdfOutput.outputPath,
    pdf,
    revision: {
      deletionId: job.deletionId,
      insertionId: job.insertionId,
      author: input.author,
      date: input.date,
    },
    checks: job.checks,
    pageCount: job.pageCount,
    editPage: job.editPage,
    engine: {
      name: "LibreOffice",
      version: toolchain.version,
      provisioning: toolchain.provisioning,
      producer: job.producer,
      fonts: job.fonts.candidate,
    },
    support: { inputPolicy: "trusted-fixtures", isolation: "process-boundary", osSandbox: false },
    warnings: [...job.warnings, ...(presented ? [] : ["presentation-unavailable"])],
  } satisfies ScientDocxTrackedReplaceResult;
});

export const ScientDocumentJobsToolkitHandlersLive = ScientDocumentJobsToolkit.toLayer({
  scient_docx_tracked_replace: (input) => replaceDocxTextForInvocation(input),
});
