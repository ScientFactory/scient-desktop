/**
 * Plans annotate current progress rather than forming a separate surface. Clear them when the turn
 * settles or session dies so finished steps cannot linger as working UI.
 */
import * as Context from "effect/Context";

export interface ThreadPlanProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

interface PlanStepInput {
  readonly step: string;
  readonly status: string;
}

export class ThreadPlanProgressService extends Context.Service<
  ThreadPlanProgressService,
  {
    /**
     * Feed one turn.plan.updated payload. An all-completed plan clears the
     * entry (the turn is wrapping up; nothing is "in progress" anymore).
     */
    readonly recordPlanProgress: (threadId: string, plan: ReadonlyArray<PlanStepInput>) => void;

    /** Turn settled or session died: the working indicator reverts to plain. */
    readonly clearThreadPlanProgress: (threadId: string) => void;

    readonly getThreadPlanProgress: (threadId: string) => ThreadPlanProgress | null;
  }
>()("t3/orchestration-v2/ThreadPlanProgress/ThreadPlanProgressService") {}

export function make(): ThreadPlanProgressService["Service"] {
  const progressByThreadId = new Map<string, ThreadPlanProgress>();

  return {
    recordPlanProgress: (threadId, plan) => {
      const totalSteps = plan.length;
      const completedSteps = plan.filter((step) => step.status === "completed").length;
      // Current step: the in-progress one, else the first pending one (a
      // plan that was just written has no in-progress step yet).
      const current =
        plan.find((step) => step.status === "inProgress") ??
        plan.find((step) => step.status !== "completed");
      if (totalSteps === 0 || completedSteps === totalSteps || current === undefined) {
        progressByThreadId.delete(threadId);
        return;
      }
      progressByThreadId.set(threadId, {
        step: current.step,
        completedSteps,
        totalSteps,
      });
    },

    clearThreadPlanProgress: (threadId) => {
      progressByThreadId.delete(threadId);
    },

    getThreadPlanProgress: (threadId) => progressByThreadId.get(threadId) ?? null,
  };
}
