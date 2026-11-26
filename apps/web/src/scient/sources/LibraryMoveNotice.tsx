import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { SCIENT_LIBRARY_MERGES_TO_REVIEW } from "@scientfactory/scient-sources";
import { msg, T, useGT, useMessages } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { Button } from "../../components/ui/button";
import { DUPLICATE_LABELS } from "./libraryDuplicateLabels";
import type { SourcesActivityItem } from "./sourcesFeedback";
import type { LibraryMoveStatus } from "./useLibraryMoveStatus";

/** The project's move into the personal Library: its line, with Review, Dismiss or Try again. */
export function LibraryMoveNotice(props: {
  readonly move: LibraryMoveStatus;
  /** Opens the merges the move made, for a line that says some kept different values. */
  readonly onReview?: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { line } = props.move;
  if (!line) return null;
  return (
    <div className="text-xs text-muted-foreground">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 break-words tabular-nums">
          {line.action === "dismiss" ? (
            <>
              <p>
                <T>
                  Moved into your Library. A copy of the project's sources from before the move is
                  kept in the project.
                </T>
              </p>
              <details className="mt-1">
                <summary className="cursor-pointer">
                  <T>Show locations</T>
                </summary>
                <p className="mt-1">{line.text}</p>
                {props.onReview && line.text.includes(SCIENT_LIBRARY_MERGES_TO_REVIEW) ? (
                  <Button size="xs" variant="ghost" onClick={props.onReview}>
                    {m(DUPLICATE_LABELS.review)}
                  </Button>
                ) : null}
              </details>
            </>
          ) : (
            line.text
          )}
        </div>
        {line.action === "dismiss" && props.move.canChange ? (
          <Button size="xs" variant="ghost" onClick={() => void props.move.dismiss()}>
            <T>Dismiss</T>
          </Button>
        ) : null}
        {line.action === "retry" && props.move.canChange ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.move.retrying}
            onClick={props.move.retry}
          >
            {props.move.retrying ? gt("Trying again…") : gt("Try again")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The move as one Activity item: a failed move needs Try again, a finished one's summary waits
 * for Dismiss, and a line without a control is the move running or waiting.
 */
export function libraryMoveActivity(
  move: LibraryMoveStatus,
  onReview?: () => void,
  resolve: MessageResolver = m,
): SourcesActivityItem | null {
  const { line } = move;
  if (!line) return null;
  return {
    key: "library-move",
    tone: line.action === "retry" ? "error" : line.action === "dismiss" ? "advisory" : "running",
    label:
      line.action === "retry"
        ? resolve(msg("Moving the Library failed"))
        : line.action === "dismiss"
          ? resolve(msg("Moved into your Library"))
          : resolve(msg("Moving the Library")),
    body: <LibraryMoveNotice move={move} {...(onReview ? { onReview } : {})} />,
  };
}

export function MoveBackDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>Keep this project's sources in its folder?</T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <T>
              This project’s sources, PDFs, notes and reviews are copied back into its folder. They
              also stay in My Library.
            </T>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button
            onClick={() => {
              props.onClose();
              props.onConfirm();
            }}
          >
            <T>Move back</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
