import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentPresentation,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
} from "@t3tools/contracts";
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
import { field } from "../unknownField.ts";

/** Sparse SDK observations enter the same projection as full workflow snapshots. */
export function claudeWorkflowMemberFrame(
  message: unknown,
  previous?: OrchestrationV2SubagentWorkflow,
): unknown {
  const entries = field(message, "workflow_progress");
  if (!Array.isArray(entries)) return message;
  const observations = parseWorkflowProgress(entries);
  if (observations === undefined) return message;
  return {
    workflow_progress: entries.map((entry: unknown) => {
      const observation = observations.agents.find(
        (agent) => agent.index === field(entry, "index"),
      );
      if (field(entry, "type") !== "workflow_agent" || observation === undefined) return entry;
      const state =
        observation.label === undefined ? workflowAgentStatus(observation) : observation.state;
      const startedAt =
        observation.startedAt === undefined
          ? undefined
          : Option.getOrUndefined(DateTime.make(observation.startedAt));
      return {
        ...(typeof entry === "object" && entry !== null ? entry : {}),
        label:
          observation.label ??
          previous?.agents.find((agent) => agent.index === observation.index)?.label ??
          `Agent ${observation.index + 1}`,
        ...(startedAt === undefined ? {} : { startedAt: DateTime.toEpochMillis(startedAt) }),
        ...(state === "pending"
          ? { state: "queued" }
          : state === "running"
            ? { state: "start" }
            : state === "completed"
              ? { state: "done" }
              : state === "failed"
                ? { state: "error" }
                : {}),
      };
    }),
    usage: field(message, "usage"),
  };
}

export function claudeWorkflowMemberObservations(message: unknown) {
  return parseWorkflowProgress(field(message, "workflow_progress"))?.agents;
}

interface ClaudeWorkflowMemberDisplay {
  readonly status: OrchestrationV2Subagent["status"];
  readonly presentation: OrchestrationV2SubagentPresentation;
  readonly result: string | undefined;
}

/** Enriches upstream's member state without retaining or emitting another copy. */
export function claudeWorkflowMemberDisplay(input: {
  readonly previous:
    | {
        readonly status: OrchestrationV2Subagent["status"];
        readonly presentation: OrchestrationV2SubagentPresentation | undefined;
        readonly attempt: number;
        readonly result: string | undefined;
      }
    | undefined;
  readonly member: OrchestrationV2WorkflowAgent;
  readonly observation: ClaudeWorkflowAgentEntry | undefined;
  readonly status: OrchestrationV2Subagent["status"];
  readonly coordinatorStatus: OrchestrationV2Subagent["status"];
  readonly restarted: boolean;
  readonly attempt: number;
  readonly now: DateTime.Utc;
}): ClaudeWorkflowMemberDisplay {
  const { previous, member, observation, coordinatorStatus, restarted, attempt, now } = input;
  let status = input.status;
  if (coordinatorStatus === "running" && observation !== undefined) {
    if (["cancelled", "killed"].includes(observation.state)) status = "cancelled";
    if (["paused", "idle"].includes(observation.state)) status = "idle";
  }
  if (
    !restarted &&
    previous !== undefined &&
    ["completed", "failed", "cancelled", "interrupted"].includes(previous.status) &&
    attempt <= previous.attempt
  ) {
    status = previous.status;
  }
  if (
    !restarted &&
    observation === undefined &&
    previous?.status === "idle" &&
    coordinatorStatus === "running"
  ) {
    status = "idle";
  }
  return {
    status,
    presentation: mergeSubagentPresentation(
      previous?.presentation,
      {
        ...(observation?.lastToolName === undefined
          ? {}
          : { lastToolName: observation.lastToolName }),
        ...(member.phaseIndex === undefined ? {} : { phaseIndex: member.phaseIndex }),
        ...(member.phaseTitle === undefined ? {} : { phaseTitle: member.phaseTitle }),
        ...(member.totalTokens === undefined && member.toolCalls === undefined
          ? {}
          : {
              usage: {
                ...(member.totalTokens === undefined ? {} : { totalTokens: member.totalTokens }),
                ...(member.toolCalls === undefined ? {} : { toolUses: member.toolCalls }),
              },
            }),
      },
      DateTime.formatIso(now),
      restarted,
    ),
    result: observation?.error ?? member.result ?? (restarted ? undefined : previous?.result),
  };
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
/** Retains coordinator ownership only; upstream owns member state and event emission. */
export function makeClaudeWorkflowMembers<
  Coordinator extends WorkflowCoordinator,
  Context extends WorkflowTurnContext<Coordinator>,
  U,
>(input: {
  readonly sessionSubagentsByTaskId: Ref.Ref<Map<string, Coordinator>>;
  readonly updateCoordinator: (update: {
    readonly context: Context;
    readonly taskId: string;
    readonly status: "failed" | "interrupted" | "cancelled";
  }) => Effect.Effect<unknown, U>;
}) {
  const { sessionSubagentsByTaskId } = input;
  const workflowCoordinatorOwners = new Map<
    OrchestrationV2Subagent["id"],
    {
      readonly context: Context;
      readonly taskId: string;
      readonly nativeThreadId: string;
      readonly observationsOnly: boolean;
    }
  >();
  const pendingWorkflowPresentations = new Map<
    string,
    Partial<NonNullable<OrchestrationV2Subagent["presentation"]>>
  >();
  return {
    /** Workflow presentations a run handle announced before its task started. */
    pendingPresentations: pendingWorkflowPresentations,
    /** The coordinator's turn owns its workflow members on this native thread. */
    recordCoordinator(
      task: OrchestrationV2Subagent,
      context: Context,
      taskId: string,
      frame?: unknown,
    ) {
      const nativeThreadId = context.input.providerThread.nativeThreadRef?.nativeId;
      if (
        task.presentation?.kind === "workflow" &&
        nativeThreadId !== undefined &&
        nativeThreadId !== null
      ) {
        const observations = claudeWorkflowMemberObservations(frame);
        workflowCoordinatorOwners.set(task.id, {
          context,
          taskId,
          nativeThreadId,
          observationsOnly:
            observations === undefined || observations.length === 0
              ? (workflowCoordinatorOwners.get(task.id)?.observationsOnly ?? true)
              : observations.every((entry) => entry.label === undefined),
        });
      }
    },
    ownerOf: (taskId: string, nativeThreadId: string) =>
      [...workflowCoordinatorOwners.values()].find(
        (owner) => owner.taskId === taskId && owner.nativeThreadId === nativeThreadId,
      ),
    settleForNativeProcess: Effect.fnUntraced(function* (
      nativeThreadId: string,
      status: "failed" | "interrupted" | "cancelled",
    ) {
      for (const owner of workflowCoordinatorOwners.values()) {
        if (owner.nativeThreadId !== nativeThreadId) continue;
        const coordinator = (yield* Ref.get(sessionSubagentsByTaskId)).get(owner.taskId);
        if (
          coordinator === undefined ||
          ((coordinator.task.workflow?.agents.length ?? 0) > 0 && !owner.observationsOnly) ||
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
> = ReturnType<typeof makeClaudeWorkflowMembers<Coordinator, Context, never>>;
