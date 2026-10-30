import {
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeLanguageRuntimeInspection,
  type ComputeSessionRecord,
} from "@t3tools/contracts";

import { computeScientPart } from "./computeInstallationSettingsModel";

type ComputeRuntimeProfile = ComputeLanguageRuntimeInspection["runtimes"][number]["profile"];

export const SCIENTIFIC_PYTHON_TOOLKIT_ID = "python-data-and-figures";

function computeRuntimeSourceLabel(source: ComputeRuntimeProfile["source"]): string {
  switch (source) {
    case "managed":
      return "Scient-managed";
    case "project":
      return "Project";
    case "configured":
      return "Custom";
    case "path":
    case "conventional":
      return "System";
  }
}

export function computeRuntimeDisplayLabel(
  profile: ComputeRuntimeProfile,
  languageName = "Python",
): string {
  const version = profile.languageVersion.trim();
  return `${version.length > 0 && version !== "unknown" ? `${languageName} ${version}` : languageName} · ${computeRuntimeSourceLabel(profile.source)}`;
}

/** A runtime as the Console's picker names it; where it came from only tells two apart. */
export function computeRuntimeChoiceLabel(
  runtime: {
    readonly languageId: string;
    readonly languageName: string;
    readonly profile: ComputeRuntimeProfile;
  },
  runtimes: ReadonlyArray<{ readonly languageId: string }>,
): string {
  const version = runtime.profile.languageVersion.trim();
  // SQL's version is DuckDB's, and a kernel may not report one.
  const name =
    runtime.languageId === "sql" || version === "" || version === "unknown"
      ? runtime.languageName
      : `${runtime.languageName} ${version}`;
  if (runtimes.filter((other) => other.languageId === runtime.languageId).length < 2) return name;
  const { source, origin } = runtime.profile;
  return `${name} · ${source === "managed" ? "Scient-managed" : (origin ?? "System")}`;
}

/** A stop or read proves shutdown only for the exact session and generation, in a terminal status. */
export function isExactTerminalComputeSession(
  record: Pick<ComputeSessionRecord, "sessionId" | "generation" | "status">,
  expected: Pick<ComputeSessionRecord, "sessionId" | "generation">,
): boolean {
  return (
    record.sessionId === expected.sessionId &&
    record.generation === expected.generation &&
    TERMINAL_COMPUTE_SESSION_STATUSES.has(record.status)
  );
}

export type ComputePreRunRuntimeChoice = {
  readonly current: ComputeLanguageRuntimeInspection["runtimes"][number];
  readonly managed: ComputeLanguageRuntimeInspection["runtimes"][number];
};

/**
 * Offers a choice only when the automatic Python can run Compute itself but is
 * missing the required scientific Toolkit and an already-installed managed
 * runtime has that Toolkit ready. This never installs or changes a preference.
 */
export function resolveComputePreRunRuntimeChoice(
  language: ComputeLanguageRuntimeInspection | null,
): ComputePreRunRuntimeChoice | null {
  if (language?.enabled !== true || language.descriptor.languageId !== "python") return null;
  const current = language.runtimes[0];
  if (
    current === undefined ||
    current.profile.source === "managed" ||
    current.verification.readiness !== "ready" ||
    current.toolkits.find((toolkit) => toolkit.toolkitId === SCIENTIFIC_PYTHON_TOOLKIT_ID)
      ?.readiness !== "missing-requirement"
  )
    return null;

  const managedStatus = language.managedRuntime;
  if (
    managedStatus?.installed !== true ||
    managedStatus.operation !== null ||
    Boolean(managedStatus.failure) ||
    Boolean(managedStatus.failureMessage) ||
    managedStatus.toolkitChanges?.some((change) => change.state !== "failed")
  )
    return null;

  const managed = language.runtimes.find(
    (candidate) =>
      candidate.profile.source === "managed" &&
      candidate.verification.readiness === "ready" &&
      candidate.toolkits.find((toolkit) => toolkit.toolkitId === SCIENTIFIC_PYTHON_TOOLKIT_ID)
        ?.readiness === "ready",
  );
  return managed === undefined ? null : { current, managed };
}

