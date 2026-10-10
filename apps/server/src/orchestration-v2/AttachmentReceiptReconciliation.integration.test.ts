import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import { ProviderDriverKind, ProviderSessionId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type UserInputAttachments,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { claimPendingAttachments } from "./AttachmentClaims.ts";
import {
  attachmentHasReservations,
  reserveAttachment,
  type AttachmentReservationOwner,
} from "./AttachmentFileUse.ts";
import {
  AttachmentReservationReconciliation,
  layer as reconciliationLayer,
} from "./AttachmentReservationReconciliation.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { dispatchCommand } from "./ThreadMessageIntake.ts";
import { makeReplayServerConfig } from "./testkit/ProviderReplayHarness.ts";

const now = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
const threadId = ThreadId.make("receipt-owner");
const instanceId = ProviderInstanceId.make("receipt-fixture");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("receipt-project"),
  title: "Receipt proof",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "synthetic" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
};
const message = (
  id: string,
  attachments: ReadonlyArray<ChatAttachment>,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  role: "user",
  text: "Private file receipt proof",
  attachments,
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
});
const question = (
  requestId: string,
  attachments: UserInputAttachments[string],
  completed = true,
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`item:${requestId}`),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: completed ? "completed" : "pending",
  title: null,
  startedAt: now,
  completedAt: completed ? now : null,
  updatedAt: now,
  type: "user_input_request",
  requestId: RuntimeRequestId.make(requestId),
  questions: [],
  ...(completed
    ? { questionAnswer: { requestId, answers: {}, attachmentsByQuestionId: { q: attachments } } }
    : {}),
});
type Payloads = { [E in OrchestrationV2DomainEvent as E["type"]]: E["payload"] };
let ordinal = 0;
const event = <K extends keyof Payloads>(type: K, payload: Payloads[K]) =>
  ({
    id: EventId.make(`receipt:event:${++ordinal}`),
    threadId,
    occurredAt: now,
    type,
    payload,
  }) as OrchestrationV2DomainEvent;
const owner = (
  commandId: string,
  messageId = "original",
): Extract<AttachmentReservationOwner, { kind: "command" }> => ({
  kind: "command",
  threadId,
  commandId: CommandId.make(commandId),
  commandType: "message.dispatch",
  target: { type: "message", messageId: MessageId.make(messageId) },
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Effect.acquireRelease(
    makeReplayServerConfig("receipt-reconciliation"),
    (config) => fs.remove(path.dirname(config.stateDir), { recursive: true }).pipe(Effect.orDie),
  );
  const stores = Layer.mergeAll(
    EventStore.layer,
    CommandReceiptStore.layer,
    ProjectionStore.layer,
  ).pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(path.join(config.stateDir, "receipts.sqlite"))),
  );
  const services = Layer.mergeAll(stores, EventSink.layer.pipe(Layer.provide(stores))).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
  );
  const recovered = reconciliationLayer.pipe(Layer.provideMerge(services));
  const stored = Effect.fn("test.receiptPrivateFile")(function* (pending = false) {
    const attachment = {
      type: "file" as const,
      id: ChatAttachmentId.make(
        pending ? createPendingAttachmentId("txt") : createAttachmentId(threadId, "txt")!,
      ),
      name: "proof.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
    } satisfies ChatAttachment;
    const filename = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
    yield* fs.writeFileString(filename, "evidence");
    return { attachment, filename };
  });
  return { fs, config, services, recovered, stored };
});

