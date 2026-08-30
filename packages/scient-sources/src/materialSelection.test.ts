import { describe, expect, it } from "@effect/vitest";

import type { ScientSourceAttachment } from "./model.ts";
import { selectScientSourceMaterial, verifyScientSourceMaterial } from "./materialSelection.ts";

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

describe("Scient Source material verification", () => {
  const selected = material("pdf-selected", {
    sha256: "AABBCC",
    byteLength: 2_048,
  });

  it("reports missing bytes without selecting a fallback material", () => {
    expect(verifyScientSourceMaterial(selected, { _tag: "Missing" })).toEqual({
      _tag: "MissingBytes",
      material: selected,
    });
  });

  it("reports changed bytes from the exact observed hash", () => {
    expect(
      verifyScientSourceMaterial(selected, {
        _tag: "Available",
        sha256: "different",
        byteLength: 2_048,
      }),
    ).toEqual({
      _tag: "HashMismatch",
      material: selected,
      observedSha256: "different",
    });
  });

  it("treats hexadecimal case as equivalent and still verifies byte length", () => {
    expect(
      verifyScientSourceMaterial(selected, {
        _tag: "Available",
        sha256: "aabbcc",
        byteLength: 1,
      }),
    ).toEqual({
      _tag: "ByteLengthMismatch",
      material: selected,
      observedByteLength: 1,
    });
    expect(
      verifyScientSourceMaterial(selected, {
        _tag: "Available",
        sha256: "aabbcc",
        byteLength: 2_048,
      }),
    ).toEqual({ _tag: "Verified", material: selected });
  });
});
