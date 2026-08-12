export const SCIENT_UX_LAB_ENABLED = import.meta.env.VITE_SCIENT_UX_LAB === "1";

export const sourcesLabScenarios = [
  { value: "imported", label: "Imported sources" },
  { value: "recent-import", label: "Import just completed" },
  { value: "warning", label: "Metadata warning" },
  { value: "empty", label: "No sources" },
] as const;

export type SourcesLabScenario = (typeof sourcesLabScenarios)[number]["value"];

const SOURCES_SCENARIO_STORAGE_KEY = "scient.uxLab.sourcesScenario";

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
