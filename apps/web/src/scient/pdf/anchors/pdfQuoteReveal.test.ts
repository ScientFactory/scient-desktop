import {
  ArtifactAuthority,
  LogicalDocumentKey,
  PDF_TEXT_PROFILE,
  PdfTarget,
} from "@scientfactory/document-artifacts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScientPdfRuntime } from "../pdfRuntime";
import { locatePdfQuote } from "./pdfQuoteReveal";

const target = PdfTarget.make({
  version: 1,
  document: {
    authority: ArtifactAuthority.make("environment-1"),
    logicalDocumentKey: LogicalDocumentKey.make("workspace:/p/a.pdf"),
    title: "a.pdf",
    fileName: "a.pdf",
    locator: { _tag: "workspace", workspaceRoot: "/p", relativePath: "a.pdf" },
  },
  material: null,
  extractor: { profile: PDF_TEXT_PROFILE, version: "6.2.108" },
  selector: {
    type: "text",
    pages: [
      {
        page: 2,
        viewBox: [0, 0, 612, 792],
        rotation: 0,
        userUnit: 1,
        pageTextHash: "f".repeat(64),
        start: 0,
        end: 5,
        quote: "Hello",
        prefix: "",
        suffix: "",
      },
    ],
  },
});

/** A reader whose pages never render and whose page text never arrives. */
function stalledRuntime() {
  const scrollPageIntoView = vi.fn();
  const runtime = {
    document: { numPages: 3, getPage: () => new Promise(() => undefined) },
    viewer: { getPageView: () => undefined, scrollPageIntoView },
    eventBus: { on: vi.fn(), off: vi.fn() },
  } as unknown as ScientPdfRuntime;
  return { runtime, scrollPageIntoView };
}

describe("locating a quote", () => {
  afterEach(() => vi.useRealTimers());

  it("does nothing to the reader once cancelled", async () => {
    const { runtime, scrollPageIntoView } = stalledRuntime();
    const controller = new AbortController();
    controller.abort();
    await expect(locatePdfQuote(runtime, target, controller.signal)).rejects.toBeDefined();
    expect(scrollPageIntoView).not.toHaveBeenCalled();
  });

  it("stops a search that outlasts its budget and calls it incomplete", async () => {
    vi.useFakeTimers();
    const { runtime } = stalledRuntime();
    const located = locatePdfQuote(runtime, target, new AbortController().signal);
    // The quoted page never renders, then extraction never answers.
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(located).resolves.toEqual({
      outcome: { _tag: "Incomplete", page: 2 },
      highlight: null,
    });
  });
});
