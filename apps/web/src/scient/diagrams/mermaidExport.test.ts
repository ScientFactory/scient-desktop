// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  copyMermaidPng,
  diagramFileBaseName,
  downloadMermaidPng,
  mermaidMarkdownCopySource,
  prepareSvgForExport,
  mermaidSvgToPngBlob,
  svgRasterizationRefusal,
} from "./mermaidExport";

const { copyPngBlobToClipboard, downloadPresentationBlob } = vi.hoisted(() => ({
  copyPngBlobToClipboard: vi.fn(async (_blob: Blob) => undefined),
  downloadPresentationBlob: vi.fn((_blob: Blob, _fileName: string) => undefined),
}));

vi.mock("../presentation/loadCanvasImage", () => ({
  loadCanvasImage: vi.fn(async () => ({ naturalWidth: 40, naturalHeight: 20 })),
}));
vi.mock("../presentation/imageClipboard", () => ({ copyPngBlobToClipboard }));
vi.mock("../presentation/presentationExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../presentation/presentationExport")>()),
  downloadPresentationBlob,
}));

describe("diagram export helpers", () => {
  it("uses a stable, portable filename without discarding non-Latin titles", () => {
    expect(diagramFileBaseName("Research lifecycle.mmd")).toBe("Research-lifecycle");
    expect(diagramFileBaseName("תרשים ניסוי.svg")).toBe("תרשים-ניסוי");
    expect(diagramFileBaseName("***")).toBe("diagram");
    expect(diagramFileBaseName(null)).toBe("diagram");
  });

  it("preserves fence metadata and settled source in copied Markdown", () => {
    expect(
      mermaidMarkdownCopySource("flowchart LR\n  A --> B\n", "mermaid", 'title="study.mmd"'),
    ).toBe('```mermaid title="study.mmd"\nflowchart LR\n  A --> B\n```\n\n');
  });

  it("uses a longer fence when the diagram source contains triple backticks", () => {
    expect(mermaidMarkdownCopySource("flowchart LR\n  A[```]", "mermaid", undefined)).toBe(
      "````mermaid\nflowchart LR\n  A[```]\n````\n\n",
    );
  });

  it("makes exported SVG standalone and gives it the chosen appearance", () => {
    const exported = prepareSvgForExport('<svg viewBox="0 0 10 10"></svg>', "dark");
    expect(exported).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(exported).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(exported).toContain("color-scheme:dark");
    expect(exported).toContain("background:#171717");
  });

  // Mixed SVG/XHTML/MathML parsing, line breaks and actual PNG encoding are
  // asserted in svg-export-smoke.mjs: happy-dom does not model those namespaces.

  it.each(["", "<div>Not a diagram</div>", "<svg></svg><svg></svg>"])(
    "rejects a non-diagram export: %s",
    (source) => {
      expect(() => prepareSvgForExport(source, "light")).toThrow(/not an SVG/);
    },
  );
});

describe("diagram PNG export", () => {
  beforeEach(() => {
    // happy-dom has no 2D canvas; a stand-in encodes whatever was drawn.
    const context = { fillStyle: "", fillRect: () => undefined, drawImage: () => undefined };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
      callback(new Blob(["png"], { type: "image/png" })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    copyPngBlobToClipboard.mockClear();
    downloadPresentationBlob.mockClear();
  });

  const svg = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 20">${body}</svg>`;

  // Links never load anything when an SVG is drawn as an image; Mermaid emits
  // them for `click` directives and for links in labels.
  it.each([
    ["an anchor href", '<a href="https://example.com/docs"><text>Docs</text></a>'],
    ["an anchor xlink:href", '<a xlink:href="https://example.com/docs"><text>Docs</text></a>'],
    [
      "an HTML link in a label",
      '<foreignObject width="40" height="20"><div xmlns="http://www.w3.org/1999/xhtml"><a href="https://example.com">Docs</a></div></foreignObject>',
    ],
    ["an in-document reference", '<defs><path id="m" d="M0 0"/></defs><use href="#m"/>'],
    ["a fragment paint server", '<rect width="4" height="4" fill="url(#gradient)"/>'],
  ])("copies and downloads a diagram with %s", async (_label, body) => {
    await expect(mermaidSvgToPngBlob(svg(body), "light")).resolves.toBeInstanceOf(Blob);
    await copyMermaidPng(svg(body), "light");
    expect(copyPngBlobToClipboard).toHaveBeenCalledOnce();
    await downloadMermaidPng(svg(body), "Study flow", "dark");
    expect(downloadPresentationBlob).toHaveBeenCalledWith(expect.any(Blob), "Study-flow.png");
  });

  it.each([
    ["an SVG image", '<image href="https://example.invalid/plot.png"/>', /external image/],
    ["an xlink image", '<image xlink:href="plot.png"/>', /external image/],
    [
      "an HTML image in a label",
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://example.invalid/p.png"/></div></foreignObject>',
      /external image/,
    ],
    [
      "a filter image",
      '<filter id="f"><feImage href="https://example.invalid/p.png"/></filter>',
      /external image/,
    ],
    [
      "an external use",
      '<use href="https://example.invalid/sprite.svg#icon"/>',
      /external resource/,
    ],
    ["an external xlink use", '<use xlink:href="sprite.svg#icon"/>', /external resource/],
    [
      "a link wrapping an image",
      '<a href="https://example.com"><image href="https://example.invalid/p.png"/></a>',
      /external image/,
    ],
    [
      "an external paint server",
      '<rect width="4" height="4" style="fill:url(https://example.invalid/p.svg#g)"/>',
      /external resource/,
    ],
    [
      "a label background image",
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" style="background:url(https://example.invalid/p.png)">x</div></foreignObject>',
      /external resource/,
    ],
    ["an event handler", '<rect width="4" height="4" onclick="alert(1)"/>', /active content/],
    ["a script", "<script>alert(1)</script>", /external image/],
    [
      "an embedded object",
      '<foreignObject><object xmlns="http://www.w3.org/1999/xhtml" data="https://example.invalid/x"/></foreignObject>',
      /external image/,
    ],
    [
      "an embedded frame",
      '<foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://example.invalid/"/></foreignObject>',
      /external image/,
    ],
  ])("refuses %s before rasterizing", async (_label, body, message) => {
    await expect(mermaidSvgToPngBlob(svg(body), "light")).rejects.toThrow(message);
    await expect(copyMermaidPng(svg(body), "light")).rejects.toThrow(message);
    expect(copyPngBlobToClipboard).not.toHaveBeenCalled();
  });

  // happy-dom's HTML parser drops SVG <style> text, so these are checked on
  // the parsed SVG the rasterizer inspects rather than through the card's parse.
  it.each([
    ["a stylesheet import", "<style>@import url(https://example.invalid/theme.css);</style>"],
    ["a stylesheet image", "<style>.node{background:url(data:image/png;base64,AAAA)}</style>"],
  ])("refuses %s before rasterizing", (_label, body) => {
    const parsed = new DOMParser().parseFromString(svg(body), "image/svg+xml").documentElement;
    expect(svgRasterizationRefusal(parsed)).toMatch(/external stylesheet/);
    const fragmentOnly = new DOMParser().parseFromString(
      svg("<style>.node{fill:url(#gradient)}</style>"),
      "image/svg+xml",
    ).documentElement;
    expect(svgRasterizationRefusal(fragmentOnly)).toBeNull();
  });
});
