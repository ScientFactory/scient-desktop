import type { EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon, FileTextIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";

import { pandocReleaseNotice } from "./pandocToolModel";
import { usePandocTool } from "./usePandocTool";

/**
 * Settings ▸ Scientific Computing ▸ Word export: whether this server can
 * export Word files, the install or reinstall of the managed Pandoc it needs,
 * and that release's licence and source. Settings search and the page's
 * section list lead here for "Word", "export", and "Pandoc".
 */
export function WordExportSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const { status, view, act } = usePandocTool(props.environmentId);
  const notice = pandocReleaseNotice(status);
  return (
    <SettingsSection
      id="word-export"
      title="Word export"
      icon={<FileTextIcon className="size-4 text-muted-foreground" />}
    >
      <SettingsRow
        title="Word export (Pandoc)"
        description={view.detail}
        status={
          notice === null ? undefined : (
            <span>
              {notice.label}
              {notice.sourceUrl === null ? null : (
                <>
                  {" · "}
                  <a
                    aria-label={`${notice.release} source code (opens in browser)`}
                    className="inline-flex items-center gap-1 text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                    href={notice.sourceUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    Source code
                    <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
                  </a>
                </>
              )}
            </span>
          )
        }
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
