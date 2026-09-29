export type OmpTurnPhase =
  | "idle"
  | "accepted"
  | "running"
  | "draining"
  | "terminal"
  | "failed"
  | "unknown";

export type OmpTurnOutcome = "local" | "completed" | "failed" | "unknown";

export interface OmpTurnState {
  readonly phase: OmpTurnPhase;
  readonly requestId?: string;
  readonly sawAgent: boolean;
  /** The agent run this turn started, once its agent_start arrived. */
  readonly runId?: number;
  /**
   * A run that was still open when the previous turn settled (for example
   * after an unconfirmed drain). Its tail belongs to no turn.
   */
  readonly staleRunId?: number;
  /** The stale run ended inside this turn; frames it carried were dropped. */
  readonly staleRunEnded?: boolean;
}

export type OmpTurnSignal =
  | { readonly type: "begin"; readonly staleRunId?: number }
  | {
      readonly type: "prompt-accepted";
      readonly requestId: string;
      readonly agentInvoked?: boolean;
    }
  | { readonly type: "prompt-failed"; readonly requestId: string }
  /** This turn's prompt command was rejected before OMP accepted it. */
  | { readonly type: "command-failed" }
  | {
      readonly type: "prompt-result";
      readonly requestId?: string;
      readonly agentInvoked: boolean;
      /** OMP 18.3.1+ reported this prompt's outcome (`prompt_result.status`). */
      readonly reported?: boolean;
    }
  | { readonly type: "steer-accepted" }
  | { readonly type: "agent-start"; readonly runId?: number }
  | { readonly type: "agent-end"; readonly terminal: boolean; readonly runId?: number }
  | { readonly type: "drain-idle" }
  | { readonly type: "unconfirmed" }
  | { readonly type: "process-exit" };

export interface OmpTurnTransition {
  readonly state: OmpTurnState;
  readonly outcome?: OmpTurnOutcome;
}

export const initialOmpTurnState: OmpTurnState = {
  phase: "idle",
  sawAgent: false,
};

const finished = (phase: OmpTurnPhase): boolean =>
  phase === "terminal" || phase === "failed" || phase === "unknown";

/** The previous turn's unfinished run. A turn may span several of its own runs. */
const isStaleRun = (state: OmpTurnState, runId: number | undefined): boolean =>
  runId !== undefined && runId === state.staleRunId;

/** An agent_end must close the run this turn most recently started. */
const isForeignEnd = (state: OmpTurnState, runId: number | undefined): boolean =>
  isStaleRun(state, runId) ||
  (runId !== undefined && state.runId !== undefined && runId !== state.runId);

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
      state: {
        phase: "accepted",
        sawAgent: false,
        ...(signal.staleRunId === undefined ? {} : { staleRunId: signal.staleRunId }),
      },
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
    // Prompt outcomes correlate strictly: only the id OMP returned for this
    // turn's prompt may decide it. Until that id is known, nothing does.
    case "prompt-result":
      if (signal.requestId !== undefined && signal.requestId !== state.requestId) {
        return { state };
      }
      if (!signal.agentInvoked && !state.sawAgent) return settle(state, "terminal", "local");
      // OMP reports a prompt after its run ends, so a reported prompt with no
      // run of its own never ran (an abort that won the race, a preflight
      // denial), and the reported status decides it. If the previous turn's
      // unfinished run ended meanwhile, the prompt may have been queued into
      // it and its answer dropped with that run's frames: uncertain.
      if (signal.reported === true && !state.sawAgent) {
        return state.staleRunEnded === true
          ? settle(state, "unknown", "unknown")
          : settle(state, "terminal", "completed");
      }
      return { state };
    case "steer-accepted":
      return { state };
    case "prompt-failed":
      if (signal.requestId !== state.requestId) return { state };
      return settle(state, "failed", "failed");
    case "command-failed":
      return settle(state, "failed", "failed");
    case "agent-start":
      if (isStaleRun(state, signal.runId)) return { state };
      return {
        state: {
          ...state,
          phase: "running",
          sawAgent: true,
          ...(signal.runId === undefined ? {} : { runId: signal.runId }),
        },
      };
    case "agent-end":
      if (isStaleRun(state, signal.runId)) return { state: { ...state, staleRunEnded: true } };
      if (isForeignEnd(state, signal.runId)) return { state };
      if (!signal.terminal) return { state: { ...state, phase: "running", sawAgent: true } };
      return { state: { ...state, phase: "draining", sawAgent: true } };
    case "drain-idle":
      if (state.phase !== "draining") return { state };
      return settle(state, "terminal", "completed");
    case "unconfirmed":
    case "process-exit":
      if (state.phase === "idle") return { state };
      return settle(state, "unknown", "unknown");
    default:
      return { state };
  }
};
