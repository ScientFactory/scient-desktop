import {
  isProviderNativeSubagentThread,
  type KeepAwakeWork,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";

export interface WorkFacts {
  readonly shell: OrchestrationV2ThreadShell;
  readonly active: boolean;
  readonly blockingInput: boolean;
  readonly blockedChildren?: readonly string[];
  readonly queued: boolean;
  readonly runnableQueue: boolean;
  readonly nativeRunning: boolean;
  readonly finalizing: boolean;
  readonly progress: string;
}

export function classifyWork(facts: WorkFacts, blockedByParent: boolean): KeepAwakeWork {
  const { shell } = facts;
  const removed = shell.archivedAt !== null || shell.deletedAt !== null;
  const blockingInput =
    facts.blockingInput ||
    (shell.pendingRuntimeRequest !== null &&
      shell.pendingRuntimeRequest.kind !== "dynamic_tool_call") ||
    blockedByParent;
  const tasks = shell.pendingBackgroundTasks ?? [];
  const independent = tasks.some(
    (task) =>
      task.kind !== "command" &&
      task.kind !== "monitor" &&
      !(task.kind === "subagent" && task.childThreadId !== undefined),
  );
  const waiting =
    tasks.some((task) => task.kind === "monitor") || shell.limitRecovery?.autoResume === true;
  const queueCanAdvance = facts.runnableQueue && shell.limitRecovery?.autoResume !== true;
  const runnable =
    !removed &&
    (facts.finalizing ||
      (!blockingInput && (facts.active || facts.nativeRunning || queueCanAdvance || independent)));
  return {
    threadId: shell.id,
    title: shell.title,
    latestRunId: shell.latestRunId,
    removed,
    unfinished:
      !removed &&
      (facts.active ||
        facts.nativeRunning ||
        facts.queued ||
        facts.finalizing ||
        independent ||
        waiting ||
        blockingInput),
    runnable,
    blockingInput,
    finalizing: facts.finalizing && !removed,
    ownership: "unknown",
    progress: facts.progress,
    reason: removed
      ? "Thread closed"
      : facts.finalizing
        ? "Saving results"
        : blockingInput
          ? "Waiting for input or approval"
          : runnable
            ? "Work is running"
            : waiting
              ? "Waiting for monitoring or scheduled recovery"
              : facts.queued
                ? "Queue waiting for resume"
                : "Work finished",
  };
}

export function assembleGroups(
  facts: readonly WorkFacts[],
  requested: ReadonlySet<string>,
  includeLocalWork: boolean,
) {
  const byId = new Map<string, WorkFacts>(facts.map((entry) => [entry.shell.id, entry]));
  const children = new Map<string, Set<string>>();
  for (const entry of facts) {
    const parent =
      entry.shell.lineage.relationshipToParent === "subagent"
        ? entry.shell.lineage.parentThreadId
        : null;
    if (
      parent !== null &&
      (entry.active ||
        entry.queued ||
        entry.nativeRunning ||
        entry.finalizing ||
        entry.shell.pendingRuntimeRequest !== null ||
        (entry.shell.pendingBackgroundTasks ?? []).some((task) => task.kind !== "command"))
    ) {
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(entry.shell.id);
    }
    for (const task of entry.shell.pendingBackgroundTasks ?? [])
      if (task.kind === "subagent" && task.childThreadId !== undefined) {
        if (!children.has(entry.shell.id)) children.set(entry.shell.id, new Set());
        children.get(entry.shell.id)!.add(task.childThreadId);
      }
  }
  const parentBlocked = (entry: WorkFacts) => {
    let current = entry;
    const seen = new Set<string>();
    while (isProviderNativeSubagentThread(current.shell) && !seen.has(current.shell.id)) {
      seen.add(current.shell.id);
      const parentId = current.shell.lineage.parentThreadId;
      const parent = parentId === null ? undefined : byId.get(parentId);
      if (!parent) break;
      if (parent.blockedChildren?.some((id) => id === entry.shell.id || id === current.shell.id))
        return true;
      current = parent;
    }
    return false;
  };
  const states = new Map(
    facts.map((entry) => [entry.shell.id, classifyWork(entry, parentBlocked(entry))]),
  );
  const collect = (id: string, seen = new Set<string>()): KeepAwakeWork[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) return [];
    return [
      states.get(entry.shell.id)!,
      ...Array.from(children.get(id) ?? []).flatMap((child) => collect(child, seen)),
    ];
  };
  return facts
    .filter(
      ({ shell }) =>
        requested.has(shell.id) ||
        (includeLocalWork &&
          shell.lineage.relationshipToParent !== "subagent" &&
          (states.get(shell.id)!.unfinished || children.has(shell.id))),
    )
    .map(({ shell }) => ({ threadId: shell.id, members: collect(shell.id) }))
    .filter(
      (group) => requested.has(group.threadId) || group.members.some((member) => member.unfinished),
    );
}
