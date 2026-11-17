import type { EnvironmentId, ScientSourcesReadingStateResult } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";

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

type ProjectContext = {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly refreshOverview: () => Promise<unknown>;
};

type SnapshotRemoval = {
  readonly context: ProjectContext;
  readonly records: ReadonlyArray<ProjectRemoval>;
  readonly snapshots: number;
  readonly resolve: (removed: boolean) => void;
};

/**
 * The personal Library's actions on this project's sources and on reading state, with their
 * toasts. Removing a pin's snapshot asks first through `SnapshotRemovalDialog`.
 */
export function useLibraryProjectActions(
  input: ProjectContext & {
    readonly applyReadingState: (result: ScientSourcesReadingStateResult) => void;
  },
) {
  const [snapshotRemoval, setSnapshotRemoval] = useState<SnapshotRemoval | null>(null);
  const pendingRemovalRef = useRef<{
    readonly request: SnapshotRemoval;
    confirming: boolean;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- settles the pending removal interaction when its project context leaves or unmounts
  useLayoutEffect(
    () => () => {
      const pending = pendingRemovalRef.current;
      if (
        !pending ||
        pending.request.context.environmentId !== input.environmentId ||
        pending.request.context.root !== input.root
      )
        return;
      pendingRemovalRef.current = null;
      pending.request.resolve(false);
      setSnapshotRemoval(null);
    },
    [input.environmentId, input.root],
  );

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
  const unpinFromProject = async (
    records: ReadonlyArray<ProjectRemoval>,
    context: ProjectContext,
  ) => {
    const outcome = await changeProjectSources({
      environmentId: context.environmentId,
      root: context.root,
      changes: records.flatMap((record) =>
        projectKeys(record).map((citationKey) => ({ action: "unpin" as const, citationKey })),
      ),
    });
    await context.refreshOverview().catch(() => undefined);
    announceProjectChange(
      "remove",
      { ...outcome, changed: removedSourceCount(records, outcome) },
      removedSnapshotCount(records, outcome),
    );
    return outcome.failed === 0;
  };
  // A snapshot is only kept for this project; cancellation or failure keeps the selection.
  const removeFromProject = (records: ReadonlyArray<ProjectRemoval>): Promise<boolean> => {
    pendingRemovalRef.current?.request.resolve(false);
    pendingRemovalRef.current = null;
    setSnapshotRemoval(null);
    const snapshots = records.filter((record) => record.fromSnapshot === true).length;
    if (snapshots > 0) {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const pending: SnapshotRemoval = { context: input, records, snapshots, resolve };
      pendingRemovalRef.current = { request: pending, confirming: false };
      setSnapshotRemoval(pending);
      return promise;
    }
    return unpinFromProject(records, input);
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
      const active = pendingRemovalRef.current;
      if (!snapshotRemoval || active?.request !== snapshotRemoval || active.confirming) return;
      pendingRemovalRef.current = null;
      snapshotRemoval.resolve(false);
      setSnapshotRemoval(null);
    },
    confirmSnapshotRemoval: () => {
      const pending = snapshotRemoval;
      const active = pendingRemovalRef.current;
      if (
        !pending ||
        active?.request !== pending ||
        active.confirming ||
        pending.context.environmentId !== input.environmentId ||
        pending.context.root !== input.root
      )
        return;
      active.confirming = true;
      setSnapshotRemoval(null);
      const settle = (removed: boolean) => {
        if (pendingRemovalRef.current?.request !== pending) return;
        pendingRemovalRef.current = null;
        pending.resolve(removed);
      };
      void unpinFromProject(pending.records, pending.context).then(settle, () => settle(false));
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
