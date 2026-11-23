import type {
  AnalysisRunId,
  ComputeExecutionId,
  ComputeSessionId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";

import { useRightPanelStore } from "~/rightPanelStore";
import { scientComputeSurface } from "~/scient/rightPanel/surfaces";

export type ComputeHistoryFocus = {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
} & (
  | { readonly sessionId: ComputeSessionId; readonly executionId: ComputeExecutionId }
  | { readonly fileRunId: AnalysisRunId }
);

const useHistoryFocus = create<{ target: ComputeHistoryFocus | null }>(() => ({ target: null }));

export function openComputeHistoryRun(target: ComputeHistoryFocus) {
  useHistoryFocus.setState({ target: { ...target } });
  useRightPanelStore
    .getState()
    .openScient(target.threadRef, scientComputeSurface({ cwd: target.cwd }));
}

export function useComputeHistoryFocus(threadRef: ScopedThreadRef, cwd: string) {
  return useHistoryFocus(({ target }) =>
    target?.cwd === cwd &&
    target.threadRef.environmentId === threadRef.environmentId &&
    target.threadRef.threadId === threadRef.threadId
      ? target
      : null,
  );
}
