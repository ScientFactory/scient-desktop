import { createPdfValidationRuntime } from "@scientfactory/pdf-validation";
import { describe, expect, it } from "vite-plus/test";
import { pdfValidationWorkerUrl } from "./pdfValidationWorkerUrl.ts";

function completePdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

describe("PDF validation worker location", () => {
  it.each([
    [
      "file:///opt/scient/backend/dist/bin.mjs",
      "file:///opt/scient/backend/dist/pdf-validation-worker.mjs",
    ],
    [
      "file:///opt/scient/backend/dist/binCli-ByLO77_f.mjs",
      "file:///opt/scient/backend/dist/pdf-validation-worker.mjs",
    ],
    [
      "file:///opt/scient/backend/dist/shared-GeneratedDocumentStore.mjs",
      "file:///opt/scient/backend/dist/pdf-validation-worker.mjs",
    ],
    [
      "file:///opt/scient/relocated/binCli-hashed.mjs",
      "file:///opt/scient/relocated/pdf-validation-worker.mjs",
    ],
    [
      "file:///C:/Program%20Files/Scient/resources/backend/dist/binCli-hashed.mjs",
      "file:///C:/Program%20Files/Scient/resources/backend/dist/pdf-validation-worker.mjs",
    ],
    [
      "file:///opt/scient/backend/src/scient/documentArtifacts/GeneratedDocumentStore.ts",
      "file:///opt/scient/backend/src/pdf-validation-worker.ts",
    ],
  ])("resolves the production worker from %s", (moduleUrl, expected) => {
    expect(pdfValidationWorkerUrl(moduleUrl).href).toBe(expected);
    expect(pdfValidationWorkerUrl(new URL(moduleUrl)).href).toBe(expected);
  });

  it("keeps actual development worker validation and malformed-output rejection", async () => {
    const runtime = createPdfValidationRuntime({
      workerUrl: pdfValidationWorkerUrl(import.meta.url),
    });
    try {
      await expect(runtime.validate(completePdf(), "browser-export")).resolves.toMatchObject({
        accepted: true,
        classification: "valid",
        pageCount: 1,
        profile: "browser-export",
      });
      await expect(
        runtime.validate(new TextEncoder().encode("not a PDF"), "browser-export"),
      ).resolves.toMatchObject({
        accepted: false,
        reason: "invalid",
        profile: "browser-export",
      });
    } finally {
      await runtime.close();
    }
  });
});
