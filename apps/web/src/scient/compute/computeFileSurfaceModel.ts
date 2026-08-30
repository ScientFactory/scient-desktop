import type { ComputeSessionRecord, ComputeLanguageRuntimeInspection } from "@t3tools/contracts";

/** Discovery order is the server's preference, not a list to skip until something runs. */
export function defaultComputeRuntime(languages: ReadonlyArray<ComputeLanguageRuntimeInspection>) {
  const language = languages.find((candidate) => candidate.enabled);
  const candidate = language?.runtimes[0];
  return candidate?.verification.readiness === "ready" ? candidate : null;
}

import {
  clampScientSplitFraction,
  nudgeScientSplitFraction,
  scientSplitFractionFromPointer,
  type ScientSplitAxis,
} from "~/scient/layout/scientSplitFraction";

export const COMPUTE_FILE_VIEW_STORAGE_KEY = "scient.pythonComputeView";
export const COMPUTE_FILE_SPLIT_STORAGE_KEY = "scient.pythonComputeSplitRatio";
export const COMPUTE_FILE_SPLIT_LAYOUT_STORAGE_KEY = "scient.pythonComputeSplitLayout";

export const COMPUTE_FILE_VIEWS = ["code", "split", "results"] as const;
export type ComputeFileView = (typeof COMPUTE_FILE_VIEWS)[number];

export const COMPUTE_FILE_SPLIT_LAYOUTS = ["side-by-side", "stacked"] as const;
export type ComputeFileSplitLayout = (typeof COMPUTE_FILE_SPLIT_LAYOUTS)[number];

export const COMPUTE_FILE_VIEW_LABELS: Readonly<Record<ComputeFileView, string>> = {
  code: "Code",
  split: "Split",
  results: "Results",
};

export const DEFAULT_COMPUTE_FILE_VIEW: ComputeFileView = "code";
export const DEFAULT_COMPUTE_FILE_SPLIT_LAYOUT: ComputeFileSplitLayout = "side-by-side";
export const DEFAULT_COMPUTE_FILE_SPLIT = 0.5;
export const MIN_COMPUTE_FILE_SPLIT = 0.2;
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
    }
  | {
      readonly kind: "switch";
      readonly label: string;
      readonly canRun: true;
    };

const COMPUTE_FILE_SPLIT_BOUNDS = {
  minimum: MIN_COMPUTE_FILE_SPLIT,
  fallback: DEFAULT_COMPUTE_FILE_SPLIT,
} as const;

export function normalizeComputeFileView(value: string | null | undefined): ComputeFileView {
  return COMPUTE_FILE_VIEWS.find((candidate) => candidate === value) ?? DEFAULT_COMPUTE_FILE_VIEW;
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

export function resolveComputeRuntimeToolbarState(input: {
  readonly languageId?: string;
  readonly languageName?: string;
  readonly liveSession: ComputeRuntimeToolbarSession | null;
  readonly runtimeInspectionPending: boolean;
  readonly readyRuntimeAvailable: boolean;
  readonly preferredRuntimeExecutable: string | null;
  readonly scientificPackagesMissing: boolean;
}): ComputeRuntimeToolbarState {
  const languageId = input.languageId ?? "python";
  const languageName = input.languageName ?? "Python";
  const session = input.liveSession;
  if (session !== null) {
    if (session.languageId !== languageId) {
      return { kind: "status", label: `${session.label} active`, canRun: false };
    }
    if (session.status !== "ready") {
      return { kind: "status", label: `${languageName} ${session.status}`, canRun: false };
    }
    if (session.activity === "busy") {
      return { kind: "status", label: `${languageName} running`, canRun: true };
    }
    if (
      !input.runtimeInspectionPending &&
      session.runtime !== null &&
      input.preferredRuntimeExecutable !== null &&
      session.runtime.executable !== input.preferredRuntimeExecutable
    ) {
      return { kind: "switch", label: `Switch ${languageName}`, canRun: true };
    }
    return {
      kind: "status",
      label: input.scientificPackagesMissing
        ? `${languageName} packages missing`
        : `${languageName} ready`,
      canRun: true,
    };
  }
  if (input.readyRuntimeAvailable) {
    return {
      kind: "status",
      label: input.scientificPackagesMissing
        ? `${languageName} packages missing`
        : `${languageName} ready`,
      canRun: true,
    };
  }
  if (input.runtimeInspectionPending) {
    return { kind: "status", label: `Checking ${languageName}…`, canRun: false };
  }
  return { kind: "setup", label: `Set up ${languageName}`, canRun: false };
}
