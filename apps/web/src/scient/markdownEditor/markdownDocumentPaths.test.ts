import { describe, expect, it } from "vite-plus/test";

import {
  ensureScientMarkdownDocumentPath,
  isScientMarkdownDocumentPath,
  shouldUseScientMarkdownEditor,
} from "./markdownDocumentPaths";

describe("Scient Markdown document paths", () => {
  it.each(["notes.md", "notes.MD", "notes.markdown", "notes.MARKDOWN"])(
    "recognizes %s as a plain Markdown document",
    (path) => expect(isScientMarkdownDocumentPath(path)).toBe(true),
  );

  it.each(["notes.mdx", "notes.txt", "notes.md.backup"])(
    "does not claim rich-editor fidelity for %s",
    (path) => expect(isScientMarkdownDocumentPath(path)).toBe(false),
  );

  it("keeps supported extensions and otherwise appends .md", () => {
    expect(ensureScientMarkdownDocumentPath("notes.markdown")).toBe("notes.markdown");
    expect(ensureScientMarkdownDocumentPath("notes")).toBe("notes.md");
  });

  it("uses the rich controller only for complete, editable, rendered plain Markdown", () => {
    const eligible = {
      path: "notes.markdown",
      readOnly: false,
      renderMarkdown: true,
      truncated: false,
    } as const;
    expect(shouldUseScientMarkdownEditor(eligible)).toBe(true);
    expect(shouldUseScientMarkdownEditor({ ...eligible, path: "notes.mdx" })).toBe(false);
    expect(shouldUseScientMarkdownEditor({ ...eligible, readOnly: true })).toBe(false);
    expect(shouldUseScientMarkdownEditor({ ...eligible, truncated: true })).toBe(false);
    expect(shouldUseScientMarkdownEditor({ ...eligible, renderMarkdown: false })).toBe(false);
  });
});
