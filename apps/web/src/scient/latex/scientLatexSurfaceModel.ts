import type {
  ScientLatexBuildSnapshot,
  ScientLatexBuildState,
  ScientLatexDiagnostic,
  ScientLatexManagedInstallState,
  ScientLatexToolchainStatus,
} from "@t3tools/contracts";

import { isActiveLatexInstall } from "./latexToolchainSetupModel";

/**
 * Scient-owned browser storage keeps the `scient.` prefix and a camelCase
 * name, so nothing this fork remembers can collide with an inherited
 * `t3code.*` key or be mistaken for one when a profile is inspected.
 */
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

/** Past this many names the count says more than the list the strip can show. */
const MAX_NAMED_INSTALLING_PACKAGES = 2;
/**
 * A first build names more of them, because there the list is the explanation:
 * a document that has never built fetches its whole preamble at once, and
 * "and 6 more" after two names reads as a stall rather than as progress.
 */
const MAX_NAMED_FIRST_BUILD_PACKAGES = 6;

/**
 * What the strip says while a build waits for a package the document turned
 * out to need. Naming the packages is the point: the build looks stalled
 * otherwise, and this is the one pause that is not the compiler's. A long list
 * leads with how many there are, because the strip is one line and the tail of
 * it is the first thing an ellipsis takes.
 */
export function latexInstallingPackagesLabel(packages: ReadonlyArray<string>): string {
  if (packages.length <= MAX_NAMED_INSTALLING_PACKAGES) {
    return `Installing LaTeX packages: ${packages.join(", ")}…`;
  }
  const named = packages.slice(0, MAX_NAMED_INSTALLING_PACKAGES).join(", ");
  return `Installing ${String(packages.length)} LaTeX packages: ${named}…`;
}

/**
 * And what it says the first time, before this document has ever produced a
 * PDF. A first build against a distribution Scient installed fetches every
 * package the preamble names in one go, which is the slowest thing this
 * feature ever does and the only time the wait is measured in minutes. Saying
 * so is the difference between a reader waiting and a reader deciding the app
 * has hung; every later build is fast, and says the ordinary thing.
 */
export function latexFirstBuildInstallingLabel(packages: ReadonlyArray<string>): string {
  const named =
    packages.length <= MAX_NAMED_FIRST_BUILD_PACKAGES
      ? packages.join(", ")
      : `${packages.slice(0, MAX_NAMED_FIRST_BUILD_PACKAGES).join(", ")} and ${String(
          packages.length - MAX_NAMED_FIRST_BUILD_PACKAGES,
        )} more`;
  return `First build: installing LaTeX packages (this can take a few minutes) — ${named}`;
}

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

/** One arrow press worth of divider travel. */
export const LATEX_SPLIT_KEYBOARD_STEP = 0.02;

/**
 * The divider from the keyboard: arrows step it, Home and End park it at the
 * limits, and every other key is left to the browser. `null` means this key
 * is not the divider's to handle.
 */
export function nudgeLatexSplitFraction(current: number, key: string): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampLatexSplitFraction(current - LATEX_SPLIT_KEYBOARD_STEP);
    case "ArrowRight":
      return clampLatexSplitFraction(current + LATEX_SPLIT_KEYBOARD_STEP);
    case "Home":
      return MIN_LATEX_SPLIT_FRACTION;
    case "End":
      return 1 - MIN_LATEX_SPLIT_FRACTION;
    default:
      return null;
  }
}

/** Windows and POSIX paths compare and read the same way here. */
function normalizeLatexPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

/**
 * The root document this build actually compiles, when it is not the file on
 * screen: an included chapter builds through the root that pulls it in, and
 * saying so is the only way that reads as deliberate rather than as the
 * viewer showing the wrong document.
 */
