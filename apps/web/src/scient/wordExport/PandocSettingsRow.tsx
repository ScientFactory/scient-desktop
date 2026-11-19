import { T, useGT } from "gt-react";
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
  const gt = useGT();
  const { status, view, act, checking } = controller;
  const notice = pandocReleaseNotice(status);
  // The Word tab already says what this is for, so the row names Pandoc and
  // keeps the export dialogs' longer sentences for the states that need them.
  const description =
    view.kind === "ready"
      ? gt("Installed")
      : view.kind === "offer"
        ? [
            gt("Not installed"),
            status?.downloadBytes ? formatMegabytes(status.downloadBytes) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : view.detail;
  return (
    <SettingsRow
      id="word-export"
      // oxlint-disable-next-line t3code/no-untranslated-copy -- product name
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
                  aria-label={gt("{release} source code (opens in browser)", {
                    release: notice.release,
                  })}
                  className="inline-flex items-center gap-1 text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
                  href={notice.sourceUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  <T>Source code</T>
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
            disabled={view.busy || checking}
            onClick={act}
          >
            {view.kind === "offer" ? gt("Install now") : view.actionLabel}
          </Button>
        )
      }
    />
  );
}
