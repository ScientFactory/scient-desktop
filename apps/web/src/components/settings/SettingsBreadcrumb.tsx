import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/skills/external": "External skills",
  "/settings/skills/project": "Project skills",
  "/settings/open-source-licenses": "Open source licenses",
  // SCIENT-FORK:START — Scient Extensions subpages
  "/settings/extensions/installed": "Installed extensions",
  "/settings/extensions/all": "All MCP servers",
  // SCIENT-FORK:END
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  // SCIENT-FORK:START — Extensions category and item pages fall back to the section.
  if (normalizedPathname.startsWith("/settings/extensions/")) {
    return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? "Extensions";
  }
  // SCIENT-FORK:END
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? "Settings"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
