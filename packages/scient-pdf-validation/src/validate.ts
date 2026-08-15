import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  PDF_VALIDATION_MAX_BYTES,
  type PdfValidationProfile,
  type PdfValidationResult,
  rejectedPdf,
} from "./contract.ts";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export async function validatePdfBytes(
  bytes: Uint8Array,
  profile: PdfValidationProfile,
): Promise<PdfValidationResult> {
  if (bytes.byteLength === 0) {
    return rejectedPdf(profile, "empty", "The PDF output is empty.");
  }
  if (bytes.byteLength > PDF_VALIDATION_MAX_BYTES) {
    return rejectedPdf(
      profile,
      "too-large",
      `The PDF exceeds the ${PDF_VALIDATION_MAX_BYTES} byte validation limit.`,
    );
  }

  const loadingTask = getDocument({
    data: bytes,
    enableXfa: true,
    stopAtErrors: true,
    useSystemFonts: false,
  });
  try {
    const document = await loadingTask.promise;
    try {
      if (document.numPages < 1) {
        return rejectedPdf(profile, "invalid", "The PDF contains no pages.");
      }
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        try {
          await page.getOperatorList();
        } finally {
          page.cleanup();
        }
      }
      return {
        accepted: true,
        classification: "valid",
        pageCount: document.numPages,
        profile,
        warnings: ["blank-pages-allowed"],
      };
    } finally {
      await document.cleanup();
    }
  } catch (error) {
    if (errorName(error) === "PasswordException") {
      return rejectedPdf(
        profile,
        "password-protected",
        "The PDF is password protected and cannot be validated before publication.",
      );
    }
    // A missing fake-worker module is the validation environment failing, not
    // the document; say so instead of blaming the producer's output.
    const summary = `${errorName(error) ?? "Error"}: ${
      error instanceof Error ? error.message : String(error)
    }`.slice(0, 300);
    if (summary.includes("Setting up fake worker failed")) {
      return rejectedPdf(
        profile,
        "worker-failed",
        `The PDF validation environment is missing its pdfjs worker module. (${summary})`,
      );
    }
    return rejectedPdf(
      profile,
      "invalid",
      `The output is not a complete readable PDF. (${summary})`,
    );
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
