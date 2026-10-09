import { SETTINGS_SECTION_LABELS } from "~/components/settings/settingsSearch";
import type { RightPanelSurface } from "~/rightPanelStore";

export function panelCategory(surface: RightPanelSurface): string {
  switch (surface.kind) {
    case "preview":
      return "browser";
    case "file":
      return "file-preview";
    case "scient":
      return surface.module === "file" ? "file-preview" : surface.module;
    default:
      return surface.kind;
  }
}

/**
 * Every settings page, from the sidebar's own list, so a new page is never
 * reported as "other". The analytics contract must name each one; a test
 * checks it does.
 */
export const SETTINGS_ANALYTICS_SECTIONS: ReadonlySet<string> = new Set(
  Object.keys(SETTINGS_SECTION_LABELS).map((path) => path.split("/")[2] ?? ""),
);
export function settingsCategory(pathname: string): string | null {
  if (!pathname.startsWith("/settings/")) return null;
  const section = pathname.split("/")[2] ?? "";
  return SETTINGS_ANALYTICS_SECTIONS.has(section) ? section : "other";
}
