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

import { Button } from "../../components/ui/button";
import { DUPLICATE_LABELS } from "./libraryDuplicateLabels";
import type { LibraryMoveStatus } from "./useLibraryMoveStatus";

/** One line for the project's move into the personal Library, beside the store notices. */
export function LibraryMoveNotice(props: {
  readonly move: LibraryMoveStatus;
  /** Opens the merges the move made, for a line that says some kept different values. */
  readonly onReview?: () => void;
}) {
  const { line } = props.move;
  if (!line) return null;
  return (
    <div className="mx-3 mt-2 text-xs text-muted-foreground">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 break-words tabular-nums">
          {line.action === "dismiss" ? (
            <>
              <p>
                Moved into your Library. A copy of the project's sources from before the move is
                kept in the project.
              </p>
              <details className="mt-1">
                <summary className="cursor-pointer">Show locations</summary>
                <p className="mt-1">{line.text}</p>
                {props.onReview && line.text.includes(SCIENT_LIBRARY_MERGES_TO_REVIEW) ? (
                  <Button size="xs" variant="ghost" onClick={props.onReview}>
                    {DUPLICATE_LABELS.review}
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
            Dismiss
          </Button>
        ) : null}
        {line.action === "retry" ? (
          <Button size="xs" variant="ghost" onClick={props.move.retry}>
            Check again
          </Button>
        ) : null}
      </div>
    </div>
  );
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
          <AlertDialogTitle>Keep this project's sources in its folder?</AlertDialogTitle>
          <AlertDialogDescription>
            The sources and their PDFs are copied back into this project’s folder. The papers also
            stay in your personal Library, because other projects may use them. This project’s notes
            and its reviews come back too. The sealed copy from before the move stays as a recovery
            copy; it does not include later changes. For a large Library this can take a while.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            onClick={() => {
              props.onClose();
              props.onConfirm();
            }}
          >
            Move back
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
