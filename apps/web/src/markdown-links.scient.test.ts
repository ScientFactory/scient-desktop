import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import {
  extractMarkdownLinkHrefs,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import { describe, expect, it } from "vite-plus/test";

import {
  markdownFileLinkRelativeCopyPath,
  markdownLinkLookupKey,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
} from "./markdown-links";

function renderMarkdownLinkHref(markdown: string): string | undefined {
  let renderedHref: string | undefined;
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        components: {
          a({ href }) {
            renderedHref = href;
            return createElement("a", { href });
          },
        },
      },
      markdown,
    ),
  );
  return renderedHref;
}

describe("relative file destinations with punctuation and Unicode", () => {
  // regression: 2c696eb6f9 fix(files): open relative links with Unicode and punctuation
  it.each(["סיכום.md", "Folder (draft)/Study [final].md"])(
    "resolves the rendered href for %s in its workspace",
    (path) => {
      const href = renderMarkdownLinkHref(`[Open file](<${path}>)`);
      expect(href).toBeDefined();
      expect(resolveMarkdownFileLinkTarget(href!, "/work")).toBe(`/work/${path}`);
    },
  );
});

describe("spaced links from the markdown renderer", () => {
  it("resolves relative spaced folders", () => {
    const href = renderMarkdownLinkHref("[folder](<docs/My Folder>)");

    expect(href).toBe("docs/My%20Folder");
    expect(resolveMarkdownFileLinkMeta(href, "/repo/project")).toMatchObject({
      targetPath: "/repo/project/docs/My Folder",
      workspaceRelativePath: "docs/My Folder",
      basename: "My Folder",
    });
  });

  // regression: 99960383d0 fix: open agent file links in the file viewer (#8098)
  it("resolves a bare spaced filename", () => {
    const href = renderMarkdownLinkHref("[checklist](<Updated cutover checklist.html>)");

    expect(href).toBe("Updated%20cutover%20checklist.html");
    expect(resolveMarkdownFileLinkMeta(href, "/repo/project")).toMatchObject({
      targetPath: "/repo/project/Updated cutover checklist.html",
      workspaceRelativePath: "Updated cutover checklist.html",
      basename: "Updated cutover checklist.html",
    });
  });
});

describe("local chat links", () => {
  it("extracts ordinary and angle-bracketed destinations containing spaces", () => {
    expect(
      extractMarkdownLinkHrefs(
        '[figure](/tmp/figure.svg) and [report](</Users/scient/My Results/report.pdf> "PDF")',
      ),
    ).toEqual(["/tmp/figure.svg", "/Users/scient/My Results/report.pdf"]);
  });

  it("matches an angle-bracket path before and after React Markdown encodes its spaces", () => {
    expect(markdownLinkLookupKey("</Users/scient/My Results/report.pdf>")).toBe(
      markdownLinkLookupKey("/Users/scient/My%20Results/report.pdf"),
    );
  });

  it("resolves links from an external document without assigning them to its thread workspace", () => {
    expect(
      resolveMarkdownFileLinkMeta("figure.svg", "/tmp/report-pack", "/tmp/report-pack", null),
    ).toMatchObject({
      filePath: "/tmp/report-pack/figure.svg",
      workspaceRelativePath: null,
      workspaceLookupPath: null,
    });
    expect(
      resolveInlineCodeFileLinkMeta(
        "./data/results.csv",
        "/tmp/report-pack",
        "/tmp/report-pack",
        null,
      ),
    ).toMatchObject({
      filePath: "/tmp/report-pack/data/results.csv",
      workspaceRelativePath: null,
      workspaceLookupPath: null,
    });
  });
});

// regression: 79d741c351 fix(files): open the file a link means, wherever it lives
describe("links that climb out of the workspace", () => {
  it("name the host file they point to, not a workspace path starting with ..", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "../reviews/document-editing/notes.md",
        "/Users/me/ScientFactory",
      ),
    ).toMatchObject({
      filePath: "/Users/me/reviews/document-editing/notes.md",
      targetPath: "/Users/me/reviews/document-editing/notes.md",
      workspaceRelativePath: null,
      basename: "notes.md",
    });
    expect(
      resolveMarkdownFileLinkMeta(
        "/Users/me/ScientFactory/../notes.md:7",
        "/Users/me/ScientFactory",
      ),
    ).toMatchObject({
      filePath: "/Users/me/notes.md",
      targetPath: "/Users/me/notes.md:7",
      workspaceRelativePath: null,
      line: 7,
    });
  });

  it("stay workspace files when the dot segments resolve back inside", () => {
    expect(
      resolveMarkdownFileLinkMeta("../ScientFactory/reviews/notes.md", "/Users/me/ScientFactory"),
    ).toMatchObject({
      filePath: "/Users/me/ScientFactory/reviews/notes.md",
      workspaceRelativePath: "reviews/notes.md",
    });
  });

  it("resolve against a rendered file's own directory", () => {
    expect(
      resolveMarkdownFileLinkMeta("../../notes.md", "/repo", "/repo/docs", "/repo"),
    ).toMatchObject({ filePath: "/notes.md", workspaceRelativePath: null });
  });
});

