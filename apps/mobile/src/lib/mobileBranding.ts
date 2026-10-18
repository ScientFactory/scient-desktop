// SCIENT-FORK:START mobile-stage-label
// Scient keeps its own release-stage label; upstream T3's Alpha-to-Beta rename is not adopted.
export type MobileStageLabel = "Alpha" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Alpha";
}
// SCIENT-FORK:END mobile-stage-label
