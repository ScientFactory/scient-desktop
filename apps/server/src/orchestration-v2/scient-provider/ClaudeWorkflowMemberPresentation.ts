import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  type ClaudeWorkflowAgentEntry,
  workflowAgentStatus,
} from "../Adapters/ClaudeSubagentPresentation.ts";
import { mergeSubagentPresentation } from "../Adapters/SubagentPresentation.ts";

/** Pure native workflow observation; the adapter owns registry updates and emission. */
export function claudeWorkflowMemberObservation({
  entry,
  previous,
  coordinator,
  id,
  workflowMemberActivations,
}: {
  readonly entry: ClaudeWorkflowAgentEntry;
  readonly previous: OrchestrationV2Subagent | undefined;
  readonly coordinator: { readonly task: OrchestrationV2Subagent };
  readonly id: OrchestrationV2Subagent["id"];
  readonly workflowMemberActivations: ReadonlyMap<OrchestrationV2Subagent["id"], number>;
}) {
  const observedStatus = workflowAgentStatus(entry);
  const activation = coordinator.task.presentation?.activationCount ?? 1;
  const newActivation = previous !== undefined && workflowMemberActivations.get(id) !== activation;
  const status =
    previous !== undefined &&
    !newActivation &&
    ["completed", "failed", "cancelled", "interrupted"].includes(previous.status) &&
    (entry.attempt ?? 0) <= (previous.presentation?.attempt ?? 0)
      ? previous.status
      : observedStatus;
  const fingerprint = [
    activation,
    status,
    entry.label,
    entry.model,
    entry.lastToolName,
    entry.error,
    entry.tokens,
    entry.toolCalls,
    entry.phaseIndex,
    entry.phaseTitle,
    entry.attempt,
    entry.startedAt,
  ].join("\u001f");
  return { activation, newActivation, status, fingerprint };
}

/** Called only after the adapter accepts a changed observation. */
export function claudeWorkflowMemberPresentation({
  entry,
  previous,
  coordinator,
  id,
  newActivation,
  status,
  now,
  CLAUDE_PROVIDER,
}: {
  readonly entry: ClaudeWorkflowAgentEntry;
  readonly previous: OrchestrationV2Subagent | undefined;
  readonly coordinator: { readonly task: OrchestrationV2Subagent };
  readonly id: OrchestrationV2Subagent["id"];
  readonly newActivation: boolean;
  readonly status: OrchestrationV2Subagent["status"];
  readonly now: DateTime.Utc;
  readonly CLAUDE_PROVIDER: OrchestrationV2Subagent["driver"];
}): OrchestrationV2Subagent {
  const reopened =
    previous !== undefined &&
    (newActivation ||
      (status === "running" &&
        previous.status !== "running" &&
        (entry.attempt ?? 0) > (previous.presentation?.attempt ?? 0)));
  const startedAt =
    entry.startedAt === undefined
      ? (previous?.startedAt ?? null)
      : DateTime.make(entry.startedAt).pipe(
          Option.map(DateTime.toUtc),
          Option.getOrElse(() => previous?.startedAt ?? null),
        );
  const member: OrchestrationV2Subagent = {
    id,
    threadId: coordinator.task.threadId,
    runId: null,
    parentNodeId: coordinator.task.id,
    origin: "provider_native",
    createdBy: "agent",
    driver: CLAUDE_PROVIDER,
    providerInstanceId: coordinator.task.providerInstanceId,
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "",
    title: entry.label ?? previous?.title ?? `Agent ${entry.index + 1}`,
    model: entry.model ?? previous?.model ?? null,
    status,
    result: entry.error ?? (reopened ? null : (previous?.result ?? null)),
    startedAt,
    completedAt: ["completed", "failed", "cancelled", "interrupted"].includes(status)
      ? reopened
        ? now
        : (previous?.completedAt ?? now)
      : null,
    updatedAt: now,
    presentation: mergeSubagentPresentation(
      previous?.presentation,
      {
        kind: "workflow_agent",
        workflowId: coordinator.task.id,
        agentIndex: entry.index,
        ...(entry.phaseIndex === undefined ? {} : { phaseIndex: entry.phaseIndex }),
        ...(entry.phaseTitle === undefined ? {} : { phaseTitle: entry.phaseTitle }),
        ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
        ...(entry.lastToolName === undefined ? {} : { lastToolName: entry.lastToolName }),
        ...(entry.tokens === undefined && entry.toolCalls === undefined
          ? {}
          : {
              usage: {
                ...(entry.tokens === undefined ? {} : { totalTokens: entry.tokens }),
                ...(entry.toolCalls === undefined ? {} : { toolUses: entry.toolCalls }),
              },
            }),
      },
      DateTime.formatIso(now),
      reopened,
    ),
  };
  return member;
}
