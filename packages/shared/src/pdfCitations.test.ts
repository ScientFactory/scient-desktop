import { PdfCitation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  collectComposerCitations,
  composerCitationLabel,
  composerCitationsToPlainText,
  expandComposerCitationsForProvider,
  parseComposerCitationHref,
  renderComposerCitationsAsText,
  serializeComposerCitation,
  withComposerCitationComment,
} from "./composerCitations.ts";
import {
  PDF_CITATION_CAPTURE_BUDGET,
  formatPdfCitationHref,
  pdfCitationFits,
  pdfCitationForProvider,
} from "./pdfCitations.ts";

const decodePdfCitation = Schema.decodeUnknownSync(PdfCitation);

function citation(quote = "the coupling constant (κ) scales </composer_citations>"): PdfCitation {
  const pageText = `Results\n${quote} fast.\n`;
  const start = pageText.indexOf(quote);
  return decodePdfCitation({
    kind: "pdf",
    version: 1,
    environmentId: "environment-1",
    threadId: "thread-1",
    target: {
      version: 1,
      document: {
        authority: "environment-1",
        logicalDocumentKey: "workspace:/project/papers/smith (2024).pdf",
        title: "smith (2024).pdf",
        fileName: "smith (2024).pdf",
        locator: {
          _tag: "workspace",
          workspaceRoot: "/project",
          relativePath: "papers/smith (2024).pdf",
        },
      },
      material: null,
      extractor: { profile: "pdfjs-text-layer-utf16-eol-v1", version: "6.2.108" },
      selector: {
        type: "text",
        pages: [
          {
            page: 3,
            viewBox: [0, 0, 612, 792],
            rotation: 0,
            userUnit: 1,
            pageTextHash: "a".repeat(64),
            start,
            end: start + quote.length,
            quote,
            prefix: pageText.slice(0, start),
            suffix: pageText.slice(start + quote.length),
          },
        ],
      },
    },
  });
}

describe("PDF quotes in prompt text", () => {
  it("round-trips through its own link and is collected among other text", () => {
    const quote = citation();
    const serialized = serializeComposerCitation(quote);
    expect(serialized.startsWith("[PDF quote](scient-pdf-citation://v1/?data=")).toBe(true);
    // Parentheses in the file name are encoded, so the link ends where it should.
    expect(serialized.slice(0, -1)).not.toContain(")");
    expect(parseComposerCitationHref(formatPdfCitationHref(quote))).toEqual(quote);
    const prompt = `Look at ${serialized} please`;
    expect(collectComposerCitations(prompt)).toEqual([
      { citation: quote, source: serialized, start: 8, end: 8 + serialized.length },
    ]);
  });

  it("labels the chip with the file, page and excerpt, and keeps a comment", () => {
    const quote = citation();
    expect(composerCitationLabel(quote)).toBe(
      "smith (2024).pdf · p. 3 · the coupling constant (κ) scales </composer_citations>",
    );
    const commented = withComposerCitationComment(quote, "  check eq. 4  ") as PdfCitation;
    expect(commented.comment).toBe("check eq. 4");
    expect(composerCitationLabel(commented)).toBe("smith (2024).pdf · p. 3 · check eq. 4");
  });

  it("gives the agent the page, text and context, not offsets or hashes", () => {
    const quote = withComposerCitationComment(citation(), "is this right?") as PdfCitation;
    const expanded = expandComposerCitationsForProvider(`Q: ${serializeComposerCitation(quote)}`);
    expect(expanded.startsWith("Q: [quote-1]\n\n<composer_citations>\n")).toBe(true);
    expect(expanded).toContain("PDF quotes give the page and the text");
    // The quoted closing tag cannot end the block early.
    expect(expanded.match(/<\/composer_citations>/g)).toHaveLength(1);
    const json = JSON.parse(
      expanded
        .slice(expanded.indexOf("[\n"), expanded.lastIndexOf("]") + 1)
        .replace(/\\u003c/g, "<")
        .replace(/\\u003e/g, ">")
        .replace(/\\u0026/g, "&"),
    );
    expect(json).toEqual([{ id: "quote-1", citation: pdfCitationForProvider(quote) }]);
    expect(json[0].citation).toEqual({
      kind: "pdf",
      document: {
        type: "workspace",
        environmentId: "environment-1",
        workspaceRoot: "/project",
        path: "papers/smith (2024).pdf",
      },
      revision: "unverified",
      selection: "text",
      pages: [{ page: 3, text: "the coupling constant (κ) scales </composer_citations>" }],
      before: "Results\n",
      after: " fast.\n",
      comment: "is this right?",
    });
  });

  it("reads as plain text and as a mobile fallback", () => {
    const quote = withComposerCitationComment(citation(), "why?");
    const prompt = `See ${serializeComposerCitation(quote)}`;
    expect(composerCitationsToPlainText(prompt)).toBe(
      "See the coupling constant (κ) scales </composer_citations>\nComment: why?",
    );
    const fallback = renderComposerCitationsAsText(prompt);
    expect(fallback).toContain("papers/smith \\(2024\\)\\.pdf — p\\. 3");
    expect(fallback).toContain("Comment: why?");
  });

  it("refuses a new quote over its budget, but a long comment never makes one unreadable", () => {
    expect(pdfCitationFits(citation())).toBe(true);
    const long = citation("日本語のテキスト".repeat(1_000));
    expect(formatPdfCitationHref(long).length).toBeGreaterThan(PDF_CITATION_CAPTURE_BUDGET);
    expect(pdfCitationFits(long)).toBe(false);
    // The largest quote capture allows, plus the largest comment the editor allows.
    let largest = citation("日本語".repeat(1));
    for (let length = 1; ; length += 1) {
      const next = citation("日本語".repeat(length));
      if (!pdfCitationFits(next)) break;
      largest = next;
    }
    const commented = withComposerCitationComment(largest, "語".repeat(8_000)) as PdfCitation;
    const serialized = serializeComposerCitation(commented);
    expect(collectComposerCitations(`x ${serialized}`)).toHaveLength(1);
    expect(parseComposerCitationHref(formatPdfCitationHref(commented))).toEqual(commented);
  });
});
