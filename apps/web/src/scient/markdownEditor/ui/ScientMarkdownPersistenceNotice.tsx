import type { Dispatch, SetStateAction, RefObject } from "react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Copy, Info } from "lucide-react";

import { Button } from "~/components/ui/button";
import type { MarkdownPersistenceLease } from "../persistence/markdownPersistenceRegistry";
import {
  documentFailureCode,
  documentFailurePlainReason,
  documentFailureReason,
} from "../persistence/documentFailureReason";

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

/** The text can always leave, whatever is stopping the save: this asks where to put a copy. */
function saveTextCopy(relativePath: string, text: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  link.download = relativePath.split("/").at(-1) ?? "document.txt";
  link.click();
  URL.revokeObjectURL(link.href);
}

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
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const previousIssue = useRef<string | null>(null);
  const issue = pendingInput
    ? "input"
    : snapshot.currentMissing
      ? "missing-current"
      : snapshot.conflict
        ? "conflict"
        : snapshot.error
          ? snapshot.pending
            ? "failure"
            : "refresh"
          : null;
  const failed = issue === "failure";
  const plainReason = failed ? documentFailurePlainReason(snapshot.error) : null;
  const title =
    (issue === "input"
      ? "Finish your edit in Rich"
      : issue === "missing-current"
        ? "This file is no longer on disk"
        : issue === "conflict"
          ? "This file changed on disk while you were editing"
          : issue === "refresh"
            ? refreshCopy.title
            : "Couldn’t save") + (plainReason ? `: ${plainReason}` : "");
  const choices =
    issue === "refresh" && onOpenFile ? missingFileChoices.slice(0, MAX_MISSING_FILE_CHOICES) : [];

  const reason =
    issue === "failure" || issue === "refresh" ? documentFailureReason(snapshot.error) : null;
  const code = reason === null ? null : documentFailureCode(snapshot.error);
  // Technical facts stay out of the sentence and are only for bug reports.
  const details = [reason, code ? `Code: ${code}` : null].filter(
    (line): line is string => line !== null,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Names the exact text last copied, so different details never read as copied.
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const detailsText = details.join("\n");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets notice state and updates the aria-live announcement when the persistence issue changes
  useEffect(() => {
    if (issue === previousIssue.current) return;
    previousIssue.current = issue;
    setAnnouncement(issue ? title : "");
    setConfirmation(null);
    setReviewError(null);
    setDetailsOpen(false);
  }, [issue, title]);

  const tone = issue === "conflict" && snapshot.attention === null ? "info" : "warning";
  const description =
    issue === "input"
      ? "It isn’t saved yet. Fix or undo it there before using Source."
      : issue === "missing-current"
        ? "Your text is still here and hasn’t been saved anywhere."
        : confirmation?.action === "local"
          ? "Replace the file on disk with your version? Scient checks for newer changes first."
          : confirmation?.action === "disk"
            ? "Use the version on disk? Your edits can be restored while this document stays open."
            : issue === "conflict"
              ? "Nothing was overwritten."
              : issue === "refresh"
                ? refreshCopy.description
                : "Your text is still here, and Scient keeps trying.";

  const run = (operation: () => Promise<boolean>) =>
    createPersistenceNoticeOperation({ regionRef, setBusy, setConfirmation })(operation);

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
          data-tone={tone}
          className="shrink-0 border-b border-border bg-card scient-reading-micro text-foreground"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5">
            {tone === "info" ? (
              <Info className="size-3.5 shrink-0 text-info" aria-hidden="true" />
            ) : (
              <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            )}
            <p className="min-w-0 flex-1 basis-64 leading-snug">
              <span id={titleId} className="font-medium">
                {title}.
              </span>{" "}
              <span className="text-muted-foreground">{description}</span>
            </p>
            <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
              {issue === "input" ? (
                onReturnToRich ? (
                  <Button size="xs" onClick={onReturnToRich}>
                    Return to Rich
                  </Button>
                ) : null
              ) : issue === "missing-current" ? (
                <Button
                  size="xs"
                  disabled={
                    busy ||
                    snapshot.inFlight ||
                    snapshot.reading ||
                    snapshot.publicationIntent !== null
                  }
                  onClick={() =>
                    void run(async () => {
                      const created = await persistence.recreateMissingCurrent();
                      if (!created)
                        setReviewError(
                          "Couldn’t create the file. Your text is still here; check the folder before trying again.",
                        );
                      return created;
                    })
                  }
                >
                  Save it again
                </Button>
              ) : confirmation ? (
                <>
                  <Button
                    size="xs"
                    variant={confirmation.action === "local" ? "destructive" : "default"}
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
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmation(null)}
                  >
                    Cancel
                  </Button>
                </>
              ) : issue === "conflict" && snapshot.conflict ? (
                <>
                  <Button
                    size="xs"
                    variant="outline"
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
              ) : issue === "failure" ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    saveTextCopy(persistence.target.relativePath, snapshot.draftSource)
                  }
                >
                  Save a copy
                </Button>
              ) : (
                <>
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() => void run(() => persistence.retry())}
                  >
                    Try again
                  </Button>
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
                </>
              )}
              {details.length > 0 ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((open) => !open)}
                >
                  Details
                  {detailsOpen ? (
                    <ChevronUp className="size-3" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="size-3" aria-hidden="true" />
                  )}
                </Button>
              ) : null}
            </div>
          </div>
          {reviewError ? (
            <p className="px-3 pb-2 pl-9 text-warning-foreground" role="alert">
              {reviewError}
            </p>
          ) : null}
          {detailsOpen && details.length > 0 ? (
            <div className="flex flex-col items-start gap-1.5 px-3 pb-2 pl-9">
              <pre
                className="w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-muted-foreground"
                data-persistence-reason={reason !== null || undefined}
              >
                {detailsText}
              </pre>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard?.writeText(detailsText).then(
                    () => setCopiedText(detailsText),
                    () => setCopiedText(null),
                  )
                }
              >
                <Copy className="size-3" aria-hidden="true" />
                {copiedText === detailsText ? "Copied" : "Copy details"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {snapshot.recoverySource !== null ? (
        <div className="shrink-0 border-b border-border/50 px-3 py-1.5 scient-reading-micro text-muted-foreground">
          Your earlier edits can still be restored.
          <Button
            size="xs"
            variant="ghost"
            disabled={pendingInput !== null}
            onClick={() => persistence.restoreRecovery()}
          >
            Restore
          </Button>
        </div>
      ) : null}
    </>
  );
}

function createPersistenceNoticeOperation({
  regionRef,
  setBusy,
  setConfirmation,
}: {
  regionRef: RefObject<HTMLDivElement | null>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setConfirmation: Dispatch<SetStateAction<{ action: "local" | "disk"; revision: string } | null>>;
}) {
  return async (operation: () => Promise<boolean>) => {
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
}
