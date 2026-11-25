import { T, useGT, useMessages } from "gt-react";
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
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { toastManager } from "../../components/ui/toast";
import { readScientSourceRevisions, revertScientSource } from "./client";
import { useCanChangeLibrary } from "./sourcesCommands";
import { sourcesErrorMessage } from "./errorMessage";
import { byLine } from "./dayLabel";
import { changedFieldsLabel } from "./sourceLifecycleLabels";
import { settleAfter } from "./settleAfter";

type Revision = ScientSourceRevisionsResult["revisions"][number];

/** What a restore keeps as it is now (the server's `revertScientSource`). */
const KEPT_BY_RESTORE = new Set(["note", "attachments", "citationKey"]);

/**
 * A version that changed only what a restore keeps brings nothing back; the version before it
 * restores the same details.
 */
function restoreBringsBack(revision: Revision): boolean {
  return (
    revision.changes.length === 0 || revision.changes.some((field) => !KEPT_BY_RESTORE.has(field))
  );
}

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
  const gt = useGT();
  const m = useMessages();
  const [revisions, setRevisions] = useState<ReadonlyArray<Revision> | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { environmentId, root, sourceId } = props;
  const canChange = useCanChangeLibrary(environmentId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the kept revisions from the server once the dialog mounts
  useEffect(() => {
    let current = true;
    void readScientSourceRevisions(environmentId, { root, sourceId }).then(
      (result) => current && setRevisions(result.revisions),
      (cause: unknown) => current && setProblem(sourcesErrorMessage(cause)),
    );
    return () => {
      current = false;
    };
  }, [environmentId, root, sourceId]);

  const restore = async (toRevision: number) => {
    setPending(toRevision);
    setProblem(null);
    await settleAfter(
      async () => {
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
            title:
              result.outcome === "unchanged"
                ? gt("Already this version")
                : gt("Earlier version restored"),
          });
        } catch (cause) {
          setProblem(sourcesErrorMessage(cause));
        }
      },
      () => setPending(null),
    );
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
          <DialogTitle>
            <T context="a source's earlier versions">History</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {problem ? (
            <p className="mb-2 text-xs text-destructive" role="alert">
              {problem}
            </p>
          ) : null}
          {revisions === null ? (
            <p className="text-sm text-muted-foreground">
              <T>Loading…</T>
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {revisions.map((revision) => (
                <li key={revision.revision} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      {byLine(revision.savedBy, revision.savedAt, m)}
                    </div>
                    {revision.changes.length > 0 ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {changedFieldsLabel(revision.changes, m)}
                      </div>
                    ) : null}
                  </div>
                  {revision.current ? (
                    <span className="text-xs text-muted-foreground">
                      {gt("Current", { $context: "the newest version of a source" })}
                    </span>
                  ) : restoreBringsBack(revision) ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={pending !== null || !canChange}
                      onClick={() => void restore(revision.revision)}
                    >
                      {pending === revision.revision ? (
                        <LoaderCircle className="animate-spin" />
                      ) : null}
                      {gt("Restore", { $context: "verb, restores an earlier version" })}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
