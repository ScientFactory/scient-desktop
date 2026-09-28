import type {
  DesktopBridge,
  ScientDocumentPageRenderResult,
  ScientDocumentPdfPrepared,
  ScientDocumentPdfPublished,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DOCUMENT_PDF_DESKTOP_OUTDATED,
  DOCUMENT_PDF_DESKTOP_REQUIRED,
  documentPdfAvailability,
  renderDocumentPagePdf,
  renderDocumentPagePdfForHost,
} from "./documentPagePdf";
import {
  MARKDOWN_PDF_TOO_LARGE_MESSAGE,
  MarkdownPdfExportError,
  runMarkdownPdfExport,
  summarizeDocumentWarnings,
  type MarkdownPdfExportDependencies,
} from "./markdownPdfExport";

const revision = `sha256:${"a".repeat(64)}`;
const expected = {
  captureId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  documentKind: "workspace-file",
  sourceDigest: revision,
} as const;
const prepared = {
  inputRelativeUrl: "/api/assets/token/document.json",
  expected,
  title: "Report",
  warnings: [],
} as unknown as ScientDocumentPdfPrepared;
const renderResult = { bytesBase64: "JVBERi0" } as unknown as ScientDocumentPageRenderResult;
const published = { title: "Report", warnings: [] } as unknown as ScientDocumentPdfPublished;
const target = { cwd: "/project", relativePath: "notes/report.md" };

function dependencies(
  overrides: Partial<MarkdownPdfExportDependencies> = {},
): MarkdownPdfExportDependencies {
  return {
    flush: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ pending: false, hasProblem: false, baselineRevision: revision })),
    prepare: vi.fn(async () => prepared),
    render: vi.fn(async () => ({ _tag: "rendered" as const, result: renderResult })),
    publish: vi.fn(async () => published),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Markdown PDF export", () => {
  it("saves first, captures the saved revision, prints it, and publishes that capture", async () => {
    const steps: string[] = [];
    const deps = dependencies({
      flush: vi.fn(async () => {
        steps.push("flush");
        return true;
      }),
      prepare: vi.fn(async () => {
        steps.push("prepare");
        return prepared;
      }),
    });
    expect(await runMarkdownPdfExport(deps, target)).toBe(published);
    expect(steps).toEqual(["flush", "prepare"]);
    expect(deps.prepare).toHaveBeenCalledWith({ ...target, expectedRevision: revision });
    expect(deps.render).toHaveBeenCalledWith({
      inputRelativeUrl: prepared.inputRelativeUrl,
      expected,
    });
    expect(deps.publish).toHaveBeenCalledWith({
      captureId: expected.captureId,
      render: renderResult,
    });
  });

  it("exports nothing when edits could not be saved or conflict", async () => {
    for (const deps of [
      dependencies({ flush: vi.fn(async () => false) }),
      dependencies({
        snapshot: () => ({ pending: true, hasProblem: false, baselineRevision: revision }),
      }),
      dependencies({
        snapshot: () => ({ pending: false, hasProblem: true, baselineRevision: revision }),
      }),
      dependencies({
        snapshot: () => ({ pending: false, hasProblem: false, baselineRevision: "unavailable" }),
      }),
    ]) {
      await expect(runMarkdownPdfExport(deps, target)).rejects.toBeInstanceOf(
        MarkdownPdfExportError,
      );
      expect(deps.prepare).not.toHaveBeenCalled();
    }
  });

  it("reports a refused page or an over-limit PDF without publishing", async () => {
    const refused = dependencies({
      render: vi.fn(async () => ({
        _tag: "rejected" as const,
        reason: "page-rejected" as const,
        detail: "1 diagram did not finish rendering.",
      })),
    });
    await expect(runMarkdownPdfExport(refused, target)).rejects.toThrow(
      "1 diagram did not finish rendering.",
    );
    const tooLarge = dependencies({
      render: vi.fn(async () => ({
        _tag: "rejected" as const,
        reason: "too-large" as const,
        detail: "",
      })),
    });
    await expect(runMarkdownPdfExport(tooLarge, target)).rejects.toThrow(
      MARKDOWN_PDF_TOO_LARGE_MESSAGE,
    );
    expect(refused.publish).not.toHaveBeenCalled();
    expect(tooLarge.publish).not.toHaveBeenCalled();
    // Neither capture will be published, so neither waits out its expiry.
    expect(refused.release).toHaveBeenCalledWith(expected.captureId);
    expect(tooLarge.release).toHaveBeenCalledWith(expected.captureId);
  });

  it("summarizes warnings briefly", () => {
    const warnings = Array.from({ length: 5 }, (_, index) => ({
      code: "resource-unresolved" as const,
      message: `Warning ${index + 1}.`,
    }));
    expect(summarizeDocumentWarnings(warnings)).toBe(
      "Warning 1.\nWarning 2.\nWarning 3.\nand 2 more, listed at the end of the PDF.",
    );
  });
});

describe("document page rendering on this desktop", () => {
  const artifact = {
    data: new Uint8Array([37, 80, 68, 70]),
    readiness: { status: "ready" },
    warnings: [],
    sourceSignals: {},
    blockedRequestCount: 0,
  };

  it("explains why PDF export is unavailable", () => {
    expect(documentPdfAvailability(undefined)).toEqual({
      available: false,
      reason: DOCUMENT_PDF_DESKTOP_REQUIRED,
    });
    expect(documentPdfAvailability({} as DesktopBridge)).toEqual({
      available: false,
      reason: DOCUMENT_PDF_DESKTOP_OUTDATED,
    });
  });

  it("resolves the capture against the environment and encodes the printed bytes", async () => {
    const renderDocumentPagePdfBridge = vi.fn(async () => ({
      _tag: "rendered" as const,
      artifact,
    }));
    const bridge = {
      renderDocumentPagePdf: renderDocumentPagePdfBridge,
    } as unknown as DesktopBridge;
    const outcome = await renderDocumentPagePdf({
      httpBaseUrl: "https://environment.test",
      request: { inputRelativeUrl: prepared.inputRelativeUrl, expected },
      bridge,
    });
    expect(renderDocumentPagePdfBridge).toHaveBeenCalledWith({
      inputUrl: "https://environment.test/api/assets/token/document.json",
      expected,
    });
    expect(outcome).toMatchObject({ _tag: "rendered", result: { bytesBase64: "JVBERg" } });
    expect(
      await renderDocumentPagePdf({
        httpBaseUrl: "https://environment.test",
        request: { inputRelativeUrl: prepared.inputRelativeUrl, expected },
        bridge: undefined,
      }),
    ).toMatchObject({ _tag: "rejected", detail: DOCUMENT_PDF_DESKTOP_REQUIRED });
  });

  it("rejects a malformed host request before touching the desktop", async () => {
    await expect(
      renderDocumentPagePdfForHost("https://environment.test", { inputRelativeUrl: "" }),
    ).rejects.toThrow();
  });
});
