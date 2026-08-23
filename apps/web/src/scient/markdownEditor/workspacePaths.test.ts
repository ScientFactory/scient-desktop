import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownSiblingPath, resolveWikiLinkPath } from "./workspacePaths";

describe("Markdown workspace paths", () => {
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
});
