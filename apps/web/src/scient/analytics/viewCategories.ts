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

function fileTabName(surface: RightPanelSurface): string | null {
  if (surface.kind === "file") return surface.attachment?.name ?? surface.relativePath;
  return surface.kind === "scient" && surface.module === "file" ? surface.path : null;
}

/**
 * What a right-panel tab reports when it is shown. A file tab adds its extension, which the
 * analytics contract keeps only when it is on its list of known file types.
 */
export function panelViewProperties(surface: RightPanelSurface): Record<string, string> {
  const category = panelCategory(surface);
  const name = fileTabName(surface)?.split(/[\\/]/).at(-1);
  if (name === undefined) return { category };
  const dot = name.lastIndexOf(".");
  return { category, fileType: dot > 0 ? name.slice(dot + 1).toLowerCase() : "none" };
}

// Pages split or renamed from a page the deployed gateway's contract names report as that page.
const CONTRACT_SECTION_BY_PAGE: Readonly<Record<string, string>> = {
  about: "general",
  chat: "general",
  diffs: "general",
  threads: "general",
  access: "connections",
  browser: "integrations",
  devices: "integrations",
  labs: "beta",
  maintenance: "storage",
  // Upstream's secret providers (off behind its flag) report with Scient's credentials.
  secrets: "accounts",
  worktrees: "storage",
};

const SETTINGS_PAGES: ReadonlySet<string> = new Set(
  Object.keys(SETTINGS_SECTION_LABELS).map((path) => path.split("/")[2] ?? ""),
);

/**
 * The section reported for every settings page, from the sidebar's own list, so
 * a new page is never reported as "other". The analytics contract must name
 * each one; a test checks it does.
 */
export const SETTINGS_ANALYTICS_SECTIONS: ReadonlySet<string> = new Set(
  [...SETTINGS_PAGES].map((page) => CONTRACT_SECTION_BY_PAGE[page] ?? page),
);
export function settingsCategory(pathname: string): string | null {
  if (!pathname.startsWith("/settings/")) return null;
  const page = pathname.split("/")[2] ?? "";
  return SETTINGS_PAGES.has(page) ? (CONTRACT_SECTION_BY_PAGE[page] ?? page) : "other";
}
