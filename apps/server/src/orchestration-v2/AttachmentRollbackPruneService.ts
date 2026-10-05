import { type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { AttachmentFileArbitration, attachmentHasReservations } from "./AttachmentFileUse.ts";
import type { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ThreadCommandExecutor } from "./ThreadCommandExecutor.ts";

export type RollbackPruneRequest = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: "attachment.rollback-prune" }
>;

export class AttachmentRollbackPruneDeferred extends Schema.TaggedError<AttachmentRollbackPruneDeferred>()(
  "AttachmentRollbackPruneDeferred",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** Missing composition must retain the durable request, never simulate cleanup. */
export class AttachmentRollbackPruneService extends Context.Reference<{
  readonly execute: (
    threadId: ThreadId,
    request: RollbackPruneRequest,
  ) => Effect.Effect<void, AttachmentRollbackPruneDeferred>;
}>("t3/orchestration-v2/AttachmentRollbackPruneService", {
  defaultValue: () => ({
    execute: () =>
      Effect.fail(
        new AttachmentRollbackPruneDeferred({ reason: "Prune ownership is not composed." }),
      ),
  }),
}) {}

const isDeferred = Schema.is(AttachmentRollbackPruneDeferred);

export const layer = Layer.effect(
  AttachmentRollbackPruneService,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const commands = yield* ThreadCommandExecutor;
    const sessions = yield* ProviderSessionManagerV2;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const arbitration = yield* AttachmentFileArbitration;

    const execute = Effect.fn("AttachmentRollbackPrune.execute")(function* (
      threadId: ThreadId,
      request: RollbackPruneRequest,
    ) {
      yield* commands.withLock(
        threadId,
        arbitration.withPermit(
          Effect.gen(function* () {
            const source = yield* projections.getThreadRecords(threadId, [
              "runs",
              "messages",
              "turnItems",
              "providerThreads",
              "providerSessions",
            ]);
            const retained = new Set(
              yield* projections.getRollbackAttachmentOwners({
                threadId,
                revertedRunIds: request.revertedRunIds,
                attachmentIds: request.attachmentIds,
              }),
            );
            const candidates = new Set(request.attachmentIds);
            const deferred: string[] = [];
            for (const id of candidates) {
              if (retained.has(id)) continue;
              const path = resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId: id,
              });
              if (
                path === null ||
                parseThreadSegmentFromAttachmentId(id) !== toSafeThreadAttachmentSegment(threadId)
              ) {
                deferred.push("Uncertain file ownership");
                continue;
              }
              // A missing candidate is an idempotent completed unlink, never a new
              // ownership decision. Intake verifies managed bytes under arbitration.
              if (!(yield* fs.exists(path))) continue;
              if (
                yield* attachmentHasReservations(id).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(ServerConfig, config),
                )
              ) {
                deferred.push("Receipt/publication/copy reservation");
                continue;
              }
              const owningRunIds = new Set([
                ...source.messages
                  .filter((message) =>
                    message.attachments.some((attachment) => attachment.id === id),
                  )
                  .map((message) => message.runId),
                ...source.turnItems
                  .filter(
                    (item) =>
                      item.type === "user_input_request" &&
                      item.questionAnswer !== undefined &&
                      Object.values(item.questionAnswer.attachmentsByQuestionId)
                        .flat()
                        .some((attachment) => attachment.id === id),
                  )
                  .map((item) => item.runId),
              ]);
              const owners = source.runs.filter((run) => owningRunIds.has(run.id));
              if (
                owners.length === 0 ||
                owners.some(
                  (run) => run.status !== "rolled_back" || !request.revertedRunIds.includes(run.id),
                )
              ) {
                deferred.push("Uncertain rollback owner");
                continue;
              }
              let nativeOwned = source.turnItems.some(
                (item) =>
                  item.type === "user_input_request" &&
                  item.questionAnswer !== undefined &&
                  Object.values(item.questionAnswer.attachmentsByQuestionId)
                    .flat()
                    .some((attachment) => attachment.id === id),
              );
              if (nativeOwned) deferred.push("Question-answer native reader release is unproven");
              for (const run of owners) {
                if (run.providerThreadId === null) {
                  if (
                    run.activeAttemptId === null &&
                    run.startedAt === null &&
                    source.thread.historyOrigin !== "v1_import" &&
                    source.thread.historyOrigin !== "conversation_import" &&
                    source.turnItems.some(
                      (item) =>
                        item.type === "user_message" &&
                        item.runId === run.id &&
                        item.inputIntent === "turn_start" &&
                        item.inheritedFrom === undefined,
                    )
                  )
                    continue;
                  deferred.push("Historical native ownership is uncertain");
                  nativeOwned = true;
                  continue;
                }
                const providerThread = source.providerThreads.find(
                  (thread) => thread.id === run.providerThreadId,
                );
                if (
                  providerThread?.providerSessionId !== null &&
                  providerThread?.providerSessionId !== undefined
                ) {
                  // Lookup is a positive live-owner witness only. None/stopped is NOT
                  // reader release: manager scope closure can complete late/timeout.
                  const live = yield* sessions.get(providerThread.providerSessionId);
                  deferred.push(
                    Option.isSome(live)
                      ? "Live native recorded-path owner"
                      : "Native reader release is unproven",
                  );
                } else deferred.push("Native recorded-path ownership is unresolved");
                nativeOwned = true;
              }
              if (!nativeOwned) yield* fs.remove(path, { force: true });
            }
            if (deferred.length > 0)
              return yield* new AttachmentRollbackPruneDeferred({
                reason: [...new Set(deferred)].join("; "),
              });
          }).pipe(Effect.uninterruptible),
        ),
      );
    });
    return {
      execute: (threadId, request) =>
        execute(threadId, request).pipe(
          Effect.mapError((cause) =>
            isDeferred(cause)
              ? cause
              : new AttachmentRollbackPruneDeferred({
                  reason: "Reference recheck or physical cleanup failed",
                  cause,
                }),
          ),
        ),
    };
  }),
);
