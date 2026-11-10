import type {
  EnvironmentId,
  ScientSourceDetailResult,
  ScientSourceRevisionsResult,
} from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { toastManager } from "../../components/ui/toast";
import { readScientSourceRevisions, revertScientSource } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import { changedFieldsLabel, revisionLabel } from "./sourceLifecycleLabels";

type Revision = ScientSourceRevisionsResult["revisions"][number];

const errorMessage = (cause: unknown) => scientSourcesErrorMessage(cause, import.meta.env.DEV);

/**
 * Kept versions of one source; restoring one saves it as the newest version. Mount it keyed by
 * source and revision while open, so each opening reads the current history.
 */
export function SourceHistoryDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceId: string;
  readonly revision: number;
  readonly onClose: () => void;
  readonly onReverted: (record: ScientSourceDetailResult) => void;
}) {
  const [revisions, setRevisions] = useState<ReadonlyArray<Revision> | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { environmentId, root, sourceId } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the kept revisions from the server once the dialog mounts
  useEffect(() => {
    let current = true;
    void readScientSourceRevisions(environmentId, { root, sourceId }).then(
      (result) => current && setRevisions(result.revisions),
      (cause: unknown) => current && setProblem(errorMessage(cause)),
    );
    return () => {
      current = false;
    };
  }, [environmentId, root, sourceId]);

  const restore = async (toRevision: number) => {
    setPending(toRevision);
    setProblem(null);
    try {
      const result = await revertScientSource(props.environmentId, {
        root: props.root,
        sourceId: props.sourceId,
        expectedRevision: props.revision,
        toRevision,
      });
      if (result.outcome === "stale") {
        // The caller remounts this dialog for the newer revision, which reloads the history.
        props.onReverted(result.record);
        return;
      }
      if (result.outcome === "duplicate") {
        setProblem("That version's identifier now belongs to another source.");
        return;
      }
      if (result.outcome === "not-found") {
        setProblem("That version is no longer kept.");
        return;
      }
      props.onReverted(result.record);
      props.onClose();
      toastManager.add({
        type: "success",
        title: result.outcome === "unchanged" ? "Already this version" : "Earlier version restored",
        ...(result.missingAttachmentCount > 0
          ? {
              description:
                result.missingAttachmentCount === 1
                  ? "Its PDF was deleted when the trash was emptied."
                  : `${result.missingAttachmentCount} of its PDFs were deleted when the trash was emptied.`,
            }
          : {}),
      });
    } catch (cause) {
      setProblem(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>
            Restoring a version saves it as the newest one, so nothing is lost.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {problem ? (
            <p className="mb-2 text-xs text-destructive" role="alert">
              {problem}
            </p>
          ) : null}
          {revisions === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ul className="divide-y divide-border">
              {revisions.map((revision) => (
                <li key={revision.revision} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{revisionLabel(revision)}</div>
                    {revision.changes.length > 0 ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {changedFieldsLabel(revision.changes)}
                      </div>
                    ) : null}
                  </div>
                  {revision.current ? (
                    <span className="text-xs text-muted-foreground">Current</span>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={pending !== null}
                      onClick={() => void restore(revision.revision)}
                    >
                      {pending === revision.revision ? (
                        <LoaderCircle className="animate-spin" />
                      ) : null}
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
