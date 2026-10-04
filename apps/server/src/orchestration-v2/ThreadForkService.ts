import {
  ContextTransferId,
  CommandId,
  OrchestrationV2Actor,
  OrchestrationV2AppThread,
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ContextTransfer,
  OrchestrationV2CreationSource,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { planConversationFork } from "./scient-fork/ConversationForkPlan.ts";
import { freezeConversationForkNativeSource } from "./scient-fork/ConversationForkNativeSource.ts";

export interface ThreadForkPlanV2 {
  readonly targetThread: OrchestrationV2AppThread;
  readonly transfer: OrchestrationV2ContextTransfer;
  readonly history: Effect.Success<ReturnType<typeof planConversationFork>>;
}

export class ThreadForkPlanError extends Schema.TaggedError<ThreadForkPlanError>()(
  "ThreadForkPlanError",
  {
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Fork copies a provider-finished conversation. Usage-limited and other
 * failed, interrupted, or cancelled turns still have a native thread (or a
 * portable transcript) even though the run did not complete successfully.
 * `waiting` is provider-finished with checkpoint capture still pending.
 * In-progress and rolled-back runs are not forkable.
 */
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
    readonly sourceRun: OrchestrationV2Run;
    readonly canonicalSourcePoint: OrchestrationV2ContextSourcePoint;
    readonly transferId: ContextTransferId;
    readonly targetThreadId: ThreadId;
    readonly title?: string;
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
    plan: (input) =>
      Effect.gen(function* () {
        if (!isForkableSourceRunStatus(input.sourceRun.status)) {
          return yield* new ThreadForkPlanError({
            sourceThreadId: input.sourceProjection.thread.id,
            targetThreadId: input.targetThreadId,
            cause: forkableSourceRunStatusError(input.sourceRun),
          });
        }
        const history = yield* planConversationFork({
          projection: input.sourceProjection,
          targetThreadId: input.targetThreadId,
          source: { kind: "settled-run", runId: input.sourceRun.id },
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
        const retainedIds = new Set(history.items.map((item) => item.inheritedFrom?.itemId));
        const native = freezeConversationForkNativeSource({
          projection: input.sourceProjection,
          retainedSourceItems: input.sourceProjection.visibleTurnItems
            .toSorted((a, b) => a.position - b.position)
            .filter(({ item }) => retainedIds.has(item.id))
            .map(({ item }) => item),
          boundaryRunId: history.boundaryRunId,
          sourceKind: "settled-run",
        });
        const lastAssistant = history.items.findLast((item) => item.type === "assistant_message");
        const targetThread: OrchestrationV2AppThread = {
          ...input.sourceProjection.thread,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          id: input.targetThreadId,
          title: input.title ?? `${input.sourceProjection.thread.title} fork`,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: input.sourceProjection.thread.id,
            relationshipToParent: "fork",
            rootThreadId: input.sourceProjection.thread.lineage.rootThreadId,
          },
          // Local frozen facts replace live source inheritance. Causal lineage
          // and native optimization proof remain on the destination receipt.
          forkedFrom: null,
          historyOrigin: "scient_fork",
          conversationImport: null,
          forkLineage: {
            originThreadId: input.sourceProjection.thread.id,
            baselineAssistantMessageId:
              lastAssistant?.type === "assistant_message" ? lastAssistant.messageId : null,
            ...(input.sourceProjection.thread.conversationImport != null
              ? { sourceImport: input.sourceProjection.thread.conversationImport }
              : input.sourceProjection.thread.forkLineage?.sourceImport === undefined
                ? {}
                : { sourceImport: input.sourceProjection.thread.forkLineage.sourceImport }),
          },
          conversationFork: {
            commandId: input.commandId,
            sourceThreadId: input.sourceProjection.thread.id,
            workspaceMode: "local",
            status: history.attachmentCopies.length === 0 ? "ready" : "pending",
            cwd: input.cwd,
            checkpointRef: null,
            checkpointOid: null,
            attachmentCopies: history.attachmentCopies,
            error: null,
          },
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          lastVisitedAt: null,
          unsettledAt: null,
          limitRecovery: null,
          pinnedAt: null,
          pinOrderKey: null,
          activeOrderKey: null,
          titleRegeneration: null,
          rollbackFailure: null,
          rollbackRequestId: undefined,
          linkedPullRequest: null,
          branchPullRequest: null,
          pullRequests: [],
          deletedAt: null,
        };
        const transfer: OrchestrationV2ContextTransfer = {
          id: input.transferId,
          type: "fork",
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          sourcePoint: input.canonicalSourcePoint,
          basePoint: null,
          sourceProviderInstanceId: input.sourceRun.providerInstanceId,
          targetProviderInstanceId: null,
          targetRunId: null,
          ...(native.strategy === "native_fork"
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
        return { targetThread, transfer, history };
      }),
  }),
);
