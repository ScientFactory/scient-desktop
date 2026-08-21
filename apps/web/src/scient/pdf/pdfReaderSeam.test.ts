// @effect-diagnostics nodeBuiltinImport:off -- Static seam audit for the source-neutral reader.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("Scient PDF reader source seam", () => {
  it("does not grow producer or raw-path branches", () => {
    const source = NodeFS.readFileSync(new URL("./ScientPdfReader.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/browser-export|latex|typst|quarto/iu);
    expect(source).not.toContain("absolutePath");
    expect(source).toContain("PdfSourceDescriptor");
    expect(source).toContain("PdfSourceResolver");
  });

  it("keeps the persisted viewport lifecycle wired to PDF.js view events", () => {
    const source = NodeFS.readFileSync(new URL("./useScientPdfReader.ts", import.meta.url), "utf8");
    expect(source).toContain('eventBus.on("pagesinit"');
    expect(source).toContain('eventBus.on("updateviewarea"');
    expect(source).toContain("viewportSession.restore(");
    expect(source).toContain("viewportSession.completeRestore()");
    expect(source).toContain("viewportSession.snapshot(");
    expect(source).toContain("viewportSession.flush()");
  });

  it("reconciles page and rotation geometry against the current pane width", () => {
    const source = NodeFS.readFileSync(new URL("./useScientPdfReader.ts", import.meta.url), "utf8");

    expect(source).toContain(
      `const onPageChanging = ({ pageNumber }: { pageNumber: number }) => {
          setState((previous) => ({ ...previous, page: pageNumber }));
          runtime.refreshForContainerSize();
        };`,
    );
    expect(source).toContain(
      `const onRotationChanging = ({ pagesRotation }: { pagesRotation: number }) => {
          setState((previous) => ({ ...previous, rotation: pagesRotation }));
          runtime.refreshForContainerSize();
        };`,
    );
    expect(source).toContain(
      "onContainerResize: (viewer) => responsiveZoom.reconcile(viewer, container.clientWidth)",
    );
    expect(source).not.toContain("refreshForPageGeometry");
  });

  it("uses the hand cursor only for enabled reader buttons", () => {
    const styles = NodeFS.readFileSync(new URL("./scientPdfReader.css", import.meta.url), "utf8");

    expect(styles).toMatch(/\.scient-pdf-reader button:not\(:disabled\) \{\s*cursor: pointer;/u);
  });

  it("keeps the page number and page count together at narrow widths", () => {
    const styles = NodeFS.readFileSync(new URL("./scientPdfReader.css", import.meta.url), "utf8");

    expect(styles).toMatch(
      /\.scient-pdf-page-control \{[^}]*flex: none;[^}]*white-space: nowrap;/su,
    );
  });

  it("teaches inverse source sync without turning the PDF into a hover target", () => {
    const source = NodeFS.readFileSync(new URL("./ScientPdfReader.tsx", import.meta.url), "utf8");
    const styles = NodeFS.readFileSync(new URL("./scientPdfReader.css", import.meta.url), "utf8");

    expect(source).not.toContain(
      '<ScientTooltip content="Ctrl/Command-double-click the PDF to open the matching source line">',
    );
    expect(source).toContain("const PDF_SOURCE_SYNC_HINT_VISIBLE_MS = 4_000;");
    expect(source).toContain("let pdfSourceSyncHintLearnedThisSession = false;");
    expect(source).not.toContain("pdfSourceSyncHintShownThisSession");
    expect(source).toContain("onClick={scheduleSourceSyncHint}");
    expect(source).toContain("onScroll={dismissSourceSyncHint}");
    expect(source).toContain("showSourceSyncHint();");
    expect(source).toContain('"⌘ double-click the PDF to open the matching source line"');
    expect(source).toContain('"Ctrl double-click the PDF to open the matching source line"');
    expect(styles).toContain("inset-block-start: 20px;");
    expect(styles).toMatch(
      /\.scient-pdf-source-sync-hint \{[^}]*position: absolute;[^}]*pointer-events: none;/su,
    );
  });

  it("adapts to the reader width while preserving compact actions in the More menu", () => {
    const source = NodeFS.readFileSync(new URL("./ScientPdfReader.tsx", import.meta.url), "utf8");
    const styles = NodeFS.readFileSync(new URL("./scientPdfReader.css", import.meta.url), "utf8");

    expect(styles).toContain("container-name: scient-pdf-reader;");
    expect(styles).toContain("@container scient-pdf-reader (max-width: 439px)");
    expect(styles).toContain("@container scient-pdf-reader (max-width: 359px)");
    expect(styles).toContain("@container scient-pdf-reader (max-width: 239px)");
    expect(styles).not.toContain("@media (max-width: 520px)");
    expect(source).toContain('className="scient-pdf-action-sidebar"');
    expect(source).toContain('className="scient-pdf-action-zoom-step"');
    expect(source).toContain('className="scient-pdf-action-fit"');
    expect(source).toContain('className="scient-pdf-action-rotate"');
    expect(source).toContain('className="scient-pdf-action-search"');
    expect(source).toContain("<ZoomOut /> Zoom out");
    expect(source).toContain("<Scan /> Actual size");
    expect(source).toContain("<ZoomIn /> Zoom in");
    expect(source).toContain("<Maximize2 /> Fit width");
    expect(source).toContain("<RotateCw /> Rotate clockwise");
    expect(source).toContain("<Search /> Search PDF");
  });
});
