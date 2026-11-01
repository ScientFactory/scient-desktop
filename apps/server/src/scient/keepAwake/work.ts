import {
  isLiveSubagentShell,
  type KeepAwakeWork,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

type ThreadLineage = OrchestrationV2ThreadShell["lineage"];

/**
 * Sleep pauses what is executing, so only that keeps the computer awake. Monitors only watch, and
 * pull request watches are monitors. A dev server the agent left running counts: from here it
 * can't be told from a six-hour job, and a pause costs more than an awake computer.
 */
export function threadWork(
  shell: OrchestrationV2ThreadShell,
): "executing" | "waiting" | "finished" {
  if (shell.archivedAt !== null || shell.deletedAt !== null) return "finished";
  const request = shell.pendingRuntimeRequest;
  const needsAnswer =
    request !== null && request.kind !== "dynamic_tool_call" && request.blocking !== false;
  // A run only waiting on another thread is that thread's work, which reports for itself.
  const executing =
    ((shell.activityRunStatus ?? null) !== null && shell.blockedOnThreadWait !== true) ||
    (shell.pendingBackgroundTasks ?? []).some((task) => task.kind !== "monitor");
  if (executing && !needsAnswer) return "executing";
  return isLiveSubagentShell(shell) || shell.limitRecovery?.autoResume === true
    ? "waiting"
    : "finished";
}

/** The thread and the parents it reports to, up to the top-level thread. */
function withParents(
  threadId: ThreadId,
  lineages: ReadonlyMap<ThreadId, ThreadLineage>,
): ReadonlyArray<ThreadId> {
  const chain = [threadId];
  for (const id of chain) {
    const lineage = lineages.get(id);
    const parent = lineage?.relationshipToParent === "subagent" ? lineage.parentThreadId : null;
    if (parent !== null && parent !== undefined && !chain.includes(parent)) chain.push(parent);
  }
  return chain;
}

export function summarizeWork(
  threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly work: "working" | "waiting" | "finished";
  }>,
  lineages: ReadonlyMap<ThreadId, ThreadLineage>,
): KeepAwakeWork {
  const inState = (state: "working" | "waiting") => [
    ...new Set(
      threads
        .filter((thread) => thread.work === state)
        .flatMap((thread) => withParents(thread.threadId, lineages)),
    ),
  ];
  return { working: inState("working"), waiting: inState("waiting") };
}
