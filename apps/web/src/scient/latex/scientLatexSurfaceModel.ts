import type {
  ScientLatexBuildSnapshot,
  ScientLatexBuildState,
  ScientLatexDiagnostic,
  ScientLatexManagedInstallState,
  ScientLatexToolchainStatus,
} from "@t3tools/contracts";

import { isActiveLatexInstall } from "./latexToolchainSetupModel";

export const LATEX_PREVIEW_MODE_STORAGE_KEY = "scient.latexPreviewMode";
export const LATEX_SPLIT_RATIO_STORAGE_KEY = "scient.latexSplitRatio";

export const LATEX_PREVIEW_MODES = ["source", "split", "pdf"] as const;
export type ScientLatexPreviewMode = (typeof LATEX_PREVIEW_MODES)[number];

export const LATEX_PREVIEW_MODE_LABELS: Readonly<Record<ScientLatexPreviewMode, string>> = {
  source: "Source",
  split: "Split",
  pdf: "PDF",
};

export const DEFAULT_LATEX_PREVIEW_MODE: ScientLatexPreviewMode = "split";
export const DEFAULT_LATEX_SPLIT_FRACTION = 0.5;
/** Neither half may be squeezed into a strip too narrow to work in. */
export const MIN_LATEX_SPLIT_FRACTION = 0.2;

export const LATEX_TOOLCHAIN_MISSING_TITLE = "No LaTeX toolchain found";
export const LATEX_TOOLCHAIN_MISSING_HINT = "Install TeX Live, MiKTeX, or Tectonic to build PDFs.";
export const LATEX_INSTALLING_LABEL = "Installing TinyTeX…";

export function normalizeLatexPreviewMode(
  value: string | null | undefined,
): ScientLatexPreviewMode {
  return LATEX_PREVIEW_MODES.find((mode) => mode === value) ?? DEFAULT_LATEX_PREVIEW_MODE;
}

export function clampLatexSplitFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LATEX_SPLIT_FRACTION;
  return Math.min(Math.max(value, MIN_LATEX_SPLIT_FRACTION), 1 - MIN_LATEX_SPLIT_FRACTION);
}

export function normalizeLatexSplitFraction(value: number | null | undefined): number {
  return value === null || value === undefined
    ? DEFAULT_LATEX_SPLIT_FRACTION
    : clampLatexSplitFraction(value);
}

/** Pointer position to editor-half width, clamped so a drag cannot close either half. */
export function latexSplitFractionFromPointer(input: {
  readonly pointerX: number;
  readonly left: number;
  readonly width: number;
}): number {
  if (input.width <= 0) return DEFAULT_LATEX_SPLIT_FRACTION;
  return clampLatexSplitFraction((input.pointerX - input.left) / input.width);
}

/** The build state the surface reads, whatever produced it. */
export interface LatexBuildStatus {
  readonly snapshot: ScientLatexBuildSnapshot | null;
  readonly toolchain: ScientLatexToolchainStatus | null;
  /** This environment has a LaTeX distribution Scient can install for it. */
  readonly canInstallManaged: boolean;
  /** The managed install this environment is running, or last ran. */
  readonly managedInstall: ScientLatexManagedInstallState | null;
  /** An install this client asked for has not been answered yet. */
  readonly installRequesting: boolean;
  /** Last transport failure. The previous snapshot stays readable beside it. */
  readonly error: string | null;
  /** A build or cancel this client asked for has not been answered yet. */
  readonly requesting: boolean;
}

export type LatexViewerState = "pdf" | "diagnostics" | "building" | "idle";

export interface LatexStatusStripModel {
  readonly state: ScientLatexBuildState;
  readonly busy: boolean;
  readonly label: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly stale: boolean;
  readonly staleReason: string | null;
  readonly toolchainMissing: boolean;
  readonly offline: boolean;
  readonly canCancel: boolean;
  readonly canRebuild: boolean;
  /** One-line summary for the collapsed diagnostics strip. */
  readonly firstDiagnosticLine: string | null;
  readonly viewer: LatexViewerState;
}

