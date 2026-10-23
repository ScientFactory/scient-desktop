import { describe, expect, it, vi } from "vite-plus/test";

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

vi.mock("../presentation/imageClipboard", () => ({ copyPngBlobToClipboard }));
vi.mock("../presentation/presentationExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../presentation/presentationExport")>()),
  downloadPresentationBlob,
}));

describe("diagram export helpers", () => {
  it("uses a stable, portable filename without discarding non-Latin titles", async () => {
    await using _fixture = _createFixture();

    expect(diagramFileBaseName("Research lifecycle.mmd")).toBe("Research-lifecycle");
    expect(diagramFileBaseName("תרשים ניסוי.svg")).toBe("תרשים-ניסוי");
    expect(diagramFileBaseName("***")).toBe("diagram");
    expect(diagramFileBaseName(null)).toBe("diagram");
  });

  it("preserves fence metadata and settled source in copied Markdown", async () => {
    await using _fixture = _createFixture();

    expect(
      mermaidMarkdownCopySource("flowchart LR\n  A --> B\n", "mermaid", 'title="study.mmd"'),
    ).toBe('```mermaid title="study.mmd"\nflowchart LR\n  A --> B\n```\n\n');
  });

  it("uses a longer fence when the diagram source contains triple backticks", async () => {
    await using _fixture = _createFixture();

    expect(mermaidMarkdownCopySource("flowchart LR\n  A[```]", "mermaid", undefined)).toBe(
      "````mermaid\nflowchart LR\n  A[```]\n````\n\n",
    );
  });

  it("makes exported SVG standalone and gives it the chosen appearance", async () => {
    await using _fixture = _createFixture();

    const exported = prepareSvgForExport('<svg viewBox="0 0 10 10"></svg>', "dark");
    expect(exported).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(exported).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(exported).toContain("color-scheme:dark");
    expect(exported).toContain("background:#171717");
  });

  it.each(["", "<div>Not a diagram</div>", "<svg></svg><svg></svg>"])(
    "rejects a non-diagram export: %s",
    async (source) => {
      await using _fixture = _createFixture();

      expect(() => prepareSvgForExport(source, "light")).toThrow(/not an SVG/);
    },
  );
});

describe("diagram PNG export", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    copyPngBlobToClipboard.mockClear();
    downloadPresentationBlob.mockClear();
  }

  async function _cleanupFixture1(_fixture: _Fixture) {
    vi.restoreAllMocks();
    copyPngBlobToClipboard.mockClear();
    downloadPresentationBlob.mockClear();
  }

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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const blob = await mermaidSvgToPngBlob(svg(body), "light");
    expect(blob.type).toBe("image/png");
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await expect(mermaidSvgToPngBlob(svg(body), "light")).rejects.toThrow(message);
    await expect(copyMermaidPng(svg(body), "light")).rejects.toThrow(message);
    expect(copyPngBlobToClipboard).not.toHaveBeenCalled();
  });

  it.each([
    ["a stylesheet import", "<style>@import url(https://example.invalid/theme.css);</style>"],
    ["a stylesheet image", "<style>.node{background:url(data:image/png;base64,AAAA)}</style>"],
  ])("refuses %s before rasterizing", async (_label, body) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const parsed = new DOMParser().parseFromString(svg(body), "image/svg+xml").documentElement;
    expect(svgRasterizationRefusal(parsed)).toMatch(/external stylesheet/);
    const fragmentOnly = new DOMParser().parseFromString(
      svg("<style>.node{fill:url(#gradient)}</style>"),
      "image/svg+xml",
    ).documentElement;
    expect(svgRasterizationRefusal(fragmentOnly)).toBeNull();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
