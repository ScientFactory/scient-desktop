import { describe, expect, it } from "@effect/vitest";

import { validatePdfBytes } from "./validate.ts";

const PASSWORD_PROTECTED_PDF_BASE64 =
  "JVBERi0xLjcKJb/3ov4KMSAwIG9iago8PCAvRXh0ZW5zaW9ucyA8PCAvQURCRSA8PCAvQmFzZVZlcnNpb24gLzEuNyAvRXh0ZW5zaW9uTGV2ZWwgOCA+PiA+PiAvUGFnZXMgMiAwIFIgL1R5cGUgL0NhdGFsb2cgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcyA+PgplbmRvYmoKMyAwIG9iago8PCAvQ29udGVudHMgNCAwIFIgL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXSAvUGFyZW50IDIgMCBSIC9SZXNvdXJjZXMgPDwgPj4gL1R5cGUgL1BhZ2UgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzMiA+PgpzdHJlYW0KF8mHMiz+NhQ2NvbHZRTkyay8Tpv23GCfssxmWsgAxpdlbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL0NGIDw8IC9TdGRDRiA8PCAvQXV0aEV2ZW50IC9Eb2NPcGVuIC9DRk0gL0FFU1YzIC9MZW5ndGggMzIgPj4gPj4gL0ZpbHRlciAvU3RhbmRhcmQgL0xlbmd0aCAyNTYgL08gPDA0Mzc4ZWZiNjRlZmNiZDJkOTYzNTQ4Yjc0MzliMmUxZDU3MzExZDllNGQ0ZTdkYmQzYmExYjg1MDZkM2MzYjIzM2FjMTcwNzBiOTVhNGQzYjU5ODRkMWM0OWUwM2RjYz4gL09FIDwwODkxMTliNzk0YjE1MWVlOWIzODAyODgxN2EwZGViYTAxOWQwNTRlNTQyYTI1MTZhMjU2OTNmYzNkM2RlOTM1PiAvUCAtNCAvUGVybXMgPDYyMjk4NzRkMzdmZWJjNTAwYWIxYTU1NzUxYzhjMzUyPiAvUiA2IC9TdG1GIC9TdGRDRiAvU3RyRiAvU3RkQ0YgL1UgPGRmYjdlYmRhNTY5NjU2MWUwYzA1MDY0YTMzYzQ1ZjE4YTA3ZTc0N2U5NzUzZTRjM2JlYjQ0NzBjY2JmOTUwMmYyMjk3Y2Y3ZDBmNDI1MmE4Y2FlMzVmMjI0MzFlNzZhYz4gL1VFIDwwNjIyYzEwYjI4NjIyYWNjYjNhYTY1NzcwNzU4MjU0YjBiOWI4OGMxMWMyZDVjYTg4OGY3M2U3YjUxMWRkNjc0PiAvViA1ID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDEzMCAwMDAwMCBuIAowMDAwMDAwMTg5IDAwMDAwIG4gCjAwMDAwMDAyOTUgMDAwMDAgbiAKMDAwMDAwMDM3NiAwMDAwMCBuIAp0cmFpbGVyIDw8IC9Sb290IDEgMCBSIC9TaXplIDYgL0lEIFs8OTFmNjNjZjBhYWUwZDU4MmI5YzgxZWNkNjgyOGQxNmM+PDkxZjYzY2YwYWFlMGQ1ODJiOWM4MWVjZDY4MjhkMTZjPl0gL0VuY3J5cHQgNSAwIFIgPj4Kc3RhcnR4cmVmCjkyMwolJUVPRgo=";

function minimalPdf(): Uint8Array {
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
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

describe("PDF structural validation", () => {
  it("accepts a deliberately blank but structurally complete PDF", async () => {
    await expect(validatePdfBytes(minimalPdf(), "producer-registration")).resolves.toEqual({
      accepted: true,
      classification: "valid",
      pageCount: 1,
      profile: "producer-registration",
      warnings: ["blank-pages-allowed"],
    });
  });

  it("rejects empty, corrupt, and truncated output", async () => {
    await expect(
      validatePdfBytes(new Uint8Array(), "producer-registration"),
    ).resolves.toMatchObject({ accepted: false, reason: "empty" });
    await expect(
      validatePdfBytes(new TextEncoder().encode("not a pdf"), "existing-load"),
    ).resolves.toMatchObject({ accepted: false, reason: "invalid" });
    const truncated = minimalPdf().slice(0, 80);
    await expect(validatePdfBytes(truncated, "producer-registration")).resolves.toMatchObject({
      accepted: false,
      reason: "invalid",
    });
  });

  it("classifies password-protected output without hanging", async () => {
    const bytes = Uint8Array.from(Buffer.from(PASSWORD_PROTECTED_PDF_BASE64, "base64"));
    await expect(validatePdfBytes(bytes, "existing-load")).resolves.toMatchObject({
      accepted: false,
      reason: "password-protected",
    });
  });
});
