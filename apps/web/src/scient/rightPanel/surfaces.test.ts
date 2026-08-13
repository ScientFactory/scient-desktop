import { describe, expect, it } from "vite-plus/test";

import {
  normalizeScientRightPanelSurface,
  scientRightPanelSurfaceTitle,
  scientSourcePdfSurface,
  scientSourcesSurface,
} from "./surfaces";

describe("Scient right-panel surfaces", () => {
  it("builds stable Sources and source-PDF descriptors", () => {
    expect(scientSourcesSurface()).toEqual({
      id: "scient:sources",
      kind: "scient",
      module: "sources",
    });
    expect(scientSourcePdfSurface({ attachmentId: "pdf 1", fileName: "Paper.pdf" })).toEqual({
      id: "scient:source-pdf:pdf%201",
      kind: "scient",
      module: "source-pdf",
      attachmentId: "pdf 1",
      fileName: "Paper.pdf",
    });
  });

  it("normalizes recognized persisted descriptors and rejects unsafe ones", () => {
    expect(
      normalizeScientRightPanelSurface({
        id: "scient:source-pdf:legacy",
        kind: "scient",
        module: "source-pdf",
        attachmentId: "pdf 1",
        fileName: "Paper.pdf",
      }),
    ).toEqual(scientSourcePdfSurface({ attachmentId: "pdf 1", fileName: "Paper.pdf" }));
    expect(
      normalizeScientRightPanelSurface({
        id: "scient:unknown",
        kind: "scient",
        module: "unknown",
      }),
    ).toBeNull();
    expect(
      normalizeScientRightPanelSurface({
        id: "scient:source-pdf:missing-file",
        kind: "scient",
        module: "source-pdf",
        attachmentId: "pdf 1",
      }),
    ).toBeNull();
  });

  it("keeps user-visible titles inside the Scient-owned registry", () => {
    expect(scientRightPanelSurfaceTitle(scientSourcesSurface())).toBe("Sources");
    expect(
      scientRightPanelSurfaceTitle(
        scientSourcePdfSurface({ attachmentId: "pdf_1", fileName: "Paper.pdf" }),
      ),
    ).toBe("Paper.pdf");
  });
});
