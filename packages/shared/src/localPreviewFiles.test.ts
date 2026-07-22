import { describe, expect, it } from "vitest";

import { isSupportedLocalHtmlPath } from "./localPreviewFiles";

describe("isSupportedLocalHtmlPath", () => {
  it.each(["lesson.html", "lesson.HTM", "/study/topics/heart.failure.html"])(
    "accepts an HTML document: %s",
    (path) => {
      expect(isSupportedLocalHtmlPath(path)).toBe(true);
    },
  );

  it.each(["lesson.md", "lesson.html.txt", "lesson", "/study/.html/lesson"])(
    "rejects a non-HTML document: %s",
    (path) => {
      expect(isSupportedLocalHtmlPath(path)).toBe(false);
    },
  );
});
