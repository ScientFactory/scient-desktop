// @effect-diagnostics nodeBuiltinImport:off -- Static audit for narrow inherited viewer seams.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const environmentPreviewSource = NodeFS.readFileSync(
  new URL("./EnvironmentFilePreview.tsx", import.meta.url),
  "utf8",
);
const artifactPreviewSource = NodeFS.readFileSync(
  new URL("../artifacts/ScientArtifactPreview.tsx", import.meta.url),
  "utf8",
);
const htmlPdfLifecycleSource = NodeFS.readFileSync(
  new URL("../documentExport/HtmlPdfLifecycleHost.tsx", import.meta.url),
  "utf8",
);
const sourcePdfPreviewSource = NodeFS.readFileSync(
  new URL("../sources/SourcePdfPreview.tsx", import.meta.url),
  "utf8",
);
const workspaceFileRefreshSource = NodeFS.readFileSync(
  new URL("../fileSurfaces/useWorkspaceFileRefresh.ts", import.meta.url),
  "utf8",
);
const filePreviewPanelSource = NodeFS.readFileSync(
  new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
  "utf8",
);

describe("Scient file refresh seams", () => {
  it("keeps chat-linked files on the shared exact-file freshness boundary", () => {
    expect(environmentPreviewSource).toContain("useEnvironmentFileRefresh({");
    expect(environmentPreviewSource).toContain("automaticRefreshUnavailable=");
    expect(htmlPdfLifecycleSource).toContain('from "../fileOpening/environmentFileChanges"');
    expect(NodeFS.existsSync(new URL("./environmentFileChanges.ts", import.meta.url))).toBe(true);
    expect(
      NodeFS.existsSync(new URL("../documentExport/environmentFileChanges.ts", import.meta.url)),
    ).toBe(false);
  });

  it("keeps workspace watcher recovery behind the existing narrow viewer seam", () => {
    expect(workspaceFileRefreshSource).toContain("fileChanges.refresh();");
    expect(workspaceFileRefreshSource).toContain("automaticRefreshUnavailable:");
    expect(filePreviewPanelSource).toContain(
      "automaticRefreshUnavailable={automaticRefreshUnavailable}",
    );
  });

  it("uses explicit responsive headers and content-derived title direction", () => {
    for (const source of [environmentPreviewSource, artifactPreviewSource]) {
      expect(source).not.toContain('className="surface-subheader');
      expect(source).toContain("data-surface-subheader");
      expect(source).toContain("in-data-[preview-panel-mode=inline]:h-7");
      expect(source).toContain('dir="auto"');
      expect(source).toContain("text-start");
    }
  });

  it("uses truthful recovery labels without adding a second PDF-reader control", () => {
    expect(artifactPreviewSource).toContain('aria-label="Reload figure"');
    expect(artifactPreviewSource).not.toContain('aria-label="Refresh figure"');
    expect(sourcePdfPreviewSource).toContain("onClick={refresh}");
    expect(sourcePdfPreviewSource).toContain("Try again");
  });
});
