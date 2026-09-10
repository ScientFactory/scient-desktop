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

const SECTIONS = new Set([
  "general",
  "appearance",
  "projects",
  "keybindings",
  "providers",
  "custom-models",
  "voice",
  "skills",
  "integrations",
  "scientific-computing",
  "source-control",
  "connections",
  "archived",
]);
export function settingsCategory(pathname: string): string | null {
  if (!pathname.startsWith("/settings/")) return null;
  const section = pathname.split("/")[2] ?? "";
  return SECTIONS.has(section) ? section : "other";
}
