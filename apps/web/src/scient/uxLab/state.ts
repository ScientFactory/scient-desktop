export const SCIENT_UX_LAB_ENABLED = import.meta.env.VITE_SCIENT_UX_LAB === "1";

export const sourcesLabScenarios = [
  { value: "imported", label: "Imported sources" },
  { value: "recent-import", label: "Import just completed" },
  { value: "warning", label: "Metadata warning" },
  { value: "empty", label: "No sources" },
] as const;

export type SourcesLabScenario = (typeof sourcesLabScenarios)[number]["value"];

const SOURCES_SCENARIO_STORAGE_KEY = "scient.uxLab.sourcesScenario";
const CONTROL_POSITION_STORAGE_KEY = "scient.uxLab.controlPosition";

export interface UxLabControlPosition {
  readonly x: number;
  readonly y: number;
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
