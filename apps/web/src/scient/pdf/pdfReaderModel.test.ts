import { describe, expect, it } from "vite-plus/test";

import {
  clampPdfPage,
  formatPdfZoom,
  nextPdfRotation,
  normalizePdfZoom,
  parseSafePdfExternalUrl,
  parsePdfPageInput,
  stepPdfZoom,
} from "./pdfReaderModel";

describe("PDF reader model", () => {
  it("clamps and validates typed page numbers", () => {
    expect(clampPdfPage(0, 20)).toBe(1);
    expect(clampPdfPage(25, 20)).toBe(20);
    expect(parsePdfPageInput(" 12 ", 20)).toBe(12);
    expect(parsePdfPageInput("0", 20)).toBeNull();
    expect(parsePdfPageInput("21", 20)).toBeNull();
    expect(parsePdfPageInput("2.5", 20)).toBeNull();
  });

  it("normalizes rotation and zoom without unbounded canvases", () => {
    expect(nextPdfRotation(0)).toBe(90);
    expect(nextPdfRotation(270)).toBe(0);
    expect(nextPdfRotation(-90)).toBe(0);
    expect(normalizePdfZoom(0.1)).toBe(0.25);
    expect(normalizePdfZoom(9)).toBe(5);
    expect(formatPdfZoom(1.255)).toBe("125%");
  });

  it("moves manual zoom through five-percent stops", () => {
    expect(stepPdfZoom(0.96, "in")).toBe(1);
    expect(stepPdfZoom(0.96, "out")).toBe(0.95);
    expect(stepPdfZoom(1.12, "in")).toBe(1.15);
    expect(stepPdfZoom(1.12, "out")).toBe(1.1);
    expect(stepPdfZoom(5, "in")).toBe(5);
    expect(stepPdfZoom(0.25, "out")).toBe(0.25);
  });

  it("allows only browser-safe PDF outline URLs", () => {
    expect(parseSafePdfExternalUrl("https://example.com/paper#results")).toBe(
      "https://example.com/paper#results",
    );
    expect(parseSafePdfExternalUrl("http://example.com/")).toBe("http://example.com/");
    expect(parseSafePdfExternalUrl("javascript:alert(1)")).toBeNull();
    expect(parseSafePdfExternalUrl("file:///etc/passwd")).toBeNull();
    expect(parseSafePdfExternalUrl("data:text/html,unsafe")).toBeNull();
    expect(parseSafePdfExternalUrl("not a URL")).toBeNull();
  });
});
