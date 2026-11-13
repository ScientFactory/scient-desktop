import { msg, useMessages } from "gt-react";

import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_LABEL = msg("Settings");

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  // SCIENT-FORK:START — Scient Accounts: label account settings.
  "/settings/accounts": "Accounts & secrets",
  // SCIENT-FORK:END
  "/settings/diagnostics": msg("Diagnostics"),
  // SCIENT-FORK:START — Scient skills subpages
  "/settings/skills/external": "External skills",
  "/settings/skills/project": "Project skills",
  // SCIENT-FORK:END
  "/settings/open-source-licenses": msg("Open source licenses"),
  // SCIENT-FORK:START — Scient Extensions subpages
  "/settings/extensions/installed": "Installed extensions",
  "/settings/extensions/all": "All MCP servers",
  // SCIENT-FORK:END
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  // SCIENT-FORK:START — Extensions and language pages fall back to their section.
  if (normalizedPathname.startsWith("/settings/extensions/")) {
    return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? "Extensions";
  }
  if (normalizedPathname.startsWith("/settings/scientific-computing/")) {
    return "Scientific Computing";
  }
  // SCIENT-FORK:END
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const m = useMessages();
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{m(SETTINGS_LABEL)}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {m(sectionLabel ?? SETTINGS_LABEL)}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
