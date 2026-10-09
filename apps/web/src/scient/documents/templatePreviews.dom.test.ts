// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import { builtInPreviewReference, sanitizePage, templatePicture } from "./templatePreviews";

describe("template pictures", () => {
  it("shows each built-in template's typeset page, and a copy's until it is updated", () => {
    expect(templatePicture("article", null)).toMatchObject({ kind: "image" });
    expect(templatePicture("no-such-template", null)).toBeNull();
    expect(templatePicture(null, null)).toBeNull();
    expect(builtInPreviewReference("thesis")).toBe("builtin:thesis");
    expect(templatePicture(null, "builtin:thesis")).toEqual(templatePicture("thesis", null));
  });

  it("keeps a page as drawn but nothing that runs, loads, edits or takes focus", () => {
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

  it("keeps durable raster figures and drops transient URLs and loading styles", () => {
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

  it("refuses a stored page without its size", () => {
    expect(templatePicture(null, "<div><p>Text</p></div>")).toBeNull();
    const element = document.createElement("div");
    element.innerHTML = '<b onmouseover="x()">bold</b>';
    sanitizePage(element);
    expect(element.innerHTML).toBe("<b>bold</b>");
  });
});
