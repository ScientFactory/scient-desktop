export type ComputeEmptyResultsState =
  | "loading-history"
  | "starting-session"
  | "running"
  | "stopping-session"
  | "idle-file"
  | "idle-session";

/** Resolve mutually exclusive empty-result copy from lifecycle truth. */
export function resolveComputeEmptyResultsState(input: {
  readonly contextLifecycle:
    | "unbound"
    | "starting"
    | "live"
    | "closing"
    | "close-failed"
    | "terminal"
    | null;
  readonly sessionStatus: string | null;
  readonly sessionActivity: string | null;
  readonly historyPending: boolean;
  readonly focusExecutionPending: boolean;
  readonly sourceFile: boolean;
}): ComputeEmptyResultsState {
  if (input.contextLifecycle === "closing") return "stopping-session";
  if (input.contextLifecycle === "starting" || input.sessionStatus === "starting") {
    return "starting-session";
  }
  if (input.sessionActivity === "busy" || input.focusExecutionPending) return "running";
  if (input.historyPending) return "loading-history";
  return input.sourceFile ? "idle-file" : "idle-session";
}
