import { useStableCallback } from "~/hooks/useStableCallback";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelSurface } from "~/rightPanelStore";
import { ensureLocalApi } from "~/localApi";
import { analysisEnvironment } from "~/state/analysis";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { useComputeConsoleStore } from "./computeConsoleStore";
import { computeContextHasRunningWork, closeComputeContext } from "./computeContextCoordinator";
import {
  computeFileContextId,
  useComputeContextStore,
  type ComputeContextId,
} from "./computeContextStore";
import { useComputeFilePresentationStore } from "./computeFilePresentationStore";
import { computeSourceLanguageForPath } from "./computeSourceLanguage";
import { isTerminalAnalysisRunStatus } from "../analysis/analysisRunUiState";
import { useCancelComputeBatchRun } from "./useCancelComputeBatchRun";

/** The session commands a chat needs to stop compute before closing its tabs. */
export function useComputeSessionCommands() {
  const cancelComputeBatchRun = useCancelComputeBatchRun();
  const stopComputeSession = useAtomCommand(computeEnvironment.stopSession, {
    reportFailure: false,
  });
  const getComputeSession = useAtomQueryRunner(computeEnvironment.session, {
    reportFailure: false,
    refresh: true,
  });
  const getBatchRun = useAtomQueryRunner(analysisEnvironment.run, {
    reportFailure: false,
    refresh: true,
  });
  return { cancelComputeBatchRun, stopComputeSession, getComputeSession, getBatchRun };
}

/**
 * Stops the compute contexts owned by right-panel surfaces before they close.
 * Resolves false when a context could not be closed, so the tabs stay open.
 */
export function useCloseComputeOwnedSurfaces(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeWorkspaceRoot: string | undefined;
  readonly commands: ReturnType<typeof useComputeSessionCommands>;
}) {
  const {
    activeThreadRef,
    activeWorkspaceRoot,
    commands: { cancelComputeBatchRun, stopComputeSession, getComputeSession, getBatchRun },
  } = input;
  const computeContextIdForSurface = (surface: RightPanelSurface): ComputeContextId | null => {
    if (surface.kind === "scient" && surface.module === "compute") {
      return surface.contextId ?? null;
    }
    if (surface.kind === "file" && surface.attachment !== undefined) return null;
    const relativePath =
      surface.kind === "file"
        ? surface.relativePath
        : surface.kind === "scient" && surface.module === "file"
          ? surface.path
          : null;
    if (
      activeThreadRef === null ||
      activeWorkspaceRoot === undefined ||
      relativePath === null ||
      computeSourceLanguageForPath(relativePath) === null
    ) {
      return null;
    }
    return computeFileContextId({
      environmentId: activeThreadRef.environmentId,
      threadId: activeThreadRef.threadId,
      cwd: activeWorkspaceRoot,
      relativePath,
    });
  };
  return useStableCallback(async (surfaces: readonly RightPanelSurface[]) => {
    const contextIds = [
      ...new Set(
        surfaces
          .map(computeContextIdForSurface)
          .filter((contextId): contextId is ComputeContextId => contextId !== null),
      ),
    ];
    const working = await Promise.all(
      contextIds.map((contextId) =>
        computeContextHasRunningWork({
          contextId,
          isSessionBusy: async ({ environmentId, cwd, sessionId }) => {
            const session = await getComputeSession({
              environmentId,
              input: { cwd, sessionId: sessionId! },
            });
            return session._tag === "Success" && session.value?.activity === "busy";
          },
          isBatchRunActive: async ({ environmentId, cwd, batchRunId }) => {
            const run = await getBatchRun({
              environmentId,
              input: { cwd, runId: batchRunId! },
            });
            return run._tag === "Success" && !isTerminalAnalysisRunStatus(run.value.receipt.status);
          },
        }),
      ),
    );
    if (
      working.some(Boolean) &&
      !(await ensureLocalApi().dialogs.confirm(
        "Stop what is running and close this tab?\n\nWhat it has printed so far stays with the file.",
        { variant: "destructive" },
      ))
    )
      return false;
    for (const contextId of contextIds) {
      const result = await closeComputeContext({
        contextId,
        stopSession: stopComputeSession,
        getSession: getComputeSession,
        cancelBatchRun: cancelComputeBatchRun,
      });
      if (!result.closed) return false;
      useComputeContextStore.getState().removeContext(contextId);
      useComputeFilePresentationStore.getState().remove(contextId);
      useComputeConsoleStore.getState().forget(contextId);
    }
    return true;
  });
}
