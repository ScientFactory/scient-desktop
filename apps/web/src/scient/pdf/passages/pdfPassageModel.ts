import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ScientPassageCapture } from "@scientfactory/scient-sources";

// Exact PDF.js extraction profile, shared with the bounded saved-passage schema.
export const PDF_PASSAGE_PROFILE = "pdfjs-text-layer-utf16-eol-v1";
export const PDF_PASSAGE_LIMITS = { pages: 4, characters: 8_000, rectangles: 256 } as const;
export type PdfRectangle = readonly [number, number, number, number];

export interface PassageMaterial {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface PassagePage {
  readonly page: number;
  readonly text: string;
  readonly viewBox: PdfRectangle;
  readonly rotation: number;
  readonly userUnit: number;
}

export interface PassageSelection extends PassagePage {
  readonly start: number;
  readonly end: number;
  readonly rectangles: ReadonlyArray<PdfRectangle>;
}

export type PdfPassageCapture = ScientPassageCapture;

export type PassageRefusal =
  | "empty-selection"
  | "too-many-pages"
  | "too-many-rectangles"
  | "page-not-ready"
  | "page-too-complex"
  | "unsupported-text-angle"
  | "selection-too-large"
  | "invalid-selection"
  | "material-changed"
  | "extractor-changed"
  | "page-missing"
  | "page-text-changed"
  | "page-geometry-changed";

export type PassageVerification =
  | { readonly _tag: "Exact" }
  | { readonly _tag: "NotExact"; readonly reason: PassageRefusal };

export function passageHash(value: string | Uint8Array): string {
  return bytesToHex(sha256(typeof value === "string" ? new TextEncoder().encode(value) : value));
}

// Match PDF.js TextLayerBuilder: raw item text, then a newline for hasEOL.
// No compatibility normalization, dehyphenation, or invented inter-item spaces.
export function passageText(items: ReadonlyArray<object>): string {
  return items
    .map((item) =>
      "str" in item && typeof item.str === "string"
        ? item.str + ("hasEOL" in item && item.hasEOL ? "\n" : "")
        : "",
    )
    .join("");
}

function validRectangle(rect: PdfRectangle, bounds: PdfRectangle): boolean {
  const tolerance = 2; // Font ascent/descent boxes may extend slightly past the crop box.
  return (
    rect.every(Number.isFinite) &&
    rect[0] < rect[2] &&
    rect[1] < rect[3] &&
    rect[0] >= bounds[0] - tolerance &&
    rect[1] >= bounds[1] - tolerance &&
    rect[2] <= bounds[2] + tolerance &&
    rect[3] <= bounds[3] + tolerance
  );
}

export function capturePdfPassage(input: {
  readonly material: PassageMaterial;
  readonly extractorVersion: string;
  readonly selection: ReadonlyArray<PassageSelection>;
}):
  | { readonly _tag: "Captured"; readonly capture: PdfPassageCapture }
  | { readonly _tag: "Refused"; readonly reason: PassageRefusal } {
  const pages = input.selection;
  if (!pages.length) return { _tag: "Refused", reason: "empty-selection" };
  if (
    pages.length > PDF_PASSAGE_LIMITS.pages ||
    pages.reduce((sum, page) => sum + page.end - page.start, 0) > PDF_PASSAGE_LIMITS.characters ||
    pages.reduce((sum, page) => sum + page.rectangles.length, 0) > PDF_PASSAGE_LIMITS.rectangles
  ) {
    return { _tag: "Refused", reason: "selection-too-large" };
  }
  if (
    !/^[a-f0-9]{64}$/.test(input.material.sha256) ||
    !Number.isSafeInteger(input.material.byteLength) ||
    input.material.byteLength <= 0 ||
    !input.extractorVersion ||
    pages.some(
      (page, index) =>
        !Number.isSafeInteger(page.page) ||
        page.page < 1 ||
        (index > 0 && page.page !== pages[index - 1]!.page + 1) ||
        !Number.isSafeInteger(page.start) ||
        !Number.isSafeInteger(page.end) ||
        page.start < 0 ||
        page.end > page.text.length ||
        page.start >= page.end ||
        !page.text.slice(page.start, page.end).trim() ||
        !page.rectangles.length ||
        !page.viewBox.every(Number.isFinite) ||
        page.viewBox[0] >= page.viewBox[2] ||
        page.viewBox[1] >= page.viewBox[3] ||
        !Number.isFinite(page.userUnit) ||
        page.userUnit <= 0 ||
        !Number.isFinite(page.rotation) ||
        page.rectangles.some((rect) => !validRectangle(rect, page.viewBox)),
    )
  ) {
    return { _tag: "Refused", reason: "invalid-selection" };
  }
  return {
    _tag: "Captured",
    capture: {
      material: { ...input.material },
      extractorVersion: input.extractorVersion,
      profile: PDF_PASSAGE_PROFILE,
      pages: pages.map((page) => ({
        page: page.page,
        pageTextHash: passageHash(page.text),
        viewBox: [...page.viewBox],
        rotation: page.rotation,
        userUnit: page.userUnit,
        start: page.start,
        end: page.end,
        quote: page.text.slice(page.start, page.end),
        prefix: page.text.slice(Math.max(0, page.start - 64), page.start),
        suffix: page.text.slice(page.end, page.end + 64),
        rectangles: page.rectangles.map((rect) => [...rect]),
      })),
    },
  };
}

export function verifyPdfPassage(
  capture: PdfPassageCapture,
  current: {
    readonly material: PassageMaterial;
    readonly extractorVersion: string;
    readonly pages: ReadonlyArray<PassagePage>;
  },
): PassageVerification {
  const fail = (reason: PassageRefusal): PassageVerification => ({ _tag: "NotExact", reason });
  if (
    capture.material.sha256 !== current.material.sha256 ||
    capture.material.byteLength !== current.material.byteLength
  )
    return fail("material-changed");
  const extractorChanged =
    capture.extractorVersion !== current.extractorVersion ||
    capture.profile !== PDF_PASSAGE_PROFILE;
  if (!capture.pages.length || capture.pages.length > PDF_PASSAGE_LIMITS.pages)
    return fail("invalid-selection");
  for (const original of capture.pages) {
    const matches = current.pages.filter((page) => page.page === original.page);
    if (matches.length !== 1) return fail("page-missing");
    const page = matches[0]!;
    if (
      page.rotation !== original.rotation ||
      page.userUnit !== original.userUnit ||
      page.viewBox.some((value, index) => value !== original.viewBox[index])
    )
      return fail("page-geometry-changed");
    if (
      !extractorChanged &&
      (passageHash(page.text) !== original.pageTextHash ||
        !original.quote ||
        page.text.slice(original.start, original.end) !== original.quote ||
        page.text.slice(Math.max(0, original.start - 64), original.start) !== original.prefix ||
        page.text.slice(original.end, original.end + 64) !== original.suffix)
    )
      return fail("page-text-changed");
  }
  if (extractorChanged) return fail("extractor-changed");
  return { _tag: "Exact" };
}

export const PASSAGE_REFUSAL_COPY: Record<PassageRefusal, string> = {
  "empty-selection": "Select a passage in the PDF first. Image-only pages have no selectable text.",
  "too-many-pages": "Select up to four consecutive pages.",
  "too-many-rectangles": "This selection has too many text fragments. Select a shorter passage.",
  "page-not-ready": "Wait for the selected pages to render, then select the passage again.",
  "page-too-complex": "This page exceeds the supported text-layer limit.",
  "unsupported-text-angle":
    "Diagonal text is not supported yet. No approximate highlight was captured.",
  "selection-too-large": "Select a shorter passage (up to four pages and 8,000 characters).",
  "invalid-selection":
    "This selection could not be captured reliably. Select text entirely inside the PDF.",
  "material-changed":
    "The PDF bytes changed. The original passage is preserved; it has not been moved to the new PDF.",
  "extractor-changed":
    "The text extractor changed. This passage needs review before it can be called exact.",
  "page-missing": "A captured page is unavailable. The original passage is preserved.",
  "page-text-changed":
    "The extracted text differs from the capture. Scient will not guess which passage to use.",
  "page-geometry-changed": "The PDF page geometry changed. The original passage is preserved.",
};
