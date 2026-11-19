import { describe, expect, it } from "@effect/vitest";

import type { ScientSourceAttachment } from "./model.ts";
import { selectScientSourceMaterial } from "./materialSelection.ts";

function material(
  attachmentId: string,
  overrides: Partial<ScientSourceAttachment> = {},
): ScientSourceAttachment {
  return {
    attachmentId,
    kind: "pdf",
    fileName: `${attachmentId}.pdf`,
    mediaType: "application/pdf",
    sha256: `sha256-${attachmentId}`,
    byteLength: 1_024,
    relativePath: `files/sha256/aa/${attachmentId}.pdf`,
    importedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("Scient Source material selection", () => {
  it("reports a Source without concrete material", () => {
    expect(selectScientSourceMaterial({ materials: [] })).toEqual({ _tag: "NoMaterial" });
  });

  it("selects the only eligible PDF without giving array position durable meaning", () => {
    const onlyMaterial = material("pdf-primary");
    expect(selectScientSourceMaterial({ materials: [onlyMaterial] })).toEqual({
      _tag: "Selected",
      material: onlyMaterial,
      selectedBy: "single-eligible-material",
    });
  });

  it("selects from a redacted material reference without requiring private storage fields", () => {
    const summary = {
      attachmentId: "pdf-summary",
      kind: "pdf",
      mediaType: "application/pdf",
      fileName: "summary.pdf",
    } as const;
    expect(selectScientSourceMaterial({ materials: [summary] })).toEqual({
      _tag: "Selected",
      material: summary,
      selectedBy: "single-eligible-material",
    });
  });

  it("requires an explicit stable ID when several eligible materials exist", () => {
    const first = material("pdf-first");
    const second = material("pdf-second");
    expect(selectScientSourceMaterial({ materials: [first, second] })).toEqual({
      _tag: "SeveralMaterials",
      materials: [first, second],
    });
    expect(
      selectScientSourceMaterial({
        materials: [first, second],
        requestedAttachmentId: second.attachmentId,
      }),
    ).toEqual({ _tag: "Selected", material: second, selectedBy: "requested-id" });
  });

  it("distinguishes missing, unsupported, and duplicate identities", () => {
    const pdf = material("pdf-one");
    expect(
      selectScientSourceMaterial({
        materials: [pdf],
        requestedAttachmentId: "pdf-missing",
      }),
    ).toEqual({ _tag: "MaterialNotFound", requestedAttachmentId: "pdf-missing" });
    expect(selectScientSourceMaterial({ materials: [pdf], supportedMaterials: [] })).toEqual({
      _tag: "UnsupportedMaterial",
      materials: [pdf],
    });
    expect(selectScientSourceMaterial({ materials: [pdf, { ...pdf }] })).toEqual({
      _tag: "DuplicateMaterialId",
      attachmentId: pdf.attachmentId,
    });
  });
});
