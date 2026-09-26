export type OmpTurnPhase =
  | "idle"
  | "accepted"
  | "running"
  | "draining"
  | "terminal"
  | "failed"
  | "interrupted"
  | "unknown";

export type OmpTurnOutcome = "local" | "completed" | "failed" | "interrupted" | "unknown";

export interface OmpTurnState {
  readonly phase: OmpTurnPhase;
  readonly requestId?: string;
  readonly cancelRequested: boolean;
  readonly sawAgent: boolean;
}

export type OmpTurnSignal =
  | { readonly type: "begin" }
  | {
      readonly type: "prompt-accepted";
      readonly requestId: string;
      readonly agentInvoked?: boolean;
    }
  | { readonly type: "prompt-failed"; readonly requestId: string }
  | { readonly type: "prompt-result"; readonly requestId?: string; readonly agentInvoked: boolean }
  | { readonly type: "steer-accepted" }
  | { readonly type: "agent-start" }
  | { readonly type: "agent-end"; readonly terminal: boolean }
  | { readonly type: "drain-idle" }
  | { readonly type: "cancel-requested" }
  | { readonly type: "cancel-confirmed" }
  | { readonly type: "unconfirmed" }
  | { readonly type: "process-exit" };

export interface OmpTurnTransition {
  readonly state: OmpTurnState;
  readonly outcome?: OmpTurnOutcome;
}

export const initialOmpTurnState: OmpTurnState = {
  phase: "idle",
  cancelRequested: false,
  sawAgent: false,
};

const finished = (phase: OmpTurnPhase): boolean =>
  phase === "terminal" || phase === "failed" || phase === "interrupted" || phase === "unknown";

const settle = (
  state: OmpTurnState,
  phase: OmpTurnPhase,
  outcome: OmpTurnOutcome,
): OmpTurnTransition => ({
  state: { ...state, phase },
  outcome,
});

/**
 * Prompt acceptance is not turn completion. A turn completes on a local prompt,
 * or after a terminal agent_end has been followed by an idle confirmation.
 * Subagent and compaction frames are not signals: they must not reach this reducer.
 */
export const reduceOmpTurn = (state: OmpTurnState, signal: OmpTurnSignal): OmpTurnTransition => {
  if (signal.type === "begin") {
    return {
      state: { phase: "accepted", cancelRequested: false, sawAgent: false },
    };
  }
  if (finished(state.phase)) return { state };
  switch (signal.type) {
    case "prompt-accepted": {
      const next = { ...state, requestId: signal.requestId };
      if (signal.agentInvoked === false && !state.sawAgent) {
        return settle(next, "terminal", "local");
      }
      if (state.phase === "running" || state.phase === "draining") return { state: next };
      return { state: { ...next, phase: "accepted" } };
    }
    case "prompt-result":
      if (
        signal.requestId !== undefined &&
        state.requestId !== undefined &&
        signal.requestId !== state.requestId
      ) {
        return { state };
      }
      if (!signal.agentInvoked && !state.sawAgent) {
        return settle(
          signal.requestId === undefined ? state : { ...state, requestId: signal.requestId },
          "terminal",
          "local",
        );
      }
      return {
        state: signal.requestId === undefined ? state : { ...state, requestId: signal.requestId },
      };
    case "steer-accepted":
      return { state };
    case "prompt-failed":
      if (state.requestId !== undefined && signal.requestId !== state.requestId) return { state };
      return settle(state, "failed", "failed");
    case "agent-start":
      return { state: { ...state, phase: "running", sawAgent: true } };
    case "agent-end":
      if (!signal.terminal) return { state: { ...state, phase: "running", sawAgent: true } };
      return { state: { ...state, phase: "draining", sawAgent: true } };
    case "drain-idle":
      if (state.phase !== "draining") return { state };
      return state.cancelRequested
        ? settle(state, "interrupted", "interrupted")
        : settle(state, "terminal", "completed");
    case "cancel-requested":
      return { state: { ...state, cancelRequested: true } };
    case "cancel-confirmed":
      return settle(state, "interrupted", "interrupted");
    case "unconfirmed":
    case "process-exit":
      if (state.phase === "idle") return { state };
      return settle(state, "unknown", "unknown");
    default:
      return { state };
  }
};
