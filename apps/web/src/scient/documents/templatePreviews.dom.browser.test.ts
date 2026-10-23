import { describe, expect, it, vi } from "vite-plus/test";

import {
  builtInPreviewReference,
  captureVisualPage,
  sanitizePage,
  templatePicture,
} from "./templatePreviews";

describe("template pictures", () => {
  it("shows each built-in template's typeset page, and a copy's until it is updated", async () => {
    await using _fixture = _createFixture();

    expect(templatePicture("article", null)).toMatchObject({ kind: "image" });
    expect(templatePicture("no-such-template", null)).toBeNull();
    expect(templatePicture(null, null)).toBeNull();
    expect(builtInPreviewReference("thesis")).toBe("builtin:thesis");
    expect(templatePicture(null, "builtin:thesis")).toEqual(templatePicture("thesis", null));
  });

  it("keeps a page as drawn but nothing that runs, loads, edits or takes focus", async () => {
    await using _fixture = _createFixture();

    const stored =
      '<div data-page-width="816" data-page-height="1056">' +
      '<div class="scient-latex-page-stage" id="stage" style="width: 816px">' +
      '<p contenteditable="true" tabindex="0" onclick="alert(1)">Weekly notes</p>' +
      '<a href="javascript:alert(1)">link</a><span onerror="alert(1)">x</span>' +
      "<script>alert(1)</script><iframe></iframe>" +
      "</div></div>";
    const picture = templatePicture(null, stored);
    expect(picture).toMatchObject({ kind: "page", width: 816, height: 1056 });
    const html = picture?.kind === "page" ? picture.html : "";
    expect(html).toContain("Weekly notes");
    expect(html).toContain('style="width: 816px"');
    for (const unsafe of [
      "onclick",
      "onerror",
      "javascript:",
      "<script",
      "<iframe",
      "contenteditable",
      "tabindex",
      'id="stage"',
    ])
      expect(html).not.toContain(unsafe);
  });

  it("keeps durable raster figures and drops transient URLs and loading styles", async () => {
    await using _fixture = _createFixture();

    const picture = templatePicture(
      null,
      '<div data-page-width="816" data-page-height="1056">' +
        '<img src="https://assets.test/figure?token=expires" srcset="https://assets.test/large 2x">' +
        '<img src="data:image/png;base64,AAAA"><div style="background-image: url(https://assets.test/image)"></div>' +
        '<svg><use href="https://assets.test/external.svg#image"/></svg></div>',
    );
    const html = picture?.kind === "page" ? picture.html : "";
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).not.toContain("https:");
    expect(html).not.toContain("srcset");
  });

  it("recovers a tainted displayed figure as durable pixels", async () => {
    await using _fixture = _createFixture();

    const stage = document.createElement("div");
    stage.className = "scient-latex-page-stage";
    stage.style.width = "816px";
    const url = new URL("/test/fixtures/assets/0001.png", window.location.href);
    stage.innerHTML = `<div class="scient-latex-visual-paper"><img src="${url.href}"></div>`;
    document.body.append(stage);
    _fixture.cleanup.defer(() => stage.remove());
    const image = stage.querySelector("img")!;
    await image.decode();
    // The isolated harness blocks cross-origin images before canvas access.
    // Inject only that security failure; the recovery decodes and re-encodes real PNG bytes.
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementationOnce(() => {
      throw new DOMException("The canvas is tainted", "SecurityError");
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    const close = vi.spyOn(ImageBitmap.prototype, "close");
    try {
      const captured = await captureVisualPage();
      expect(fetch).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(encode).toHaveBeenCalledTimes(2);
      expect(captured).toContain("data:image/png;base64,");
      const decoded = new Image();
      const fragment = document.createElement("div");
      fragment.innerHTML = captured!;
      decoded.src = fragment.querySelector("img")!.src;
      await decoded.decode();
      expect(decoded.naturalWidth).toBe(16);
      expect(decoded.naturalHeight).toBe(16);
      expect(captured).not.toContain(url.origin);
      expect(captured).not.toContain("https:");
    } finally {
      stage.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("keeps no style or attribute that can fetch a resource", async () => {
    await using _fixture = _createFixture();

    const element = document.createElement("div");
    element.innerHTML =
      '<p style="width: 10px; background-image: image-set(&quot;https://attacker.example/a.png&quot; 1x)">a</p>' +
      '<p style="background: u\\72l(https://attacker.example/b.png); color: red">b</p>' +
      '<p style="--x: url(https://attacker.example/c.png)">c</p>' +
      '<svg><rect fill="url(https://attacker.example/d.svg#p)"></rect><rect fill="url(#local)"></rect>' +
      '<rect fill="u\\72l(https://attacker.example/e.svg#p)"></rect>' +
      '<rect filter="url(#local) url(https://attacker.example/f.svg#p)"></rect></svg>' +
      '<p style="width: 10px">d</p>';
    sanitizePage(element);
    const html = element.innerHTML;
    expect(html).not.toContain("attacker.example");
    expect(html).toContain("width: 10px");
    expect(html).toContain('fill="url(#local)"');
  });

  it("refuses a stored page without its size", async () => {
    await using _fixture = _createFixture();

    expect(templatePicture(null, "<div><p>Text</p></div>")).toBeNull();
    const element = document.createElement("div");
    element.innerHTML = '<b onmouseover="x()">bold</b>';
    sanitizePage(element);
    expect(element.innerHTML).toBe("<b>bold</b>");
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
