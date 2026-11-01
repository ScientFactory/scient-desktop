import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { resolveMarkdownFileLinkTarget } from "@t3tools/shared/markdownLinks";
import { describe, expect, it } from "vite-plus/test";

import { markdownFileLinkRelativeCopyPath, resolveMarkdownFileLinkMeta } from "./markdown-links";

describe("resolveMarkdownFileLinkTarget", () => {
  // regression: ce96ad0b61 UI fixes
  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  // regression: ce96ad0b61 UI fixes
  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  // regression: 166bce0389 Feature/intellij editors (#2475)
  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  // regression: ce96ad0b61 UI fixes
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  // regression: 99960383d0 fix: open agent file links in the file viewer (#8098)
  it.each(["md", "html", "xml"])(
    "resolves a bare spaced .%s filename from the markdown renderer",
    (extension) => {
      const href = renderMarkdownLinkHref(`[checklist](<Updated cutover checklist.${extension}>)`);

      expect(href).toBe(`Updated%20cutover%20checklist.${extension}`);
      expect(resolveMarkdownFileLinkMeta(href, "/repo/project")).toMatchObject({
        targetPath: `/repo/project/Updated cutover checklist.${extension}`,
        workspaceRelativePath: `Updated cutover checklist.${extension}`,
        basename: `Updated cutover checklist.${extension}`,
      });
    },
  );

  // regression: 8faf031c2d fix(web): respect case in POSIX file links (#9309)
  it.each([
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/file.ts", "c:/", "Users/MIKE/file.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts%20", "/tmp/repo", "file.ts "],
  ])("preserves the preview target for %s in workspace %s", (href, cwd, workspaceRelativePath) => {
    expect(resolveMarkdownFileLinkMeta(href, cwd)).toMatchObject({ workspaceRelativePath });
  });

  // regression: aa5a144d04 small nits
  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  // regression: ce96ad0b61 UI fixes
  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  // regression: ce96ad0b61 UI fixes
  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("//cdn.example.com/clip.mp4", "/workspace")).toBeNull();
  });

  // regression: aa5a144d04 small nits
  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  // regression: 29f4ebb106 chore(upstream): align with t3code 2c8bdf6177
  it("resolves file uri authorities only within the owning Windows workspace share", () => {
    expect(
      resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg", "\\\\server\\share"),
    ).toBe("\\\\server\\share\\workspace-image.svg");
    expect(resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg")).toBeNull();
    expect(
      resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg", "C:\\workspace"),
    ).toBeNull();
    expect(
      resolveMarkdownFileLinkTarget(
        "file://another-server/share/workspace-image.svg",
        "\\\\server\\share",
      ),
    ).toBeNull();
  });

  // regression: 68061af042 Improve markdown file link UX (#1956)
  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath:
        "t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
      workspaceRelativePath:
        "apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  // regression: 166bce0389 Feature/intellij editors (#2475)
  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  // regression: 922bd69225 refactor(media): unify file and media previews across clients (#9253)
  it("decodes an encoded drive colon in a file uri before dropping its slash", () => {
    expect(resolveMarkdownFileLinkTarget("file:///c%3A/Users/x/shot.png")).toBe(
      "c:/Users/x/shot.png",
    );
  });
});

describe("markdownFileLinkRelativeCopyPath", () => {
  const relativeCopyPath = (href: string, cwd: string) => {
    const meta = resolveMarkdownFileLinkMeta(href, cwd);
    if (!meta) throw new Error(`unresolved link ${href}`);
    return markdownFileLinkRelativeCopyPath(meta);
  };

  // regression: efacdaf575 chore(upstream): align T3 through 35be904f2f with Scient native Codex policy
  it("copies workspace root links as the root directory", () => {
    expect(relativeCopyPath("/workspace/project", "/workspace/project")).toBe(".");
    expect(relativeCopyPath("docs/..", "/workspace/project")).toBe(".");
  });
});

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
