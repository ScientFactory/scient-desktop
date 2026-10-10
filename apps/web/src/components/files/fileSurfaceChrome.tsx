import { ChevronRightIcon, FileQuestionIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { RefreshIcon } from "~/components/ui/refresh-icon";

import { Spinner } from "~/components/ui/spinner";
import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { DIFF_SURFACE_THEME_UNSAFE_CSS } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

/**
 * One header row for every file surface in the side panel, whether the file
 * comes from the workspace or was captured as an attachment: crumbs on the
 * left, icon-only actions on the right. Attachments and workspace files must
 * not grow separate chrome.
 */
export const FILE_SURFACE_SUBHEADER_CLASS =
  "flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent";

export const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";

export const FILE_LINK_REVEAL_UNSAFE_CSS = `
  ${DIFF_SURFACE_THEME_UNSAFE_CSS}

  diffs-container {
    --diffs-bg: var(--code-background, var(--background)) !important;
    --diffs-light-bg: var(--code-background, var(--background)) !important;
    --diffs-dark-bg: var(--code-background, var(--background)) !important;
    background-color: var(--code-background, var(--background)) !important;
    color: var(--code-foreground, var(--foreground)) !important;
  }

  /* Tint through --diffs-line-bg, not background-color. The editor paints row
     tints on a layer below its text selection; a background on the row itself
     covers the selection and makes selected text on this line invisible. */
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    --diffs-line-bg: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;

/**
 * An icon-only header action with its label in a tooltip, the same control workspace files use.
 * A `pressed` action is a toggle and says so; a command (Copy, Save, Close) is a plain button,
 * because announcing it as an unpressed toggle tells a screen reader it has a state it has not.
 */
export function FileSurfaceAction(props: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const pressed = props.pressed;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          pressed === undefined ? (
            <Button
              type="button"
              className="shrink-0"
              disabled={props.disabled ?? false}
              onClick={props.onPress}
              aria-label={props.label}
              variant="ghost"
              size="icon-sm"
            >
              {props.children}
            </Button>
          ) : (
            <Toggle
              className="shrink-0"
              pressed={pressed}
              disabled={props.disabled ?? false}
              onPressedChange={props.onPress}
              aria-label={props.label}
              variant="ghost"
              size="sm"
            >
              {props.children}
            </Toggle>
          )
        }
      />
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function FileSurfaceNotice(props: { readonly children: ReactNode }) {
  return (
    <div
      role="status"
      className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 scient-reading-micro text-warning-foreground"
    >
      {props.children}
    </div>
  );
}

export function FileSurfaceLoading(props: { readonly className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading file"
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center text-muted-foreground",
        props.className,
      )}
    >
      <Spinner size="lg" />
    </div>
  );
}

/**
 * The one centered state a file surface shows instead of a file: a failure, or
 * a file that has no preview. Calm by design: a muted icon, a short title and
 * description, one recovery action, and the raw error only behind Details.
 */
export function FileSurfaceMessage(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly details?: string | null;
  readonly icon?: LucideIcon;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  /** "alert" announces a failure; "status" is for a neutral no-preview state. */
  readonly role?: "alert" | "status";
  readonly children?: ReactNode;
}) {
  const Icon = props.icon ?? FileQuestionIcon;
  const retrying = props.retrying ?? false;
  return (
    <div
      role={props.role ?? "status"}
      className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col items-center justify-center-safe overflow-y-auto px-6 py-8"
    >
      <div className="flex w-full max-w-80 flex-col items-center gap-3 text-center scient-reading-ui">
        <Icon className="size-6 shrink-0 text-muted-foreground/70" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-balance text-foreground">{props.title}</p>
          {props.description ? (
            <p className="text-xs leading-relaxed text-balance text-muted-foreground">
              {props.description}
            </p>
          ) : null}
        </div>
        {props.onRetry || props.children ? (
          <div className="flex flex-wrap justify-center gap-2">
            {props.onRetry ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={props.onRetry}
                disabled={retrying}
                aria-busy={retrying}
              >
                <RefreshIcon size="xs" refreshing={retrying} />
                Try again
              </Button>
            ) : null}
            {props.children}
          </div>
        ) : null}
        {props.details ? (
          <div className="flex w-full flex-col items-center scient-reading-micro">
            <Collapsible className="flex w-full flex-col items-center">
              <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronRightIcon
                  className="size-3 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
                  aria-hidden="true"
                />
                Details
              </CollapsibleTrigger>
              <CollapsiblePanel motion="fast" className="w-full">
                <pre
                  dir="auto"
                  className="mt-2 max-h-40 w-full overflow-auto rounded-md bg-muted/50 px-2.5 py-2 text-start font-mono leading-relaxed break-words whitespace-pre-wrap text-muted-foreground select-text"
                >
                  {props.details}
                </pre>
              </CollapsiblePanel>
            </Collapsible>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A file surface that failed to load; announced, and retryable when a retry can help. */
export function FileSurfaceFailure(props: {
  readonly title: string;
  readonly description: ReactNode;
  readonly details?: string | null;
  readonly icon?: LucideIcon;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly children?: ReactNode;
}) {
  return <FileSurfaceMessage {...props} role="alert" />;
}
