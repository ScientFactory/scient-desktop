import {
  ContextTransferId,
  CommandId,
  OrchestrationV2Actor,
  OrchestrationV2AppThread,
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ContextTransfer,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { planConversationFork } from "./scient-fork/ConversationForkPlan.ts";
import { freezeConversationForkNativeSource } from "./scient-fork/ConversationForkNativeSource.ts";
import { conversationForkBoundaryItem } from "./scient-fork/ConversationForkBoundaryItem.ts";

export interface ThreadForkPlanV2 {
  readonly targetThread: OrchestrationV2AppThread;
  readonly transfer: OrchestrationV2ContextTransfer;
  // SCIENT-FORK:START — a side chat shows only its own rows, so it freezes nothing.
  readonly frozen: {
    readonly history: Effect.Success<ReturnType<typeof planConversationFork>>;
    readonly boundaryItem: Extract<OrchestrationV2TurnItem, { type: "fork" }>;
  } | null;
  // SCIENT-FORK:END
}

export class ThreadForkPlanError extends Schema.TaggedError<ThreadForkPlanError>()(
  "ThreadForkPlanError",
  {
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** waiting means provider-finished with checkpoint capture pending. */
export function isForkableSourceRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "completed" ||
    status === "waiting" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

export function forkableSourceRunStatusError(
  run: Pick<OrchestrationV2Run, "id" | "status">,
): string {
  return `Fork source run ${run.id} is ${run.status}; in-progress and rolled-back runs cannot be forked.`;
}

export interface ThreadForkServiceV2Shape {
  readonly plan: (input: {
    readonly sourceProjection: OrchestrationV2ThreadProjection;
    readonly commandId: CommandId;
    readonly cwd: string;
    /** Null only for a side chat whose parent has no stable run yet. */
    readonly sourceRun: OrchestrationV2Run | null;
    readonly sourceProviderThread?: OrchestrationV2ProviderThread | undefined;
    readonly sourceTokenUsage?: OrchestrationV2ProviderTurnTokenUsage | undefined;
    readonly canonicalSourcePoint: OrchestrationV2ContextSourcePoint;
    readonly transferId: ContextTransferId;
    readonly targetThreadId: ThreadId;
    readonly title?: string;
    readonly sideChat?: boolean;
    readonly createdBy: OrchestrationV2Actor;
    readonly creationSource: OrchestrationV2CreationSource;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<ThreadForkPlanV2, ThreadForkPlanError>;
}

export class ThreadForkServiceV2 extends Context.Service<
  ThreadForkServiceV2,
  ThreadForkServiceV2Shape
>()("t3/orchestration-v2/ThreadForkService/ThreadForkServiceV2") {}

export const layer: Layer.Layer<ThreadForkServiceV2> = Layer.succeed(
  ThreadForkServiceV2,
  ThreadForkServiceV2.of({
    plan: Effect.fn("ThreadForkService.plan")(function* (input) {
      const { sourceRun } = input;
      const sourceLineage = input.sourceProjection.thread.lineage;
      // A task a linked environment delegated here is a subagent of a remote thread.
      if (
        input.sideChat &&
        (sourceLineage.sideChat ||
          sourceLineage.relationshipToParent === "subagent" ||
          input.sourceProjection.thread.delegatedFrom !== undefined)
      ) {
        return yield* new ThreadForkPlanError({
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          cause: sourceLineage.sideChat
            ? "A side chat cannot start another side chat."
            : "A subagent cannot start a side chat.",
        });
      }
      if (sourceRun !== null && !isForkableSourceRunStatus(sourceRun.status)) {
        return yield* new ThreadForkPlanError({
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          cause: forkableSourceRunStatusError(sourceRun),
        });
      }
      // SCIENT-FORK:START — a normal fork freezes its prefix; a side chat stays a live view.
      if (sourceRun === null && input.sideChat !== true) {
        return yield* new ThreadForkPlanError({
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          cause: "Only a side chat can start without a source run.",
        });
      }
      const frozenRun = input.sideChat === true ? null : sourceRun;
      const history =
        frozenRun === null
          ? null
          : yield* planConversationFork({
              projection: input.sourceProjection,
              targetThreadId: input.targetThreadId,
              source: { kind: "settled-run", runId: frozenRun.id },
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadForkPlanError({
                    sourceThreadId: input.sourceProjection.thread.id,
                    targetThreadId: input.targetThreadId,
                    cause,
                  }),
              ),
            );
      const native =
        history === null
          ? null
          : freezeConversationForkNativeSource({
              projection: input.sourceProjection,
              retainedSourceItems: history.retained,
              boundaryRunId: history.boundaryRunId,
              sourceKind: "settled-run",
            });
      // SCIENT-FORK:END
      const targetThread: OrchestrationV2AppThread = {
        ...input.sourceProjection.thread,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
        id: input.targetThreadId,
        title: input.title ?? `${input.sourceProjection.thread.title} fork`,
        // The source's title job completes only on the source thread.
        titleRegeneration: null,
        // Side chats share the parent's worktree, so they start supervised.
        ...(input.sideChat ? { runtimeMode: "approval-required" as const } : {}),
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: input.sourceProjection.thread.id,
          relationshipToParent: "fork",
          rootThreadId: input.sourceProjection.thread.lineage.rootThreadId,
          ...(input.sideChat ? { sideChat: true } : {}),
        },
        // SCIENT-FORK:START — frozen facts for a normal fork; a side chat keeps upstream's link.
        ...(history === null
          ? {
              forkedFrom:
                sourceRun === null
                  ? null
                  : {
                      type: "run" as const,
                      threadId: input.sourceProjection.thread.id,
                      runId: sourceRun.id,
                    },
              historyOrigin: "native" as const,
              conversationImport: null,
              forkLineage: null,
              conversationFork: null,
            }
          : {
              // Local frozen facts replace live source inheritance. Causal lineage
              // and native optimization proof remain on the destination receipt.
              forkedFrom: null,
              historyOrigin: "scient_fork" as const,
              conversationImport: null,
              forkLineage: {
                originThreadId: input.sourceProjection.thread.id,
                baselineAssistantMessageId: history.baselineAssistantMessageId,
                ...(input.sourceProjection.thread.conversationImport != null
                  ? { sourceImport: input.sourceProjection.thread.conversationImport }
                  : input.sourceProjection.thread.forkLineage?.sourceImport === undefined
                    ? {}
                    : { sourceImport: input.sourceProjection.thread.forkLineage.sourceImport }),
              },
              conversationFork: {
                commandId: input.commandId,
                sourceThreadId: input.sourceProjection.thread.id,
                workspaceMode: "local" as const,
                status: "ready" as const,
                cwd: input.cwd,
                checkpointRef: null,
                checkpointOid: null,
                attachmentCopies: history.attachmentCopies,
                error: null,
              },
            }),
        // SCIENT-FORK:END
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        // A guest link belongs to the thread it was made for.
        guestShare: null,
        lastVisitedAt: null,
        unsettledAt: null,
        limitRecovery: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        rollbackFailure: null,
        rollbackRequestId: undefined,
        // PR context follows the conversation; watching remains the source thread's responsibility.
        pullRequests: input.sourceProjection.thread.pullRequests?.map(
          ({ watch: _watch, ...link }) => link,
        ),
        // A fork is a new thread; it does not inherit how often the source was opened.
        opens: null,
        deletedAt: null,
      };
      const transfer: OrchestrationV2ContextTransfer = {
        id: input.transferId,
        type: "fork",
        sourceThreadId: input.sourceProjection.thread.id,
        targetThreadId: input.targetThreadId,
        sourcePoint: input.canonicalSourcePoint,
        basePoint: null,
        sourceProviderInstanceId:
          sourceRun?.providerInstanceId ?? input.sourceProjection.thread.providerInstanceId,
        // Only native forks retain this context; portable handoffs rebuild it.
        sourceTokenUsage:
          (sourceRun?.status === "completed" || sourceRun?.status === "waiting") &&
          // SCIENT-FORK:START — a normal fork needs its exact native proof.
          (native === null
            ? input.sourceProviderThread?.nativeThreadRef?.strength === "strong"
            : native.strategy === "native_fork")
            ? // SCIENT-FORK:END
              input.sourceTokenUsage
            : undefined,
        targetProviderInstanceId: null,
        targetRunId: null,
        ...(native === null
          ? {}
          : native.strategy === "native_fork"
            ? { frozenSource: native.frozenSource }
            : { portableReason: native.reason }),
        status: "pending",
        resolution: null,
        createdBy: input.createdBy,
        error: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        consumedAt: null,
      };
      // SCIENT-FORK:START
      const frozen =
        history === null || frozenRun === null
          ? null
          : {
              history,
              boundaryItem: conversationForkBoundaryItem({
                targetThreadId: input.targetThreadId,
                ordinal: history.history.length,
                createdAt: input.createdAt,
                source: {
                  type: "run" as const,
                  threadId: input.sourceProjection.thread.id,
                  runId: frozenRun.id,
                },
              }),
            };
      return { targetThread, transfer, frozen };
      // SCIENT-FORK:END
    }),
  }),
);
