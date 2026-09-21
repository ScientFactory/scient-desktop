// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { createVisualEditManifest, visualManifestOffset } from "./visualEditManifest";

function pdfWith(...texts: string[]) {
  const container = document.createElement("div");
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  const layer = document.createElement("div");
  layer.className = "textLayer";
  const spans = texts.map((text) => {
    const span = document.createElement("span");
    span.textContent = text;
    layer.append(span);
    return span;
  });
  page.append(layer);
  container.append(page);
  return { container, spans };
}

function documentTextItems(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll(".textLayer span"),
    (span) => span.textContent ?? "",
  );
}

describe("revision-local Visual edit manifest", () => {
  it("maps unique PDF tokens before interaction and removes its affordance on disposal", () => {
    const source =
      "\\begin{document}\nAlpha office words.\n\nSecond unique paragraph.\n\\end{document}";
    const { container, spans } = pdfWith("Alpha office words.", "Second unique paragraph.");
    const manifest = createVisualEditManifest(container, source, documentTextItems(container));
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entryFor(spans[0]!)).not.toBeNull();
    expect(spans[0]!.classList.contains("scient-latex-visual-editable")).toBe(true);
    expect(spans[0]!.getAttribute("tabindex")).toBe("0");
    expect(spans[0]!.getAttribute("aria-description")).toContain("Press Enter");
    expect(spans[0]!.getAttribute("aria-keyshortcuts")).toBe("Enter Space F2");
    manifest.dispose();
    expect(spans[0]!.classList.contains("scient-latex-visual-editable")).toBe(false);
    expect(spans[0]!.hasAttribute("tabindex")).toBe(false);
    expect(spans[0]!.hasAttribute("aria-description")).toBe(false);
    expect(spans[0]!.hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("fails closed for repeated, short, generated, RTL, and multi-node tokens", () => {
    const source =
      "\\begin{document}\nRepeated prose. Repeated prose. Unique literal sentence.\n\\end{document}";
    const { container, spans } = pdfWith("Repeated prose.", "ab", "Generated title");
    const rtl = document.createElement("span");
    rtl.dir = "rtl";
    rtl.textContent = "Unique literal sentence.";
    const split = document.createElement("span");
    split.append("Unique ", document.createElement("b"), "literal sentence.");
    container.querySelector(".textLayer")!.append(rtl, split);
    const manifest = createVisualEditManifest(container, source, documentTextItems(container));
    expect(manifest.entryFor(spans[0]!)).toBeNull();
    expect(manifest.entryFor(spans[1]!)).toBeNull();
    expect(manifest.entryFor(spans[2]!)).toBeNull();
    expect(manifest.entryFor(rtl)).toBeNull();
    expect(manifest.entryFor(split)).toBeNull();
  });

  it("maps PDF ligatures and whitespace to stable source-run offsets", () => {
    const source = "\\begin{document}\nBefore office   words after.\n\\end{document}";
    const { container, spans } = pdfWith("Before ofﬁce", "words after.");
    const manifest = createVisualEditManifest(container, source, documentTextItems(container));
    const entry = manifest.entryFor(spans[0]!);
    expect(entry).not.toBeNull();
    expect(entry!.run.text.slice(visualManifestOffset(entry!, 7)).startsWith("office")).toBe(true);
    expect(visualManifestOffset(entry!, spans[0]!.textContent!.length)).toBeGreaterThan(
      visualManifestOffset(entry!, 0),
    );
  });

  it("fails closed when an omitted short span leaves the source run only partly covered", () => {
    const source = "\\begin{document}\nA unique editable sentence.\n\\end{document}";
    const { container, spans } = pdfWith("A", "unique editable sentence.");
    const manifest = createVisualEditManifest(container, source, documentTextItems(container));

    expect(manifest.entries).toHaveLength(0);
    expect(manifest.entryFor(spans[0]!)).toBeNull();
    expect(manifest.entryFor(spans[1]!)).toBeNull();
    expect(spans[1]!.classList.contains("scient-latex-visual-editable")).toBe(false);
  });

  it("admits an ordered fragmented run only when every normalized character is covered", () => {
    const source = "\\begin{document}\nAlpha unique editable sentence.\n\\end{document}";
    const { container, spans } = pdfWith("Alpha ", "unique editable sentence.");
    const manifest = createVisualEditManifest(container, source, documentTextItems(container));

    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entryFor(spans[0]!)).not.toBeNull();
    expect(manifest.entryFor(spans[1]!)).not.toBeNull();
  });

  it("fails closed when one source run is split across PDF pages", () => {
    const source = "\\begin{document}\nAlpha unique editable sentence.\n\\end{document}";
    const first = pdfWith("Alpha ");
    const second = pdfWith("unique editable sentence.");
    second.container.querySelector(".page")!.setAttribute("data-page-number", "2");
    first.container.append(...second.container.childNodes);
    const manifest = createVisualEditManifest(
      first.container,
      source,
      documentTextItems(first.container),
    );

    expect(manifest.entries).toHaveLength(0);
    expect(manifest.entryFor(first.spans[0]!)).toBeNull();
    expect(manifest.entryFor(second.spans[0]!)).toBeNull();
  });

  it("rejects two rendered Participants spans that claim the same source interval", () => {
    const source = "\\begin{document}\n\\textbf{Participants}\n\\end{document}";
    const { container, spans } = pdfWith("Participants", "Participants");
    // Even inconsistent or stale output evidence cannot override the reverse
    // source-interval proof built from the rendered text layer itself.
    const manifest = createVisualEditManifest(container, source, ["Participants"]);

    expect(manifest.entries).toHaveLength(0);
    expect(manifest.entryFor(spans[0]!)).toBeNull();
    expect(manifest.entryFor(spans[1]!)).toBeNull();
  });

  it("rejects a virtualized Results span when the immutable PDF contains another occurrence", () => {
    const source =
      "\\begin{document}\n\\textbf{Results}\n\n\\articleSection{Results}\n\\end{document}";
    // Only page 2 is currently materialized. Its opaque macro output would
    // otherwise borrow the unique editable source range from page 1.
    const { container, spans } = pdfWith("Results");
    container.querySelector(".page")!.setAttribute("data-page-number", "2");
    const manifest = createVisualEditManifest(container, source, ["Results", "Results"]);

    expect(manifest.entries).toHaveLength(0);
    expect(manifest.entryFor(spans[0]!)).toBeNull();
  });

  it("rejects a duplicate even when another page splits it across PDF text items", () => {
    const source = "\\begin{document}\nParticipants\n\\end{document}";
    const { container, spans } = pdfWith("Participants");
    const manifest = createVisualEditManifest(container, source, [
      "Participants",
      "Partici",
      "pants",
    ]);

    expect(manifest.entries).toHaveLength(0);
    expect(manifest.entryFor(spans[0]!)).toBeNull();
  });

  it("does not confuse identical text in separate columns", () => {
    const source = "\\begin{document}\nColumn label.\n\nColumn label.\n\\end{document}";
    const { container, spans } = pdfWith("Column label.", "Column label.");
    const manifest = createVisualEditManifest(container, source, documentTextItems(container));
    expect(manifest.entries).toHaveLength(0);
    expect(manifest.entryFor(spans[0]!)).toBeNull();
    expect(manifest.entryFor(spans[1]!)).toBeNull();
  });
});