/**
 * The runtime new sessions use, as the server chose it. Servers without a selection record put
 * their preference first; that order is not a list to skip until something runs.
 */
export function defaultComputeRuntime(languages: ReadonlyArray<ComputeLanguageRuntimeInspection>) {
  const language = languages.find((candidate) => candidate.enabled);
  if (language?.selection !== undefined) {
    const executable = language.selection.executable;
    return (
      language.runtimes.find(
        (candidate) =>
          candidate.profile.executable === executable &&
          candidate.verification.readiness === "ready",
      ) ?? null
    );
  }
  const candidate = language?.runtimes[0];
  return candidate?.verification.readiness === "ready" ? candidate : null;
}

/** Why the runtime the user or project chose cannot run, when that blocks Run. */
export interface ComputeReadyRuntime {
  readonly language: ComputeLanguageRuntimeInspection;
  readonly candidate: ComputeLanguageRuntimeInspection["runtimes"][number];
  readonly key: string;
}

/** What a Console runs on: what its session used, or failing that what was picked, or the default. */
export function computeConsoleRuntime(input: {
  readonly ready: ReadonlyArray<ComputeReadyRuntime>;
  readonly session: Pick<ComputeSessionRecord, "languageId" | "runtime"> | null;
  readonly chosenKey: string;
  readonly defaultRuntime: ComputeReadyRuntime["candidate"] | null;
}): ComputeReadyRuntime | null {
  const { ready, session, chosenKey, defaultRuntime } = input;
  const sameLanguage = ready.filter(
    (runtime) => runtime.language.descriptor.languageId === session?.languageId,
  );
  return (
    sameLanguage.find(
      (runtime) => runtime.candidate.profile.executable === session?.runtime?.executable,
    ) ??
    sameLanguage[0] ??
    ready.find((runtime) => runtime.key === chosenKey) ??
    ready.find((runtime) => runtime.candidate === defaultRuntime) ??
    null
  );
}

export function computeRuntimeBlocker(
  language: ComputeLanguageRuntimeInspection | null,
): { readonly mode: "explicit" | "project"; readonly problem: string } | null {
  const selection = language?.selection;
  if (selection === undefined || selection.mode === "automatic" || selection.executable !== null)
    return null;
  return { mode: selection.mode, problem: selection.problem ?? "" };
}

import {
  clampScientSplitFraction,
  nudgeScientSplitFraction,
  scientSplitFractionFromPointer,
  type ScientSplitAxis,
} from "~/scient/layout/scientSplitFraction";

// Keep the existing key for compatibility. It now remembers only the layout to
// reveal after Run; opening a source file itself always starts in Code.
export const COMPUTE_FILE_RESULTS_VIEW_STORAGE_KEY = "scient.pythonComputeView";
export const COMPUTE_FILE_SPLIT_STORAGE_KEY = "scient.pythonComputeSplitRatio";
export const COMPUTE_FILE_SPLIT_LAYOUT_STORAGE_KEY = "scient.pythonComputeSplitLayout";

export const COMPUTE_FILE_VIEWS = ["code", "split", "results"] as const;
export type ComputeFileView = (typeof COMPUTE_FILE_VIEWS)[number];
export type ComputeFileResultsView = Exclude<ComputeFileView, "code">;

const COMPUTE_FILE_SPLIT_LAYOUTS = ["side-by-side", "stacked"] as const;
export type ComputeFileSplitLayout = (typeof COMPUTE_FILE_SPLIT_LAYOUTS)[number];

export const COMPUTE_FILE_VIEW_LABELS: Readonly<Record<ComputeFileView, string>> = {
  code: "Code",
  split: "Split",
  results: "Results",
};

