import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ScientPdfRuntime } from "../pdfRuntime";
import { readPdfTextSelection } from "./pdfTextLayer";

/** pdf.js-shaped pages: `.page[data-page-number] > .textLayer > span` per line, `br` for EOL. */
function pages(
  lines: ReadonlyArray<ReadonlyArray<string>>,
  rotate: (page: number) => string = () => "0",
) {
  const viewer = document.createElement("div");
  const views = lines.map((pageLines, index) => {
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = String(index + 1);
    const layer = document.createElement("div");
    layer.className = "textLayer";
    for (const line of pageLines) {
      const span = document.createElement("span");
      span.textContent = line;
      span.style.setProperty("--rotate", `${rotate(index + 1)}deg`);
      layer.append(span, document.createElement("br"));
    }
    page.append(layer);
    viewer.append(page);
    return {
      textLayer: { div: layer },
      pdfPage: { view: [0, 0, 612, 792], rotate: 0, userUnit: 1 },
    };
  });
  document.body.append(viewer);
  const runtime = {
    viewer: { viewer, getPageView: (index: number) => views[index] },
  } as unknown as ScientPdfRuntime;
  const text = (page: number, line: number) =>
    viewer.querySelectorAll(".page")[page - 1]!.querySelectorAll("span")[line]!.firstChild as Text;
  return { viewer, runtime, text };
}

function select(start: Text, startOffset: number, end: Text, endOffset: number) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("reading a PDF selection", () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  it("maps a selection across pages to per-page offsets in the text-layer profile", () => {
    const { runtime, text } = pages([
      ["alpha one", "alpha two"],
      ["beta one"],
      ["gamma one", "gamma two"],
    ]);
    const read = readPdfTextSelection(runtime, select(text(1, 1), 6, text(3, 0), 5));
    expect(read._tag).toBe("Ready");
    if (read._tag !== "Ready") return;
    expect(
      read.pages.map(({ page, text: pageText, start, end }) => ({
        page,
        quote: pageText.slice(start, end),
      })),
    ).toEqual([
      { page: 1, quote: "two\n" },
      { page: 2, quote: "beta one\n" },
      { page: 3, quote: "gamma" },
    ]);
    expect(read.pages[0]!.text).toBe("alpha one\nalpha two\n");
  });

  it("allows four pages when a fifth holds only the selection's end", () => {
    const { runtime, text } = pages([["p1"], ["p2"], ["p3"], ["p4"], ["p5"]]);
    const read = readPdfTextSelection(runtime, select(text(1, 0), 0, text(5, 0), 0));
    expect(read._tag).toBe("Ready");
    if (read._tag === "Ready") expect(read.pages.map((page) => page.page)).toEqual([1, 2, 3, 4]);
    // Both ends on boundary-only pages: pages 2–5 hold the text.
    const both = pages([["p1"], ["p2"], ["p3"], ["p4"], ["p5"], ["p6"]]);
    const spanning = readPdfTextSelection(
      both.runtime,
      select(both.text(1, 0), 2, both.text(6, 0), 0),
    );
    expect(spanning._tag).toBe("Ready");
    if (spanning._tag === "Ready") {
      expect(spanning.pages.map((page) => page.page)).toEqual([2, 3, 4, 5]);
    }
    expect(readPdfTextSelection(runtime, select(text(1, 0), 0, text(5, 0), 2))).toEqual({
      _tag: "Refused",
      reason: "too-many-pages",
    });
  });

  it("refuses diagonal text and ignores selections outside the viewer", () => {
    const { runtime, text } = pages([["slanted words"]], () => "30");
    expect(readPdfTextSelection(runtime, select(text(1, 0), 0, text(1, 0), 7))).toEqual({
      _tag: "Refused",
      reason: "unsupported-text-angle",
    });
    const outside = document.createElement("p");
    outside.textContent = "chat text";
    document.body.append(outside);
    const node = outside.firstChild as Text;
    expect(readPdfTextSelection(runtime, select(node, 0, node, 4))).toEqual({ _tag: "Empty" });
  });
});
