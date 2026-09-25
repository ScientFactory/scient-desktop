import { AlertTriangle, Check, RefreshCw } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Popover, PopoverTrigger, PopoverPopup, PopoverTitle } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

import type { FileReloadNotice, FileSaveErrorNotice } from "./useWorkspaceFileRefresh";

export function ScientFileReloadButton(props: {
  readonly automaticRefreshUnavailable?: boolean;
  readonly isPending: boolean;
  readonly label?: string;
  readonly onReload: () => void;
  readonly size?: "icon-sm" | "icon-xs";
}) {
  const label = props.label ?? "Reload file from disk";
  const actionLabel = props.isPending
    ? "Reloading file…"
    : props.automaticRefreshUnavailable
      ? `Automatic updates paused — ${label.toLowerCase()}`
      : label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className="shrink-0"
            onClick={props.onReload}
            aria-label={actionLabel}
            aria-busy={props.isPending}
            disabled={props.isPending}
            variant={props.automaticRefreshUnavailable ? "ghost-warning" : "ghost"}
            size={props.size ?? "icon-sm"}
          >
            <RefreshCw className={cn("size-3.5", props.isPending && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup>{actionLabel}</TooltipPopup>
    </Tooltip>
  );
}

export function ScientFileFreshnessNotices(props: {
  readonly relativePath: string | null;
  readonly notice: FileReloadNotice | null;
  readonly readError: string | null;
  readonly saveError: FileSaveErrorNotice | null;
  readonly saveRetryReady: boolean;
  readonly hasFallbackData: boolean;
  readonly onCancel: () => void;
  readonly onReload: () => void;
  readonly onRequestOverwrite: () => void;
  readonly onRetrySave: () => void;
  readonly onResolve: (action: "discard" | "retry") => void;
}) {
  const visibleNotice = props.notice?.relativePath === props.relativePath ? props.notice : null;
  const visibleSaveError =
    props.saveError?.relativePath === props.relativePath ? props.saveError : null;
  const resolutionReady = visibleNotice?.contents !== null;

  return (
    <>
      {visibleNotice ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-warning/24 bg-warning-surface px-3 py-2 scient-reading-micro text-warning-foreground"
          role="status"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1 leading-relaxed">
            {visibleNotice.kind === "manual-reload"
              ? "This file has unsaved edits. Reloading will discard your local buffer."
              : visibleNotice.kind === "confirm-overwrite"
                ? "This will replace the newer file on disk with your local buffer. A further concurrent change will still be rejected."
                : "This file changed on disk while you had unsaved edits. Your local buffer was kept and was not allowed to overwrite the newer file."}
          </div>
          {visibleNotice.kind === "external-change" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!resolutionReady}
              onClick={props.onRequestOverwrite}
            >
              Use my edits
            </Button>
          ) : (
            <Button size="xs" variant="ghost" onClick={props.onCancel}>
              Cancel
            </Button>
          )}
          <Button
            size="xs"
            variant={visibleNotice.kind === "confirm-overwrite" ? "destructive" : "outline"}
            disabled={!resolutionReady}
            onClick={() =>
              props.onResolve(visibleNotice.kind === "confirm-overwrite" ? "retry" : "discard")
            }
          >
            {visibleNotice.kind === "confirm-overwrite" ? "Overwrite disk" : "Reload from disk"}
          </Button>
        </div>
      ) : null}
      {visibleSaveError && !visibleNotice ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 scient-reading-micro text-destructive"
          role="alert"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            Changes are still local and have not been saved. {visibleSaveError.message}
          </span>
          <Button size="xs" variant="ghost" onClick={props.onReload}>
            Reload…
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!props.saveRetryReady}
            onClick={props.onRetrySave}
          >
            Retry save
          </Button>
        </div>
      ) : null}
      {props.relativePath && props.readError && props.hasFallbackData ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 scient-reading-micro text-destructive"
          role="alert"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            The latest version could not be loaded. Showing the last available copy.
          </span>
          <Button size="xs" variant="outline" onClick={props.onReload}>
            Try again
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** A fixed toolbar slot keeps asynchronous save notices outside the document flow. */
export function ScientFileFreshnessStatus(
  props: Parameters<typeof ScientFileFreshnessNotices>[0] & { readonly pending: boolean },
) {
  const conflict = props.notice?.relativePath === props.relativePath && props.notice !== null;
  const failed = props.saveError?.relativePath === props.relativePath && props.saveError !== null;
  const readFailed = Boolean(props.relativePath && props.readError && props.hasFallbackData);
  const needsAttention = conflict || failed || readFailed;
  const status = conflict
    ? "File changed: review your save options"
    : failed
      ? "Changes have not been saved"
      : readFailed
        ? "The latest file could not be loaded"
        : props.pending
          ? "Saving changes"
          : "No file warnings";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className={cn("w-24 shrink-0", needsAttention && "text-warning")}
            aria-label={`File status: ${status}`}
            title={status}
          />
        }
      >
        {needsAttention ? (
          <AlertTriangle className="size-3.5" aria-hidden="true" />
        ) : props.pending ? (
          <RefreshCw className="size-3.5" aria-hidden="true" />
        ) : (
          <Check className="size-3.5" aria-hidden="true" />
        )}
        File status
      </PopoverTrigger>
      <span className="sr-only" role="status">
        {status}
      </span>
      <PopoverPopup align="end" className="w-96 max-w-[calc(100vw-24px)] p-3">
        <PopoverTitle>File status</PopoverTitle>
        {needsAttention ? (
          <div className="mt-2 [&>div]:flex-wrap [&>div]:rounded-md [&>div]:border-0 [&>div>span]:whitespace-normal [&>div>span]:overflow-visible">
            <ScientFileFreshnessNotices {...props} />
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {props.pending
              ? "Your changes are being saved to the project file."
              : "There are no pending file warnings."}
          </p>
        )}
      </PopoverPopup>
    </Popover>
  );
}
