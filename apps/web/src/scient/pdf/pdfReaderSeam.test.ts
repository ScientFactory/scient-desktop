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

  it("routes Save Copy through the typed host capability instead of navigation", () => {
    const readerSource = NodeFS.readFileSync(
      new URL("./ScientPdfReader.tsx", import.meta.url),
      "utf8",
    );
    const sourceActions = NodeFS.readFileSync(new URL("./pdfSource.ts", import.meta.url), "utf8");

    expect(sourceActions).toContain("documents.saveAssetCopy({");
    expect(sourceActions).not.toContain('document.createElement("a")');
    expect(readerSource).toContain("await observePdfCopy(");
    expect(readerSource).toContain("props.actions.saveCopy(");
    expect(readerSource).toContain("disabled={savingCopy}");
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

  it("binds source actions and navigation to the actually presented revision during staged updates", () => {
    const readerSource = NodeFS.readFileSync(
      new URL("./ScientPdfReader.tsx", import.meta.url),
      "utf8",
    );

    const bundleSource = NodeFS.readFileSync(
      new URL("./usePresentedPdfSourceBundle.ts", import.meta.url),
      "utf8",
    );
    expect(readerSource).toContain("const presentedSource = usePresentedPdfSourceBundle({");
    expect(readerSource).toContain("presentation: reader.presentation,");
    expect(readerSource).toContain("reader.presentation?.revisionId === requestedRevisionId");
    expect(readerSource).toContain("reader.presentation.sourceUrl === props.sourceAsset.url");
    expect(readerSource).toContain("if (!currentPresentation) return;");
    expect(bundleSource).toContain("bundle.documentKey === presentation.documentKey");
    expect(bundleSource).toContain("bundle.revisionId === presentation.revisionId");
    expect(bundleSource).toContain("bundle.resolved.url === presentation.sourceUrl");
  });

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

  it("uses the hand cursor only for enabled reader buttons", () => {
    const styles = NodeFS.readFileSync(new URL("./scientPdfReader.css", import.meta.url), "utf8");

    expect(styles).toMatch(/\.scient-pdf-reader button:not\(:disabled\) \{\s*cursor: pointer;/u);
  });

  it("keeps the page number and page count together at narrow widths", () => {
    const styles = NodeFS.readFileSync(
      new URL("../writing/documentReaderControls.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /\.scient-pdf-page-control \{[^}]*flex: none;[^}]*white-space: nowrap;/su,
    );
  });

  it("styles the PDF.js selection overlay without exposing its native text-layer selection", () => {
    const styles = NodeFS.readFileSync(new URL("./scientPdfReader.css", import.meta.url), "utf8");

    expect(styles).toMatch(
      /\.scient-pdf-viewer-container \.pdfViewer \.canvasWrapper \.selection \{[^}]*background:/su,
    );
    expect(styles).not.toMatch(/\.textLayer\s+::selection\s*\{/u);
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
    expect(source).toContain("onScrollCapture={dismissSourceSyncHint}");
    expect(source).toContain("showSourceSyncHint();");
    expect(source).toContain("Double-click a PDF word to show its matching source line");
    expect(source).toContain("const onInverseSearch = props.syncNavigation?.onInverseSearch;");
    expect(source).not.toContain(
      "props.syncNavigation === undefined || (!event.ctrlKey && !event.metaKey)",
    );
    expect(styles).toContain("inset-block-start: 20px;");
    expect(styles).toMatch(
      /\.scient-pdf-source-sync-hint \{[^}]*position: absolute;[^}]*pointer-events: none;/su,
    );
  });

  it("reports the current page and marks a successful forward-sync point", () => {
    const readerSource = NodeFS.readFileSync(
      new URL("./ScientPdfReader.tsx", import.meta.url),
      "utf8",
    );
    const hookSource = NodeFS.readFileSync(
      new URL("./useScientPdfReader.ts", import.meta.url),
      "utf8",
    );
    const styles = NodeFS.readFileSync(new URL("./scientPdfReader.css", import.meta.url), "utf8");

    expect(readerSource).toContain("onSyncPageChange?.(state.page)");
    expect(hookSource).toContain('marker.className = "scient-pdf-sync-marker"');
    expect(hookSource).toContain("pageView.viewport.convertToViewportPoint(");
    expect(styles).toMatch(
      /\.scient-pdf-sync-marker \{[^}]*position: absolute;[^}]*pointer-events: none;/su,
    );
  });

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
    expect(source).toContain("<Scan /> Actual size");
    expect(source).toContain("<ZoomIn /> Zoom in");
    expect(source).toContain("<Maximize2 /> Fit width");
    expect(source).toContain("<RotateCw /> Rotate clockwise");
    expect(controlsSource).toContain("<Search /> Search {props.label}");
  });
});
