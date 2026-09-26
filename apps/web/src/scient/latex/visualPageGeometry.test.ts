// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createVisualEditManifest } from "./visualEditManifest";
import { measureDraftGeometry, visualTextHit } from "./visualPageGeometry";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Visual draft geometry", () => {
  it("leaves native controls and distant page whitespace outside the edit hit area", () => {
    const source = "\\begin{document}\nA unique editable line.\n\\end{document}\n";
    const container = document.createElement("div");
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    const layer = document.createElement("div");
    layer.className = "textLayer";
    const span = document.createElement("span");
    span.textContent = "A unique editable line.";
    const control = document.createElement("button");
    const controlIcon = document.createElement("span");
    control.append(controlIcon);
    layer.append(span);
    page.append(layer, control);
    container.append(page);
    document.body.append(container);

    const manifest = createVisualEditManifest(container, source, ["A unique editable line."]);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return new DOMRect(
        100 + this.startOffset * 7,
        100,
        Math.max(7, (this.endOffset - this.startOffset) * 7),
        12,
      );
    });
    const hit = (
      target: Element,
      clientX: number,
      clientY: number,
    ): ReturnType<typeof visualTextHit> => {
      let result: ReturnType<typeof visualTextHit> = null;
      container.addEventListener(
        "click",
        (event) => {
          result = visualTextHit(event, container, manifest);
        },
        { once: true },
      );
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX, clientY }));
      return result;
    };

    expect(hit(controlIcon, 110, 106)).toBeNull();
    expect(hit(page, 500, 106)).toBeNull();
    expect(hit(page, 95, 106)?.span).toBe(span);
    manifest.dispose();
  });

  it("uses only manifest spans from the clicked source run when a substring repeats", () => {
    const source = "\\begin{document}\nA unique geometry phrase.\n\ngeometry.\n\\end{document}\n";
    const host = document.createElement("div");
    const container = document.createElement("div");
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    const layer = document.createElement("div");
    layer.className = "textLayer";
    const anchor = document.createElement("span");
    anchor.textContent = "A unique geometry phrase.";
    const unrelated = document.createElement("span");
    // This token occurs in both source paragraphs, so the manifest correctly
    // leaves it read-only even though its raw text is contained by the anchor.
    unrelated.textContent = "geometry";
    layer.append(anchor, unrelated);
    page.append(layer);
    container.append(page);
    host.append(container);
    document.body.append(host);

    const manifest = createVisualEditManifest(container, source, [
      "A unique geometry phrase.",
      "geometry",
    ]);
    const entry = manifest.entryFor(anchor);
    expect(entry).not.toBeNull();
    expect(manifest.entryFor(unrelated)).toBeNull();

    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(5, 7, 900, 700));
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return this.startContainer === anchor.firstChild
        ? new DOMRect(25, 37, 200, 12)
        : new DOMRect(600, 400, 80, 12);
    });

    expect(
      measureDraftGeometry(container, { span: anchor, page, run: entry!.run }, manifest),
    ).toMatchObject({ left: 20, top: 30, width: 200, height: 12 });
    manifest.dispose();
  });
});
