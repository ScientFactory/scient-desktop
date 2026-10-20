import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive, isProviderNativeSubagentThread } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "./orchestrationV2PendingBackgroundWork.ts";
import { copySorted } from "./Array.ts";
import * as DateTime from "effect/DateTime";

export function keepAwakeProgressToken(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "nodes" | "turnItems" | "messages"
  >,
) {
  // Poll times, session timestamps, and thread metadata do not establish execution progress.
  return JSON.stringify([
    projection.runs.map((run) => [run.id, run.status, run.activeAttemptId]),
    projection.attempts.map((attempt) => [attempt.id, attempt.status]),
    projection.nodes.map((node) => [node.id, node.status]),
    Math.max(0, ...projection.turnItems.map((item) => DateTime.toEpochMillis(item.updatedAt))),
    Math.max(
      0,
      ...projection.messages
        .filter((message) => message.role === "assistant")
        .map((message) => DateTime.toEpochMillis(message.updatedAt)),
    ),
  ]);
}

export function hasKeepAwakeShellWork(shell: OrchestrationV2ThreadShell): boolean {
  return (
    ["preparing", "starting", "running", "waiting", "queued"].includes(shell.status) ||
    shell.pendingRuntimeRequest !== null ||
    shell.limitRecovery?.autoResume === true ||
    (shell.pendingBackgroundTasks ?? []).some((task) => task.kind !== "command")
  );
}

export function deriveKeepAwakeWork(projection: OrchestrationV2ThreadProjection) {
  const runs = projection.runs;
  const latest = runs.reduce<(typeof runs)[number] | undefined>(
    (last, run) => (last === undefined || run.ordinal > last.ordinal ? run : last),
    undefined,
  );
  if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null) {
    return {
      unfinished: false,
      needsAwake: false,
      needsAwakeWithoutChildren: false,
      childThreadIds: [],
      hasRunnableQueue: false,
      latestRunId: latest?.id ?? null,
      reason: "Thread closed",
    };
  }
  const active = runs.some((run) =>
    ["preparing", "starting", "running", "waiting"].includes(run.status),
  );
  const queued = copySorted(
    runs.filter((run) => run.status === "queued"),
    (left, right) =>
      (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
      left.ordinal - right.ordinal,
  );
  const pendingInput = projection.runtimeRequests.some(
    (request) => request.status === "pending" && request.kind !== "dynamic_tool_call",
  );
  const failedStart = projection.turnItems.some(
    (item) => item.type === "error" && item.runId === queued[0]?.id,
  );
  const runnableQueue = queued.some((run) => run.queueHeld !== true) && !failedStart;
  const automaticRecovery = projection.thread.limitRecovery?.autoResume === true;
  const background = derivePendingBackgroundWork({
    latestRun: latest,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs,
    pullRequests: projection.thread.pullRequests,
  }).filter((task) => task.kind !== "command");
  const backgroundWork = background.length > 0;
  const childThreadIds = background.flatMap((task) =>
    task.kind === "subagent" && task.childThreadId !== undefined ? [task.childThreadId] : [],
  );
  const independentBackground = background.some(
    (task) => task.kind !== "subagent" || task.childThreadId === undefined,
  );
  const nativeSubagent =
    isProviderNativeSubagentThread(projection.thread) &&
    projection.nodes.some(
      (node) =>
        node.kind === "root_turn" &&
        node.runId === null &&
        isOrchestrationV2WorkActive(node.status),
    );
  const unfinished =
    active ||
    queued.length > 0 ||
    backgroundWork ||
    nativeSubagent ||
    automaticRecovery ||
    pendingInput;
  const canAdvance =
    !pendingInput && (active || runnableQueue || nativeSubagent || automaticRecovery);
  return {
    unfinished,
    needsAwake: canAdvance || backgroundWork,
    needsAwakeWithoutChildren: canAdvance || independentBackground,
    childThreadIds,
    hasRunnableQueue: runnableQueue,
    latestRunId: latest?.id ?? null,
    reason: backgroundWork
      ? "Subagents or monitoring"
      : pendingInput
        ? "Waiting for input or approval"
        : active || nativeSubagent
          ? "Running or saving results"
          : runnableQueue
            ? "Queued work"
            : automaticRecovery
              ? "Waiting for automatic provider recovery"
              : queued.length > 0
                ? "Queue waiting for resume"
                : "Work finished",
  };
}
