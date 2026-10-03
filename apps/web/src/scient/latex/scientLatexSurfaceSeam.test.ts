// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited file-panel seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const panelSource = NodeFS.readFileSync(
  new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
  "utf8",
);
const projectSource = NodeFS.readFileSync(
  new URL("./LatexProjectVisualEditor.tsx", import.meta.url),
  "utf8",
);
const surfaceSource = NodeFS.readFileSync(
  new URL("./ScientLatexSurface.tsx", import.meta.url),
  "utf8",
);
const automationHostSource = NodeFS.readFileSync(
  new URL("../../components/preview/PreviewAutomationHosts.tsx", import.meta.url),
  "utf8",
);
const surfaceStyles = NodeFS.readFileSync(new URL("./scient-latex.css", import.meta.url), "utf8");

function mountedPropNames(): ReadonlyArray<string> {
  const mount = panelSource.match(/<ScientLatexSurface\b([\s\S]*?)\/>/u);
  if (!mount?.[1]) throw new Error("FilePreviewPanel no longer mounts ScientLatexSurface.");
  return [...mount[1].matchAll(/(\w+)=\{/gu)]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "key");
}

function declaredPropNames(): ReadonlyArray<string> {
  const declaration = surfaceSource.match(/interface ScientLatexSurfaceProps \{([\s\S]*?)\n\}/u);
  if (!declaration?.[1]) throw new Error("ScientLatexSurface no longer declares its props.");
  return [...declaration[1].matchAll(/readonly (\w+):/gu)].map((match) => match[1] ?? "");
}

