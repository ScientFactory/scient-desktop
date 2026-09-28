import type {
  DocumentWarning,
  ScientDocumentPageRenderOutcome,
  ScientDocumentPageRenderRequest,
  ScientDocumentPdfPrepared,
  ScientDocumentPdfPublished,
  ScientDocumentPdfPublishInput,
  ScientMarkdownPdfPrepareInput,
} from "@t3tools/contracts";

/**
 * Exporting a project Markdown file from the editor: save pending edits,
 * capture exactly the saved revision on the server, print it on this desktop,
 * and publish the PDF to Scient's generated-document store. Each step is a
 * dependency so the sequence is testable without a desktop or server.
 */

export class MarkdownPdfExportError extends Error {
  override readonly name = "MarkdownPdfExportError";
}

export interface MarkdownPdfExportSnapshot {
  readonly pending: boolean;
  readonly hasProblem: boolean;
  readonly baselineRevision: string;
}

export interface MarkdownPdfExportDependencies {
  /** Saves the editor's pending edits; false when they could not be saved. */
  readonly flush: () => Promise<boolean>;
  readonly snapshot: () => MarkdownPdfExportSnapshot;
  readonly prepare: (input: ScientMarkdownPdfPrepareInput) => Promise<ScientDocumentPdfPrepared>;
  readonly render: (
    request: ScientDocumentPageRenderRequest,
  ) => Promise<ScientDocumentPageRenderOutcome>;
  readonly publish: (input: ScientDocumentPdfPublishInput) => Promise<ScientDocumentPdfPublished>;
  /** Frees a capture that will not be published; failures are ignored, the capture expires. */
  readonly release: (
    captureId: ScientDocumentPdfPrepared["expected"]["captureId"],
  ) => Promise<void>;
}

export const MARKDOWN_PDF_TOO_LARGE_MESSAGE =
  "The PDF is larger than Scient's 64 MiB export limit. Export a shorter document.";

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export async function runMarkdownPdfExport(
  dependencies: MarkdownPdfExportDependencies,
  target: { readonly cwd: string; readonly relativePath: string },
): Promise<ScientDocumentPdfPublished> {
  if (!(await dependencies.flush())) {
    throw new MarkdownPdfExportError(
      "Scient could not save your latest edits, so nothing was exported. Resolve the save problem and export again.",
    );
  }
  const snapshot = dependencies.snapshot();
  if (snapshot.pending || snapshot.hasProblem) {
    throw new MarkdownPdfExportError(
      "The document has unsaved changes or a save conflict. Resolve it and export again.",
    );
  }
  if (!REVISION_PATTERN.test(snapshot.baselineRevision)) {
    throw new MarkdownPdfExportError("The saved revision of this document is unknown.");
  }
  const prepared = await dependencies.prepare({
    cwd: target.cwd,
    relativePath: target.relativePath,
    expectedRevision:
      snapshot.baselineRevision as ScientMarkdownPdfPrepareInput["expectedRevision"],
  });
  return printAndPublishDocumentPdf(dependencies, prepared, MARKDOWN_PDF_TOO_LARGE_MESSAGE);
}

/**
 * The steps every document PDF shares once the server has captured it: print
 * the captured page on this desktop, then publish exactly that capture. A
 * capture that is not printed is released; publication removes it otherwise.
 */
export async function printAndPublishDocumentPdf(
  dependencies: Pick<MarkdownPdfExportDependencies, "render" | "publish" | "release">,
  prepared: ScientDocumentPdfPrepared,
  tooLargeMessage: string,
): Promise<ScientDocumentPdfPublished> {
  const { captureId } = prepared.expected;
  let outcome: Awaited<ReturnType<MarkdownPdfExportDependencies["render"]>>;
  try {
    outcome = await dependencies.render({
      inputRelativeUrl: prepared.inputRelativeUrl,
      expected: prepared.expected,
    });
  } catch (cause) {
    await dependencies.release(captureId).catch(() => undefined);
    throw cause;
  }
  if (outcome._tag === "rejected") {
    await dependencies.release(captureId).catch(() => undefined);
    throw new MarkdownPdfExportError(
      outcome.reason === "too-large" ? tooLargeMessage : outcome.detail,
    );
  }
  return dependencies.publish({ captureId, render: outcome.result });
}

/** A short, readable summary of an export's limitations for a notice. */
export function summarizeDocumentWarnings(warnings: ReadonlyArray<DocumentWarning>): string {
  const shown = warnings.slice(0, 3).map((warning) => warning.message);
  const more = warnings.length - shown.length;
  return [...shown, ...(more > 0 ? [`and ${more} more, listed at the end of the PDF.`] : [])].join(
    "\n",
  );
}
