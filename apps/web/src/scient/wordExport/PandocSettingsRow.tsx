import { ExternalLinkIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { SettingsRow } from "~/components/settings/settingsLayout";

import { formatMegabytes, pandocReleaseNotice } from "./pandocToolModel";
import type { PandocToolController } from "./usePandocTool";

/**
 * Settings ▸ Documents ▸ Word: whether this server can export Word files, the
 * install or reinstall of the managed Pandoc it needs, and that release's
 * licence and source. Settings search leads here for "Word", "export", and
 * "Pandoc".
 */
export function PandocSettingsRow({ controller }: { readonly controller: PandocToolController }) {
  const { status, view, act } = controller;
  const notice = pandocReleaseNotice(status);
  // The Word tab already says what this is for, so the row names Pandoc and
  // keeps the export dialogs' longer sentences for the states that need them.
  const description =
    view.kind === "ready"
      ? "Installed"
      : view.kind === "offer"
        ? ["Not installed", status?.downloadBytes ? formatMegabytes(status.downloadBytes) : null]
            .filter(Boolean)
            .join(" · ")
        : view.detail;
  return (
    <SettingsRow
      id="word-export"
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
          <Button type="button" size="sm" variant="outline" disabled={view.busy} onClick={act}>
            {view.kind === "offer" ? "Install now" : view.actionLabel}
          </Button>
        )
      }
    />
  );
}
