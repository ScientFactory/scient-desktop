import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import type {
  ScientLatexBuildSnapshot,
  ScientLatexDiagnostic,
  ScientLatexToolchainStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LATEX_PREVIEW_MODE,
  DEFAULT_LATEX_SPLIT_FRACTION,
  LATEX_TOOLCHAIN_MISSING_HINT,
  LATEX_TOOLCHAIN_MISSING_TITLE,
  MIN_LATEX_SPLIT_FRACTION,
  clampLatexSplitFraction,
  formatLatexDiagnosticLine,
  formatLatexDiagnosticLocation,
  isActiveLatexBuildState,
  latexDiagnosticCounts,
  latexDiagnosticRows,
  latexSplitFractionFromPointer,
  latexStatusStripModel,
  normalizeLatexPreviewMode,
  normalizeLatexSplitFraction,
  type LatexBuildStatus,
} from "./scientLatexSurfaceModel";

function diagnostic(overrides: Partial<ScientLatexDiagnostic> = {}): ScientLatexDiagnostic {
  return {
    severity: "error",
    file: "/workspace/paper/main.tex",
    line: 12,
    message: "Undefined control sequence.",
    ...overrides,
  };
}

function snapshot(
  state: ScientLatexBuildSnapshot["state"],
  overrides: Partial<ScientLatexBuildSnapshot> = {},
): ScientLatexBuildSnapshot {
  return {
    logicalDocumentKey: "latex:/workspace/paper/main.tex",
    rootRelativePath: "main.tex",
    state,
    diagnostics: [],
    descriptor: null,
    failureSummary: null,
    startedAtEpochMs: null,
    finishedAtEpochMs: null,
    toolchain: null,
    pendingRerun: false,
    ...overrides,
  };
}

function generatedDescriptor(overrides?: {
  readonly bindingStatus?: "current" | "stale";
  readonly staleReason?: string | null;
}) {
  return PdfSourceDescriptor.make({
    _tag: "generated-pdf",
    authority: ArtifactAuthority.make("environment-latex"),
    logicalDocumentKey: LogicalDocumentKey.make("latex:/workspace/paper/main.tex"),
    artifactId: ArtifactId.make("artifact-1"),
    revisionId: ArtifactRevisionId.make("revision-1"),
    bindingGeneration: BindingGeneration.make(1),
    bindingStatus: overrides?.bindingStatus ?? "current",
    staleReason: overrides?.staleReason ?? null,
    title: "main",
    fileName: "main.pdf",
    capabilities: { canSaveCopy: true, canRevealSource: false },
  });
}

const toolchain = (kind: ScientLatexToolchainStatus["kind"]): ScientLatexToolchainStatus => ({
  kind,
  executable: kind === null ? null : kind,
  version: null,
  probedAtEpochMs: 1,
});

function status(overrides: Partial<LatexBuildStatus> = {}): LatexBuildStatus {
  return {
    snapshot: null,
    toolchain: null,
    canInstallManaged: false,
    managedInstall: null,
    installRequesting: false,
    error: null,
    requesting: false,
    ...overrides,
  };
}

describe("latex preview mode persistence", () => {
  it("falls back to the default for missing or unknown stored modes", () => {
    expect(normalizeLatexPreviewMode(null)).toBe(DEFAULT_LATEX_PREVIEW_MODE);
    expect(normalizeLatexPreviewMode(undefined)).toBe(DEFAULT_LATEX_PREVIEW_MODE);
    expect(normalizeLatexPreviewMode("preview")).toBe(DEFAULT_LATEX_PREVIEW_MODE);
    expect(normalizeLatexPreviewMode("Source")).toBe(DEFAULT_LATEX_PREVIEW_MODE);
  });

  it("keeps every mode the segmented control offers", () => {
    expect(normalizeLatexPreviewMode("source")).toBe("source");
    expect(normalizeLatexPreviewMode("split")).toBe("split");
    expect(normalizeLatexPreviewMode("pdf")).toBe("pdf");
  });
});

