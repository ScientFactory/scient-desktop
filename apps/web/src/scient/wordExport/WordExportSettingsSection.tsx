import type { EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon, FileTextIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { SettingsSourcePanel } from "~/components/settings/SettingsSourceStrip";

import { formatMegabytes, pandocReleaseNotice } from "./pandocToolModel";
import { usePandocTool } from "./usePandocTool";

/**
 * Settings ▸ Documents ▸ Word export, set in the same panel surface as the
 * LaTeX and Markdown tabs above it: whether this server can
 * export Word files, the install or reinstall of the managed Pandoc it needs,
 * and that release's licence and source. Settings search and the page's
 * section list lead here for "Word", "export", and "Pandoc".
 */
export function WordExportSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const { status, view, act } = usePandocTool(props.environmentId);
  const notice = pandocReleaseNotice(status);
  // The row sits under "Word export", so it names Pandoc and keeps the
  // export dialogs' longer sentences for the states that need them.
  const description =
    view.kind === "ready"
      ? "Installed"
      : view.kind === "offer"
        ? ["Not installed", status?.downloadBytes ? formatMegabytes(status.downloadBytes) : null]
            .filter(Boolean)
            .join(" · ")
        : view.detail;
  return (
    <SettingsSection
      id="word-export"
      title="Word export"
      icon={<FileTextIcon className="size-4 text-muted-foreground" />}
      variant="plain"
    >
      <div className="px-3 sm:px-4">
        <SettingsSourcePanel>
          <SettingsRow
            title="Pandoc"
            description={description}
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
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={view.busy}
                  onClick={act}
                >
                  {view.kind === "offer" ? "Install now" : view.actionLabel}
                </Button>
              )
            }
          />
        </SettingsSourcePanel>
      </div>
    </SettingsSection>
  );
}
