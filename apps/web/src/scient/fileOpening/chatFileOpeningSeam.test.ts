// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat/view seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const chatMarkdownSource = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);
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
    // Every click asks the environment what the link means before opening.
    expect(chatMarkdownSource).toContain("const plan = await planFileLinkOpen(panelPath);");
    expect(chatMarkdownSource).toContain(
      '.openFile(threadRef, plan.kind === "resolved" ? plan.path : panelPath, line);',
    );
    expect(chatMarkdownSource).toContain(
      "!canPreviewMedia && isAbsolutePath(fileLinkMeta.filePath)",
    );
    // Outside media links resolve like other links, then open in the media viewer.
    expect(chatMarkdownSource).toContain("openMarkdownMediaLink(mediaPath, fileLinkMeta.filePath)");
    expect(chatMarkdownSource).toContain("openMarkdownMedia(mediaPath, filePath);");
  });

  it("routes HTML through the integrated Browser with an explicit document capability", () => {
    expect(chatMarkdownSource).toContain(
      "openHtmlLinkInBrowser(fileLinkMeta.filePath, browserRelativePath)",
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