describe("a POSIX workspace whose name ends in a backslash", () => {
  // regression: e210e19f5e fix(files): keep POSIX folder names when joining paths
  it("keeps a plain relative link inside that workspace", () => {
    expect(resolveMarkdownFileLinkMeta("notes.txt", "/tmp/project\\")).toMatchObject({
      filePath: "/tmp/project\\/notes.txt",
      workspaceRelativePath: "notes.txt",
    });
  });
});

// regression: d75449ca1d fix(files): reliable copy paths and calm file-failure states (#400)
describe("markdownFileLinkRelativeCopyPath", () => {
  const relativeCopyPath = (href: string, cwd: string) => {
    const meta = resolveMarkdownFileLinkMeta(href, cwd);
    if (!meta) throw new Error(`unresolved link ${href}`);
    return markdownFileLinkRelativeCopyPath(meta);
  };

  it("copies the workspace-relative path, not the workspace-prefixed label", () => {
    expect(relativeCopyPath("docs/report.md", "/workspace/project")).toBe("docs/report.md");
    expect(relativeCopyPath("/workspace/project/report.md", "/workspace/project")).toBe(
      "report.md",
    );
    expect(relativeCopyPath("docs/My%20Folder/a%20b.md", "/workspace/project")).toBe(
      "docs/My Folder/a b.md",
    );
  });

  it("keeps the link's line and column", () => {
    expect(relativeCopyPath("src/main.ts:12:4", "/workspace/project")).toBe("src/main.ts:12:4");
    expect(
      relativeCopyPath(
        "file:///C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("apps/web/src/session-logic.ts:501");
  });

  it("has no relative path for a file outside the workspace", () => {
    expect(relativeCopyPath("/tmp/report.md", "/workspace/project")).toBeNull();
    expect(relativeCopyPath("../outside.md:12", "/workspace/project")).toBeNull();
    expect(relativeCopyPath("/workspace/project/../outside.md", "/workspace/project")).toBeNull();
    expect(relativeCopyPath("C:/repo/../other/a.ts", "C:/repo")).toBeNull();
  });

  it("collapses dot segments that stay inside the workspace", () => {
    expect(relativeCopyPath("../project/report.md:12", "/workspace/project")).toBe("report.md:12");
    expect(relativeCopyPath("C:/repo/../repo/src/a.ts", "C:/repo")).toBe("src/a.ts");
    expect(relativeCopyPath("docs/../src/./main.ts:3", "/workspace/project")).toBe("src/main.ts:3");
    expect(relativeCopyPath("./docs/report.md", "/workspace/project")).toBe("docs/report.md");
  });
});

// regression: 585c51cd10 fix(files): let the host place home-relative links
describe("home-relative file links", () => {
  it("keeps the authored spelling so the environment that owns the files can place it", () => {
    expect(resolveMarkdownFileLinkMeta("~/notes/today.md:12", "/srv/project")).toMatchObject({
      homeRelativePath: "~/notes/today.md",
      line: 12,
    });
    expect(
      resolveMarkdownFileLinkMeta("~/My%20Notes.md", "/Users/ada/project")?.homeRelativePath,
    ).toBe("~/My Notes.md");
    expect(resolveMarkdownFileLinkMeta("notes/today.md", "/srv/project")).not.toHaveProperty(
      "homeRelativePath",
    );
  });

  it("looks up inline workspace basenames without guessing a home-relative root", () => {
    expect(resolveInlineCodeFileLinkMeta("user.ts:12", "/workspace")?.workspaceLookupPath).toBe(
      "user.ts",
    );
    expect(
      resolveInlineCodeFileLinkMeta("src/user.ts:12", "/workspace", "/workspace/docs")
        ?.workspaceLookupPath,
    ).toBe("src/user.ts");
    expect(
      resolveInlineCodeFileLinkMeta("~/user.ts:12", "/workspace")?.workspaceLookupPath,
    ).toBeNull();
    expect(
      resolveMarkdownFileLinkMeta("~/user.ts:12", "/workspace")?.workspaceLookupPath,
    ).toBeNull();
  });
});
