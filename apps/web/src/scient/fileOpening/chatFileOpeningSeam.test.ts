// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat/view seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

// ChatMarkdown mounts the link-opening hooks; the hooks hold the click flow.
const chatMarkdownSource = [
  NodeFS.readFileSync(new URL("../../components/ChatMarkdown.tsx", import.meta.url), "utf8"),
  NodeFS.readFileSync(new URL("./useChatFileLinkOpening.ts", import.meta.url), "utf8"),
].join("\n");
const chatViewSource = NodeFS.readFileSync(
  new URL("../../components/ChatView.tsx", import.meta.url),
  "utf8",
);
const environmentPreviewSource = NodeFS.readFileSync(
  new URL("./EnvironmentFilePreview.tsx", import.meta.url),
  "utf8",
);
const htmlPreviewSource = NodeFS.readFileSync(
  new URL("./openEnvironmentFileInPreview.ts", import.meta.url),
  "utf8",
);

describe("universal chat-file opening seam", () => {
  it("uses the file surface for workspace and readable host files while preserving media preview", () => {
    expect(chatMarkdownSource).toContain("onOpenInPanel(panelPath, line);");
    // Every click asks the environment what the link means before opening,
    // within a bounded wait, and yields to a newer click or panel action.
    expect(chatMarkdownSource).toContain("await settleWithin(");
    expect(chatMarkdownSource.match(/if \(!isCurrentClick\(\)\) return/gu)).toHaveLength(3);
    // A workspace locator is asked about as that location; only a link
    // authored from the home folder is asked about by its `~/` spelling.
    expect(chatMarkdownSource).toContain(
      "authoredHomeRelative ? panelPath : workspaceLocatorAskPath(panelPath, cwd),",
    );
    expect(chatMarkdownSource).toContain(
      "authoredHomeRelative ? clientPlacedLinkPath(panelPath, cwd) : panelPath,",
    );
    expect(chatMarkdownSource).toContain(
      "homeRelativePath !== undefined ? openHomeRelativeLinkInPanel : openFileInPanel",
    );
    // A resolved link opens the file it meant; any other answer opens the
    // link where it is. Nothing is announced: the tab shows which file it is.
    expect(chatMarkdownSource).toContain(
      '.openFile(threadRef, plan.kind === "resolved" ? plan.path : location, line);',
    );
    expect(chatMarkdownSource).not.toContain("Link resolved to");
    expect(chatMarkdownSource).toContain(
      "(!canPreviewMedia && isAbsolutePath(fileLinkMeta.filePath)",
    );
    // A home-relative link is never placed by the client's guess: media asks
    // through its media action, everything else through the panel action.
    expect(chatMarkdownSource).toMatch(
      /homeRelativePath !== undefined\s+\? canPreviewMedia\s+\? null\s+: homeRelativePath/u,
    );
    // Outside media links resolve like other links, then open in the media viewer.
    expect(chatMarkdownSource).toContain(
      "openMarkdownMediaLink(mediaPath, fileLinkMeta.filePath, homeRelativePath)",
    );
    expect(chatMarkdownSource).toContain("openMarkdownMedia(mediaPath, filePath);");
  });

  it("routes HTML through the integrated Browser with an explicit document capability", () => {
    expect(chatMarkdownSource).toContain(
      "openHtmlLinkInBrowser(\n                    fileLinkMeta.filePath,\n                    browserRelativePath,\n                    homeRelativePath,",
    );
    expect(chatMarkdownSource).toContain(
      'resolveWorkspaceFileLinkOpenTarget(fileLinkMeta.filePath) === "browser"',
    );
    expect(chatMarkdownSource).toContain("shouldUseMarkdownFileBrowserPrimaryAction({");
    expect(
      chatMarkdownSource.match(/handleOpenInFilePreview\(\);/gu)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(htmlPreviewSource).toContain('access: "html-document"');
    expect(htmlPreviewSource).toContain("openUrlInPreview({");
  });

  it("keeps the explicit Scient environment-file surface read-only", () => {
    expect(chatViewSource).toContain(
      '() => import("../scient/fileOpening/EnvironmentFilePreview")',
    );
    expect(chatViewSource.match(/<EnvironmentFilePreview/gu)).toHaveLength(1);
    expect(environmentPreviewSource).toContain("useEnvironmentFileRefresh({");
    expect(environmentPreviewSource).toContain("fileLinkWorkspaceRoot={null}");
    expect(environmentPreviewSource).not.toContain("projects.writeFile");
  });
});
