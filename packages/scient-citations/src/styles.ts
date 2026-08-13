export const SCIENT_REFERENCE_STYLES = [
  { id: "vancouver", label: "Vancouver" },
  { id: "apa", label: "APA 7" },
] as const;

export type ScientReferenceStyleId = (typeof SCIENT_REFERENCE_STYLES)[number]["id"];