it.live(
  "recovers accepted and rejected receipt pins after ambiguous response loss using original events despite later edits",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, config, services, recovered, stored } = yield* fixture;
        const pending = yield* stored(true);
        let accepted: UserInputAttachments[string] = [];
        let rejected: ChatAttachment | undefined;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({ events: [event("thread.created", thread)] });
            const result = yield* dispatchCommand({
              type: "runtime-request.respond",
              threadId,
              commandId: CommandId.make("lost-answer"),
              requestId: RuntimeRequestId.make("lost-question"),
              answers: { q: ["yes"] },
              attachmentsByQuestionId: { q: [pending.attachment] },
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.mock(ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
                  Layer.mock(ThreadManagementService)({
                    dispatch: (command) =>
                      Effect.gen(function* () {
                        if (command.type !== "runtime-request.respond")
                          return yield* Effect.die("Unexpected command");
                        accepted = Object.values(command.attachmentsByQuestionId ?? {}).flat();
                        yield* sink
                          .commitCommand({
                            commandId: command.commandId,
                            threadId,
                            commandType: command.type,
                            acceptedAt: now,
                            effects: [],
                            events: [
                              event("turn-item.updated", question("lost-question", accepted)),
                            ],
                          })
                          .pipe(
                            Effect.mapError(
                              (cause) =>
                                new OrchestratorDispatchError({
                                  commandId: command.commandId,
                                  commandType: command.type,
                                  cause,
                                }),
                            ),
                          );
                        return yield* new OrchestratorDispatchError({
                          commandId: command.commandId,
                          commandType: command.type,
                          cause: "Response lost after commit",
                        });
                      }),
                  }),
                ),
              ),
              Effect.result,
            );
            expect(result._tag).toBe("Failure");
            expect(accepted).toHaveLength(1);
            expect(yield* attachmentHasReservations(accepted[0]!.id)).toBe(true);
            yield* sink.write({
              events: [event("turn-item.updated", question("lost-question", []))],
            });
            const file = yield* stored();
            rejected = file.attachment;
            const pin = yield* reserveAttachment(file.attachment);
            yield* pin.ready(owner("rejected-command"));
            yield* sink.commitRejectedCommand({
              commandId: CommandId.make("rejected-command"),
              threadId,
              commandType: "message.dispatch",
              rejectedAt: now,
              error: "Definitive rejection",
            });
            expect(yield* attachmentHasReservations(file.attachment.id)).toBe(true);
          }).pipe(Effect.provide(services)),
        );
        // The first SQLite scope is closed; fresh acquisition recovers only ready operations.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* AttachmentReservationReconciliation;
            for (const attachment of [...accepted, rejected!]) {
              expect(yield* attachmentHasReservations(attachment.id)).toBe(false);
              expect(
                yield* fs.readFileString(
                  resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
                ),
              ).toBe("evidence");
            }
            expect(yield* fs.readFileString(pending.filename)).toBe("evidence");
            const events = yield* EventStore.EventStoreV2;
            const original = yield* events
              .readByCommandId({ commandId: CommandId.make("lost-answer") })
              .pipe(Stream.runCollect);
            expect(
              original[0]?.event.type === "turn-item.updated" &&
                original[0].event.payload.type === "user_input_request" &&
                original[0].event.payload.questionAnswer?.attachmentsByQuestionId.q,
            ).toEqual(accepted);
            const projection = yield* ProjectionStore.ProjectionStoreV2;
            const current = yield* projection.getThreadRecords(threadId, ["turnItems"]);
            expect(
              current?.turnItems[0]?.type === "user_input_request" &&
                current.turnItems[0].questionAnswer?.attachmentsByQuestionId.q,
            ).toEqual([]);
            // Once composed, the intake's actual post-commit exit hook settles
            // the fresh invocation even when its caller receives an ambiguous error.
            const sink = yield* EventSink.EventSinkV2;
            let fresh: UserInputAttachments[string] = [];
            const liveResult = yield* dispatchCommand({
              type: "runtime-request.respond",
              threadId,
              commandId: CommandId.make("live-lost-answer"),
              requestId: RuntimeRequestId.make("live-question"),
              answers: { q: ["yes"] },
              attachmentsByQuestionId: { q: [pending.attachment] },
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.mock(ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
                  Layer.mock(ThreadManagementService)({
                    dispatch: (command) =>
                      Effect.gen(function* () {
                        if (command.type !== "runtime-request.respond")
                          return yield* Effect.die("Unexpected command");
                        fresh = Object.values(command.attachmentsByQuestionId ?? {}).flat();
                        yield* sink
                          .commitCommand({
                            commandId: command.commandId,
                            threadId,
                            commandType: command.type,
                            acceptedAt: now,
                            effects: [],
                            events: [event("turn-item.updated", question("live-question", fresh))],
                          })
                          .pipe(
                            Effect.mapError(
                              (cause) =>
                                new OrchestratorDispatchError({
                                  commandId: command.commandId,
                                  commandType: command.type,
                                  cause,
                                }),
                            ),
                          );
                        return yield* new OrchestratorDispatchError({
                          commandId: command.commandId,
                          commandType: command.type,
                          cause: "Reply lost after commit",
                        });
                      }),
                  }),
                ),
              ),
              Effect.result,
            );
            expect(liveResult._tag).toBe("Failure");
            expect(fresh).toHaveLength(1);
            expect(fresh[0]!.id).not.toBe(accepted[0]!.id);
            expect(yield* attachmentHasReservations(fresh[0]!.id)).toBe(false);
            expect(
              yield* fs.readFileString(
                resolveAttachmentPath({
                  attachmentsDir: config.attachmentsDir,
                  attachment: fresh[0]!,
                })!,
              ),
            ).toBe("evidence");
            expect(yield* fs.readFileString(pending.filename)).toBe("evidence");
            const liveOriginal = yield* events
              .readByCommandId({ commandId: CommandId.make("live-lost-answer") })
              .pipe(Stream.runCollect);
            expect(
              liveOriginal[0]?.event.type === "turn-item.updated" &&
                liveOriginal[0].event.payload.type === "user_input_request" &&
                liveOriginal[0].event.payload.questionAnswer?.attachmentsByQuestionId.q,
            ).toEqual(fresh);
          }).pipe(Effect.provide(recovered)),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.live("retains absent, mismatched and incomplete canonical receipt evidence across reopen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, services, recovered, stored } = yield* fixture;
      const cases = [
        owner("absent"),
        { ...owner("accepted"), threadId: ThreadId.make("wrong-thread") },
        { ...owner("accepted"), commandType: "queued-run.edit" as const },
        owner("accepted", "wrong-target"),
        owner("missing-final-event"),
      ];
      const files: Array<{ attachment: ChatAttachment; filename: string }> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({ events: [event("thread.created", thread)] });
          yield* sink.commitCommand({
            commandId: CommandId.make("accepted"),
            threadId,
            commandType: "message.dispatch",
            acceptedAt: now,
            effects: [],
            events: [event("message.updated", message("original", []))],
          });
          const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
          yield* receipts.upsert({
            commandId: CommandId.make("missing-final-event"),
            threadId,
            commandType: "message.dispatch",
            acceptedAt: now,
            resultSequence: 999,
            status: "accepted",
            error: null,
          });
          for (const metadata of cases) {
            const file = yield* stored();
            files.push(file);
            const pin = yield* reserveAttachment(file.attachment);
            yield* pin.ready(metadata);
          }
          const anonymous = yield* stored();
          files.push(anonymous);
          yield* reserveAttachment(anonymous.attachment);
        }).pipe(Effect.provide(services)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reconciliation = yield* AttachmentReservationReconciliation;
          yield* reconciliation.reconcile();
          for (const file of files) {
            expect(yield* attachmentHasReservations(file.attachment.id)).toBe(true);
            expect(yield* fs.readFileString(file.filename)).toBe("evidence");
          }
        }).pipe(Effect.provide(recovered)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.live(
  "requires the exact completed question and launch initial-message receipt rather than thread creation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, recovered, stored } = yield* fixture;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.commitCommand({
              commandId: CommandId.make("launch"),
              threadId,
              commandType: "thread.create",
              acceptedAt: now,
              effects: [],
              events: [event("thread.created", thread)],
            });
            const complete = yield* stored();
            const wrong = yield* stored();
            const incomplete = yield* stored();
            const initial = yield* stored();
            for (const [file, commandId, requestId] of [
              [complete, "answer", "exact"],
              [wrong, "answer", "wrong"],
              [incomplete, "pending-answer", "pending"],
            ] as const) {
              const pin = yield* reserveAttachment(file.attachment);
              yield* pin.ready({
                kind: "command",
                threadId,
                commandId: CommandId.make(commandId),
                commandType: "runtime-request.respond",
                target: { type: "question", requestId: RuntimeRequestId.make(requestId) },
              });
            }
            yield* sink.commitCommand({
              commandId: CommandId.make("answer"),
              threadId,
              commandType: "runtime-request.respond",
              acceptedAt: now,
              effects: [],
              events: [event("turn-item.updated", question("exact", [complete.attachment]))],
            });
            yield* sink.commitCommand({
              commandId: CommandId.make("pending-answer"),
              threadId,
              commandType: "runtime-request.respond",
              acceptedAt: now,
              effects: [],
              events: [event("turn-item.updated", question("pending", [], false))],
            });
            const pin = yield* reserveAttachment(initial.attachment);
            yield* pin.ready({
              ...owner("launch:initial-message"),
              target: { type: "initial-message" },
            });
            const badLaunch = yield* reserveAttachment(initial.attachment);
            yield* badLaunch.ready({ ...owner("launch"), target: { type: "initial-message" } });
            const reconciliation = yield* AttachmentReservationReconciliation;
            yield* reconciliation.reconcile();
            expect(yield* attachmentHasReservations(complete.attachment.id)).toBe(false);
            for (const file of [wrong, incomplete, initial])
              expect(yield* attachmentHasReservations(file.attachment.id)).toBe(true);
            yield* sink.commitCommand({
              commandId: CommandId.make("launch:initial-message"),
              threadId,
              commandType: "message.dispatch",
              acceptedAt: now,
              effects: [],
              events: [event("message.updated", message("opening", [initial.attachment]))],
            });
            yield* reconciliation.reconcile();
            // The separately mismatched thread-create token remains independently pinned.
            expect(yield* attachmentHasReservations(initial.attachment.id)).toBe(true);
            yield* badLaunch.release;
            expect(yield* attachmentHasReservations(initial.attachment.id)).toBe(false);
            for (const file of [complete, wrong, incomplete, initial])
              expect(yield* fs.readFileString(file.filename)).toBe("evidence");
          }).pipe(Effect.provide(recovered)),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.live(
  "keeps held private claim copies pinned despite earlier receipts until physical preparation finishes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, config, recovered, stored } = yield* fixture;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            const reconciliation = yield* AttachmentReservationReconciliation;
            yield* sink.write({ events: [event("thread.created", thread)] });
            for (const status of ["accepted", "rejected"] as const) {
              const commandId = CommandId.make(`old-${status}`);
              if (status === "accepted")
                yield* sink.commitCommand({
                  commandId,
                  threadId,
                  commandType: "message.dispatch",
                  acceptedAt: now,
                  effects: [],
                  events: [event("message.updated", message("original", []))],
                });
              else
                yield* sink.commitRejectedCommand({
                  commandId,
                  threadId,
                  commandType: "message.dispatch",
                  rejectedAt: now,
                  error: "Already rejected",
                });
              const pending = yield* stored(true);
              const entered = yield* Deferred.make<string>();
              const resume = yield* Deferred.make<void>();
              const copying = yield* claimPendingAttachments({
                threadId,
                attachments: [pending.attachment],
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, {
                  ...fs,
                  copyFile: (from, to) =>
                    Deferred.succeed(entered, to).pipe(
                      Effect.andThen(Deferred.await(resume)),
                      Effect.andThen(fs.copyFile(from, to)),
                    ),
                }),
                Effect.forkChild,
              );
              const copyingPath = yield* Deferred.await(entered);
              const id = copyingPath.split("/").at(-1)!.slice(0, -4);
              yield* reconciliation.reconcile();
              expect(yield* attachmentHasReservations(id)).toBe(true);
              expect(yield* fs.exists(copyingPath)).toBe(false);
              expect(yield* fs.readFileString(pending.filename)).toBe("evidence");
              yield* Deferred.succeed(resume, undefined);
              const claim = yield* Fiber.join(copying);
              expect(yield* fs.readFileString(claim.claimedPaths[0]!)).toBe("evidence");
              yield* claim.bindReceipt(owner(commandId));
              yield* reconciliation.reconcile(claim.attachments.map((attachment) => attachment.id));
              expect(yield* attachmentHasReservations(claim.attachments[0]!.id)).toBe(false);
              // Reconciliation removes only this operation's token, never its private bytes.
              yield* fs.writeFileString(claim.claimedPaths[0]!, "modified");
              expect(yield* fs.readFileString(pending.filename)).toBe("evidence");
              expect(
                yield* fs.readFileString(
                  resolveAttachmentPath({
                    attachmentsDir: config.attachmentsDir,
                    attachment: claim.attachments[0]!,
                  })!,
                ),
              ).toBe("modified");
            }
          }).pipe(Effect.provide(recovered)),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.live(
  "production ingestion reconciles a generated publication reservation after its durable event",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, stored, services } = yield* fixture;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const published = yield* stored();
            const reservation = yield* reserveAttachment(published.attachment, {
              publication: true,
            });
            yield* reservation.ready({ kind: "generated-publication", threadId });
            expect(yield* attachmentHasReservations(published.attachment.id)).toBe(true);
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({ events: [event("thread.created", thread)] });
            const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
            yield* ingestor.ingestNormalized({
              providerSessionId: ProviderSessionId.make("generated-publication-session"),
              providerInstanceId: instanceId,
              threadId,
              event: {
                type: "turn_item.updated",
                driver: ProviderDriverKind.make("codex"),
                turnItem: {
                  type: "assistant_message",
                  id: TurnItemId.make("item:generated-publication"),
                  threadId,
                  runId: null,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  messageId: MessageId.make("generated-publication-message"),
                  streaming: false,
                  text: "Generated attachment",
                  attachments: [published.attachment],
                },
              },
            });
            expect(yield* attachmentHasReservations(published.attachment.id)).toBe(false);
            expect(yield* fs.readFileString(published.filename)).toBe("evidence");
          }).pipe(
            Effect.provide(
              RuntimeLayer.layerProviderEventIngestorProvided.pipe(Layer.provideMerge(services)),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
