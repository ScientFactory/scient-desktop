import { useCallback } from "react";
import type { AnalysisRunSnapshot, EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { analysisEnvironment } from "~/state/analysis";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isTerminalAnalysisRunStatus } from "../analysis/analysisRunUiState";

export interface ComputeBatchCancelInput {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly runId: AnalysisRunSnapshot["receipt"]["runId"];
  readonly waitForExit?: boolean;
}

/** Tab-close cancellation stays available without mounting result renderers. */
export function useCancelComputeBatchRun() {
  const cancelRun = useAtomCommand(analysisEnvironment.cancelRun, { reportFailure: false });
  return useCallback(
    async ({
      environmentId,
      cwd,
      runId,
      waitForExit,
    }: ComputeBatchCancelInput): Promise<boolean> => {
      const result = await cancelRun({
        environmentId,
        input: { cwd, runId, ...(waitForExit ? { waitForExit: true } : {}) },
      });
      if (result._tag === "Success")
        return (
          !waitForExit ||
          (result.value.receipt.runId === runId &&
            isTerminalAnalysisRunStatus(result.value.receipt.status))
        );
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to stop batch run",
            description:
              error instanceof Error ? error.message : "Shutdown could not be confirmed.",
          }),
        );
      }
      return false;
    },
    [cancelRun],
  );
}
