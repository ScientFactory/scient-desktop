import type { ProjectFileErrorReason } from "@t3tools/contracts";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { useState } from "react";
import * as Cause from "effect/Cause";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Popover, PopoverTrigger, PopoverPopup, PopoverTitle } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

import { staleCopyNotice } from "./fileFailureCopy";
import type { FileReloadNotice, FileSaveErrorNotice } from "./useWorkspaceFileRefresh";

export type RetainedFileAttention =
  | "recovery_required"
  | "target_changed"
  | "mutation_unavailable"
  | "mutation_intent_conflict"
  | "outcome_unknown";

/** Terminal mutation notices never imply that retrying an old intent is safe. */
export function retainedAttentionCopy(attention: RetainedFileAttention) {
  switch (attention) {
    case "recovery_required":
      return {
        title: "Review retained file versions",
        description:
          "The file operation’s outcome needs review. Your draft is still open. Review the current file and retained versions, and save a separate copy if needed. Accepting the reviewed current disk version requires backend confirmation and keeps your local draft; it does not confirm the old operation succeeded. Reviewing or discarding versions alone does not unblock the retained mutation.",
      };
    case "target_changed":
      return {
        title: "The file target changed",
        description:
          "Scient stopped this operation because the file or its containing path changed. Your draft is still open. Review the actual file and retained versions before starting a new operation.",
      };
    case "mutation_unavailable":
      return {
        title: "Safe file mutation is unavailable",
        description:
          "This environment cannot perform the requested safe file operation. Your draft is still open. Review or save a separate copy; retrying this operation will not make it safe.",
      };
    case "mutation_intent_conflict":
      return {
        title: "This file operation conflicts with an earlier intent",
        description:
          "Scient refused to reuse this operation’s identity for different input. Your draft is still open. Review the current file and retained versions before starting a new operation.",
      };
    case "outcome_unknown":
      return {
        title: "The file operation’s outcome is unknown",
        description:
          "Scient could not confirm whether the file operation completed. Your source draft and open path were kept. Inspect the source, destination, and retained versions before reopening the actual file. Do not repeat the old operation blindly.",
      };
  }
}

/** Recovery evidence may arrive inside an Effect cause or as a wire error. */
export function retainedFileEvidence(error: unknown): {
  readonly recoveryId: string | null;
  readonly retainedPaths: ReadonlyArray<string>;
} {
  if (Cause.isCause(error)) {
    for (const reason of error.reasons) {
      if (reason._tag !== "Fail") continue;
      const evidence = retainedFileEvidence(reason.error);
      if (evidence.recoveryId !== null || evidence.retainedPaths.length > 0) return evidence;
    }
  }
  if (typeof error === "object" && error !== null) {
    return {
      recoveryId:
        "recoveryId" in error && typeof error.recoveryId === "string" ? error.recoveryId : null,
      retainedPaths:
        "retainedPaths" in error && Array.isArray(error.retainedPaths)
          ? error.retainedPaths.filter((path): path is string => typeof path === "string")
          : [],
    };
  }
  return { recoveryId: null, retainedPaths: [] };
}

/** The notice is one line; more candidates than this stay behind Try again. */
const MAX_STALE_COPY_CHOICES = 2;