export const DEFAULT_COMPUTE_FILE_RESULTS_VIEW: ComputeFileResultsView = "split";
export const DEFAULT_COMPUTE_FILE_SPLIT_LAYOUT: ComputeFileSplitLayout = "side-by-side";
export const DEFAULT_COMPUTE_FILE_SPLIT = 0.5;
export const MIN_COMPUTE_FILE_SPLIT = 0.3;
export const COMPUTE_FILE_SPLIT_KEYBOARD_STEP = 0.02;

type ComputeRuntimeToolbarSession = Pick<
  ComputeSessionRecord,
  "activity" | "label" | "languageId" | "runtime" | "status"
>;

export type ComputeRuntimeToolbarState =
  | {
      readonly kind: "setup";
      readonly label: string;
      readonly canRun: false;
    }
  | {
      readonly kind: "status";
      readonly label: string;
      readonly canRun: boolean;
      /** Starting, closing or running: shown as a spinner, never as a word. */
      readonly busy?: true;
      readonly note?: string;
    }
  | {
      readonly kind: "switch";
      readonly label: string;
      readonly canRun: true;
    }
  | {
      /** The check failed: retry it. Never presented as "not installed". */
      readonly kind: "retry";
      readonly label: string;
      readonly canRun: false;
      readonly note?: string;
    }
  | {
      /** The chosen or project runtime cannot run; choose another in settings. */
      readonly kind: "choose";
      readonly label: string;
      readonly canRun: false;
      readonly note: string;
    };

export function computeRuntimeSetupActionLabel(languageId: string, languageName: string): string {
  return languageId === "matlab" ? `Connect ${languageName}` : `Set up ${languageName}`;
}

const SCIENTIFIC_PACKAGES_NOTE = "Some scientific packages are missing";

export function isComputeCapacityReachedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "capacity-reached"
  );
}

const COMPUTE_FILE_SPLIT_BOUNDS = {
  minimum: MIN_COMPUTE_FILE_SPLIT,
  fallback: DEFAULT_COMPUTE_FILE_SPLIT,
} as const;

export function normalizeComputeFileResultsView(
  value: string | null | undefined,
): ComputeFileResultsView {
  return value === "results" ? "results" : DEFAULT_COMPUTE_FILE_RESULTS_VIEW;
}

export function computeFileViewAfterRun(
  current: ComputeFileView,
  preferredResultsView: ComputeFileResultsView,
): ComputeFileView {
  return current === "code" ? preferredResultsView : current;
}

export function normalizeComputeFileSplitLayout(
  value: string | null | undefined,
): ComputeFileSplitLayout {
  if (value === "horizontal") return "side-by-side";
  if (value === "vertical") return "stacked";
  return (
    COMPUTE_FILE_SPLIT_LAYOUTS.find((candidate) => candidate === value) ??
    DEFAULT_COMPUTE_FILE_SPLIT_LAYOUT
  );
}

export function clampComputeFileSplit(value: number): number {
  return clampScientSplitFraction(value, COMPUTE_FILE_SPLIT_BOUNDS);
}

export function normalizeComputeFileSplit(value: number | null | undefined): number {
  return value === null || value === undefined
    ? DEFAULT_COMPUTE_FILE_SPLIT
    : clampComputeFileSplit(value);
}

export function computeFileSplitFromPointer(input: {
  readonly pointerX: number;
  readonly left: number;
  readonly width: number;
}): number {
  return scientSplitFractionFromPointer(input, COMPUTE_FILE_SPLIT_BOUNDS);
}

export function nudgeComputeFileSplit(
  current: number,
  key: string,
  axis: ScientSplitAxis = "x",
): number | null {
  return nudgeScientSplitFraction(
    current,
    key,
    COMPUTE_FILE_SPLIT_BOUNDS,
    COMPUTE_FILE_SPLIT_KEYBOARD_STEP,
    axis,
  );
}

/** "Python 3.14": the language and version, never the install source or session identity. */
export function computeRuntimeVersionLabel(
  languageName: string,
  version: string | null | undefined,
): string {
  const trimmed = version?.trim();
  return trimmed && trimmed !== "unknown" ? `${languageName} ${trimmed}` : languageName;
}

