import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { TurnId } from "@t3tools/contracts";

import { derivePendingBackgroundWork } from "./orchestrationV2PendingBackgroundWork.ts";
import { isOrchestrationV2TurnItemVisible } from "./orchestrationV2Timeline.ts";
import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "./orchestrationV2ThreadError.ts";
import { threadPullRequestsOf } from "./threadPullRequests.ts";

export function threadShellFromProjection(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell {
  const providerSession =
    projection.providerSessions
      .filter((session) => session.providerInstanceId === projection.thread.providerInstanceId)
      .sort(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null;
  const latestRun =
    usageLimitRunPresentedAsLatest(
      projection.runs,
      projection.turnItems,
      providerSession?.lastError ?? null,
    ) ?? latestUnheldRun(projection.runs);
  const activeRun =
    projection.runs
      .filter(isInterruptibleRunForShell)
      .sort((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const activityRun =
    projection.runs
      .filter(isActivityRunForShell)
      .sort((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const pendingRuntimeRequest =
    projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .sort(
        (left, right) =>
          DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
      )[0] ?? null;
  const latestUserMessage =
    projection.messages
      .filter((message) => message.role === "user")
      .sort(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null;
  const pendingBackgroundTasks = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs: projection.runs,
  });
  return {
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    id: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    providerInstanceId: projection.thread.providerInstanceId,
    modelSelection: projection.thread.modelSelection,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    pullRequests: threadPullRequestsOf(projection.thread),
    ...(projection.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: projection.thread.linkedPullRequest }),
    ...(projection.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: projection.thread.branchPullRequest }),
    ...(projection.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: projection.thread.activeOrderKey }),
    lineage: projection.thread.lineage,
    forkedFrom: projection.thread.forkedFrom,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    ...(projection.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: projection.thread.historyOrigin }),
    latestRunId: latestRun?.id ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    activeRunId: activeRun?.id ?? null,
    activityRunStatus: activityRun?.status ?? null,
    activityRunStartedAt: activityRun?.startedAt ?? activityRun?.requestedAt ?? null,
    status: latestRun?.status ?? "idle",
    ...threadErrorSummary(
      latestRootProviderFailure(latestRun, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    pendingRuntimeRequest:
      pendingRuntimeRequest === null
        ? null
        : {
            id: pendingRuntimeRequest.id,
            kind: pendingRuntimeRequest.kind,
            createdAt: pendingRuntimeRequest.createdAt,
          },
    // Thread detail owns message bodies. Keeping them out of shell rows makes
    // initial hydration and streaming updates independent of transcript size.
    latestVisibleMessage: null,
    latestUserMessageAt: latestUserMessage?.updatedAt ?? null,
    hasActionableProposedPlan: projection.plans.some(
      (plan) => plan.kind === "proposed_plan" && plan.status === "active",
    ),
    pendingBackgroundTasks,
    providerInstanceHistory: providerInstanceHistoryForShell({
      threadId: projection.thread.id,
      providerThreads: projection.providerThreads,
    }),
    itemCount: projection.turnItems.reduce(
      (count, item) =>
        count +
        Number(
          isOrchestrationV2TurnItemVisible({
            item,
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems,
          }),
        ),
      0,
    ),
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: projection.thread.createdAt,
    updatedAt: projection.updatedAt,
    archivedAt: projection.thread.archivedAt,
    settledOverride: projection.thread.settledOverride,
    settledAt: projection.thread.settledAt,
    unsettledAt: projection.thread.unsettledAt ?? null,
    snoozedUntil: projection.thread.snoozedUntil ?? null,
    snoozedAt: projection.thread.snoozedAt ?? null,
    pinnedAt: projection.thread.pinnedAt ?? null,

    autoSettleDisabledAt: projection.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: projection.thread.pinOrderKey ?? null,
    lastVisitedAt: projection.thread.lastVisitedAt,
    titleRegeneration: projection.thread.titleRegeneration ?? null,
    limitRecovery: projection.thread.limitRecovery ?? null,
    deletedAt: projection.thread.deletedAt,
    // SCIENT-FORK: thread filing must survive detail-only archived routes.
    sectionId: projection.thread.sectionId ?? null,
    conversationImport: projection.thread.conversationImport ?? null,
    forkLineage: projection.thread.forkLineage ?? null,
    latestCompletedAnswer: latestCompletedAnswerFromProjection(projection),
  };
}

/** A newer unfinished run does not replace the last successful root answer. */
export function latestCompletedAnswerFromProjection(projection: OrchestrationV2ThreadProjection) {
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  const completedRuns = projection.runs
    .filter((run) => run.status === "completed" && run.completedAt !== null)
    .sort((left, right) => right.ordinal - left.ordinal);
  for (const run of completedRuns) {
    const answer = projection.messages
      .filter(
        (message) =>
          message.runId === run.id &&
          message.role === "assistant" &&
          (message.nodeId === run.rootNodeId ||
            (message.nodeId !== null &&
              nodes.get(message.nodeId)?.kind === "assistant_message" &&
              nodes.get(message.nodeId)?.parentNodeId === run.rootNodeId)) &&
          !message.streaming &&
          message.text.trim().length > 0,
      )
      .sort(
        (left, right) =>
          DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt) ||
          right.id.localeCompare(left.id),
      )[0];
    if (answer && run.completedAt !== null) {
      return {
        turnId: TurnId.make(run.id),
        messageId: answer.id,
        completedAt: DateTime.formatIso(run.completedAt),
      };
    }
  }
  return null;
}

/**
 * Provider instances that have owned this thread's root conversation, oldest
 * first. Subagent provider threads carry an owner node and are excluded so a
 * delegated Codex child does not make a Claude thread look handed off.
 */
export function providerInstanceHistoryForShell(input: {
  readonly threadId: ThreadId;
  readonly providerThreads: ReadonlyArray<
    OrchestrationV2ThreadProjection["providerThreads"][number]
  >;
}): ReadonlyArray<ProviderInstanceId> {
  const history: Array<ProviderInstanceId> = [];
  for (const providerThread of input.providerThreads
    .filter((thread) => thread.appThreadId === input.threadId && thread.ownerNodeId === null)
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    )) {
    if (!history.includes(providerThread.providerInstanceId)) {
      history.push(providerThread.providerInstanceId);
    }
  }
  return history;
}

function isInterruptibleRunForShell(run: OrchestrationV2ThreadProjection["runs"][number]): boolean {
  return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

type ShellActivityRunStatus = "preparing" | "running" | "starting" | "waiting";

export function isActivityRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
): run is OrchestrationV2ThreadProjection["runs"][number] & {
  readonly status: ShellActivityRunStatus;
} {
  return isInterruptibleRunForShell(run) || run.status === "waiting";
}