const ACTIVE_LATEX_BUILD_STATES: ReadonlySet<ScientLatexBuildState> = new Set([
  "queued",
  "running",
  "publishing",
]);

export function isActiveLatexBuildState(state: ScientLatexBuildState): boolean {
  return ACTIVE_LATEX_BUILD_STATES.has(state);
}

export function latexDiagnosticCounts(diagnostics: ReadonlyArray<ScientLatexDiagnostic>): {
  readonly errors: number;
  readonly warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

/** `main.tex:12`, `main.tex`, or nothing when the log never named a file. */
export function formatLatexDiagnosticLocation(diagnostic: ScientLatexDiagnostic): string | null {
  if (diagnostic.file === null) return null;
  const fileName = diagnostic.file.split(/[\\/]/u).at(-1) ?? diagnostic.file;
  return diagnostic.line === null ? fileName : `${fileName}:${diagnostic.line}`;
}

export function formatLatexDiagnosticLine(diagnostic: ScientLatexDiagnostic): string {
  const location = formatLatexDiagnosticLocation(diagnostic);
  return location === null ? diagnostic.message : `${location} ${diagnostic.message}`;
}

export interface LatexDiagnosticRow {
  readonly key: string;
  readonly diagnostic: ScientLatexDiagnostic;
}

/**
 * Rows for the diagnostics list. A log repeats the same message often enough
 * that identity has to include which occurrence this is.
 */
export function latexDiagnosticRows(
  diagnostics: ReadonlyArray<ScientLatexDiagnostic>,
): ReadonlyArray<LatexDiagnosticRow> {
  const occurrences = new Map<string, number>();
  return diagnostics.map((diagnostic) => {
    const identity = `${diagnostic.severity}:${diagnostic.file ?? ""}:${diagnostic.line ?? ""}:${diagnostic.message}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return { key: `${identity}#${occurrence}`, diagnostic };
  });
}

function buildLabel(state: ScientLatexBuildState): string {
  switch (state) {
    case "queued":
      return "Queued…";
    case "running":
      return "Building…";
    case "publishing":
      return "Publishing…";
    case "succeeded":
      return "Built";
    case "failed":
      return "Build failed";
    case "cancelled":
      return "Build cancelled";
    case "idle":
      return "Not built yet";
  }
}

export function latexStatusStripModel(status: LatexBuildStatus): LatexStatusStripModel {
  const snapshot = status.snapshot;
  const state = snapshot?.state ?? "idle";
  const active = isActiveLatexBuildState(state);
  const installing = status.installRequesting || isActiveLatexInstall(status.managedInstall);
  const busy = active || status.requesting || installing;
  const counts = latexDiagnosticCounts(snapshot?.diagnostics ?? []);
  const descriptor = snapshot?.descriptor ?? null;
  const generated = descriptor !== null && descriptor._tag === "generated-pdf" ? descriptor : null;
  const toolchainMissing = status.toolchain !== null && status.toolchain.kind === null;
  const offline = status.error !== null;
  const firstDiagnostic =
    snapshot?.diagnostics.find((diagnostic) => diagnostic.severity === "error") ??
    snapshot?.diagnostics[0] ??
    null;

  return {
    state,
    busy,
    label: installing
      ? LATEX_INSTALLING_LABEL
      : toolchainMissing
        ? LATEX_TOOLCHAIN_MISSING_TITLE
        : busy
          ? buildLabel(status.requesting && !active ? "running" : state)
          : offline
            ? "Build status unavailable"
            : buildLabel(state),
    errorCount: counts.errors,
    warningCount: counts.warnings,
    stale: generated?.bindingStatus === "stale",
    staleReason: generated?.staleReason ?? null,
    toolchainMissing,
    offline,
    canCancel: active,
    canRebuild: !status.requesting && !installing,
    firstDiagnosticLine:
      firstDiagnostic === null ? null : formatLatexDiagnosticLine(firstDiagnostic),
    viewer:
      descriptor !== null ? "pdf" : state === "failed" ? "diagnostics" : busy ? "building" : "idle",
  };
}
