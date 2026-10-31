// SCIENT-OWNED: Undo of one send to Overleaf (design section 4.3). It shows
// what the send changed and what Undo puts back, runs it (the server saves the
// folder's editors, puts the earlier versions back, then syncs), and shows what
// it did: what it put back, what it left and why, and the sync.
import type {
  EnvironmentId,
  ScientOverleafUndoableSends,
  ScientOverleafUndoResult,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";

import { listOverleafUndoableSends } from "./client";
import { runOverleafUndo } from "./overleafActions";
import {
  operationErrorText,
  overleafUndoView,
  overleafUndoSucceeded,
  undoChangeLabel,
} from "./overleafModel";
import type { OverleafConnection } from "./overleafStore";

type Send = ScientOverleafUndoableSends["sends"][number];

type Phase =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly send: Send | null }
  | { readonly _tag: "undoing"; readonly send: Send }
  | { readonly _tag: "done"; readonly result: ScientOverleafUndoResult }
  | { readonly _tag: "failed"; readonly message: string };

function changeName(change: Send["changes"][number]): string {
  return change.kind === "renamed" ? `${change.to} → ${change.from}` : change.path;
}

// Outside the component: the React Compiler does not compile try/catch.
async function undoSend(
  context: Parameters<typeof runOverleafUndo>[0],
  send: Send,
): Promise<Phase> {
  try {
    return { _tag: "done", result: await runOverleafUndo(context, send.attemptNumber) };
  } catch (error) {
    return { _tag: "failed", message: operationErrorText(error) };
  }
}

/**
 * Undo of `attemptNumber`, or of the newest send that can be undone. Opened from
 * the Overleaf chip ("Undo last send…") and from the review tab after a sync
 * that sent.
 */
export function OverleafUndoDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly connection: OverleafConnection;
  readonly attemptNumber?: number | undefined;
  readonly openReview?: (() => void) | undefined;
  readonly onClose: () => void;
}) {
  const { environmentId, workspaceRoot, connection, attemptNumber, onClose } = props;
  const [phase, setPhase] = useState<Phase>({ _tag: "loading" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Opening the dialog reads the undoable sends from the server; the answer is dropped once it closes.
  useEffect(() => {
    let cancelled = false;
    listOverleafUndoableSends(environmentId, {
      workspaceRoot,
      connectionId: connection.connectionId,
    }).then(
      ({ sends }) => {
        if (cancelled) return;
        const send =
          attemptNumber === undefined
            ? (sends[0] ?? null)
            : (sends.find((listed) => listed.attemptNumber === attemptNumber) ?? null);
        setPhase({ _tag: "ready", send });
      },
      (error: unknown) => {
        if (!cancelled) setPhase({ _tag: "failed", message: operationErrorText(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, workspaceRoot, connection.connectionId, attemptNumber]);

  const busy = phase._tag === "undoing";
  const send = phase._tag === "ready" || phase._tag === "undoing" ? phase.send : null;
  const view = phase._tag === "done" ? overleafUndoView(phase.result) : null;
  const undo = async (chosen: Send) => {
    setPhase({ _tag: "undoing", send: chosen });
    const completed = await undoSend(
      { environmentId, workspaceRoot, connection, openReview: props.openReview },
      chosen,
    );
    if (completed._tag === "done" && overleafUndoSucceeded(completed.result)) {
      const resultView = overleafUndoView(completed.result);
      toastManager.add({
        type: resultView.tone,
        title: resultView.title,
        description: resultView.lines.join(" "),
      });
      onClose();
      return;
    }
    setPhase(completed);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <OverleafMark aria-hidden className="size-4" />
              {send ? `Undo send #${send.attemptNumber}` : "Undo send"}
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {phase._tag === "loading" ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading…
            </p>
          ) : phase._tag === "failed" ? (
            <p className="text-sm text-destructive" role="alert">
              {phase.message}
            </p>
          ) : view ? (
            <div className="flex flex-col gap-1" role="status">
              <p className="text-sm font-medium">{view.title}</p>
              {view.lines.map((line) => (
                <p key={line} className="text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          ) : send === null ? (
            <p className="text-sm text-muted-foreground">No send to undo.</p>
          ) : (
            <ul className="flex flex-col" aria-label="What Undo puts back">
              {send.changes.map((change) => (
                <li key={changeName(change)} className="flex min-w-0 items-center gap-2 py-0.5">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">
                    {undoChangeLabel(change)}
                  </span>
                  <span className="min-w-0 truncate text-sm">{changeName(change)}</span>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter variant="bare" className="mt-2">
          {phase._tag === "done" || phase._tag === "failed" || send === null ? (
            <Button type="button" size="sm" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => void undo(send)}>
                {busy ? "Undoing…" : "Undo"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