describe("latex split fraction", () => {
  it("never lets either half fall below the minimum share", () => {
    expect(clampLatexSplitFraction(0)).toBe(MIN_LATEX_SPLIT_FRACTION);
    expect(clampLatexSplitFraction(1)).toBe(1 - MIN_LATEX_SPLIT_FRACTION);
    expect(clampLatexSplitFraction(-4)).toBe(MIN_LATEX_SPLIT_FRACTION);
    expect(clampLatexSplitFraction(0.35)).toBe(0.35);
  });

  it("rejects stored values that are not usable fractions", () => {
    expect(normalizeLatexSplitFraction(null)).toBe(DEFAULT_LATEX_SPLIT_FRACTION);
    expect(normalizeLatexSplitFraction(undefined)).toBe(DEFAULT_LATEX_SPLIT_FRACTION);
    expect(normalizeLatexSplitFraction(Number.NaN)).toBe(DEFAULT_LATEX_SPLIT_FRACTION);
    expect(normalizeLatexSplitFraction(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_LATEX_SPLIT_FRACTION,
    );
    expect(normalizeLatexSplitFraction(0.42)).toBe(0.42);
  });

  it("maps a pointer position onto the clamped fraction", () => {
    expect(latexSplitFractionFromPointer({ pointerX: 500, left: 100, width: 800 })).toBe(0.5);
    expect(latexSplitFractionFromPointer({ pointerX: 110, left: 100, width: 800 })).toBe(
      MIN_LATEX_SPLIT_FRACTION,
    );
    expect(latexSplitFractionFromPointer({ pointerX: 1_000, left: 100, width: 800 })).toBe(
      1 - MIN_LATEX_SPLIT_FRACTION,
    );
    expect(latexSplitFractionFromPointer({ pointerX: 40, left: 0, width: 0 })).toBe(
      DEFAULT_LATEX_SPLIT_FRACTION,
    );
  });
});

describe("latex diagnostics formatting", () => {
  it("counts each severity", () => {
    expect(
      latexDiagnosticCounts([
        diagnostic(),
        diagnostic({ severity: "warning" }),
        diagnostic({ severity: "warning" }),
      ]),
    ).toEqual({ errors: 1, warnings: 2 });
    expect(latexDiagnosticCounts([])).toEqual({ errors: 0, warnings: 0 });
  });

  it("shows the file name and line the log reported", () => {
    expect(formatLatexDiagnosticLocation(diagnostic())).toBe("main.tex:12");
    expect(formatLatexDiagnosticLocation(diagnostic({ line: null }))).toBe("main.tex");
    expect(formatLatexDiagnosticLocation(diagnostic({ file: null }))).toBeNull();
    expect(formatLatexDiagnosticLocation(diagnostic({ file: "chapters\\intro.tex" }))).toBe(
      "intro.tex:12",
    );
    expect(formatLatexDiagnosticLine(diagnostic())).toBe("main.tex:12 Undefined control sequence.");
    expect(formatLatexDiagnosticLine(diagnostic({ file: null }))).toBe(
      "Undefined control sequence.",
    );
  });

  it("gives repeated log messages distinct row identities", () => {
    const rows = latexDiagnosticRows([
      diagnostic(),
      diagnostic(),
      diagnostic({ severity: "warning", message: "Overfull \\hbox." }),
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    expect(rows.map((row) => row.diagnostic.message)).toEqual([
      "Undefined control sequence.",
      "Undefined control sequence.",
      "Overfull \\hbox.",
    ]);
    // Identity must not depend on position, so an unchanged row keeps its key.
    expect(latexDiagnosticRows([diagnostic()])[0]?.key).toBe(rows[0]?.key);
    expect(latexDiagnosticRows([])).toEqual([]);
  });
});

describe("latex build states", () => {
  it("treats only server-side work as active", () => {
    expect(isActiveLatexBuildState("queued")).toBe(true);
    expect(isActiveLatexBuildState("running")).toBe(true);
    expect(isActiveLatexBuildState("publishing")).toBe(true);
    expect(isActiveLatexBuildState("idle")).toBe(false);
    expect(isActiveLatexBuildState("succeeded")).toBe(false);
    expect(isActiveLatexBuildState("failed")).toBe(false);
    expect(isActiveLatexBuildState("cancelled")).toBe(false);
  });
});

describe("latexStatusStripModel", () => {
  it("describes a document that has never been built", () => {
    const model = latexStatusStripModel(status());
    expect(model).toMatchObject({
      state: "idle",
      busy: false,
      label: "Not built yet",
      errorCount: 0,
      warningCount: 0,
      stale: false,
      toolchainMissing: false,
      canCancel: false,
      canRebuild: true,
      viewer: "idle",
    });
    expect(model.firstDiagnosticLine).toBeNull();
  });

  it("spins and offers cancel while the server is working", () => {
    for (const state of ["queued", "running", "publishing"] as const) {
      const model = latexStatusStripModel(status({ snapshot: snapshot(state) }));
      expect(model.busy).toBe(true);
      expect(model.canCancel).toBe(true);
      expect(model.viewer).toBe("building");
    }
    expect(latexStatusStripModel(status({ snapshot: snapshot("queued") })).label).toBe("Queued…");
    expect(latexStatusStripModel(status({ snapshot: snapshot("running") })).label).toBe(
      "Building…",
    );
    expect(latexStatusStripModel(status({ snapshot: snapshot("publishing") })).label).toBe(
      "Publishing…",
    );
  });

  it("is busy while this client's own request is unanswered", () => {
    const model = latexStatusStripModel(status({ requesting: true }));
    expect(model.busy).toBe(true);
    expect(model.label).toBe("Building…");
    expect(model.canRebuild).toBe(false);
    expect(model.canCancel).toBe(false);
  });

  it("counts diagnostics and points the viewer at them when a build fails", () => {
    const model = latexStatusStripModel(
      status({
        snapshot: snapshot("failed", {
          diagnostics: [
            diagnostic({ severity: "warning", message: "Overfull \\hbox.", line: 4 }),
            diagnostic(),
            diagnostic({ severity: "warning", message: "Font shape undefined.", line: 9 }),
          ],
          failureSummary: "latexmk exited with code 12",
        }),
      }),
    );
    expect(model.label).toBe("Build failed");
    expect(model.errorCount).toBe(1);
    expect(model.warningCount).toBe(2);
    expect(model.viewer).toBe("diagnostics");
    // The collapsed strip leads with the first error, not the first message.
    expect(model.firstDiagnosticLine).toBe("main.tex:12 Undefined control sequence.");
  });

  it("falls back to the first message when a build only warned", () => {
    const model = latexStatusStripModel(
      status({
        snapshot: snapshot("succeeded", {
          diagnostics: [diagnostic({ severity: "warning", message: "Overfull \\hbox.", line: 4 })],
          descriptor: generatedDescriptor(),
        }),
      }),
    );
    expect(model.label).toBe("Built");
    expect(model.warningCount).toBe(1);
    expect(model.firstDiagnosticLine).toBe("main.tex:4 Overfull \\hbox.");
    expect(model.viewer).toBe("pdf");
  });

  it("keeps showing the published PDF after a later build fails", () => {
    const model = latexStatusStripModel(
      status({
        snapshot: snapshot("failed", {
          descriptor: generatedDescriptor({ bindingStatus: "stale", staleReason: "build failed" }),
          diagnostics: [diagnostic()],
        }),
      }),
    );
    expect(model.viewer).toBe("pdf");
    expect(model.stale).toBe(true);
    expect(model.staleReason).toBe("build failed");
  });

  it("names the missing toolchain ahead of any build state", () => {
    const model = latexStatusStripModel(
      status({ snapshot: snapshot("failed"), toolchain: toolchain(null) }),
    );
    expect(model.toolchainMissing).toBe(true);
    expect(model.label).toBe(LATEX_TOOLCHAIN_MISSING_TITLE);
    expect(LATEX_TOOLCHAIN_MISSING_TITLE).toBe("No LaTeX toolchain found");
    expect(LATEX_TOOLCHAIN_MISSING_HINT).toBe(
      "Install TeX Live, MiKTeX, or Tectonic to build PDFs.",
    );
  });

  it("does not claim a missing toolchain before the probe answers", () => {
    expect(latexStatusStripModel(status()).toolchainMissing).toBe(false);
    expect(
      latexStatusStripModel(status({ toolchain: toolchain("tectonic") })).toolchainMissing,
    ).toBe(false);
  });

  it("reports an unreachable environment without dropping the last snapshot", () => {
    const model = latexStatusStripModel(
      status({ snapshot: snapshot("succeeded"), error: "Failed to fetch" }),
    );
    expect(model.offline).toBe(true);
    expect(model.label).toBe("Build status unavailable");
    expect(model.state).toBe("succeeded");
  });

  it("keeps the spinner honest while a poll fails mid-build", () => {
    const model = latexStatusStripModel(
      status({ snapshot: snapshot("running"), error: "Failed to fetch" }),
    );
    expect(model.busy).toBe(true);
    expect(model.label).toBe("Building…");
  });
});
