import { msg, useGT, useMessages } from "gt-react";

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
  "/settings/accounts": msg("Accounts & secrets"),
  // SCIENT-FORK:END
  "/settings/diagnostics": msg("Diagnostics"),
  // SCIENT-FORK:START — Scient skills subpages
  "/settings/skills/external": msg("External skills"),
  "/settings/skills/project": msg("Project skills"),
  // SCIENT-FORK:END
  "/settings/open-source-licenses": msg("Open source licenses"),
  // SCIENT-FORK:START — Scient Extensions subpages
  "/settings/extensions/installed": msg("Installed extensions"),
  "/settings/extensions/all": msg("All MCP servers"),
  // SCIENT-FORK:END
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  // SCIENT-FORK:START — Extensions and language pages fall back to their section.
  if (normalizedPathname.startsWith("/settings/extensions/")) {
    return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? msg("Extensions");
  }
  if (normalizedPathname.startsWith("/settings/scientific-computing/")) {
    return msg("Scientific Computing");
  }
  // SCIENT-FORK:END
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const gt = useGT();
  const m = useMessages();
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <WorkspaceBreadcrumb ariaLabel={gt("Settings breadcrumb")}>
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
