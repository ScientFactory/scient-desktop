import type { EnvironmentId } from "@t3tools/contracts";
import { FileTextIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";

import { usePandocTool } from "./usePandocTool";

/**
 * Settings ▸ Scientific Computing ▸ Word export: whether this server can
 * export Word files, and the "Install now" for the managed Pandoc it needs.
 */
export function WordExportSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const { view, act } = usePandocTool(props.environmentId);
  return (
    <SettingsSection
      id="word-export"
      title="Document conversion"
      icon={<FileTextIcon className="size-4 text-muted-foreground" />}
    >
      <SettingsRow
        title="Word export (Pandoc)"
        description={view.detail}
        serverScoped
        control={
          view.actionLabel === null ? null : (
            <Button type="button" size="sm" variant="outline" disabled={view.busy} onClick={act}>
              {view.kind === "offer" ? "Install now" : view.actionLabel}
            </Button>
          )
        }
      />
    </SettingsSection>
  );
}