export function ScientFileReloadButton(props: {
  readonly automaticRefreshUnavailable?: boolean;
  readonly isPending: boolean;
  readonly label?: string;
  readonly onReload: () => void;
  readonly size?: "icon-sm" | "icon-xs";
}) {
  const label = props.label ?? "Reload file from disk";
  // A reload usually takes a few milliseconds; one short turn shows it happened.
  const [turns, setTurns] = useState(0);
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
            onClick={() => {
              setTurns((count) => count + 1);
              props.onReload();
            }}
            aria-label={actionLabel}
            aria-busy={props.isPending}
            disabled={props.isPending}
            variant={props.automaticRefreshUnavailable ? "ghost-warning" : "ghost"}
            size={props.size ?? "icon-sm"}
          >
            <RefreshCw
              key={turns}
              className={cn(
                "size-3.5",
                props.isPending
                  ? "animate-spin"
                  : turns > 0 && "animate-[spin_0.6s_ease-in-out_1] motion-reduce:animate-none",
              )}
            />
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
  /** Why the latest read failed, when the system said so. */
  readonly readFailureReason?: ProjectFileErrorReason | null;
  /** Workspace files a file that is no longer here may have become. */
  readonly missingFileChoices?: ReadonlyArray<string>;
  readonly onOpenFile?: (path: string) => void;
  /** A reload is in flight; blocks a second Try again. */
  readonly reloading?: boolean;
  readonly onCancel: () => void;
  readonly onReload: () => void;
  readonly onRequestOverwrite: () => void;
  readonly onRetrySave: () => void;
  readonly onResolve: (action: "discard" | "retry") => void;
}) {
  const openFile = props.onOpenFile;
  const visibleNotice = props.notice?.relativePath === props.relativePath ? props.notice : null;
  const visibleSaveError =
    props.saveError?.relativePath === props.relativePath ? props.saveError : null;
  const resolutionReady = visibleNotice?.contents !== null;
  const retainedCopy = visibleSaveError?.attention
    ? retainedAttentionCopy(visibleSaveError.attention)
    : null;
  const evidence = retainedFileEvidence(visibleSaveError?.error);

  return (
    <>
      {visibleNotice && !retainedCopy ? (
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
      {visibleSaveError && (!visibleNotice || retainedCopy) ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 scient-reading-micro text-destructive"
          role="alert"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          {retainedCopy ? (
            <>
              <div className="min-w-0 flex-1 leading-relaxed">
                <p className="font-medium">{retainedCopy.title}</p>
                <p>{retainedCopy.description}</p>
                {evidence.recoveryId ? (
                  <p className="break-all">Recovery reference: {evidence.recoveryId}</p>
                ) : null}
              </div>
              {evidence.retainedPaths.map((path) => (
                <Button
                  key={path}
                  size="xs"
                  variant="outline"
                  disabled={!openFile}
                  title={path}
                  onClick={() => openFile?.(path)}
                >
                  Open retained version read-only
                </Button>
              ))}
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      ) : null}
      {!retainedCopy && props.relativePath && props.readError && props.hasFallbackData ? (
        // The last good copy is still on screen, so this is a caution, not a failure.
        <div
          className="flex shrink-0 items-center gap-2 border-b border-warning/20 bg-warning-surface px-3 py-2 scient-reading-micro text-warning-foreground"
          role="status"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {staleCopyNotice(props.readFailureReason ?? null)}
          </span>
          {props.readFailureReason === "not_found" && openFile
            ? (props.missingFileChoices ?? []).slice(0, MAX_STALE_COPY_CHOICES).map((choice) => (
                <Button
                  key={choice}
                  size="xs"
                  variant="outline"
                  className="max-w-48"
                  title={`Open ${choice}`}
                  onClick={() => openFile(choice)}
                >
                  <span className="truncate">{choice}</span>
                </Button>
              ))
            : null}
          <Button
            size="xs"
            variant="outline"
            disabled={props.reloading ?? false}
            aria-busy={props.reloading ?? false}
            onClick={props.onReload}
          >
            Try again
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** A fixed toolbar slot keeps asynchronous save notices outside the document flow. */
export function ScientFileFreshnessStatus(
  props: Parameters<typeof ScientFileFreshnessNotices>[0] & {
    readonly pending: boolean;
    /**
     * What a file's document session is asking about. Its own notice, above
     * the document, carries the choices; this only keeps the status truthful.
     */
    readonly sessionAttention?: "conflict" | "failure" | "refresh" | RetainedFileAttention | null;
  },
) {
  const conflict =
    props.sessionAttention === "conflict" ||
    (props.notice?.relativePath === props.relativePath && props.notice !== null);
  const failed =
    props.sessionAttention === "failure" ||
    (props.saveError?.relativePath === props.relativePath && props.saveError !== null);
  const readFailed =
    props.sessionAttention === "refresh" ||
    Boolean(props.relativePath && props.readError && props.hasFallbackData);
  const attention =
    props.saveError?.relativePath === props.relativePath
      ? (props.saveError?.attention ?? props.sessionAttention)
      : props.sessionAttention;
  const retainedAttention =
    attention === "recovery_required" ||
    attention === "target_changed" ||
    attention === "mutation_unavailable" ||
    attention === "mutation_intent_conflict" ||
    attention === "outcome_unknown"
      ? retainedAttentionCopy(attention)
      : null;
  const needsAttention = retainedAttention !== null || conflict || failed || readFailed;
  const status =
    retainedAttention?.title ??
    (conflict
      ? "File changed: review your save options"
      : failed
        ? "Changes have not been saved"
        : readFailed
          ? "The latest file could not be loaded"
          : props.pending
            ? "Saving changes"
            : "No file warnings");
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant={needsAttention ? "ghost-warning" : "ghost"}
            className="w-24 shrink-0"
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
      <PopoverPopup align="end" width="lg" padding="comfortable">
        <PopoverTitle>File status</PopoverTitle>
        {props.sessionAttention ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {status}. The notice above the document has the options.
          </p>
        ) : needsAttention ? (
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
