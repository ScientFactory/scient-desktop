import { describe, expect, it } from "vite-plus/test";

import {
  markdownWikiTargetForPath,
  resolveMarkdownSiblingPath,
  resolveMarkdownUrlPath,
  resolveWikiLinkPath,
} from "./workspacePaths";

describe("Markdown workspace paths", () => {
  it.each([
    ["Other%20notes.md", "notes/Other notes.md", ""],
    ["%D7%A9%D7%9C%D7%95%D7%9D.md#heading", "notes/שלום.md", "#heading"],
    ["100%25.md", "notes/100%.md", ""],
    ["hash%23name.md?query#fragment", "notes/hash#name.md", "?query#fragment"],
    ["literal%2520.md", "notes/literal%20.md", ""],
  ])("decodes a URL pathname once: %s", (href, relativePath, suffix) => {
    expect(resolveMarkdownUrlPath("notes/result.md", href)).toEqual({ relativePath, suffix });
  });

  it.each([
    "%ZZ.md",
    "%2Fetc/passwd",
    "%2e%2e/%2e%2e/secret",
    "%00.md",
    "file%3Asecret",
    "#heading",
  ])("rejects unsafe URL destinations: %s", (href) => {
    expect(resolveMarkdownUrlPath("notes/result.md", href)).toBeNull();
  });

  it("does not decode literal wiki filenames", () => {
    expect(resolveWikiLinkPath("notes/result.md", "100%20literal")).toBe("notes/100%20literal.md");
  });
  it("resolves portable sibling assets and wiki links", () => {
    expect(resolveMarkdownSiblingPath("notes/result.md", "../figures/cell.png")).toBe(
      "figures/cell.png",
    );
    expect(resolveMarkdownSiblingPath("notes/result.md", "./img/a.png#panel-b")).toBe(
      "notes/img/a.png#panel-b",
    );
    expect(resolveWikiLinkPath("notes/result.md", "Methods/Protocol#setup")).toBe(
      "notes/Methods/Protocol.md",
    );
  });

  it("rejects paths that escape the workspace or delegate to a URL scheme", () => {
    expect(resolveMarkdownSiblingPath("result.md", "../secret.png")).toBeNull();
    expect(resolveMarkdownSiblingPath("result.md", "/absolute.png")).toBeNull();
    expect(resolveMarkdownSiblingPath("result.md", "file:///tmp/a.png")).toBeNull();
    expect(resolveWikiLinkPath("result.md", "#local-heading")).toBeNull();
  });

  it("builds portable wiki targets relative to the authored document", () => {
    expect(markdownWikiTargetForPath("notes/result.md", "notes/Methods/Protocol.md")).toBe(
      "Methods/Protocol",
    );
    expect(markdownWikiTargetForPath("notes/result.md", "Overview.md")).toBe("../Overview");
    expect(markdownWikiTargetForPath("result.md", "result.md")).toBe("result");
    expect(markdownWikiTargetForPath("result.md", "notes/archive.markdown")).toBe(
      "notes/archive.markdown",
    );
    expect(markdownWikiTargetForPath("result.md", "images/plot.png")).toBeNull();
    expect(markdownWikiTargetForPath("result.md", "../outside.md")).toBeNull();
  });
});
