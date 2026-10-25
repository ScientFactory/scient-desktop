import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownLinkPresentation } from "./markdownLinks";

// regression: 8b5034cf61 fix(mobile): preserve stored thread link navigation
describe("resolveMarkdownLinkPresentation thread links", () => {
  it.each(["t3-thread://v1/thread-1", "t3-thread://v1/remote/thread%252F1"])(
    "preserves valid current and saved thread link %s for native dispatch",
    (href) => {
      expect(resolveMarkdownLinkPresentation(href)).toEqual({ kind: "link", href });
    },
  );

  it("does not expose malformed thread links as native press targets", () => {
    expect(resolveMarkdownLinkPresentation("t3-thread://v1/remote/thread-1/extra")).toEqual({
      kind: "link",
      href: null,
    });
  });
});
