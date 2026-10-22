import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ArtifactAuthority, LogicalDocumentKey } from "./contracts.ts";
import {
  PDF_TEXT_PROFILE,
  PdfTarget,
  relocatePdfText,
  verifyPdfTarget,
  type PdfCurrentPage,
} from "./pdfTarget.ts";

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const viewBox = [0, 0, 612, 792] as const;
const page3 = "Results\nThe coupling constant scales as the inverse square.\nNext line.\n";

function target(overrides?: { readonly material?: PdfTarget["material"] }): PdfTarget {
  const start = page3.indexOf("coupling");
  const end = page3.indexOf(" as the");
  return PdfTarget.make({
    version: 1,
    document: {
      authority: ArtifactAuthority.make("environment-1"),
      logicalDocumentKey: LogicalDocumentKey.make("workspace:/p/paper.pdf"),
      title: "paper.pdf",
      fileName: "paper.pdf",
      locator: { _tag: "workspace", workspaceRoot: "/p", relativePath: "paper.pdf" },
    },
    material: overrides?.material ?? null,
    extractor: { profile: PDF_TEXT_PROFILE, version: "6.2.108" },
    selector: {
      type: "text",
      pages: [
        {
          page: 3,
          viewBox: [...viewBox],
          rotation: 0,
          userUnit: 1,
          pageTextHash: hash("a"),
          start,
          end,
          quote: page3.slice(start, end),
          prefix: page3.slice(Math.max(0, start - 64), start),
          suffix: page3.slice(end, end + 64),
        },
      ],
    },
  });
}

const current = (text: string, textHash = hash("a")): PdfCurrentPage => ({
  page: 3,
  text,
  textHash,
  viewBox,
  rotation: 0,
  userUnit: 1,
});

describe("PDF target", () => {
  it("round-trips through JSON and rejects an inconsistent quote", () => {
    const json = Schema.fromJsonString(PdfTarget);
    const value = target();
    expect(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(value))).toEqual(value);
    const page = value.selector.pages[0]!;
    expect(() =>
      PdfTarget.make({
        ...value,
        selector: { type: "text", pages: [{ ...page, end: page.end + 1 }] },
      }),
    ).toThrow();
  });

  it("reuses offsets only when the live page text proves them", () => {
    const material = { sha256: hash("b"), byteLength: 10 };
    const stored = target({ material });
    const read = (text: string, textHash?: string, version = "6.2.108") =>
      verifyPdfTarget(stored, {
        material,
        extractorVersion: version,
        page: (page) => (page === 3 ? current(text, textHash) : undefined),
      });
    expect(read(page3)).toEqual({ material: "match", selectorValid: true });
    // Same bytes, but a new extractor: the offsets are no longer proven.
    expect(read(page3, undefined, "7.0.0")).toEqual({ material: "match", selectorValid: false });
    expect(read(`X${page3}`, hash("c")).selectorValid).toBe(false);
    expect(
      verifyPdfTarget(target(), {
        material: null,
        extractorVersion: "6.2.108",
        page: () => current(page3),
      }),
    ).toEqual({ material: "unknown", selectorValid: true });
  });

  it("finds the quote again by its context, across pages, and never guesses", () => {
    const stored = target();
    const moved = {
      pages: [
        { page: 1, text: "Intro.\n" },
        { page: 2, text: page3 },
      ],
      complete: true,
    };
    expect(relocatePdfText(stored, moved)).toEqual({
      _tag: "Found",
      ranges: [{ page: 2, start: page3.indexOf("coupling"), end: page3.indexOf(" as the") }],
    });

    // The quote now straddles a page break.
    const split = page3.indexOf("constant");
    expect(
      relocatePdfText(stored, {
        pages: [
          { page: 4, text: page3.slice(0, split) },
          { page: 5, text: page3.slice(split) },
        ],
        complete: true,
      }),
    ).toEqual({
      _tag: "Found",
      ranges: [
        { page: 4, start: page3.indexOf("coupling"), end: split },
        { page: 5, start: 0, end: page3.indexOf(" as the") - split },
      ],
    });

    // The context changed but the quote is unique.
    expect(
      relocatePdfText(stored, {
        pages: [{ page: 1, text: "Now: the coupling constant scales fast." }],
        complete: true,
      })._tag,
    ).toBe("Found");
    expect(
      relocatePdfText(stored, {
        pages: [
          { page: 1, text: "the coupling constant scales twice" },
          { page: 2, text: "and the coupling constant scales again" },
        ],
        complete: true,
      }),
    ).toEqual({ _tag: "Ambiguous" });
    expect(
      relocatePdfText(stored, { pages: [{ page: 1, text: "nothing" }], complete: true }),
    ).toEqual({ _tag: "NotFound" });
    // A unique match among the pages read so far proves nothing about the rest.
    expect(relocatePdfText(stored, { ...moved, complete: false })).toEqual({ _tag: "Incomplete" });
    // Nor does a repeated bare quote: an unread page could hold the one with its context.
    expect(
      relocatePdfText(stored, {
        pages: [
          { page: 1, text: "coupling constant scales" },
          { page: 2, text: "coupling constant scales" },
        ],
        complete: false,
      }),
    ).toEqual({ _tag: "Incomplete" });
  });
});
