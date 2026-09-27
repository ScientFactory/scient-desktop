import {
  ScientDocumentPdfExportError,
  type ScientDocumentPdfPrepared,
  type ScientMarkdownPdfPrepareInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { documentLogicalKey, writeDocumentCapture } from "./DocumentCapture.ts";
import { buildMarkdownFileBundle, readProjectMarkdownFile } from "./MarkdownFileBundle.ts";

/**
 * Captures a project Markdown file for export at exactly the revision the
 * editor saved. The editor flushes its pending edits first; a file that
 * differs from that revision is refused rather than exported silently.
 */
export const captureProjectMarkdownFile = Effect.fn("MarkdownPdfPreparation.capture")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly relativePath: string;
    readonly expectedRevision?: string;
  }) {
    const file = yield* readProjectMarkdownFile(input.workspaceRoot, input.relativePath);
    if (input.expectedRevision !== undefined && file.revision !== input.expectedRevision) {
      return yield* new ScientDocumentPdfExportError({
        reason: "source-changed",
        detail:
          "The file on disk differs from the version saved in the editor. Save or reload it, then export again.",
      });
    }
    const bundle = yield* buildMarkdownFileBundle({ workspaceRoot: input.workspaceRoot, file });
    const written = yield* writeDocumentCapture({
      bundle,
      logicalDocumentKey: documentLogicalKey("markdown-pdf", file.canonicalPath),
      source: {
        _tag: "workspace-file",
        workspaceRoot: input.workspaceRoot,
        relativePath: input.relativePath,
        canonicalPath: file.canonicalPath,
      },
    });
    return { ...written, file };
  },
);

export const prepareMarkdownPdf = Effect.fn("MarkdownPdfPreparation.prepare")(function* (
  input: ScientMarkdownPdfPrepareInput,
) {
  const { record, inputRelativeUrl } = yield* captureProjectMarkdownFile({
    workspaceRoot: input.cwd,
    relativePath: input.relativePath,
    expectedRevision: input.expectedRevision,
  });
  return {
    inputRelativeUrl,
    expected: record.expected,
    title: record.title || "Document",
    warnings: record.warnings,
  } satisfies ScientDocumentPdfPrepared;
});
