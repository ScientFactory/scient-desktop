// @effect-diagnostics nodeBuiltinImport:off -- Static seam audit for the source-neutral reader.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("Scient PDF reader source seam", () => {
  it("does not grow producer or raw-path branches", () => {
    const source = NodeFS.readFileSync(new URL("./ScientPdfReader.tsx", import.meta.url), "utf8");
    expect(source.replace(/\/\*[\s\S]*?\*\//gu, "")).not.toMatch(
      /browser-export|latex|typst|quarto/iu,
    );
    expect(source).not.toContain("absolutePath");
    expect(source).toContain("PdfSourceDescriptor");
    expect(source).toContain("PdfSourceResolver");
  });

  // regression: 62abb32e7f fix: preserve PDF reader state across remounts
  it("keeps the persisted viewport lifecycle wired to PDF.js view events", () => {
    const source = NodeFS.readFileSync(new URL("./useScientPdfReader.ts", import.meta.url), "utf8");
    expect(source).toContain('eventBus.on("pagesinit"');
    expect(source).toContain('eventBus.on("updateviewarea"');
    expect(source).toContain("viewportSession.restore(");
    expect(source).toContain("viewportSession.completeRestore()");
    expect(source).toContain("viewportSession.snapshot(");
    expect(source).toContain("viewportSession.flush()");
  });

  // regression: 739ac30aaa fix(web): stabilize responsive PDF reader
  it("reconciles page and rotation geometry against the current pane width", () => {
    const source = NodeFS.readFileSync(new URL("./useScientPdfReader.ts", import.meta.url), "utf8");

    expect(source).toContain(
      `const onPageChanging = ({ pageNumber }: { pageNumber: number }) => {
          if (!displayed()) return;
          setState((previous) => ({ ...previous, page: pageNumber }));
          runtime.refreshForContainerSize();
        };`,
    );
    expect(source).toContain(
      `const onRotationChanging = ({ pagesRotation }: { pagesRotation: number }) => {
          if (!displayed()) return;
          setState((previous) => ({ ...previous, rotation: pagesRotation }));
          runtime.refreshForContainerSize();
        };`,
    );
    expect(source).toContain(
      "onContainerResize: (viewer) => responsiveZoom.reconcile(viewer, container.clientWidth)",
    );
    expect(source).not.toContain("refreshForPageGeometry");
  });

  // regression: 739ac30aaa fix(web): stabilize responsive PDF reader
  it("uses the hand cursor only for enabled reader buttons", () => {
    const styles = NodeFS.readFileSync(new URL("./scientPdfReader.css", import.meta.url), "utf8");

    expect(styles).toMatch(/\.scient-pdf-reader button:not\(:disabled\) \{\s*cursor: pointer;/u);
  });

  // regression: 739ac30aaa fix(web): stabilize responsive PDF reader
  it("keeps the page number and page count together at narrow widths", () => {
    const styles = NodeFS.readFileSync(
      new URL("../writing/documentReaderControls.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.scient-pdf-page-control \{[^}]*flex: none;[^}]*white-space: nowrap;/su,
    );
  });

  // regression: 6f5031e780 fix(pdf): isolate text selection rendering (#274)
  it("styles the PDF.js selection overlay without exposing its native text-layer selection", () => {
    const styles = NodeFS.readFileSync(new URL("./scientPdfReader.css", import.meta.url), "utf8");

    expect(styles).toMatch(
      /\.scient-pdf-viewer-container \.pdfViewer \.canvasWrapper \.selection \{[^}]*background:/su,
    );
    expect(styles).not.toMatch(/\.textLayer\s+::selection\s*\{/u);
  });

  // regression: 739ac30aaa fix(web): stabilize responsive PDF reader
  it("adapts to the reader width while preserving compact actions in the More menu", () => {
    const readerSource = NodeFS.readFileSync(
      new URL("./ScientPdfReader.tsx", import.meta.url),
      "utf8",
    );
    const controlsSource = NodeFS.readFileSync(
      new URL("../writing/DocumentReaderControls.tsx", import.meta.url),
      "utf8",
    );
    const source = `${readerSource}\n${controlsSource}`;
    const styles = NodeFS.readFileSync(
      new URL("../writing/documentReaderControls.css", import.meta.url),
      "utf8",
    );

    expect(readerSource).toContain("<DocumentReaderControls");
    expect(readerSource).toContain('label="PDF"');
    expect(styles).toContain("container-name: scient-document-controls;");
    expect(styles).toContain("@container scient-document-controls (max-width: 439px)");
    expect(styles).toContain("@container scient-document-controls (max-width: 359px)");
    expect(styles).toContain("@container scient-document-controls (max-width: 239px)");
    expect(styles).not.toContain("@media (max-width: 520px)");
    expect(source).toContain('className="scient-pdf-action-sidebar"');
    expect(source).toContain('className="scient-pdf-action-zoom-step"');
    expect(source).not.toContain('className="scient-pdf-action-fit"');
    expect(source).not.toContain('className="scient-pdf-action-rotate"');
    expect(controlsSource).toContain('className="scient-reader-search"');
    expect(source).toContain("<ZoomOut /> Zoom out");
    // Actual size is not offered in More; clicking the percentage fits the width.
    expect(source).not.toContain("Actual size");
    expect(source).toContain("<ZoomIn /> Zoom in");
    expect(source).toContain("<Maximize2 /> Fit width");
    expect(source).toContain("<RotateCw /> Rotate clockwise");
    expect(controlsSource).toContain("<Search /> Search {props.label}");
  });
});