export function latexCompiledFromPath(
  rootRelativePath: string | null | undefined,
  relativePath: string,
): string | null {
  if (rootRelativePath === null || rootRelativePath === undefined) return null;
  const root = normalizeLatexPath(rootRelativePath);
  if (root.length === 0 || root === normalizeLatexPath(relativePath)) return null;
  return root;
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

/**
 * The file a diagnostic names, as the reader knows it: rebased on the
 * workspace root so a message from `chapters/intro.tex` is not indexed under
 * the same `intro.tex` as every other chapter's, and left whole when the log
 * pointed outside the workspace (a class file from the distribution, say).
 */
export function latexDiagnosticPath(file: string, workspaceRoot: string | null): string {
  const path = normalizeLatexPath(file);
  if (workspaceRoot === null) return path;
  const root = normalizeLatexPath(workspaceRoot).replace(/\/+$/u, "");
  return root.length > 0 && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** `chapters/intro.tex:12`, `chapters/intro.tex`, or nothing when no file was named. */
export function formatLatexDiagnosticLocation(
  diagnostic: ScientLatexDiagnostic,
  workspaceRoot: string | null = null,
): string | null {
  if (diagnostic.file === null) return null;
  const path = latexDiagnosticPath(diagnostic.file, workspaceRoot);
  return diagnostic.line === null ? path : `${path}:${diagnostic.line}`;
}

export function formatLatexDiagnosticLine(
  diagnostic: ScientLatexDiagnostic,
  workspaceRoot: string | null = null,
): string {
  const location = formatLatexDiagnosticLocation(diagnostic, workspaceRoot);
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

type LatexPdfDescriptor = ScientLatexBuildSnapshot["descriptor"];

function descriptorsEqual(left: LatexPdfDescriptor, right: LatexPdfDescriptor): boolean {
  if (left === null || right === null) return left === right;
  if (
    left._tag !== right._tag ||
    left.logicalDocumentKey !== right.logicalDocumentKey ||
    left.title !== right.title ||
    left.fileName !== right.fileName
  ) {
    return false;
  }
  switch (left._tag) {
    case "generated-pdf":
      return (
        right._tag === "generated-pdf" &&
        left.artifactId === right.artifactId &&
        left.revisionId === right.revisionId &&
        left.bindingGeneration === right.bindingGeneration &&
        left.bindingStatus === right.bindingStatus &&
        left.staleReason === right.staleReason
      );
    case "workspace-pdf":
      return (
        right._tag === "workspace-pdf" &&
        left.workspaceRoot === right.workspaceRoot &&
        left.relativePath === right.relativePath
      );
    case "environment-pdf":
      return right._tag === "environment-pdf" && left.path === right.path;
  }
}

/**
 * Whether two toolchain reports say the same thing. Identity says nothing
 * here: a snapshot decoded off the wire carries a freshly built object every
 * poll, so anything comparing toolchains by reference compares two different
 * objects describing one unchanged engine.
 */
export function toolchainsEqual(
  left: ScientLatexToolchainStatus | null,
  right: ScientLatexToolchainStatus | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.executable === right.executable &&
    left.version === right.version &&
    left.source === right.source &&
    left.probedAtEpochMs === right.probedAtEpochMs
  );
}

function stringListsEqual(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function diagnosticsEqual(
  left: ReadonlyArray<ScientLatexDiagnostic>,
  right: ReadonlyArray<ScientLatexDiagnostic>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((diagnostic, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      diagnostic.severity === other.severity &&
      diagnostic.file === other.file &&
      diagnostic.line === other.line &&
      diagnostic.message === other.message
    );
  });
}

/**
 * Whether two polls of the same document say the same thing. A build that
 * takes ten seconds answers the same snapshot six times over; holding onto
 * the first one keeps the surface — and the PDF reader inside it — from
 * re-rendering for news that never arrived.
 */
export function latexSnapshotsEqual(
  left: ScientLatexBuildSnapshot,
  right: ScientLatexBuildSnapshot,
): boolean {
  return (
    left.state === right.state &&
    left.pendingRerun === right.pendingRerun &&
    left.logicalDocumentKey === right.logicalDocumentKey &&
    left.rootRelativePath === right.rootRelativePath &&
    left.failureSummary === right.failureSummary &&
    left.startedAtEpochMs === right.startedAtEpochMs &&
    left.finishedAtEpochMs === right.finishedAtEpochMs &&
    // A build that stops to fetch a package stays `running` throughout, so
    // this is the only field that says the strip has something new to show.
    stringListsEqual(left.installingPackages, right.installingPackages) &&
    descriptorsEqual(left.descriptor, right.descriptor) &&
    toolchainsEqual(left.toolchain, right.toolchain) &&
    diagnosticsEqual(left.diagnostics, right.diagnostics)
  );
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

export function latexStatusStripModel(
  status: LatexBuildStatus,
  workspaceRoot: string | null = null,
): LatexStatusStripModel {
  const snapshot = status.snapshot;
  const state = snapshot?.state ?? "idle";
  const active = isActiveLatexBuildState(state);
  const installing = status.installRequesting || isActiveLatexInstall(status.managedInstall);
  const installingPackages = snapshot?.installingPackages ?? [];
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
      : installingPackages.length > 0
        ? // No descriptor means this document has never produced a PDF here, so
          // this fetch is the one standing between the reader and their first
          // one — and the only one worth setting expectations for.
          descriptor === null
          ? latexFirstBuildInstallingLabel(installingPackages)
          : latexInstallingPackagesLabel(installingPackages)
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
      firstDiagnostic === null ? null : formatLatexDiagnosticLine(firstDiagnostic, workspaceRoot),
    viewer:
      descriptor !== null ? "pdf" : state === "failed" ? "diagnostics" : busy ? "building" : "idle",
  };
}
