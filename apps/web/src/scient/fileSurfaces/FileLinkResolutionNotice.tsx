import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

/**
 * Says that this tab shows a different file than the link that opened it
 * named, so an unexpected match is noticed. It belongs to the tab rather than
 * floating over the panel, so it never covers the document, and it speaks in
 * the past tense because the missing location was only checked at that moment.
 */
export function FileLinkResolutionNotice(props: {
  /** Where the link pointed. */
  readonly missingPath: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-border/50 bg-muted/35 px-3 py-1.5 scient-reading-micro text-muted-foreground"
    >
      <span className="min-w-0 flex-1">
        Opened from a link to{" "}
        <span className="font-mono break-all text-foreground/80 select-text">
          {props.missingPath}
        </span>
        , which was missing when checked.
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        className="shrink-0"
        aria-label="Dismiss"
        onClick={props.onDismiss}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