describe("Scient LaTeX file-preview seam", () => {
  it("does not mount collapsed diagnostics over the Visual document", () => {
    expect(surfaceSource).toContain(
      '(diagnostics.length > 0 || status.state === "failed") && diagnosticsOpen',
    );
    expect(surfaceSource).toContain("onClick={() => setDiagnosticsOpen(true)}");
  });
  it("lazily mounts the surface for LaTeX paths only", () => {
    expect(panelSource).toContain('import("~/scient/latex/ScientLatexSurface")');
    expect(panelSource).toContain("default: module.ScientLatexSurface,");
    expect(panelSource).toContain("isLatexPreviewFile(relativePath)");
    expect(panelSource.match(/<ScientLatexSurface\b/gu)).toHaveLength(1);
  });

  it("passes exactly the props the surface declares", () => {
    expect([...mountedPropNames()].sort()).toEqual([...declaredPropNames()].sort());
  });

  it("resolves a document root before starting a build and offers known roots when inference is incomplete", () => {
    expect(surfaceSource).toContain("useLatexDocumentResolution({");
    expect(surfaceSource).toContain("resolvedRootRelativePath === null");
    expect(surfaceSource).toContain('resolution.result?._tag === "unresolved"');
    expect(surfaceSource).toContain('aria-label="Choose LaTeX document to compile"');
  });

  it("carries the selected root through SyncTeX source navigation", () => {
    expect(surfaceSource).toContain("latexRootRelativePath: snapshot.rootRelativePath");
    expect(panelSource).toContain("latexRootRelativePath={latexRootRelativePath}");
  });

  it("consumes an automatic Split presentation without changing the saved user preference", () => {
    expect(surfaceSource).toContain("props.latexPresentationRequest?.mode ?? initialPreviewMode()");
    expect(surfaceSource).toContain("setPreferredMode(request.mode)");
    expect(surfaceSource).toContain(
      "props.onLatexPresentationRequestHandled(props.relativePath, request)",
    );
    expect(surfaceSource).not.toMatch(/persist\([^)]*request\.mode/u);
  });

  it("finishes an active Visual transaction before a source reveal can unmount it", () => {
    expect(surfaceSource).toMatch(
      /const visualRevealNeedsFinish =[\s\S]*?useLayoutEffect\(\(\) => \{\s*if \(!visualRevealNeedsFinish\) return;\s*finishVisualEditingRef\.current\?\.\(\);\s*setFinishedVisualRevealRequestId\(revealRequestId\);/u,
    );
    expect(surfaceSource).toContain(
      "const revealPending = revealRequested && !visualRevealNeedsFinish;",
    );
  });

  it("opens successful agent builds on their source while carrying the resolved root", () => {
    expect(automationHostSource).toContain('request.operation === "documentLatexPresent"');
    expect(automationHostSource).toContain("openFile(threadRef, input.sourcePath, undefined, {");
    expect(automationHostSource).toContain('latexPreviewMode: "split"');
    expect(automationHostSource).toContain("latexRootRelativePath: input.rootSourcePath");
  });

  it("mounts source-derived writing independently of the compiled viewer", () => {
    expect(surfaceSource).toContain("<LatexProjectVisualEditor");
    expect(surfaceSource).toContain('const showVisual = activePreview === "visual";');
    expect(surfaceSource).toContain("const showRightPane = activePreview !== null;");
    expect(surfaceSource).toContain("{showVisual || visualOpened ? (");
    expect(surfaceSource).not.toContain("LatexVisualInteraction");
    expect(surfaceSource).not.toContain("ensureLatexVisualBuild");
    expect(surfaceSource).not.toContain("scheduleLatexRebuild");
    expect(surfaceSource).not.toContain("coordinator.setSuspended");
  });

  it("keeps source ownership separate from the root-keyed build target", () => {
    expect(surfaceSource).toContain("sourceRelativePath: props.relativePath");
    expect(surfaceSource).toContain("relativePath: resolvedRootRelativePath");
    expect(surfaceSource).toContain("build.snapshot?.visualSourceRevisions?.[props.relativePath]");
  });

  it("hands the surface the file's document session, not the panel's saver", () => {
    // One owner saves a LaTeX file for every view of it. The panel's generic
    // saver and its Discard/Retry resolution must not reach the surface again.
    expect(mountedPropNames()).toEqual(expect.arrayContaining(["revision", "persistence"]));
    for (const retired of [
      "saveResolution",
      "onSaveConfirmed",
      "onSaveFailure",
      "onSaveResolutionApplied",
      "onPendingChange",
    ])
      expect(mountedPropNames()).not.toContain(retired);
    expect(panelSource).toContain(
      "isRichMarkdown || (documentSessionIsCurrent && isLatexPreviewFile(relativePath))",
    );
    expect(panelSource).toContain("surfaceOwnsConflictDetection: usesDocumentSession");
  });

  it("edits source through the session's bindings instead of forking an editor or a saver", () => {
    expect(panelSource).toMatch(/^export function MarkdownSourceSurface\(/mu);
    expect(surfaceSource).toMatch(
      /import \{ MarkdownSourceSurface \} from "~\/components\/files\/FilePreviewPanel"/u,
    );
    expect(surfaceSource).not.toMatch(/EditableFileSurface/u);
    expect(surfaceSource).not.toMatch(/useFileSaveCoordinator|new FileSaveCoordinator/u);
    expect(surfaceSource).not.toMatch(/new Editor</u);
    expect(surfaceSource).not.toMatch(/useProjectFileQuery/u);
    expect(projectSource).not.toMatch(/useFileSaveCoordinator|new FileSaveCoordinator/u);
    expect(projectSource).toContain("useMarkdownPersistenceLease({");
  });

  it("passes truthful source and current PDF page context to forward SyncTeX", () => {
    // The inherited editor does not expose its cursor on main. Zero is
    // SyncTeX's specified unknown-column value, and avoids guessing visual
    // offsets for wrapped or bidirectional source text.
    expect(surfaceSource).toContain("column: 0");
    expect(surfaceSource).toContain("column: position.column");
    expect(surfaceSource).toContain("pageHint: pdfPageRef.current");
    expect(surfaceSource).toContain("onPageChange: handlePdfPageChange");
  });

  it("keeps PDF and Split navigation separate from writing", () => {
    expect(surfaceSource).toContain('if (mode !== "split" || splitPreview !== "pdf") return;');
    expect(surfaceSource).toMatch(
      /mode === "pdf" \|\| \(mode === "split" && splitPreview === "pdf"\)[\s\S]*?\? \{ onInverseSearch: handleInverseSync \}/u,
    );
    expect(surfaceSource).not.toContain("renderInteraction: renderVisualInteraction");
    expect(surfaceSource).not.toContain('if (preferredMode === "source") selectMode("split")');
    expect(surfaceSource).toContain('event.key.toLowerCase() === "s"');
    expect(surfaceSource).toContain(
      "void saveAndBuild(false, pdfVisible && !!build.toolchain?.kind)",
    );
  });

  it("keeps the LaTeX surface off the chat markdown pipeline", () => {
    expect(surfaceSource).not.toMatch(/ChatMarkdown/u);
    expect(surfaceSource).not.toMatch(/from "~\/components\/ChatMarkdown"/u);
  });

  it("uses the hand cursor only for enabled buttons", () => {
    expect(surfaceStyles).toContain(".scient-latex-surface button:not(:disabled)");
    expect(surfaceStyles).toMatch(
      /\.scient-latex-surface button:not\(:disabled\) \{\s*cursor: pointer;/u,
    );
  });

  it("exports only the Scient-owned surface", () => {
    const exported = [...surfaceSource.matchAll(/^export (?:function|const|class) (\w+)/gmu)].map(
      (match) => match[1],
    );
    expect(exported).toEqual(["ScientLatexSurface"]);
    expect(surfaceSource).not.toMatch(/^export default/mu);
    expect(surfaceSource).not.toMatch(/^export \{/mu);
  });

  it("counts this file's queued or failed save before the project retires its recovery copy", () => {
    // The project editor clears its stored recovery copy when nothing is
    // pending. A failed or queued save of the open file must hold that back.
    // The session's pending flag covers all three: unsaved, saving, and a
    // save waiting on a conflict or a failure.
    expect(surfaceSource).toContain("selectedPending={sourcePending}");
  });
});
