import {
  ScientDocumentPageRenderOutcome,
  scientDocumentBlockedRequestsNote,
  type DocumentWarning,
  type ScientDocumentExportInput,
  type ScientDocumentExportResult,
  type ScientDocumentPdfExportError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GeneratedDocumentStore from "../../../scient/documentArtifacts/GeneratedDocumentStore.ts";
import {
  removeDocumentCapture,
  type DocumentCaptureRecord,
} from "../../../scient/documentExport/DocumentCapture.ts";
import {
  beginDocumentPdfProduction,
  confirmCapturedSourceCurrent,
  DOCUMENT_PDF_TOO_LARGE_DETAIL,
  documentPdfWarnings,
  publishDocumentPdfBytes,
  validateDocumentRender,
} from "../../../scient/documentExport/DocumentPdfPublication.ts";
import { isMarkdownDocumentPath } from "../../../scient/documentExport/MarkdownFileBundle.ts";
import { captureProjectMarkdownFile } from "../../../scient/documentExport/MarkdownPdfPreparation.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import {
  assertCurrentDocumentBuildProject,
  commitStagedProjectPdfOutput,
  type ProjectDocumentBuildBoundaryError,
  resolveDocumentBuildProject,
  resolveProjectPdfOutput,
  stageProjectPdfOutput,
} from "./projectDocumentBuild.ts";
import { ScientDocumentExportToolError } from "./tools.ts";

type ErrorCode = ConstructorParameters<typeof ScientDocumentExportToolError>[0]["code"];

const toolError = (
  code: ErrorCode,
  message: string,
  receipt?: Pick<ScientDocumentExportToolError, "publishedSource" | "outputPath">,
) => new ScientDocumentExportToolError({ code, message, ...receipt });

const boundaryToolError = (cause: ProjectDocumentBuildBoundaryError) =>
  toolError(cause.code, cause.message);

/** `ScientDocumentExportResult.warnings` holds at most this many entries. */
const MAX_TOOL_WARNINGS = 64;

const RENDERER_UNAVAILABLE_MESSAGE =
  "A current connected Scient desktop is required to export this PDF.";

const exportErrorToToolError = (cause: ScientDocumentPdfExportError) =>
  toolError(
    cause.reason === "invalid-source"
      ? "invalid-source-path"
      : cause.reason === "source-unavailable"
        ? "source-not-found"
        : cause.reason === "source-changed"
          ? "source-changed"
          : cause.reason === "too-large"
            ? "too-large"
            : cause.reason === "render-rejected" || cause.reason === "invalid-pdf"
              ? "render-failed"
              : "publication-failed",
    cause.detail,
  );

const decodeRenderOutcome = Schema.decodeUnknownEffect(ScientDocumentPageRenderOutcome);

const abandonQuietly = (
  store: GeneratedDocumentStore.GeneratedDocumentStore["Service"],
  handle: GeneratedDocumentStore.GeneratedDocumentProductionHandle,
  reason: string,
) => store.abandonProduction({ ...handle, reason }).pipe(Effect.ignore);

const renderCapture = Effect.fn("ScientDocumentExport.render")(function* (
  scope: Parameters<
    PreviewAutomationBroker.PreviewAutomationBroker["Service"]["invoke"]
  >[0]["scope"],
  record: DocumentCaptureRecord,
  inputRelativeUrl: string,
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const raw = yield* broker
    .invoke({
      scope,
      operation: "documentPagePdfRender",
      input: { inputRelativeUrl, expected: record.expected },
      timeoutMs: 100_000,
    })
    .pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("document page PDF render failed", { errorTag: cause._tag }),
      ),
      Effect.mapError((cause) =>
        cause._tag === "PreviewAutomationNoAvailableHostError" ||
        cause._tag === "PreviewAutomationUnsupportedClientError"
          ? toolError("renderer-unavailable", RENDERER_UNAVAILABLE_MESSAGE)
          : toolError(
              "render-failed",
              "Scient could not render the document page as PDF. Check the document and try again.",
            ),
      ),
    );
  const outcome = yield* decodeRenderOutcome(raw).pipe(
    Effect.mapError(() =>
      toolError("render-failed", "The desktop returned an invalid document render result."),
    ),
  );
  if (outcome._tag === "rendered") return outcome.result;
  return yield* toolError(
    outcome.reason === "too-large" ? "too-large" : "render-failed",
    outcome.reason === "too-large"
      ? DOCUMENT_PDF_TOO_LARGE_DETAIL
      : outcome.detail || "Scient could not render the document page as PDF.",
  );
});

/**
 * `scient_document_export`: a project Markdown file to a project PDF at an
 * explicit output path. Authority, output staging, and partial-publication
 * receipts follow `scient_pdf_build`; the source is captured and rendered on
 * Scient's document page instead of loaded as HTML.
 */
