// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited file-panel seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const panelSource = NodeFS.readFileSync(
  new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
  "utf8",
);
const surfaceSource = NodeFS.readFileSync(
  new URL("./ScientMarkdownFileSurface.tsx", import.meta.url),
  "utf8",
);
const workspaceSource = NodeFS.readFileSync(
  new URL("./ScientMarkdownWorkspaceSurface.tsx", import.meta.url),
  "utf8",
);
const browserSource = NodeFS.readFileSync(
  new URL("../../components/files/FileBrowserPanel.tsx", import.meta.url),
  "utf8",
);
const chatViewSource = NodeFS.readFileSync(
  new URL("../../components/ChatView.tsx", import.meta.url),
  "utf8",
);
const rightPanelTabsSource = NodeFS.readFileSync(
  new URL("../../components/RightPanelTabs.tsx", import.meta.url),
  "utf8",
);

describe("Scient Markdown file-preview seam", () => {
  it("lazily mounts one owned plain-Markdown editor while retaining T3's MDX preview", () => {
    expect(panelSource).toContain('import("~/scient/markdownEditor/ScientMarkdownFileSurface")');
    expect(panelSource.match(/<ScientMarkdownFileSurface\b/gu)).toHaveLength(1);
    expect(panelSource.match(/<ScientMarkdownSaveStatus\b/gu)).toHaveLength(1);
    expect(panelSource).toContain("isScientMarkdownDocumentPath(relativePath)");
    expect(panelSource).toContain("isMarkdownDocument && renderMarkdown");
    expect(panelSource).toContain("RenderedMarkdownSurface");
    expect(panelSource).toContain("<FileMarkdownPreview");
    expect(panelSource).not.toContain("<ChatMarkdown");
    expect(panelSource).toContain("shouldUseScientMarkdownEditor({");
    expect(panelSource).toContain("readOnly: file.data.readOnly ?? false");
    expect(panelSource).toContain("file.data.readOnly ? (");
    expect(panelSource).toContain("isMarkdownDocument && renderMarkdown ? (");
    expect(panelSource).toContain("readOnly={false}");
  });

  it("keeps parsing, editor state, and persistence policy out of the inherited panel", () => {
    expect(panelSource).not.toMatch(/ProseMirror|CodeMirror|MarkdownSaveQueue|MarkdownParser/gu);
    expect(surfaceSource).toContain("projectEnvironment.writeFile");
    expect(surfaceSource).toContain("expectedRevision: intent.expectedRevision");
    expect(surfaceSource).toContain("setProjectFileQueryData(props.environmentId");
    expect(surfaceSource).toContain("confirmProjectFileQueryData(");
    expect(panelSource).toContain("authoritativeSnapshot={markdownAuthoritativeSnapshot}");
    expect(surfaceSource).toContain("authoritativeSnapshot={props.authoritativeSnapshot}");
    expect(surfaceSource.match(/onOpenLink=\{handleOpenLink\}/gu)).toHaveLength(1);
  });

  it("carries the existing conflict-resolution and line-reveal seams into the owned editor", () => {
    for (const prop of [
      "saveResolution={",
      "onSaveResolutionApplied={handleSaveResolutionApplied}",
      "revealLine={revealLine}",
      "revealRequestId={revealRequestId}",
    ]) {
      expect(panelSource).toContain(prop);
    }
  });

  it("keeps one rendered surface that is always editable, toggled only by the eye switch", () => {
    expect(panelSource).toContain('"Show markdown source"');
    expect(panelSource).toContain('"Show rendered markdown"');
    expect(panelSource).not.toContain("PenLine");
    expect(panelSource).not.toContain("editChrome=");
    expect(panelSource).toContain("renderMarkdown ?");
    expect(panelSource).not.toContain('aria-label="Markdown mode"');
    expect(panelSource).toContain('const RENDER_MARKDOWN_STORAGE_KEY = "t3code.renderMarkdown";');
    expect(panelSource).toContain("runAfterPendingSave([relativePath], apply);");
    for (const retired of ['value="write"', 'value="read"', 'value="split"', 'value="source"']) {
      expect(panelSource).not.toContain(retired);
    }
  });

  it("keeps pending-save policy in one owned adapter instead of inherited tabs", () => {
    expect(chatViewSource).toContain('from "~/scient/fileSurfaces/usePendingSurfaceDeparture";');
    expect(chatViewSource).toContain("useActivePendingSurfaceDeparture({");
    expect(chatViewSource).toContain("usePendingSurfaceNavigationBlocker(pendingFileSurfaceIds);");
    expect(rightPanelTabsSource).not.toMatch(
      /usePendingSurface|pendingSurfaceBlocks|Finishing the file save/gu,
    );
    expect(chatViewSource).toContain("const openFileSourceSurfaceNow = useCallback(");
    expect(chatViewSource).toContain("const openFileSurfaceNow = useScientFileOpening({");
    expect(chatViewSource).toMatch(
      /const openFileSurface = useCallback\([\s\S]*?runAfterPendingFileSave\(`file:\$\{relativePath\}`,[\s\S]*?openFileSurfaceNow\(relativePath\)/u,
    );
  });

  it("routes table context actions through the owned editor and app menu", () => {
    expect(workspaceSource).toContain('from "./tableContextMenu";');
    expect(workspaceSource).toContain("showTableContextMenu: async (position) => {");
    expect(workspaceSource).toContain("showScientMarkdownTableContextMenu(position");
    expect(workspaceSource).toContain("api.contextMenu.show(items, menuPosition)");
  });

  it("limits workspace lifecycle UI to one owned create and rename mount", () => {
    expect(browserSource.match(/<ScientMarkdownCreateButton\b/gu)).toHaveLength(1);
    expect(panelSource.match(/<ScientMarkdownRenameButton\b/gu)).toHaveLength(1);
    expect(browserSource).not.toContain("createOnly: true");
    expect(panelSource).not.toContain("projects.renameFile");
    expect(panelSource).toContain("isRichMarkdown && !file.data?.readOnly");
  });

  it("refreshes the current workspace tree and link index after refresh, creation, or agent edits", () => {
    expect(browserSource).toContain("void treeControllerRef.current?.refresh();");
    expect(browserSource).toContain("refreshProjectEntriesQuery(environmentId, cwd);");
    const dependencies = browserSource.match(
      /const refreshEntries = useCallback\([\s\S]*?\}, \[([^\]]*)\]\);/u,
    )?.[1];
    expect(dependencies).toContain("cwd");
    expect(dependencies).toContain("environmentId");
    expect(browserSource).toMatch(
      /useWorkspaceMutationRefresh\(\{[\s\S]*?refresh: refreshEntries/u,
    );
    expect(browserSource).toMatch(/onCreated=\{[\s\S]*?handleRefresh\(\);[\s\S]*?onOpenFile/gu);
  });

  it("verifies internal links before routing them through the existing project file opener", () => {
    expect(surfaceSource).toContain(
      "const path = resolveWikiLinkPath(props.relativePath, target);",
    );
    expect(surfaceSource).toContain("projectEnvironment.listDirectory");
    expect(surfaceSource).toContain('view: "with-internals"');
    expect(surfaceSource).toContain("const onOpenFile = props.onOpenFile;");
    expect(surfaceSource).toContain("onOpenFile(relativePath);");
    expect(surfaceSource).toContain("onOpenWikiLink={handleOpenWikiLink}");
  });

  it("uses the current filename itself as the Markdown rename affordance", () => {
    expect(panelSource).toContain("currentFileControl={");
    expect(panelSource).toContain("<ScientMarkdownRenameButton");
    expect(panelSource).toContain('label={relativePath.slice(relativePath.lastIndexOf("/") + 1)}');
  });

  it("keeps the inline filename and formatting rows on the same rhythm as the tab row", () => {
    expect(panelSource).toContain("const usesScientMarkdownEditor =");
    expect(panelSource).toContain("in-data-[preview-panel-mode=inline]:mb-2");
    expect(panelSource).toMatch(
      /usesScientMarkdownEditor\s*\?\s*"in-data-\[preview-panel-mode=inline\]:mb-2"\s*:\s*"in-data-\[preview-panel-mode=inline\]:mb-3"/u,
    );
  });
});
