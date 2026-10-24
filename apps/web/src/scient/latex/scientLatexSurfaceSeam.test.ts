// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited file-panel seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

// The inherited panel and the Scient module that loads its surfaces.
const panelSource = [
  "../../components/files/FilePreviewPanel.tsx",
  "../fileSurfaces/scientLazyFileSurfaces.tsx",
]
  .map((path) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");
const projectSource = NodeFS.readFileSync(
  new URL("./LatexProjectVisualEditor.tsx", import.meta.url),
  "utf8",
);
const surfaceSource = NodeFS.readFileSync(
  new URL("./ScientLatexSurface.tsx", import.meta.url),
  "utf8",
);

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
  return [...declaration[1].matchAll(/readonly (\w+)\??:/gu)].map((match) => match[1] ?? "");
}

describe("Scient LaTeX file-preview seam", () => {
  it("lazily mounts the surface for LaTeX paths only", () => {
    expect(panelSource).toContain('import("~/scient/latex/ScientLatexSurface")');
    expect(panelSource).toContain("default: module.ScientLatexSurface,");
    expect(panelSource).toContain("isLatexPreviewFile(relativePath)");
    expect(panelSource.match(/<ScientLatexSurface\b/gu)).toHaveLength(1);
  });

  it("passes exactly the props the surface declares", () => {
    expect([...mountedPropNames()].sort()).toEqual([...declaredPropNames()].sort());
  });

  it("consumes an automatic Split presentation without changing the saved user preference", () => {
    expect(surfaceSource).toContain("props.latexPresentationRequest?.mode ?? initialPreviewMode()");
    expect(surfaceSource).toContain("setPreferredMode(request.mode)");
    expect(surfaceSource).toContain(
      "const acknowledgePresentation = props.onLatexPresentationRequestHandled;",
    );
    expect(surfaceSource).toContain("acknowledgePresentation(props.relativePath, request)");
    expect(surfaceSource).toContain("acknowledgePresentationRequest(");
    expect(surfaceSource).not.toMatch(/persist\([^)]*request\.mode/u);
  });

  it("finishes an active Visual transaction before a source reveal can unmount it", () => {
    expect(surfaceSource).toMatch(
      /const visualRevealNeedsFinish =[\s\S]*?const finishVisualForReveal = useStableCallback\(\(requestId: number\) => \{\s*finishVisualEditingRef\.current\?\.\(\);\s*setFinishedVisualRevealRequestId\(requestId\);\s*\}\);\s*useLayoutEffect\(\(\) => \{\s*if \(!visualRevealNeedsFinish\) return;\s*finishVisualForReveal\(revealRequestId\);/u,
    );
    expect(surfaceSource).toContain(
      "const revealPending = revealRequested && !visualRevealNeedsFinish;",
    );
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
      "isLatexPreviewFile(relativePath) || /\\.bib$/i.test(relativePath)",
    );
    expect(panelSource).toContain("surfaceOwnsConflictDetection: usesDocumentSession");
  });

  it("routes bibliography tabs through the session-backed source surface", () => {
    expect(panelSource).toMatch(
      /const usesDocumentSession =[\s\S]*?!isHostFile[\s\S]*?documentSessionIsCurrent[\s\S]*?isLatexPreviewFile\(relativePath\) \|\| \/\\\.bib\$\/i\.test\(relativePath\)/u,
    );
    expect(panelSource).toMatch(
      /usesDocumentSession && relativePath !== null \? \{ environmentId, cwd, relativePath \} : null/u,
    );
    expect(panelSource).toMatch(
      /markdownLease \? \(\s*<MarkdownSourceSurface[\s\S]*?persistence=\{markdownLease\}/u,
    );
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

  it("keeps the LaTeX surface off the chat markdown pipeline", () => {
    expect(surfaceSource).not.toMatch(/ChatMarkdown/u);
    expect(surfaceSource).not.toMatch(/from "~\/components\/ChatMarkdown"/u);
  });

  it("exports only the Scient-owned surface", () => {
    const exported = [...surfaceSource.matchAll(/^export (?:function|const|class) (\w+)/gmu)].map(
      (match) => match[1],
    );
    expect(exported).toEqual(["ScientLatexSurface"]);
    expect(surfaceSource).not.toMatch(/^export default/mu);
    expect(surfaceSource).not.toMatch(/^export \{/mu);
  });
});