export const exportScientDocumentForInvocation = Effect.fn("ScientDocumentExport.export")(
  function* (input: ScientDocumentExportInput) {
    const path = yield* Path.Path;
    const authority = yield* resolveDocumentBuildProject().pipe(Effect.mapError(boundaryToolError));
    const { invocation, root } = authority;
    if (!isMarkdownDocumentPath(path, input.sourcePath)) {
      return yield* toolError(
        "invalid-source-path",
        "sourcePath must identify a project-relative .md or .markdown document.",
      );
    }
    if (path.extname(input.outputPath).toLowerCase() !== ".pdf") {
      return yield* toolError(
        "unsupported-format",
        "PDF is the available export format; outputPath must end in .pdf.",
      );
    }
    const output = yield* resolveProjectPdfOutput(root, input.outputPath).pipe(
      Effect.mapError(boundaryToolError),
    );
    const { record, inputRelativeUrl, file } = yield* captureProjectMarkdownFile({
      workspaceRoot: root,
      relativePath: input.sourcePath,
    }).pipe(Effect.mapError(exportErrorToToolError));
    const captureId = record.expected.captureId;

    return yield* Effect.gen(function* () {
      const rendered = yield* renderCapture(invocation, record, inputRelativeUrl);
      const bytes = yield* validateDocumentRender(record, rendered).pipe(
        Effect.andThen((validated) =>
          confirmCapturedSourceCurrent(record).pipe(Effect.as(validated)),
        ),
        Effect.mapError(exportErrorToToolError),
      );
      const generatedDocuments = yield* GeneratedDocumentStore.GeneratedDocumentStore;
      const handle = yield* beginDocumentPdfProduction(record).pipe(
        Effect.mapError(exportErrorToToolError),
      );

      const { source, projectOutputState } = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* assertCurrentDocumentBuildProject(authority).pipe(
            Effect.mapError(boundaryToolError),
            Effect.tapError(() =>
              abandonQuietly(generatedDocuments, handle, "The project workspace changed."),
            ),
          );
          const staged = yield* stageProjectPdfOutput(output, bytes).pipe(
            Effect.mapError(boundaryToolError),
            Effect.tapError(() =>
              abandonQuietly(
                generatedDocuments,
                handle,
                "The requested project output could not be staged.",
              ),
            ),
          );
          yield* assertCurrentDocumentBuildProject(authority).pipe(
            Effect.mapError(boundaryToolError),
            Effect.tapError(() =>
              abandonQuietly(generatedDocuments, handle, "The project workspace changed."),
            ),
          );
          const source = yield* publishDocumentPdfBytes(record, handle, bytes).pipe(
            Effect.mapError(() =>
              toolError("publication-failed", "Scient rejected or could not store the PDF."),
            ),
          );
          if (source._tag !== "generated-pdf") {
            return yield* toolError(
              "publication-failed",
              "Scient returned an unsupported PDF source.",
            );
          }
          const projectOutputState = yield* assertCurrentDocumentBuildProject(authority).pipe(
            Effect.mapError(boundaryToolError),
            Effect.andThen(
              commitStagedProjectPdfOutput(staged).pipe(Effect.mapError(boundaryToolError)),
            ),
            Effect.as("written" as const),
            Effect.catch((cause) =>
              Effect.logWarning("published document PDF could not replace its project output", {
                errorCode: cause.code,
                outputPath: output.outputPath,
              }).pipe(
                Effect.as(
                  cause.code === "project-changed"
                    ? ("authority-stale" as const)
                    : ("write-failed" as const),
                ),
              ),
            ),
          );
          return { source, projectOutputState };
        }),
      );

      const partialMessage =
        "Scient stored an immutable PDF revision, but could not safely write the requested project file. The publishedSource receipt identifies the available revision; outputPath was not written.";
      const authorityStillCurrent = yield* assertCurrentDocumentBuildProject(authority).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (projectOutputState === "authority-stale" || !authorityStillCurrent) {
        const outputWasWritten = projectOutputState === "written";
        return yield* toolError(
          outputWasWritten ? "project-changed" : "partial-publication",
          outputWasWritten
            ? "Scient wrote the PDF to the workspace where the export began, but the active workspace changed before presentation. The PDF was not opened in the new workspace."
            : partialMessage,
          { publishedSource: source, outputPath: output.outputPath },
        );
      }

      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const presented = yield* broker
        .invoke({
          scope: invocation,
          operation: "documentPdfPresent",
          input: { source },
          timeoutMs: 10_000,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("exported document PDF could not be presented", {
              errorTag: cause._tag,
            }).pipe(Effect.as(false)),
          ),
        );
      if (projectOutputState === "write-failed") {
        return yield* toolError("partial-publication", partialMessage, {
          publishedSource: source,
          outputPath: output.outputPath,
        });
      }

      // The tool result holds 64 warnings. What must always be reported (the
      // refused-request note and the status flags) keeps its place when the
      // document's own notes do not fit; a closing entry counts the rest.
      const describe = (warning: DocumentWarning) =>
        `${warning.code}: ${warning.message}`.slice(0, 640);
      const flags = [
        ...(rendered.blockedRequestCount > 0
          ? [
              describe({
                code: "resource-unresolved",
                message: scientDocumentBlockedRequestsNote(rendered.blockedRequestCount),
              }),
              "blocked-external-resources",
            ]
          : []),
        ...(presented ? [] : ["presentation-unavailable"]),
      ];
      const notes = [
        ...new Set([...documentPdfWarnings(record, rendered).map(describe), ...rendered.warnings]),
      ].filter((note) => !flags.includes(note));
      const room = MAX_TOOL_WARNINGS - flags.length;
      const warnings =
        notes.length <= room
          ? [...notes, ...flags]
          : [
              ...notes.slice(0, room - 1),
              ...flags,
              `…and ${notes.length - (room - 1)} more notes, listed at the end of the PDF.`,
            ];
      return {
        sourcePath: file.relativePath,
        outputPath: output.outputPath,
        format: "pdf",
        source,
        title: record.title || "Document",
        pageCount: source.pageCount ?? 1,
        byteLength: bytes.byteLength,
        warnings,
        validation: "structural",
        visualReviewPerformed: false,
      } satisfies ScientDocumentExportResult;
    }).pipe(Effect.ensuring(removeDocumentCapture(captureId)));
  },
);
