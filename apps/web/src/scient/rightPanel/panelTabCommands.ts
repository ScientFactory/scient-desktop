import type { RightPanelSurface } from "~/rightPanelStore";

/** The tab `step` places from the open one, wrapping at either end. */
export function adjacentPanelSurface(
  surfaces: readonly RightPanelSurface[],
  activeSurfaceId: string | null,
  step: 1 | -1,
): RightPanelSurface | null {
  if (surfaces.length < 2) return null;
  const index = surfaces.findIndex((surface) => surface.id === activeSurfaceId);
  if (index < 0) return surfaces[0] ?? null;
  return surfaces[(index + step + surfaces.length) % surfaces.length] ?? null;
}

/**
 * Tabs a second copy makes sense for: a browser page, while browsers can be
 * opened here, and a terminal (a new shell in the same project). Files, Diff,
 * Sources and documents are one view per project.
 */
export function canDuplicatePanelSurface(
  surface: RightPanelSurface,
  options: { readonly browserAvailable: boolean },
): boolean {
  return (surface.kind === "preview" && options.browserAvailable) || surface.kind === "terminal";
}
