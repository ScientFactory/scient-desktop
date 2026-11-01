/**
 * Background tasks can outlive turns and must keep shell liveness visible. Restart clears this
 * in-memory registry; orphaned work is not live. Show monitoring only when watch loops are the sole
 * live work, otherwise working.
 */
import { INERT_TASK_TYPES, MONITOR_TASK_TYPES } from "@t3tools/contracts";
import * as Context from "effect/Context";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

interface ThreadLivenessState {
  readonly agents: Set<string>;
  readonly monitors: Set<string>;
}

// Use shared classification sets so ingestion's agentKind, client folds, and liveness cannot drift.
// Monitor tasks include background shells; inert tasks are plan bookkeeping.

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

export class ThreadBackgroundLivenessService extends Context.Service<
  ThreadBackgroundLivenessService,
  {
    /**
     * Missing taskType on synthesized workflow/Codex rows counts as agent work. Internal shells are
     * covered by their owning agent, but nested agents count separately because they can outlive
     * that parent.
     */
    readonly recordTaskLiveness: (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly taskType: string | undefined;
      readonly status: string | undefined;
      readonly kind: "started" | "progress" | "updated" | "completed";
      readonly agentId?: string | undefined;
    }) => void;

    /** Session death orphans all of a thread's background work. */
    readonly clearThreadLiveness: (threadId: string) => void;

    /**
     * Two-state vocabulary by design: any live agent work is "working";
     * "monitoring" only when watch loops are the ONLY live work.
     */
    readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;
  }
>()("t3/orchestration-v2/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}

export function make(): ThreadBackgroundLivenessService["Service"] {
  const stateByThreadId = new Map<string, ThreadLivenessState>();

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = { agents: new Set(), monitors: new Set() };
    stateByThreadId.set(threadId, created);
    return created;
  };

  // Classification is per-transition, not sticky: a task first seen without
  // a taskType may later reveal itself as a shell, become inert, or turn out
  // to be agent-owned. Every path drops any prior entry for the taskId so a
  // stale bucket assignment can't pin the thread's status (review finding).
  const drop = (threadId: string, taskId: string) => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return;
    }
    state.agents.delete(taskId);
    state.monitors.delete(taskId);
    if (state.agents.size === 0 && state.monitors.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  return {
    recordTaskLiveness: (input) => {
      const taskType = input.taskType;
      if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
        drop(input.threadId, input.taskId);
        return;
      }
      // A subagent's internal non-agent work (its own shells/monitors) is
      // covered by the owning agent's liveness. Nested agents fall through:
      // they can outlive their parent (review finding).
      if (
        input.agentId !== undefined &&
        (taskType === undefined || MONITOR_TASK_TYPES.has(taskType))
      ) {
        drop(input.threadId, input.taskId);
        return;
      }

      // Idle counts as not-live: a resting (resumable) Codex child isn't
      // doing anything, and an all-idle fleet must not pin Working.
      const terminal =
        input.kind === "completed" ||
        input.status === "idle" ||
        (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
      if (terminal) {
        drop(input.threadId, input.taskId);
        return;
      }

      // Status-free progress/metadata is not a restart; a delayed row after idle must not re-enter
      // the live set.
      if ((input.kind === "progress" || input.kind === "updated") && input.status === undefined) {
        const existing = stateByThreadId.get(input.threadId);
        const stillLive =
          existing !== undefined &&
          (existing.agents.has(input.taskId) || existing.monitors.has(input.taskId));
        if (!stillLive) {
          return;
        }
      }

      drop(input.threadId, input.taskId);
      const state = stateFor(input.threadId);
      const bucket =
        taskType !== undefined && MONITOR_TASK_TYPES.has(taskType) ? state.monitors : state.agents;
      bucket.add(input.taskId);
    },

    clearThreadLiveness: (threadId) => {
      stateByThreadId.delete(threadId);
    },

    getThreadBackgroundLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return null;
      }
      if (state.agents.size > 0) {
        return "working";
      }
      if (state.monitors.size > 0) {
        return "monitoring";
      }
      return null;
    },
  };
}
