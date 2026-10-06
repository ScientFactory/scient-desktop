import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  type ClaudeWorkflowAgentEntry,
  parseWorkflowProgress,
  workflowAgentStatus,
} from "../Adapters/ClaudeSubagentPresentation.ts";
import { mergeSubagentPresentation } from "../Adapters/SubagentPresentation.ts";
import type { ProviderAdapterV2Event } from "../ProviderAdapter.ts";

/** Pure native workflow observation; the registry below owns updates and emission. */
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

type WorkflowCoordinator = { readonly task: OrchestrationV2Subagent };
type WorkflowTurnContext<Coordinator extends WorkflowCoordinator> = {
  readonly subagentsByTaskId: ReadonlyMap<string, Coordinator>;
  readonly input: {
    readonly providerThread: {
      readonly nativeThreadRef: { readonly nativeId: string | null } | null;
    };
  };
};
type WorkflowEvent = Extract<
  ProviderAdapterV2Event,
  { readonly type: "subagent.updated" } | { readonly type: "node.updated" }
>;

/** Workflow slots are observations owned by their coordinator, not resumable native tasks. */
export function makeClaudeWorkflowMembers<
  Coordinator extends WorkflowCoordinator,
  Context extends WorkflowTurnContext<Coordinator>,
  E,
  U,
>(input: {
  readonly CLAUDE_PROVIDER: OrchestrationV2Subagent["driver"];
  readonly emitProviderEvent: (event: WorkflowEvent) => Effect.Effect<void, E>;
  readonly sessionSubagentsByTaskId: Ref.Ref<Map<string, Coordinator>>;
  readonly claudeSubagentIds: (
    context: Context,
    taskId: string,
  ) => { readonly nodeId: OrchestrationV2Subagent["id"] };
  readonly updateCoordinator: (update: {
    readonly context: Context;
    readonly taskId: string;
    readonly status: "failed" | "interrupted" | "cancelled";
  }) => Effect.Effect<unknown, U>;
}) {
  const { CLAUDE_PROVIDER, emitProviderEvent, sessionSubagentsByTaskId, claudeSubagentIds } = input;
  const workflowCoordinatorOwners = new Map<
    OrchestrationV2Subagent["id"],
    {
      readonly context: Context;
      readonly taskId: string;
      readonly nativeThreadId: string;
    }
  >();
  const workflowMembers = new Map<OrchestrationV2Subagent["id"], OrchestrationV2Subagent>();
  const pendingWorkflowPresentations = new Map<
    string,
    Partial<NonNullable<OrchestrationV2Subagent["presentation"]>>
  >();
  const workflowMemberFingerprints = new Map<OrchestrationV2Subagent["id"], string>();
  const workflowMemberActivations = new Map<OrchestrationV2Subagent["id"], number>();
  const emitWorkflowMember = Effect.fnUntraced(function* (member: OrchestrationV2Subagent) {
    workflowMembers.set(member.id, member);
    yield* emitProviderEvent({
      type: "subagent.updated",
      driver: CLAUDE_PROVIDER,
      subagent: member,
    });
    yield* emitProviderEvent({
      type: "node.updated",
      driver: CLAUDE_PROVIDER,
      node: {
        id: member.id,
        threadId: member.threadId,
        runId: null,
        parentNodeId: member.parentNodeId,
        rootNodeId: member.parentNodeId,
        kind: "subagent",
        status: member.status,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: member.startedAt,
        completedAt: member.completedAt,
      },
    });
  });
  return {
    /** Workflow presentations a run handle announced before its task started. */
    pendingPresentations: pendingWorkflowPresentations,
    /** The coordinator's turn owns its workflow members on this native thread. */
    recordCoordinator(task: OrchestrationV2Subagent, context: Context, taskId: string) {
      const nativeThreadId = context.input.providerThread.nativeThreadRef?.nativeId;
      if (
        task.presentation?.kind === "workflow" &&
        nativeThreadId !== undefined &&
        nativeThreadId !== null
      ) {
        workflowCoordinatorOwners.set(task.id, {
          context,
          taskId,
          nativeThreadId,
        });
      }
    },
    ownerOf: (taskId: string, nativeThreadId: string) =>
      [...workflowCoordinatorOwners.values()].find(
        (owner) => owner.taskId === taskId && owner.nativeThreadId === nativeThreadId,
      ),
    /**
     * Settle runless display members before the coordinator clears the
     * final owned background item. The root subscriber can then close
     * without dropping these terminal member/node receipts. Returns undefined
     * when no member is open, so ordinary subagents run no extra steps.
     */
    settleMembersOf: (
      workflowId: OrchestrationV2Subagent["id"],
      status: "completed" | "failed" | "cancelled" | "interrupted",
      now: DateTime.Utc,
    ): Effect.Effect<void, E> | undefined => {
      const isOpenMember = (member: OrchestrationV2Subagent) =>
        member.presentation?.workflowId === workflowId &&
        ["pending", "running", "waiting", "idle"].includes(member.status);
      let hasOpenMember = false;
      for (const member of workflowMembers.values()) if (isOpenMember(member)) hasOpenMember = true;
      if (!hasOpenMember) return undefined;
      return Effect.gen(function* () {
        for (const member of workflowMembers.values()) {
          if (!isOpenMember(member)) continue;
          yield* emitWorkflowMember({
            ...member,
            status,
            completedAt: member.completedAt ?? now,
            updatedAt: now,
          });
        }
      });
    },
    update: Effect.fnUntraced(function* (context: Context, taskId: string, message: unknown) {
      const record =
        typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
      const progress = parseWorkflowProgress(record.workflow_progress);
      if (progress === undefined) return;
      const coordinator =
        context.subagentsByTaskId.get(taskId) ??
        (yield* Ref.get(sessionSubagentsByTaskId)).get(taskId);
      if (coordinator === undefined || coordinator.task.status !== "running") return;
      const now = yield* DateTime.now;
      for (const entry of progress.agents) {
        const id = claudeSubagentIds(context, `${taskId}:wf:${entry.index}`).nodeId;
        const previous = workflowMembers.get(id);
        const { activation, newActivation, status, fingerprint } = claudeWorkflowMemberObservation({
          entry,
          previous,
          coordinator,
          id,
          workflowMemberActivations,
        });
        if (workflowMemberFingerprints.get(id) === fingerprint) continue;
        workflowMemberFingerprints.set(id, fingerprint);
        workflowMemberActivations.set(id, activation);
        const member = claudeWorkflowMemberPresentation({
          entry,
          previous,
          coordinator,
          id,
          newActivation,
          status,
          now,
          CLAUDE_PROVIDER,
        });
        yield* emitWorkflowMember(member);
      }
    }),
    settleForNativeProcess: Effect.fnUntraced(function* (
      nativeThreadId: string,
      status: "failed" | "interrupted" | "cancelled",
    ) {
      for (const owner of workflowCoordinatorOwners.values()) {
        if (owner.nativeThreadId !== nativeThreadId) continue;
        const coordinator = (yield* Ref.get(sessionSubagentsByTaskId)).get(owner.taskId);
        if (
          coordinator === undefined ||
          ["completed", "failed", "cancelled", "interrupted"].includes(coordinator.task.status)
        )
          continue;
        yield* input.updateCoordinator({
          context: owner.context,
          taskId: owner.taskId,
          status,
        });
      }
    }),
  };
}

export type ClaudeWorkflowMembers<
  Coordinator extends WorkflowCoordinator,
  Context extends WorkflowTurnContext<Coordinator>,
> = ReturnType<typeof makeClaudeWorkflowMembers<Coordinator, Context, never, never>>;
