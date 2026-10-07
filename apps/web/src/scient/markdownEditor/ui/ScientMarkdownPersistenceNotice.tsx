import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "~/components/ui/button";
import type { MarkdownPersistenceLease } from "../persistence/markdownPersistenceRegistry";
import { documentFailureReason } from "../persistence/documentFailureReason";

// The same small number of same-name files the plain viewer offers inline.
const MAX_MISSING_FILE_CHOICES = 2;
const NO_MISSING_FILE_CHOICES: ReadonlyArray<string> = [];

/** What the notice says when the open document could not be re-read from disk. */
export interface MarkdownRefreshNoticeCopy {
  readonly title: string;
  readonly description: string;
}

const UNEXPLAINED_REFRESH_FAILURE: MarkdownRefreshNoticeCopy = {
  title: "This file couldn’t be refreshed",
  description:
    "Scient could not check the latest disk version. The last confirmed version is still open. Retry to check it again.",
};

/** Routine persistence is silent. Only an actionable episode is announced. */
export function ScientMarkdownPersistenceNotice({
  persistence,
  refreshCopy = UNEXPLAINED_REFRESH_FAILURE,
  missingFileChoices = NO_MISSING_FILE_CHOICES,
  onOpenFile,
  onReturnToRich,
}: {
  readonly persistence: MarkdownPersistenceLease;
  /** Names why the last refresh read failed, when the operating system said. */
  readonly refreshCopy?: MarkdownRefreshNoticeCopy;
  /**
   * Workspace files a missing path may have meant, given only when the file
   * is missing; each opens as another document.
   */
  readonly missingFileChoices?: ReadonlyArray<string>;
  readonly onOpenFile?: (relativePath: string) => void;
  readonly onReturnToRich?: () => void;
}) {
  const snapshot = useSyncExternalStore(persistence.subscribe, persistence.getSnapshot);
  const pendingInput = useSyncExternalStore(persistence.subscribe, persistence.getPendingInput);
  const titleId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const [confirmation, setConfirmation] = useState<{
    action: "local" | "disk";
    revision: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const previousIssue = useRef<string | null>(null);
  const issue = pendingInput
    ? "input"
    : snapshot.conflict
      ? "conflict"
      : snapshot.error
        ? snapshot.pending
          ? "failure"
          : "refresh"
        : null;
  const title =
    issue === "input"
      ? "Finish the pending edit in Rich"
      : issue === "conflict"
        ? "This file was changed by another writer"
        : issue === "refresh"
          ? refreshCopy.title
          : "Changes haven’t been saved";
  const choices =
    issue === "refresh" && onOpenFile ? missingFileChoices.slice(0, MAX_MISSING_FILE_CHOICES) : [];

  const reason =
    issue === "failure" || issue === "refresh" ? documentFailureReason(snapshot.error) : null;

  useEffect(() => {
    if (issue === previousIssue.current) return;
    previousIssue.current = issue;
    setAnnouncement(issue ? title : "");
    setConfirmation(null);
  }, [issue, title]);

  const run = async (operation: () => Promise<boolean>) => {
    const focusWasInNotice = regionRef.current?.contains(document.activeElement) ?? false;
    const surface = regionRef.current?.parentElement;
    setBusy(true);
    try {
      await operation();
    } finally {
      setBusy(false);
      setConfirmation(null);
      // Only restore focus when the user's action removed its focused control.
      if (focusWasInNotice)
        requestAnimationFrame(() => {
          if (document.activeElement !== document.body && document.activeElement?.isConnected)
            return;
          const editor =
            surface?.querySelector<HTMLElement>(
              ".scient-markdown-workspace [contenteditable='true']",
            ) ??
            surface
              ?.querySelector("diffs-container")
              ?.shadowRoot?.querySelector<HTMLElement>("[data-content][contenteditable]");
          editor?.focus({ preventScroll: true });
        });
    }
  };

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {issue ? (
        <div
          ref={regionRef}
          role="region"
          aria-labelledby={titleId}
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/24 bg-warning-surface px-3 py-2 scient-reading-micro text-warning-foreground"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1 basis-64 leading-relaxed">
            <p id={titleId} className="font-medium">
              {title}
            </p>
            <p>
              {issue === "input"
                ? "Your input remains in its rich editor. Correct or undo it there before editing Source, saving, or replacing this document."
                : confirmation?.action === "local"
                  ? "Replace the version on disk with your current edits? Scient will check for another change before writing."
                  : confirmation?.action === "disk"
                    ? "Use the latest disk version? Your current edits will remain recoverable while this document is open."
                    : issue === "conflict"
                      ? "Your edits are still open and have not overwritten the newer file on disk."
                      : issue === "refresh"
                        ? refreshCopy.description
                        : "Your edits are still open, but saving or checking the disk version could not finish. Keep this document open and retry."}
            </p>
            {reason !== null && confirmation === null ? (
              <p className="opacity-80" data-persistence-reason>
                {reason}
              </p>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
            {issue === "input" ? (
              onReturnToRich ? (
                <Button size="xs" variant="outline" onClick={onReturnToRich}>
                  Return to Rich
                </Button>
              ) : null
            ) : confirmation ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmation(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant={confirmation.action === "local" ? "destructive" : "outline"}
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      confirmation.action === "local"
                        ? persistence.resolveWithLocal(confirmation.revision)
                        : persistence.resolveWithDisk(),
                    )
                  }
                >
                  {confirmation.action === "local" ? "Replace disk version" : "Use disk version"}
                </Button>
              </>
            ) : issue === "conflict" && snapshot.conflict ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      action: "local",
                      revision: snapshot.conflict!.externalRevision,
                    })
                  }
                >
                  Keep my edits…
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      action: "disk",
                      revision: snapshot.conflict!.externalRevision,
                    })
                  }
                >
                  Use disk version…
                </Button>
              </>
            ) : (
              <>
                {choices.map((choice) => (
                  <Button
                    key={choice}
                    size="xs"
                    variant="outline"
                    className="max-w-48"
                    title={`Open ${choice}`}
                    onClick={() => onOpenFile?.(choice)}
                  >
                    <span className="truncate">{choice}</span>
                  </Button>
                ))}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => persistence.retry())}
                >
                  Retry
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
      {snapshot.recoverySource !== null ? (
        <div className="shrink-0 border-b border-border/50 px-3 py-1.5 scient-reading-micro text-muted-foreground">
          Previous local edits are available while this document remains open.
          <Button
            size="xs"
            variant="ghost"
            disabled={pendingInput !== null}
            onClick={() => persistence.restoreRecovery()}
          >
            Restore previous edits
          </Button>
        </div>
      ) : null}
    </>
  );
}
