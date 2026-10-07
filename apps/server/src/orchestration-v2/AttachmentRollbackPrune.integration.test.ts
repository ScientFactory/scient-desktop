import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  CheckpointId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as EffectWorker from "./EffectWorker.ts";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import { dispatchCommand } from "./ThreadMessageIntake.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { reserveAttachment } from "./AttachmentFileUse.ts";
import {
  AttachmentRollbackPruneService,
  layer as pruneLayer,
  type RollbackPruneRequest,
} from "./AttachmentRollbackPruneService.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ThreadCommandExecutor, layer as commandsLayer } from "./ThreadCommandExecutor.ts";
import { makeReplayServerConfig } from "./testkit/ProviderReplayHarness.ts";

const now = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
const threadId = ThreadId.make("prune-owner");
const foreignId = ThreadId.make("foreign-owner");
const instanceId = ProviderInstanceId.make("prune-fixture");
const modelSelection = { instanceId, model: "synthetic" };
const thread = (id: ThreadId): OrchestrationV2AppThread => ({
  id,
  projectId: ProjectId.make("prune-project"),
  title: id,
  providerInstanceId: instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
});
const run = (
  id: RunId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run => ({
  id,
  threadId,
  ordinal,
  providerInstanceId: instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: null,
  completedAt: status === "queued" ? null : now,
  checkpointId: null,
  contextHandoffId: null,
});
const message = (
  owner: ThreadId,
  id: string,
  runId: RunId | null,
  attachments: ReadonlyArray<ChatAttachment>,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId: owner,
  runId,
  nodeId: null,
  role: "user",
  text: "synthetic attachment evidence",
  attachments,
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
});
const itemBase = (id: string, runId: RunId | null, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

type Payloads = { [E in OrchestrationV2DomainEvent as E["type"]]: E["payload"] };
let eventOrdinal = 0;
const event = <K extends keyof Payloads>(type: K, owner: ThreadId, payload: Payloads[K]) =>
  ({
    id: EventId.make(`prune:event:${++eventOrdinal}`),
    type,
    threadId: owner,
    occurredAt: now,
    payload,
  }) as OrchestrationV2DomainEvent;
const request = (ids: ReadonlyArray<string>, runs: ReadonlyArray<RunId>): RollbackPruneRequest => ({
  type: "attachment.rollback-prune",
  attachmentIds: ids,
  revertedRunIds: runs,
  checkpointId: CheckpointId.make("prune-baseline"),
  providerThreadId: ProviderThreadId.make("prune-rewind-owner"),
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Effect.acquireRelease(makeReplayServerConfig("guarded-prune"), (config) =>
    fs.remove(path.dirname(config.stateDir), { recursive: true }).pipe(Effect.orDie),
  );
  const db = makeSqlitePersistenceLive(path.join(config.stateDir, "prune.sqlite")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, EffectOutbox.layer).pipe(
    Layer.provideMerge(db),
  );
  const services = Layer.mergeAll(
    stores,
    EventSink.layer.pipe(Layer.provide(stores)),
    ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
    commandsLayer,
  ).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
  );
  const owned = Effect.fn("test.pruneOwnedFile")(function* (name: string, owner = threadId) {
    const attachment = {
      type: name.endsWith(".png") ? ("image" as const) : ("file" as const),
      id: ChatAttachmentId.make(
        createAttachmentId(owner, name.endsWith(".png") ? undefined : "txt")!,
      ),
      name,
      mimeType: name.endsWith(".png") ? "image/png" : "text/plain",
      sizeBytes: 8,
    } satisfies ChatAttachment;
    const filename = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
    yield* fs.writeFileString(filename, "evidence");
    return { attachment, filename };
  });
  return { config, services, owned, fs };
});

