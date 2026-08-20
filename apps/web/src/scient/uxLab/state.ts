import {
  DEFAULT_COMPUTE_LAB_SCENARIO,
  normalizeComputeLabScenario,
  type ComputeLabScenario,
} from "./computeFixtures";

export const SCIENT_UX_LAB_ENABLED = import.meta.env.VITE_SCIENT_UX_LAB === "1";

export const uxLabJourneys = [
  { value: "zotero-sources", label: "Zotero sources" },
  { value: "matlab-run-file", label: "MATLAB run file" },
  { value: "compute-session", label: "Compute session (design)" },
] as const;

export type UxLabJourney = (typeof uxLabJourneys)[number]["value"];

export const sourcesLabScenarios = [
  { value: "imported", label: "Imported sources" },
  { value: "recent-import", label: "Import just completed" },
  { value: "warning", label: "Metadata warning" },
  { value: "empty", label: "No sources" },
] as const;

export type SourcesLabScenario = (typeof sourcesLabScenarios)[number]["value"];

export const matlabLabScenarios = [
  {
    value: "success",
    label: "Successful cohort analysis",
    relativePath: "ux-lab-fixtures/matlab/cohort_analysis.m",
  },
  {
    value: "failure",
    label: "MATLAB error",
    relativePath: "ux-lab-fixtures/matlab/failed_analysis.m",
  },
  {
    value: "long-running",
    label: "Long run to stop",
    relativePath: "ux-lab-fixtures/matlab/long_running_analysis.m",
  },
] as const;

export type MatlabLabScenario = (typeof matlabLabScenarios)[number]["value"];

const JOURNEY_STORAGE_KEY = "scient.uxLab.journey";
const SOURCES_SCENARIO_STORAGE_KEY = "scient.uxLab.sourcesScenario";
const MATLAB_SCENARIO_STORAGE_KEY = "scient.uxLab.matlabScenario";
const COMPUTE_SCENARIO_STORAGE_KEY = "scient.uxLab.computeScenario";
const CONTROL_POSITION_STORAGE_KEY = "scient.uxLab.controlPosition";

export interface UxLabControlPosition {
  readonly x: number;
  readonly y: number;
}

export function normalizeUxLabJourney(value: string | null): UxLabJourney {
  return uxLabJourneys.some((journey) => journey.value === value)
    ? (value as UxLabJourney)
    : "zotero-sources";
}

export function readUxLabJourney(): UxLabJourney {
  if (!SCIENT_UX_LAB_ENABLED || typeof window === "undefined") return "zotero-sources";
  return normalizeUxLabJourney(window.localStorage.getItem(JOURNEY_STORAGE_KEY));
}

export function selectUxLabJourney(value: UxLabJourney): void {
  window.localStorage.setItem(JOURNEY_STORAGE_KEY, value);
  window.location.reload();
}

export function normalizeSourcesLabScenario(value: string | null): SourcesLabScenario {
  return sourcesLabScenarios.some((scenario) => scenario.value === value)
    ? (value as SourcesLabScenario)
    : "imported";
}

export function readSourcesLabScenario(): SourcesLabScenario {
  if (!SCIENT_UX_LAB_ENABLED || typeof window === "undefined") return "imported";
  return normalizeSourcesLabScenario(window.localStorage.getItem(SOURCES_SCENARIO_STORAGE_KEY));
}

export function selectSourcesLabScenario(value: SourcesLabScenario): void {
  window.localStorage.setItem(SOURCES_SCENARIO_STORAGE_KEY, value);
  window.location.reload();
}

export function normalizeMatlabLabScenario(value: string | null): MatlabLabScenario {
  return matlabLabScenarios.some((scenario) => scenario.value === value)
    ? (value as MatlabLabScenario)
    : "success";
}

export function readMatlabLabScenario(): MatlabLabScenario {
  if (!SCIENT_UX_LAB_ENABLED || typeof window === "undefined") return "success";
  return normalizeMatlabLabScenario(window.localStorage.getItem(MATLAB_SCENARIO_STORAGE_KEY));
}

export function selectMatlabLabScenario(value: MatlabLabScenario): void {
  window.localStorage.setItem(MATLAB_SCENARIO_STORAGE_KEY, value);
  window.location.reload();
}

export function matlabLabScenarioDefinition(value: MatlabLabScenario) {
  return matlabLabScenarios.find((scenario) => scenario.value === value)!;
}

export function readComputeLabScenario(): ComputeLabScenario {
  if (!SCIENT_UX_LAB_ENABLED || typeof window === "undefined") return DEFAULT_COMPUTE_LAB_SCENARIO;
  return normalizeComputeLabScenario(window.localStorage.getItem(COMPUTE_SCENARIO_STORAGE_KEY));
}

/**
 * Unlike the other journeys, selecting a compute scenario does not reload.
 *
 * Sources and MATLAB scenarios are installed before the app boots, because they
 * replace external state the app reads once at startup. Compute fixtures are
 * read by a lab surface at render time, so a reload would only cost the panel
 * its expanded tracebacks -- exactly the state a designer is comparing across
 * scenarios.
 */
export function selectComputeLabScenario(value: ComputeLabScenario): void {
  window.localStorage.setItem(COMPUTE_SCENARIO_STORAGE_KEY, value);
}

export function normalizeUxLabControlPosition(value: string | null): UxLabControlPosition | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "x" in parsed &&
      "y" in parsed &&
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // Invalid development-only state falls back to the default corner.
  }
  return null;
}

export function readUxLabControlPosition(): UxLabControlPosition | null {
  if (!SCIENT_UX_LAB_ENABLED || typeof window === "undefined") return null;
  return normalizeUxLabControlPosition(window.localStorage.getItem(CONTROL_POSITION_STORAGE_KEY));
}

export function saveUxLabControlPosition(position: UxLabControlPosition): void {
  window.localStorage.setItem(CONTROL_POSITION_STORAGE_KEY, JSON.stringify(position));
}
