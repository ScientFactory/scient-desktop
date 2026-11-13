import type { EnvironmentId, ScientSourcesReadingStateResult } from "@t3tools/contracts";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { setScientSourcesReadingState } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import {
  changeProjectSources,
  projectKeys,
  removedSnapshotCount,
  removedSourceCount,
  type ProjectSourcesChange,
  type ProjectSourcesOutcome,
} from "./libraryActions";
import {
  addedToProjectLabel,
  goneFromComputerLabel,
  LIBRARY_LABELS,
  readingResultLabel,
  removedFromProjectLabel,
  removeSnapshotsHelp,
  removeSnapshotsLabel,
  type ReadingStateChange,
} from "./libraryLabels";

type ProjectRemoval = {
  readonly citationKey?: string | undefined;
  readonly alsoCitedAs?: ReadonlyArray<string> | undefined;
  readonly fromSnapshot?: boolean | undefined;
};

/**
 * The personal Library's actions on this project's sources and on reading state, with their
 * toasts. Removing a pin's snapshot asks first through `SnapshotRemovalDialog`.
 */
export function useLibraryProjectActions(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly refreshOverview: () => Promise<unknown>;
  readonly applyReadingState: (result: ScientSourcesReadingStateResult) => void;
}) {
  const [snapshotRemoval, setSnapshotRemoval] = useState<{
    readonly records: ReadonlyArray<ProjectRemoval>;
    readonly snapshots: number;
    readonly resolve: (ran: boolean) => void;
  } | null>(null);

  const announceProjectChange = (
    kind: "add" | "remove",
    outcome: ProjectSourcesOutcome,
    snapshots = 0,
  ) => {
    if (outcome.changed > 0) {
      toastManager.add({
        type: "success",
        title:
          kind === "add"
            ? addedToProjectLabel(outcome.changed)
            : removedFromProjectLabel(outcome.changed),
        ...(kind === "remove"
          ? {
              description:
                snapshots > 0
                  ? goneFromComputerLabel(snapshots)
                  : outcome.changed === 1
                    ? LIBRARY_LABELS.staysInLibrary
                    : LIBRARY_LABELS.stayInLibrary,
            }
          : {}),
      });
    }
    if (outcome.failed > 0) {
      toastManager.add({
        type: "error",
        title: kind === "add" ? LIBRARY_LABELS.addFailed : LIBRARY_LABELS.removeFailed,
        description:
          outcome.error ??
          (outcome.failed === 1
            ? "1 source is no longer in the Library."
            : `${outcome.failed} sources are no longer in the Library.`),
      });
    }
  };
  const changeProject = async (
    kind: "add" | "remove",
    changes: ReadonlyArray<ProjectSourcesChange>,
  ) => {
    const outcome = await changeProjectSources({
      environmentId: input.environmentId,
      root: input.root,
      changes,
    });
    await input.refreshOverview().catch(() => undefined);
    announceProjectChange(kind, outcome);
  };
  const addToProject = (records: ReadonlyArray<{ readonly sourceId: string }>) =>
    changeProject(
      "add",
      records.map((record) => ({ action: "pin", sourceId: record.sourceId })),
    );
  const unpinFromProject = async (records: ReadonlyArray<ProjectRemoval>) => {
    const outcome = await changeProjectSources({
      environmentId: input.environmentId,
      root: input.root,
      changes: records.flatMap((record) =>
        projectKeys(record).map((citationKey) => ({ action: "unpin" as const, citationKey })),
      ),
    });
    await input.refreshOverview().catch(() => undefined);
    announceProjectChange(
      "remove",
      { ...outcome, changed: removedSourceCount(records, outcome) },
      removedSnapshotCount(records, outcome),
    );
  };
  // A snapshot is only kept for this project, so its removal asks first; false means cancelled.
  const removeFromProject = (records: ReadonlyArray<ProjectRemoval>): Promise<boolean> => {
    const snapshots = records.filter((record) => record.fromSnapshot === true).length;
    if (snapshots > 0) {
      return new Promise<boolean>((resolve) => {
        setSnapshotRemoval({ records, snapshots, resolve });
      });
    }
    return unpinFromProject(records).then(() => true);
  };
  const setReadingState = async (
    sourceIds: ReadonlyArray<string>,
    change: ReadingStateChange,
    announce: boolean,
  ) => {
    const result = await setScientSourcesReadingState(input.environmentId, {
      root: input.root,
      sourceIds: [...sourceIds],
      ...change,
    }).catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: LIBRARY_LABELS.readingFailed,
        description: scientSourcesErrorMessage(cause, import.meta.env.DEV),
      });
      return null;
    });
    if (!result) return;
    input.applyReadingState(result);
    if (announce) toastManager.add({ type: "success", ...readingResultLabel(change, result) });
  };

  return {
    addToProject,
    removeFromProject,
    setReadingState,
    snapshotRemoval,
    cancelSnapshotRemoval: () => {
      snapshotRemoval?.resolve(false);
      setSnapshotRemoval(null);
    },
    confirmSnapshotRemoval: () => {
      const pendingRemoval = snapshotRemoval;
      setSnapshotRemoval(null);
      if (pendingRemoval) {
        pendingRemoval.resolve(true);
        void unpinFromProject(pendingRemoval.records);
      }
    },
  };
}

export function SnapshotRemovalDialog(props: {
  readonly actions: ReturnType<typeof useLibraryProjectActions>;
}) {
  const { actions } = props;
  return (
    <AlertDialog
      open={actions.snapshotRemoval !== null}
      onOpenChange={(open) => {
        if (!open) actions.cancelSnapshotRemoval();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {removeSnapshotsLabel(actions.snapshotRemoval?.snapshots ?? 1)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {removeSnapshotsHelp(actions.snapshotRemoval?.snapshots ?? 1)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={actions.confirmSnapshotRemoval}>
            {LIBRARY_LABELS.removeFromProject}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
