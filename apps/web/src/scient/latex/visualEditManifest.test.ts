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

describe("revision-local Visual edit manifest", () => {
  it("maps unique PDF tokens before interaction and removes its affordance on disposal", () => {
    const source =
      "\\begin{document}\nAlpha office words.\n\nSecond unique paragraph.\n\\end{document}";
    const { container, spans } = pdfWith("Alpha office words.", "Second unique paragraph.");
    const manifest = createVisualEditManifest(container, source);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entryFor(spans[0]!)).not.toBeNull();
    expect(spans[0]!.classList.contains("scient-latex-visual-editable")).toBe(true);
    manifest.dispose();
    expect(spans[0]!.classList.contains("scient-latex-visual-editable")).toBe(false);
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
    const manifest = createVisualEditManifest(container, source);
    expect(manifest.entryFor(spans[0]!)).toBeNull();
    expect(manifest.entryFor(spans[1]!)).toBeNull();
    expect(manifest.entryFor(spans[2]!)).toBeNull();
    expect(manifest.entryFor(rtl)).toBeNull();
    expect(manifest.entryFor(split)).toBeNull();
  });

  it("maps PDF ligatures and whitespace to stable source-run offsets", () => {
    const source = "\\begin{document}\nBefore office   words after.\n\\end{document}";
    const { container, spans } = pdfWith("office words");
    spans[0]!.textContent = "ofﬁce words";
    const manifest = createVisualEditManifest(container, source);
    const entry = manifest.entryFor(spans[0]!);
    expect(entry).not.toBeNull();
    expect(entry!.run.text.slice(visualManifestOffset(entry!, 0)).startsWith("office words")).toBe(
      true,
    );
    expect(visualManifestOffset(entry!, spans[0]!.textContent!.length)).toBeGreaterThan(
      visualManifestOffset(entry!, 0),
    );
  });

  it("does not confuse identical text in separate columns", () => {
    const source = "\\begin{document}\nColumn label.\n\nColumn label.\n\\end{document}";
    const { container, spans } = pdfWith("Column label.", "Column label.");
    const manifest = createVisualEditManifest(container, source);
    expect(manifest.entries).toHaveLength(0);
    expect(manifest.entryFor(spans[0]!)).toBeNull();
    expect(manifest.entryFor(spans[1]!)).toBeNull();
  });
});