// These fixtures prove physical cleanup for durable never-started local work.
// Native/question files stay deferred until an independently granted reader
// release contract exists. They do not close ITD01's native conjunction.
it.live(
  "prunes only non-delivered rollback bytes and retains queue, inherited, fork and native owners after reopen/rebuild",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { config, services, owned, fs } = yield* fixture;
        const removed = yield* owned("removed.png");
        const shared = yield* owned("shared.txt");
        const alias = yield* owned("alias.txt");
        const held = yield* owned("held.txt");
        const extracted = yield* owned("extracted.txt");
        const forkSource = yield* owned("fork.txt");
        const question = yield* owned("question.txt");
        const foreign = yield* owned("foreign.txt", foreignId);
        const failed = run(RunId.make("never-started"), 1, "failed");
        const queue = { ...run(RunId.make("held-retry"), 2, "queued"), queueHeld: true };
        const extractedRun = run(RunId.make("extracted-edit"), 3, "rolled_back");
        const nativeRun = {
          ...run(RunId.make("native-history"), 4, "rolled_back"),
          startedAt: now,
        };
        const ids = [removed, shared, alias, held, extracted, forkSource, question, foreign].map(
          (file) => file.attachment.id,
        );
        const prune = request(ids, [failed.id, extractedRun.id, nativeRun.id]);
        const commandId = CommandId.make("prune-commit");
        const inherited: OrchestrationV2TurnItem = {
          ...itemBase("inherited", failed.id, 1),
          type: "assistant_message",
          messageId: MessageId.make("inherited"),
          text: "inherited",
          streaming: false,
          attachments: [shared.attachment],
          inheritedFrom: {
            threadId: foreignId,
            itemId: TurnItemId.make("source"),
            runId: null,
            status: "completed",
          },
        };
        const original: OrchestrationV2TurnItem = {
          ...itemBase("original", failed.id, 0),
          type: "user_message",
          messageId: MessageId.make("local"),
          inputIntent: "turn_start",
          text: "never started",
          attachments: [
            removed.attachment,
            shared.attachment,
            alias.attachment,
            forkSource.attachment,
          ],
          createdBy: "user",
          creationSource: "web",
        };
        const queuedOrigin: OrchestrationV2TurnItem = {
          ...itemBase("extracted", extractedRun.id, 2),
          type: "user_message",
          messageId: MessageId.make("extracted"),
          text: "edit journal source",
          inputIntent: "queued_turn",
          attachments: [extracted.attachment],
          createdBy: "user",
          creationSource: "web",
        };
        const answer: OrchestrationV2TurnItem = {
          ...itemBase("question", nativeRun.id, 3),
          type: "user_input_request",
          requestId: RuntimeRequestId.make("question"),
          questions: [],
          questionAnswer: {
            requestId: "question",
            answers: {},
            attachmentsByQuestionId: { q: [question.attachment] },
          },
        };
        const verify = Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const pruneService = yield* AttachmentRollbackPruneService;
          const error = yield* pruneService.execute(threadId, prune).pipe(Effect.flip);
          expect(error.reason).toContain("reader release");
          expect(yield* fs.exists(removed.filename)).toBe(false);
          for (const file of [shared, alias, held, extracted, forkSource, question, foreign])
            expect(yield* fs.readFileString(file.filename)).toBe("evidence");
          expect(
            (yield* store.getThreadRecords(threadId, ["messages"])).messages.find(
              (row) => row.id === MessageId.make("local"),
            )?.attachments,
          ).toContainEqual(removed.attachment);
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const effect = yield* outbox.get("prune-commit");
          expect(Option.isSome(effect) && effect.value.status).toBe("pending");
        });
        const pruning = pruneLayer.pipe(
          Layer.provideMerge(services),
          Layer.provide(Layer.mock(ProviderSessionManagerV2)({ get: () => Effect.succeedNone })),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({
              events: [
                event("thread.created", threadId, thread(threadId)),
                event("thread.created", foreignId, {
                  ...thread(foreignId),
                  archivedAt: now,
                  deletedAt: now,
                  conversationFork: {
                    commandId: CommandId.make("pending-fork"),
                    sourceThreadId: threadId,
                    workspaceMode: "local",
                    status: "failed",
                    cwd: config.cwd,
                    checkpointRef: null,
                    checkpointOid: null,
                    attachmentCopies: [
                      { source: forkSource.attachment, target: foreign.attachment },
                    ],
                    error: "retryable",
                  },
                }),
                ...[failed, queue, extractedRun, nativeRun].map((payload) =>
                  event("run.created", threadId, payload),
                ),
                event(
                  "message.updated",
                  threadId,
                  message(threadId, "local", failed.id, [
                    removed.attachment,
                    shared.attachment,
                    alias.attachment,
                    forkSource.attachment,
                  ]),
                ),
                event(
                  "message.updated",
                  threadId,
                  message(threadId, "held", queue.id, [held.attachment]),
                ),
                event(
                  "message.updated",
                  threadId,
                  message(threadId, "extracted", extractedRun.id, [extracted.attachment]),
                ),
                event(
                  "message.updated",
                  foreignId,
                  message(foreignId, "foreign", null, [
                    shared.attachment,
                    {
                      ...alias.attachment,
                      id: ChatAttachmentId.make(alias.attachment.id.toUpperCase()),
                    },
                    foreign.attachment,
                  ]),
                ),
                ...[original, inherited, queuedOrigin, answer].map((payload) =>
                  event("turn-item.updated", threadId, payload),
                ),
              ],
            });
            expect(yield* fs.exists(removed.filename)).toBe(true);
            yield* sink.writeWithEffects({
              events: [event("run.updated", threadId, { ...failed, status: "rolled_back" })],
              effects: [{ id: "prune-commit", commandId, threadId, request: prune }],
            });
            expect(yield* fs.exists(removed.filename)).toBe(true);
            yield* verify;
            yield* verify;
          }).pipe(Effect.provide(pruning)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* verify;
            const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
            yield* maintenance.rebuild;
            yield* verify;
          }).pipe(Effect.provide(pruning)),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.live("retains files and enqueues no prune when the rollback projection transaction fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { services, owned, fs } = yield* fixture;
      const file = yield* owned("failed-commit.png");
      const failed = run(RunId.make("failed-commit"), 1, "failed");
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* sink.write({
          events: [
            event("thread.created", threadId, thread(threadId)),
            event("run.created", threadId, failed),
            event(
              "message.updated",
              threadId,
              message(threadId, "local", failed.id, [file.attachment]),
            ),
          ],
        });
        const missing = ThreadId.make("missing-owner");
        const result = yield* Effect.flatMap(EventSink.EventSinkV2, (failingSink) =>
          failingSink.writeWithEffects({
            events: [
              event("run.updated", threadId, { ...failed, status: "rolled_back" }),
              event("message.updated", missing, message(missing, "missing", null, [])),
            ],
            effects: [
              {
                id: "failed-prune",
                commandId: CommandId.make("failed-prune"),
                threadId,
                request: request([file.attachment.id], [failed.id]),
              },
            ],
          }),
        ).pipe(
          Effect.provide(
            Layer.fresh(EventSink.layer).pipe(
              Layer.provide(
                Layer.succeed(ProjectionStore.ProjectionStoreV2, {
                  ...store,
                  apply: (entry) =>
                    entry.threadId === missing
                      ? Effect.fail(
                          new ProjectionStore.ProjectionStoreApplyEventError({
                            eventType: entry.type,
                            cause: "Injected projector failure after rollback run update",
                          }),
                        )
                      : store.apply(entry),
                }),
              ),
            ),
          ),
          Effect.exit,
        );
        expect(result._tag).toBe("Failure");
        expect((yield* store.getThreadRecords(threadId, ["runs"])).runs[0]?.status).toBe("failed");
        expect(Option.isNone(yield* outbox.get("failed-prune"))).toBe(true);
        expect(yield* fs.readFileString(file.filename)).toBe("evidence");
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.live("rechecks a later retained reference and refuses managed reuse after cleanup wins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { services, owned, fs } = yield* fixture;
      const kept = yield* owned("late.png");
      const removed = yield* owned("wins.png");
      const reverted = run(RunId.make("reverted"), 1, "rolled_back");
      const prune = request([kept.attachment.id, removed.attachment.id], [reverted.id]);
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const commands = yield* ThreadCommandExecutor;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        yield* sink.write({
          events: [
            event("thread.created", threadId, thread(threadId)),
            event("run.created", threadId, reverted),
            event(
              "message.updated",
              threadId,
              message(threadId, "local", reverted.id, [kept.attachment, removed.attachment]),
            ),
            event("turn-item.updated", threadId, {
              ...itemBase("original", reverted.id, 0),
              type: "user_message",
              messageId: MessageId.make("local"),
              inputIntent: "turn_start",
              text: "never started",
              attachments: [kept.attachment, removed.attachment],
              createdBy: "user",
              creationSource: "web",
            }),
          ],
        });
        const delayed = pruneLayer.pipe(
          Layer.provide(
            Layer.succeed(ThreadCommandExecutor, {
              activeKeys: commands.activeKeys,
              withLock: (key, effect) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(resume)),
                  Effect.andThen(commands.withLock(key, effect)),
                ),
            }),
          ),
          Layer.provide(Layer.mock(ProviderSessionManagerV2)({ get: () => Effect.succeedNone })),
        );
        const cleaning = yield* Effect.gen(function* () {
          const service = yield* AttachmentRollbackPruneService;
          yield* service.execute(threadId, prune);
        }).pipe(Effect.provide(delayed), Effect.forkChild);
        yield* Deferred.await(entered);
        const pin = yield* reserveAttachment(kept.attachment);
        yield* commands.withLock(
          threadId,
          sink.write({
            events: [
              event(
                "message.updated",
                threadId,
                message(threadId, "later", null, [kept.attachment]),
              ),
            ],
          }),
        );
        yield* pin.release;
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(cleaning);
        expect(yield* fs.readFileString(kept.filename)).toBe("evidence");
        expect(yield* fs.exists(removed.filename)).toBe(false);
        expect((yield* reserveAttachment(removed.attachment).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        let dispatched = false;
        const refused = yield* dispatchCommand({
          type: "queued-run.edit",
          commandId: CommandId.make("missing-reuse"),
          threadId,
          runId: reverted.id,
          text: "reuse",
          attachments: [removed.attachment],
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.mock(ThreadManagementService)({
                dispatch: () =>
                  Effect.sync(() => {
                    dispatched = true;
                  }).pipe(Effect.andThen(Effect.die("Missing bytes must reject before dispatch"))),
              }),
              Layer.mock(ProjectCloneTracker)({}),
            ),
          ),
          Effect.exit,
        );
        expect(refused._tag).toBe("Failure");
        expect(dispatched).toBe(false);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect(
  "retries only cleanup past the normal attempt limit without relabeling committed rollback",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { services, owned, fs } = yield* fixture;
        const removed = yield* owned("retry.png");
        const reverted = run(RunId.make("cleanup-retry"), 1, "rolled_back");
        const prune = request([removed.attachment.id], [reverted.id]);
        yield* Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          yield* sink.writeWithEffects({
            events: [
              event("thread.created", threadId, thread(threadId)),
              event("run.created", threadId, reverted),
              event(
                "message.updated",
                threadId,
                message(threadId, "local", reverted.id, [removed.attachment]),
              ),
              event("turn-item.updated", threadId, {
                ...itemBase("original", reverted.id, 0),
                type: "user_message",
                messageId: MessageId.make("local"),
                inputIntent: "turn_start",
                text: "never started",
                attachments: [removed.attachment],
                createdBy: "user",
                creationSource: "web",
              }),
            ],
            effects: [
              {
                id: "retry-prune",
                commandId: CommandId.make("retry-prune"),
                threadId,
                request: prune,
              },
            ],
          });
          let attempts = 0;
          const failingFs = {
            ...fs,
            remove: (filename: string, options?: Parameters<typeof fs.remove>[1]) =>
              filename === removed.filename && attempts++ === 0
                ? Effect.die("Injected physical unlink failure")
                : fs.remove(filename, options),
          };
          const pruning = pruneLayer.pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem, failingFs)),
            Layer.provide(Layer.mock(ProviderSessionManagerV2)({ get: () => Effect.succeedNone })),
          );
          const executor = Layer.effect(
            EffectWorker.OrchestrationEffectExecutorV2,
            Effect.gen(function* () {
              const service = yield* AttachmentRollbackPruneService;
              return {
                execute: (effect: EffectOutbox.OrchestrationEffectV2) =>
                  effect.request.type === "attachment.rollback-prune"
                    ? service.execute(effect.threadId, effect.request).pipe(
                        Effect.mapError(
                          (cause) =>
                            new EffectWorker.OrchestrationEffectExecutionError({
                              effectId: effect.id,
                              effectType: effect.request.type,
                              cause,
                            }),
                        ),
                      )
                    : Effect.die("Cleanup must never redispatch rewind"),
              };
            }),
          ).pipe(Layer.provide(pruning));
          yield* Effect.gen(function* () {
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            expect(yield* worker.runOnce).toBe(true);
            const pending = yield* outbox.get("retry-prune");
            expect(Option.isSome(pending) && pending.value.status).toBe("pending");
            expect(Option.isSome(pending) && pending.value.attemptCount).toBe(1);
            expect(yield* fs.exists(removed.filename)).toBe(true);
            expect((yield* store.getThreadRecords(threadId, ["runs"])).runs[0]?.status).toBe(
              "rolled_back",
            );
            yield* TestClock.adjust(100);
            expect(yield* worker.runOnce).toBe(true);
            expect(yield* fs.exists(removed.filename)).toBe(false);
            const completed = yield* outbox.get("retry-prune");
            expect(Option.isSome(completed) && completed.value.status).toBe("succeeded");
            expect(attempts).toBe(2);
            expect(yield* worker.runOnce).toBe(false);
          }).pipe(
            Effect.provide(
              EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(Layer.provide(executor)),
            ),
          );
        }).pipe(Effect.provide(services));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