export function resolveComputeRuntimeToolbarState(input: {
  readonly languageId?: string;
  readonly languageName?: string;
  readonly runtimeVersion?: string | null;
  readonly liveSession: ComputeRuntimeToolbarSession | null;
  readonly runtimeInspectionPending: boolean;
  readonly readyRuntimeAvailable: boolean;
  readonly preferredRuntimeExecutable: string | null;
  readonly scientificPackagesMissing: boolean;
  /** The runtime check failed or returned nothing for this language. */
  readonly runtimeCheckFailure?: string | null;
  readonly runtimeBlocker?: ReturnType<typeof computeRuntimeBlocker>;
  readonly capacityRecoveryAvailable?: boolean;
  readonly startingRetryAvailable?: boolean;
  readonly contextLifecycle?:
    | "unbound"
    | "starting"
    | "live"
    | "closing"
    | "close-failed"
    | "terminal";
}): ComputeRuntimeToolbarState {
  const languageId = input.languageId ?? "python";
  const languageName = input.languageName ?? "Python";
  const session = input.liveSession;
  const label = computeRuntimeVersionLabel(languageName, input.runtimeVersion);
  const note = input.scientificPackagesMissing ? { note: SCIENTIFIC_PACKAGES_NOTE } : {};
  if (input.contextLifecycle === "starting") {
    return input.capacityRecoveryAvailable || input.startingRetryAvailable
      ? { kind: "status", label, canRun: true }
      : { kind: "status", label, canRun: false, busy: true };
  }
  if (input.contextLifecycle === "closing") {
    return { kind: "status", label, canRun: false, busy: true };
  }
  if (input.contextLifecycle === "close-failed") {
    return { kind: "status", label, canRun: false };
  }
  if (session !== null) {
    if (session.languageId !== languageId) {
      return { kind: "status", label: session.label, canRun: false };
    }
    const current = computeRuntimeVersionLabel(languageName, session.runtime?.languageVersion);
    if (session.status !== "ready") {
      return { kind: "status", label: current, canRun: false, busy: true };
    }
    if (session.activity === "busy") {
      return { kind: "status", label: current, canRun: true, busy: true };
    }
    if (
      !input.runtimeInspectionPending &&
      session.runtime !== null &&
      input.preferredRuntimeExecutable !== null &&
      session.runtime.executable !== input.preferredRuntimeExecutable
    ) {
      return { kind: "switch", label: current, canRun: true };
    }
    return { kind: "status", label: current, canRun: true, ...note };
  }
  // Inspect is a package-metadata probe, not proof that a live kernel already
  // exists. Keep the compact language/version label and let Run own startup.
  if (input.readyRuntimeAvailable) {
    return { kind: "status", label, canRun: true, ...note };
  }
  if (input.runtimeInspectionPending) {
    return { kind: "status", label: languageName, canRun: false, busy: true };
  }
  if (input.runtimeCheckFailure != null) {
    return {
      kind: "retry",
      label: `Couldn't check ${languageName}`,
      canRun: false,
      ...(input.runtimeCheckFailure ? { note: input.runtimeCheckFailure } : {}),
    };
  }
  if (input.runtimeBlocker != null) {
    return {
      kind: "choose",
      label:
        input.runtimeBlocker.mode === "project"
          ? "Project environment can't run"
          : `${languageName} unavailable`,
      canRun: false,
      note: input.runtimeBlocker.problem,
    };
  }
  // Scient can set up its own part, but a language that brings its own kernel has to be installed.
  if (computeScientPart(languageId) === null) {
    return {
      kind: "status",
      label: "Not installed",
      canRun: false,
      note: `${languageName} is not installed`,
    };
  }
  return {
    kind: "setup",
    label: computeRuntimeSetupActionLabel(languageId, languageName),
    canRun: false,
  };
}
