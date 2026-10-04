import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ChatAttachmentId,
  EventId,
  NodeId,
  PlanId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../config.ts";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as DateTime from "effect/DateTime";
import { EventSinkV2 } from "./EventSink.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { AcpProviderCapabilitiesV2 } from "./Adapters/AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  NativeSessionOperationError,
  type NativeSessionUpdate,
} from "./Adapters/NativeSessionAdapterV2.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2, type OrchestratorV2Error } from "./Orchestrator.ts";
import {
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";
import { sourcePlanFingerprint } from "./SourcePlan.ts";

const instanceId = ProviderInstanceId.make("omp");
const modelSelection = { instanceId, model: "queue-policy-model" };

interface NativeOffer {
  readonly input: ProviderAdapterV2TurnInput;
  readonly releaseSend: Effect.Effect<void>;
  readonly settle: (status: "completed" | "failed") => Effect.Effect<void>;
}

const withNativeQueue = <A, E, R>(
  name: string,
  body: (controls: {
    readonly threadId: ThreadId;
    readonly orchestrator: OrchestratorV2["Service"];
    readonly offers: ReadonlyArray<string>;
    readonly preparationReady: Effect.Effect<void>;
    readonly releasePreparation: Effect.Effect<void>;
    readonly preparationAttempts: () => number;
    readonly nativeInterruptions: () => number;
    readonly takeOffer: Effect.Effect<NativeOffer, Cause.TimeoutError>;
    readonly waitFor: (
      predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
    ) => Effect.Effect<
      OrchestrationV2ThreadProjection,
      OrchestratorV2Error | Cause.TimeoutError,
      Scope.Scope
    >;
  }) => Effect.Effect<A, E, R>,
  options: {
    readonly holdFirstSend?: boolean;
    readonly refuseSend?: number;
    readonly ambiguousSend?: number;
    readonly synchronousFailSend?: number;
    readonly acceptBeforeSyncFailure?: boolean;
    readonly holdSyncFailure?: boolean;
    readonly ingestSyncAcceptance?: boolean;
    readonly holdPreparation?: boolean;
    readonly refusePreparation?: boolean;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const allocator = yield* IdAllocatorV2;
      const scope = yield* Scope.Scope;
      const offered = yield* Queue.unbounded<NativeOffer>();
      const firstSendReleased = yield* Deferred.make<void>();
      const preparationReady = yield* Deferred.make<void>();
      const preparationReleased = yield* Deferred.make<void>();
      let preparationAttempts = 0;
      const offers: string[] = [];
      let nativeInterruptions = 0;
      const adapterOptions = {
        instanceId,
        driver: ProviderDriverKind.make("omp"),
        capabilities: AcpProviderCapabilitiesV2,
        idAllocator: allocator,
        defaultCwd: cwd,
        continuations: { offer: () => Effect.die("No background continuation in queue fixture") },
        open: (input, publish) =>
          Effect.succeed({
            nativeId: `queue-policy:${input.providerSessionId}`,
            nativeThreadKnown: true,
            send: (turn, nativeTurnId) =>
              Effect.gen(function* () {
                offers.push(turn.message.text);
                const nativeAccepted = yield* Deferred.make<void>();
                const released =
                  options.holdFirstSend && offers.length === 1
                    ? firstSendReleased
                    : yield* Deferred.make<void>();
                yield* Queue.offer(offered, {
                  input: turn,
                  releaseSend: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
                  settle: (status) =>
                    Deferred.await(nativeAccepted).pipe(
                      Effect.andThen(
                        publish({
                          type: "terminal",
                          status,
                          ...(status === "failed"
                            ? { detail: "Controlled native provider failure" }
                            : {}),
                        }),
                      ),
                    ),
                });
                if (options.synchronousFailSend === offers.length) {
                  if (options.holdSyncFailure && !options.ingestSyncAcceptance)
                    yield* Deferred.await(released);
                  yield* publish({ type: "offered", nativeTurnId });
                  if (options.acceptBeforeSyncFailure)
                    yield* publish({ type: "accepted", nativeTurnId });
                  if (options.holdSyncFailure && options.ingestSyncAcceptance)
                    yield* Deferred.await(released);
                  return yield* new NativeSessionOperationError({
                    detail: "Synchronous native transport failure",
                  });
                }
                if (
                  options.refuseSend === offers.length ||
                  options.ambiguousSend === offers.length
                ) {
                  const ambiguous = options.ambiguousSend === offers.length;
                  yield* publish({ type: "offered", nativeTurnId });
                  yield* Deferred.await(released).pipe(
                    Effect.andThen(
                      (ambiguous
                        ? publish({
                            type: "text",
                            id: "native-output",
                            delta: "Native output before lost response",
                          })
                        : publish({ type: "rejected", nativeTurnId })
                      ).pipe(
                        Effect.andThen(
                          publish({
                            type: "terminal",
                            status: "failed",
                            detail: ambiguous
                              ? "Native response lost after output"
                              : "Controlled native prompt refusal",
                          }),
                        ),
                      ),
                    ),
                    Effect.forkIn(scope),
                  );
                  return;
                }
                if (options.holdFirstSend && offers.length === 1) yield* Deferred.await(released);
                yield* publish({ type: "accepted", nativeTurnId });
                yield* Deferred.succeed(nativeAccepted, undefined);
              }),
            resume: () => Effect.void,
            respond: () => Effect.die("No native question in queue fixture"),
            interrupt: Effect.sync(() => {
              nativeInterruptions += 1;
            }).pipe(
              Effect.andThen(
                publish({ type: "terminal", status: "cancelled" } satisfies NativeSessionUpdate),
              ),
            ),
          }),
      } satisfies Parameters<typeof makeNativeSessionAdapterV2>[0];
      const adapter = makeNativeSessionAdapterV2(adapterOptions);
      const preparationInstanceId = ProviderInstanceId.make("queue-preparation-target");
      const preparationAdapter = makeNativeSessionAdapterV2({
        ...adapterOptions,
        instanceId: preparationInstanceId,
      });
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        {
          name,
          runtimePolicyOverride: { cwd },
        },
        makeLayer([
          options.holdFirstSend || options.synchronousFailSend !== undefined
            ? {
                ...adapter,
                openSession: (input) =>
                  adapter.openSession(input).pipe(
                    Effect.map((runtime) => ({
                      ...runtime,
                      // Delay delivery of the actual first lifecycle frame, preserving its
                      // complete identity/payload while the external send is acknowledged.
                      events: runtime.events.pipe(
                        Stream.mapEffect((event) =>
                          options.synchronousFailSend !== undefined &&
                          !options.ingestSyncAcceptance &&
                          event.type === "provider_turn.updated" &&
                          event.providerTurn.ordinal === options.synchronousFailSend
                            ? Effect.never
                            : options.holdFirstSend &&
                                event.type === "provider_turn.updated" &&
                                event.providerTurn.ordinal === 1 &&
                                event.providerTurn.status === "running"
                              ? Deferred.await(firstSendReleased).pipe(Effect.as(event))
                              : Effect.succeed(event),
                        ),
                      ),
                    })),
                  ),
              }
            : adapter,
          ...(options.holdPreparation
            ? [
                {
                  ...preparationAdapter,
                  openSession: (input: Parameters<typeof preparationAdapter.openSession>[0]) =>
                    Effect.gen(function* () {
                      preparationAttempts += 1;
                      yield* Deferred.succeed(preparationReady, undefined);
                      yield* Deferred.await(preparationReleased);
                      if (options.refusePreparation)
                        return yield* new ProviderAdapterOpenSessionError({
                          driver: preparationAdapter.driver,
                          providerSessionId: input.providerSessionId,
                          cause: "Controlled external provider preparation refusal",
                        });
                      return yield* preparationAdapter.openSession(input);
                    }),
                },
              ]
            : []),
        ]),
        { configureMcp: false },
      );
      return yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const threadId = ThreadId.make(`thread:${name}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const waitFor = Effect.fnUntraced(function* (
          predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
        ) {
          // Subscribe at the durable cursor before the first SQL read. Both existing
          // receipts and subsequent commits converge without polling or timing gaps.
          const cursor = yield* orchestrator.getThreadEventSequence(threadId);
          const pull = yield* Stream.toPull(
            orchestrator.streamStoredEventsFrom({
              threadId,
              afterSequence: cursor,
            }),
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const found = yield* Stream.concat(
            Stream.succeed(projection),
            Stream.fromPull(Effect.succeed(pull)).pipe(
              Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
            ),
          ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
          assert.isTrue(Option.isSome(found));
          if (Option.isNone(found)) return yield* Effect.die("Queue projection did not converge");
          return found.value;
        });
        const takeOffer = Queue.take(offered).pipe(Effect.timeout("15 seconds"));
        return yield* body({
          threadId,
          orchestrator,
          offers,
          preparationReady: Deferred.await(preparationReady),
          releasePreparation: Deferred.succeed(preparationReleased, undefined).pipe(Effect.asVoid),
          preparationAttempts: () => preparationAttempts,
          takeOffer,
          waitFor,
          nativeInterruptions: () => nativeInterruptions,
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, idAllocatorLayer))),
  );

const send = (
  orchestrator: OrchestratorV2["Service"],
  threadId: ThreadId,
  text: string,
  queue = false,
) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`${threadId}:send:${text}`),
    threadId,
    messageId: MessageId.make(`${threadId}:message:${text}`),
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: queue ? "queue_after_active" : "start_immediately" },
  });

for (const { bytes, refused } of [
  { bytes: false, refused: true },
  { bytes: false, refused: false },
  { bytes: true, refused: true },
  { bytes: true, refused: false },
]) {
  it.live(
    `reserves queued ${bytes ? "bytes" : "count"} through preparation until ${refused ? "held failure" : "native acceptance"}`,
    () =>
      withNativeQueue(
        `queue-reservation:${bytes}:${refused}`,
        ({
          orchestrator,
          threadId,
          takeOffer,
          waitFor,
          preparationReady,
          releasePreparation,
          preparationAttempts,
        }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const config = yield* ServerConfig;
            const ownedAttachment = Effect.fnUntraced(function* (name: string, size: number) {
              const id = createAttachmentId(threadId);
              assert.ok(id);
              const attachment = {
                type: "file" as const,
                id: ChatAttachmentId.make(id),
                name,
                mimeType: "application/octet-stream",
                sizeBytes: 1,
              };
              const path = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              assert.ok(path);
              yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
              yield* fs.writeFile(path, new Uint8Array(size).fill(73));
              assert.equal(Number((yield* fs.stat(path)).size), size);
              return { attachment, path };
            });
            yield* send(orchestrator, threadId, "Foreground");
            const foreground = yield* takeOffer;
            const headAttachment = bytes
              ? yield* ownedAttachment("head.bin", 31 * 1024 * 1024)
              : undefined;
            const tailAttachment = bytes
              ? yield* ownedAttachment("tail.bin", 32 * 1024 * 1024)
              : undefined;
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              threadId,
              commandId: CommandId.make(`${threadId}:head`),
              messageId: MessageId.make(`${threadId}:head`),
              text: "Queued head",
              attachments: headAttachment ? [headAttachment.attachment] : [],
              modelSelection: {
                instanceId: ProviderInstanceId.make("queue-preparation-target"),
                model: "queue-policy-model",
              },
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
              selectedScientSkillNames: ["preserved-skill"],
            });
            for (let index = 0; index < (bytes ? 1 : 19); index++) {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                threadId,
                commandId: CommandId.make(`${threadId}:tail:${index}`),
                messageId: MessageId.make(`${threadId}:tail:${index}`),
                text: `Tail ${index}`,
                attachments: tailAttachment ? [tailAttachment.attachment] : [],
                dispatchMode: { type: "queue_after_active" },
                createdBy: "user",
                creationSource: "web",
              });
            }
            const before = yield* orchestrator.getThreadProjection(threadId);
            const head = before.runs.find(
              (run) => run.userMessageId === MessageId.make(`${threadId}:head`),
            );
            assert.ok(head);
            assert.equal(head.status, "queued");
            const originalMessage = before.messages.find(
              (message) => message.id === head.userMessageId,
            );
            assert.ok(originalMessage);
            yield* foreground.settle("completed");
            yield* preparationReady;
            const preparing = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(preparing.runs.find((run) => run.id === head.id)?.status, "starting");
            assert.equal(
              preparing.runs.filter((run) => run.status === "queued").length,
              bytes ? 1 : 19,
            );
            const extra = bytes ? yield* ownedAttachment("extra.bin", 2 * 1024 * 1024) : undefined;
            const candidate = {
              type: "message.dispatch" as const,
              threadId,
              commandId: CommandId.make(`${threadId}:replacement`),
              messageId: MessageId.make(`${threadId}:replacement`),
              text: "Replacement",
              attachments: extra ? [extra.attachment] : [],
              dispatchMode: { type: "queue_after_active" as const },
              createdBy: "user" as const,
              creationSource: "web" as const,
            };
            if (tailAttachment && extra) {
              const tailRun = preparing.runs.find(
                (run) => run.userMessageId === MessageId.make(`${threadId}:tail:0`),
              );
              assert.ok(tailRun);
              const edit = yield* Effect.result(
                orchestrator.dispatch({
                  type: "queued-run.edit",
                  threadId,
                  runId: tailRun.id,
                  commandId: CommandId.make(`${threadId}:edit-while-reserved`),
                  text: "Enlarged tail",
                  attachments: [tailAttachment.attachment, extra.attachment],
                }),
              );
              assert.equal(
                edit._tag,
                "Failure",
                "A queued edit must retain the starting head's bytes",
              );
              assert.deepEqual(
                (yield* orchestrator.getThreadProjection(threadId)).messages.find(
                  (message) => message.id === tailRun.userMessageId,
                )?.attachments,
                [tailAttachment.attachment],
              );
            }
            const rejected = yield* Effect.result(orchestrator.dispatch(candidate));
            assert.equal(
              rejected._tag,
              "Failure",
              "Promotion cannot release a potentially restored head's budget",
            );
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).messages.some(
                (message) => message.id === candidate.messageId,
              ),
              false,
            );
            yield* releasePreparation;
            if (refused) {
              const held = yield* waitFor((projection) =>
                projection.runs.some(
                  (run) => run.id === head.id && run.status === "queued" && run.queueHeld === true,
                ),
              );
              assert.equal(preparationAttempts(), 5);
              assert.equal(
                held.runs.filter((run) => run.status === "queued").length,
                bytes ? 2 : 20,
              );
              assert.deepEqual(
                held.messages.find((message) => message.id === head.userMessageId),
                originalMessage,
              );
              const again = yield* Effect.result(
                orchestrator.dispatch({
                  type: "legacy-queue.import",
                  threadId,
                  commandId: CommandId.make(`${threadId}:after-held`),
                  queueItemId: "reserved-import",
                  messageId: candidate.messageId,
                  text: candidate.text,
                  attachments: candidate.attachments,
                  createdAt: yield* DateTime.now,
                }),
              );
              assert.equal(
                again._tag,
                "Failure",
                "Held legacy admission shares the restored queue's budget",
              );
            } else {
              const nativeHead = yield* takeOffer;
              assert.equal(nativeHead.input.runId, head.id);
              yield* waitFor((projection) =>
                projection.providerTurns.some(
                  (turn) =>
                    turn.runAttemptId === nativeHead.input.attemptId &&
                    turn.nativeAcceptance === "accepted",
                ),
              );
              yield* orchestrator.dispatch({
                ...candidate,
                commandId: CommandId.make(`${threadId}:after-accepted`),
              });
              const admitted = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(
                admitted.messages.some((message) => message.id === candidate.messageId),
                true,
              );
              assert.equal(
                admitted.runs.filter((run) => run.status === "queued").length,
                bytes ? 2 : 20,
              );
            }
            if (headAttachment)
              assert.equal(Number((yield* fs.stat(headAttachment.path)).size), 31 * 1024 * 1024);
            if (extra) assert.equal(Number((yield* fs.stat(extra.path)).size), 2 * 1024 * 1024);
          }),
        { holdPreparation: true, refusePreparation: refused },
      ),
  );
}

for (const { queued, ambiguous } of [
  { queued: false, ambiguous: false },
  { queued: true, ambiguous: false },
  { queued: true, ambiguous: true },
]) {
  it.live(
    `${queued ? "queued" : "immediate"} ${ambiguous ? "ambiguous native failure is not replayed" : "plan refusal preserves the plan until an exact native acceptance"}`,
    () =>
      withNativeQueue(
        `source-plan-native-refusal:${queued}:${ambiguous}`,
        ({ orchestrator, threadId, takeOffer, waitFor, offers }) =>
          Effect.gen(function* () {
            const sink = yield* EventSinkV2;
            const now = yield* DateTime.now;
            const planId = PlanId.make(`${threadId}:plan`);
            const plan = {
              id: planId,
              threadId,
              runId: null,
              nodeId: NodeId.make(`${threadId}:plan-node`),
              kind: "proposed_plan" as const,
              status: "active" as const,
              markdown: "# Exact plan\nRetain this plan after native refusal.",
            };
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`${threadId}:plan-event`),
                  type: "plan.updated",
                  threadId,
                  occurredAt: now,
                  payload: plan,
                },
              ],
            });
            const foreground = queued
              ? yield* send(orchestrator, threadId, "foreground").pipe(Effect.andThen(takeOffer))
              : null;
            const dispatch = (suffix: string) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${threadId}:${suffix}`),
                threadId,
                messageId: MessageId.make(`${threadId}:${suffix}`),
                text: "Implement the exact plan",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
                dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
                sourcePlanRef: { threadId, planId },
              });
            yield* dispatch("original");
            const admitted = yield* orchestrator.getThreadProjection(threadId);
            const run = admitted.runs.find(
              (candidate) => candidate.sourcePlanRef?.planId === planId,
            );
            assert.ok(run);
            assert.equal(run.sourcePlanFingerprint, sourcePlanFingerprint(plan));
            assert.equal(admitted.plans[0]?.status, "active");
            if (foreground !== null) yield* foreground.settle("completed");
            const refused = yield* takeOffer;
            assert.equal(refused.input.runId, run.id);
            yield* waitFor((projection) =>
              projection.providerTurns.some(
                (turn) =>
                  turn.runAttemptId === refused.input.attemptId &&
                  turn.nativeAcceptance === "unknown",
              ),
            );
            yield* refused.releaseSend;
            const afterRefusal = yield* waitFor((projection) => {
              const current = projection.runs.find((candidate) => candidate.id === run.id);
              return queued && !ambiguous
                ? current?.status === "queued" && current.queueHeld === true
                : current?.status === "failed";
            });
            const pending = afterRefusal.providerTurns.find(
              (turn) => turn.runAttemptId === refused.input.attemptId,
            );
            assert.ok(pending);
            assert.equal(pending.nativeAcceptance, ambiguous ? "unknown" : "pending");
            assert.equal(pending.acceptedAt, undefined);
            const retained = afterRefusal.plans.find((candidate) => candidate.id === planId);
            assert.ok(retained?.kind === "proposed_plan");
            assert.equal(retained.status, "active");
            assert.equal(retained.consumedBy, undefined);
            if (ambiguous) {
              assert.equal(
                afterRefusal.runs.filter(
                  (candidate) => candidate.id === run.id && candidate.status === "queued",
                ).length,
                0,
              );
              assert.isTrue(
                afterRefusal.turnItems.some(
                  (item) =>
                    item.runId === run.id &&
                    item.type === "assistant_message" &&
                    item.text.includes("Native output"),
                ),
              );
              assert.equal(offers.length, 2);
              return;
            }
            if (queued) {
              const held = afterRefusal.runs.find((candidate) => candidate.id === run.id);
              assert.equal(held?.queuePosition, run.queuePosition);
              assert.equal(held?.userMessageId, run.userMessageId);
              assert.equal(held?.sourcePlanFingerprint, run.sourcePlanFingerprint);
              yield* orchestrator.dispatch({
                type: "queue.resume",
                threadId,
                commandId: CommandId.make(`${threadId}:resume`),
              });
            } else yield* dispatch("retry");
            const accepted = yield* takeOffer;
            assert.notEqual(accepted.input.attemptId, refused.input.attemptId);
            if (queued) assert.equal(accepted.input.runId, refused.input.runId);
            const consumed = yield* waitFor((projection) =>
              projection.plans.some(
                (candidate) => candidate.id === planId && candidate.status === "completed",
              ),
            );
            const consumedPlan = consumed.plans.find((candidate) => candidate.id === planId);
            assert.ok(consumedPlan?.kind === "proposed_plan");
            const receipt = consumed.providerTurns.find(
              (turn) => turn.runAttemptId === accepted.input.attemptId,
            );
            assert.ok(receipt?.acceptedAt);
            assert.equal(receipt.nativeAcceptance, "accepted");
            assert.deepEqual(consumedPlan.consumedBy, {
              threadId,
              runId: accepted.input.runId,
              runAttemptId: accepted.input.attemptId,
              providerTurnId: receipt.id,
            });
            yield* accepted.settle("failed");
            const failed = yield* waitFor((projection) =>
              projection.runs.some(
                (candidate) =>
                  candidate.id === accepted.input.runId && candidate.status === "failed",
              ),
            );
            assert.deepEqual(
              failed.plans.find((candidate) => candidate.id === planId),
              consumedPlan,
            );
            assert.equal(offers.length, queued ? 3 : 2);
          }),
        ambiguous ? { ambiguousSend: 2 } : { refuseSend: queued ? 2 : 1 },
      ),
  );
}

for (const { accepted, ingested } of [
  { accepted: false, ingested: false },
  { accepted: true, ingested: false },
  { accepted: true, ingested: true },
]) {
  it.live(
    `persists ${accepted ? "accepted" : "unknown"} synchronous start failure with ${ingested ? "already persisted acceptance" : "blocked offer ingestion"}`,
    () =>
      withNativeQueue(
        `queue-sync-failure:${accepted}:${ingested}`,
        ({ orchestrator, threadId, takeOffer, waitFor, offers }) =>
          Effect.gen(function* () {
            const sink = yield* EventSinkV2;
            const now = yield* DateTime.now;
            const planId = PlanId.make(`${threadId}:plan`);
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`${threadId}:plan-event`),
                  type: "plan.updated",
                  threadId,
                  occurredAt: now,
                  payload: {
                    id: planId,
                    threadId,
                    runId: null,
                    nodeId: NodeId.make(`${threadId}:plan-node`),
                    kind: "proposed_plan",
                    status: "active",
                    markdown: "# Synchronous exact plan",
                  },
                },
              ],
            });
            yield* send(orchestrator, threadId, "foreground");
            const foreground = yield* takeOffer;
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              threadId,
              commandId: CommandId.make(`${threadId}:queued`),
              messageId: MessageId.make(`${threadId}:queued`),
              text: "Implement",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "queue_after_active" },
              sourcePlanRef: { threadId, planId },
            });
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.status === "queued",
            );
            assert.ok(queued);
            yield* foreground.settle("completed");
            const failedOffer = yield* takeOffer;
            assert.equal(failedOffer.input.runId, queued.id);
            let ingestedReceiptId;
            if (ingested) {
              const observed = yield* waitFor((projection) =>
                projection.providerTurns.some(
                  (turn) =>
                    turn.runAttemptId === failedOffer.input.attemptId &&
                    turn.nativeAcceptance === "accepted",
                ),
              );
              ingestedReceiptId = observed.providerTurns.find(
                (turn) => turn.runAttemptId === failedOffer.input.attemptId,
              )?.id;
              assert.ok(ingestedReceiptId);
              yield* failedOffer.releaseSend;
            }
            const failed = yield* waitFor((projection) =>
              projection.runs.some((run) => run.id === queued.id && run.status === "failed"),
            );
            const receipt = failed.providerTurns.find(
              (turn) => turn.runAttemptId === failedOffer.input.attemptId,
            );
            assert.ok(receipt);
            assert.equal(receipt.status, "failed");
            if (ingested) {
              assert.equal(receipt.id, ingestedReceiptId);
              assert.equal(
                failed.providerTurns.filter(
                  (turn) => turn.runAttemptId === failedOffer.input.attemptId,
                ).length,
                1,
              );
            }
            assert.equal(receipt.nativeAcceptance, accepted ? "accepted" : "unknown");
            const plan = failed.plans.find((candidate) => candidate.id === planId);
            assert.ok(plan?.kind === "proposed_plan");
            assert.equal(plan.status, accepted ? "completed" : "active");
            if (accepted) {
              assert.ok(receipt.acceptedAt);
              assert.deepEqual(plan.consumedBy, {
                threadId,
                runId: queued.id,
                runAttemptId: failedOffer.input.attemptId,
                providerTurnId: receipt.id,
              });
            } else {
              assert.equal(receipt.acceptedAt, undefined);
              assert.equal(plan.consumedBy, undefined);
            }
            assert.equal(
              failed.runs.some((run) => run.id === queued.id && run.status === "queued"),
              false,
            );
            assert.equal(offers.length, 2);
          }),
        {
          synchronousFailSend: 2,
          acceptBeforeSyncFailure: accepted,
          ingestSyncAcceptance: ingested,
          holdSyncFailure: ingested,
        },
      ),
  );
}

it.live(
  "a delayed accepted start failure cannot consume a plan or terminalize a replacement attempt",
  () =>
    withNativeQueue(
      "queue-displaced-start-receipt",
      ({ orchestrator, threadId, takeOffer }) =>
        Effect.gen(function* () {
          const sink = yield* EventSinkV2;
          const outbox = yield* EffectOutboxV2;
          const planId = PlanId.make(`${threadId}:plan`);
          const commandId = CommandId.make(`${threadId}:planned`);
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${threadId}:plan-event`),
                type: "plan.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: planId,
                  threadId,
                  runId: null,
                  nodeId: NodeId.make(`${threadId}:plan-node`),
                  kind: "proposed_plan",
                  status: "active",
                  markdown: "# Exact replacement owner",
                },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            threadId,
            commandId,
            messageId: MessageId.make(`${threadId}:planned`),
            text: "Implement exact plan",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
            sourcePlanRef: { threadId, planId },
          });
          const offer = yield* takeOffer;
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((run) => run.id === offer.input.runId);
          const attempt = projection.attempts.find(
            (attempt) => attempt.id === offer.input.attemptId,
          );
          assert.ok(run);
          assert.ok(attempt);
          const replacementId = RunAttemptId.make(`${attempt.id}:replacement`);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${threadId}:replacement-attempt`),
                type: "run-attempt.created",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...attempt,
                  id: replacementId,
                  attemptOrdinal: attempt.attemptOrdinal + 1,
                },
              },
              {
                id: EventId.make(`${threadId}:replacement-run`),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, activeAttemptId: replacementId },
              },
            ],
          });
          const completions = yield* outbox.subscribeCompletions;
          const pull = yield* Stream.toPull(completions);
          yield* offer.releaseSend;
          const completed = yield* Stream.concat(
            Stream.succeed(undefined),
            Stream.fromPull(Effect.succeed(pull)),
          ).pipe(
            Stream.mapEffect(() => outbox.listByCommandId(commandId)),
            Stream.filter((effects) =>
              effects.some(
                (effect) =>
                  effect.request.type === "provider-turn.start" && effect.status === "succeeded",
              ),
            ),
            Stream.runHead,
            Effect.timeout("15 seconds"),
          );
          assert.isTrue(Option.isSome(completed));
          const after = yield* orchestrator.getThreadProjection(threadId);
          const current = after.runs.find((candidate) => candidate.id === run.id);
          assert.equal(current?.activeAttemptId, replacementId);
          assert.equal(current?.status, "running");
          assert.isFalse(
            after.providerTurns.some((turn) => turn.runAttemptId === offer.input.attemptId),
          );
          const plan = after.plans.find((candidate) => candidate.id === planId);
          assert.ok(plan?.kind === "proposed_plan");
          assert.equal(plan.status, "active");
          assert.isUndefined(plan.consumedBy);
        }),
      { synchronousFailSend: 1, acceptBeforeSyncFailure: true, holdSyncFailure: true },
    ),
);

it.live("normal native completion automatically drains queued messages in FIFO order", () =>
  withNativeQueue(
    "queue-policy-auto-drain",
    ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
      Effect.gen(function* () {
        yield* send(orchestrator, threadId, "foreground");
        const foreground = yield* takeOffer;
        yield* send(orchestrator, threadId, "first", true);
        yield* send(orchestrator, threadId, "second", true);
        const admitted = yield* orchestrator.getThreadProjection(threadId);
        const queued = admitted.runs.filter((run) => run.status === "queued");
        assert.equal(queued.length, 2);
        assert.isTrue(queued.every((run) => run.queueHeld !== true));
        yield* foreground.settle("completed");
        const first = yield* takeOffer;
        assert.equal(first.input.message.text, "first");
        yield* first.settle("completed");
        const second = yield* takeOffer;
        assert.equal(second.input.message.text, "second");
        yield* second.settle("completed");
        const settled = yield* waitFor((projection) =>
          projection.runs.every((run) => run.status === "completed"),
        );
        assert.equal(settled.runs.length, 3);
        assert.deepEqual(offers, ["foreground", "first", "second"]);
        assert.equal(settled.providerTurns.filter((turn) => turn.status === "completed").length, 3);
      }),
  ),
);

it.live(
  "native failure holds queued work across a later successful foreground turn until explicit Resume",
  () =>
    withNativeQueue(
      "queue-policy-failure-hold",
      ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
        Effect.gen(function* () {
          yield* send(orchestrator, threadId, "foreground");
          const foreground = yield* takeOffer;
          yield* send(orchestrator, threadId, "first", true);
          yield* send(orchestrator, threadId, "second", true);
          yield* foreground.settle("failed");
          const held = yield* waitFor(
            (projection) =>
              projection.runs.some(
                (run) => run.id === foreground.input.runId && run.status === "failed",
              ) &&
              projection.runs
                .filter((run) => run.status === "queued")
                .every((run) => run.queueHeld === true),
          );
          assert.equal(held.runs.filter((run) => run.status === "queued").length, 2);
          assert.deepEqual(offers, ["foreground"]);
          yield* send(orchestrator, threadId, "later-foreground");
          const later = yield* takeOffer;
          assert.equal(later.input.message.text, "later-foreground");
          yield* later.settle("completed");
          const afterSuccess = yield* waitFor((projection) =>
            projection.runs.some(
              (run) => run.id === later.input.runId && run.status === "completed",
            ),
          );
          const remaining = afterSuccess.runs.filter((run) => run.status === "queued");
          assert.equal(remaining.length, 2);
          assert.isTrue(remaining.every((run) => run.queueHeld === true));
          assert.deepEqual(offers, ["foreground", "later-foreground"]);
          yield* orchestrator.dispatch({
            type: "queue.resume",
            threadId,
            commandId: CommandId.make(`${threadId}:resume`),
          });
          const first = yield* takeOffer;
          assert.equal(first.input.message.text, "first");
          yield* first.settle("completed");
          const second = yield* takeOffer;
          assert.equal(second.input.message.text, "second");
          yield* second.settle("completed");
          yield* waitFor((projection) =>
            projection.runs.every(
              (run) => run.status === "completed" || run.id === foreground.input.runId,
            ),
          );
          assert.deepEqual(offers, ["foreground", "later-foreground", "first", "second"]);
        }),
    ),
);

it.live(
  "Stop holds native queued work while idle reorder and explicit head Send preserve the remaining hold",
  () =>
    withNativeQueue(
      "queue-policy-stop-hold",
      ({ orchestrator, threadId, takeOffer, offers, waitFor, nativeInterruptions }) =>
        Effect.gen(function* () {
          yield* send(orchestrator, threadId, "foreground");
          const foreground = yield* takeOffer;
          yield* send(orchestrator, threadId, "first", true);
          yield* send(orchestrator, threadId, "second", true);
          const beforeStop = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            beforeStop.runs.find((run) => run.id === foreground.input.runId)?.status,
            "running",
          );
          assert.equal(
            beforeStop.providerTurns.length,
            0,
            "Accepted external send remains gated before its native receipt reaches SQL",
          );
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            threadId,
            runId: foreground.input.runId,
            holdQueue: true,
            commandId: CommandId.make(`${threadId}:stop`),
          });
          const requested = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            requested.runs.find((run) => run.id === foreground.input.runId)?.status,
            "running",
          );
          assert.isTrue(
            requested.turnItems.some(
              (item) =>
                item.runId === foreground.input.runId && item.type === "run_interrupt_request",
            ),
          );
          assert.isFalse(
            requested.turnItems.some(
              (item) =>
                item.runId === foreground.input.runId && item.type === "run_interrupt_result",
            ),
          );
          assert.equal(requested.runs.filter((run) => run.status === "queued").length, 2);
          assert.isTrue(
            requested.runs.filter((run) => run.status === "queued").every((run) => run.queueHeld),
          );
          assert.deepEqual(offers, ["foreground"]);
          yield* foreground.releaseSend;
          const held = yield* waitFor(
            (projection) =>
              projection.runs.some(
                (run) => run.id === foreground.input.runId && run.status === "interrupted",
              ) &&
              projection.providerTurns.some(
                (turn) =>
                  turn.runAttemptId === foreground.input.attemptId && turn.status === "interrupted",
              ) &&
              projection.runs
                .filter((run) => run.status === "queued")
                .every((run) => run.queueHeld === true),
          );
          assert.equal(nativeInterruptions(), 1);
          const first = held.runs.find(
            (run) => run.userMessageId === MessageId.make(`${threadId}:message:first`),
          );
          const second = held.runs.find(
            (run) => run.userMessageId === MessageId.make(`${threadId}:message:second`),
          );
          assert.ok(first);
          assert.ok(second);
          yield* orchestrator.dispatch({
            type: "queued-run.reorder",
            threadId,
            runId: second.id,
            beforeRunId: first.id,
            commandId: CommandId.make(`${threadId}:idle-reorder`),
          });
          const reordered = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            reordered.runs.find((run) => run.id === second.id)?.queuePosition,
            first.queuePosition,
          );
          assert.deepEqual(offers, ["foreground"]);
          yield* orchestrator.dispatch({
            type: "queue.resume",
            threadId,
            runId: second.id,
            commandId: CommandId.make(`${threadId}:send-head`),
          });
          const head = yield* takeOffer;
          assert.equal(head.input.runId, second.id);
          yield* head.settle("completed");
          const afterHead = yield* waitFor((projection) =>
            projection.runs.some((run) => run.id === second.id && run.status === "completed"),
          );
          assert.equal(afterHead.runs.find((run) => run.id === first.id)?.status, "queued");
          assert.isTrue(afterHead.runs.find((run) => run.id === first.id)?.queueHeld);
          assert.deepEqual(offers, ["foreground", "second"]);
          yield* orchestrator.dispatch({
            type: "queue.resume",
            threadId,
            commandId: CommandId.make(`${threadId}:resume-rest`),
          });
          const rest = yield* takeOffer;
          assert.equal(rest.input.runId, first.id);
          yield* rest.settle("completed");
          yield* waitFor(
            (projection) =>
              projection.runs.find((run) => run.id === first.id)?.status === "completed",
          );
          assert.deepEqual(offers, ["foreground", "second", "first"]);
        }),
      { holdFirstSend: true },
    ),
);

it.live("non-user native interruption holds ordinary queued work without a holdQueue flag", () =>
  withNativeQueue(
    "queue-policy-native-interruption",
    ({ orchestrator, threadId, takeOffer, offers, waitFor, nativeInterruptions }) =>
      Effect.gen(function* () {
        yield* send(orchestrator, threadId, "foreground");
        const foreground = yield* takeOffer;
        yield* send(orchestrator, threadId, "queued", true);
        yield* waitFor((projection) =>
          projection.providerTurns.some(
            (turn) => turn.runAttemptId === foreground.input.attemptId && turn.status === "running",
          ),
        );
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          threadId,
          runId: foreground.input.runId,
          commandId: CommandId.make(`${threadId}:interrupt`),
        });
        const held = yield* waitFor(
          (projection) =>
            projection.runs.some(
              (run) => run.id === foreground.input.runId && run.status === "interrupted",
            ) && projection.runs.some((run) => run.status === "queued" && run.queueHeld === true),
        );
        assert.equal(nativeInterruptions(), 1);
        assert.deepEqual(offers, ["foreground"]);
        const queued = held.runs.find((run) => run.status === "queued");
        assert.ok(queued);
        yield* orchestrator.dispatch({
          type: "queue.resume",
          threadId,
          commandId: CommandId.make(`${threadId}:resume`),
        });
        const resumed = yield* takeOffer;
        assert.equal(resumed.input.runId, queued.id);
        yield* resumed.settle("completed");
        yield* waitFor(
          (projection) =>
            projection.runs.find((run) => run.id === queued.id)?.status === "completed",
        );
        assert.deepEqual(offers, ["foreground", "queued"]);
      }),
  ),
);

it.live("queued plan extraction and resubmission consume only the exact accepted native run", () =>
  withNativeQueue(
    "queued-source-plan-extraction",
    ({ orchestrator, threadId, takeOffer, waitFor }) =>
      Effect.gen(function* () {
        const sink = yield* EventSinkV2;
        const now = yield* DateTime.now;
        const planId = PlanId.make("queued-plan-extraction");
        yield* send(orchestrator, threadId, "foreground");
        const foreground = yield* takeOffer;
        yield* sink.write({
          events: [
            {
              id: EventId.make("queued-plan-extraction:plan"),
              type: "plan.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: planId,
                threadId,
                runId: null,
                nodeId: NodeId.make("queued-plan-extraction:plan-node"),
                kind: "proposed_plan",
                status: "active",
                markdown: "# Plan\nImplement this exact change.",
              },
            },
          ],
        });
        const dispatch = (suffix: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`queued-plan-extraction:${suffix}`),
            threadId,
            messageId: MessageId.make(`queued-plan-extraction:${suffix}`),
            text: "Implement the plan",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "queue_after_active" },
            sourcePlanRef: { threadId, planId },
          });
        yield* dispatch("original");
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        );
        assert.ok(queued);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).plans[0]?.status,
          "active",
        );
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("queued-plan-extraction:cancel"),
          threadId,
          runId: queued.id,
        });
        yield* dispatch("resubmitted");
        const resubmitted = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        );
        assert.ok(resubmitted);
        assert.notEqual(resubmitted.id, queued.id);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).plans[0]?.status,
          "active",
        );
        yield* foreground.settle("completed");
        const accepted = yield* takeOffer;
        assert.equal(accepted.input.runId, resubmitted.id);
        const consumed = yield* waitFor((projection) =>
          projection.plans.some((plan) => plan.id === planId && plan.status === "completed"),
        );
        const plan = consumed.plans.find((plan) => plan.id === planId);
        assert.ok(plan?.kind === "proposed_plan");
        assert.deepEqual(plan.consumedBy, {
          threadId,
          runId: accepted.input.runId,
          runAttemptId: accepted.input.attemptId,
          providerTurnId: consumed.providerTurns.find(
            (turn) => turn.runAttemptId === accepted.input.attemptId,
          )?.id,
        });
        yield* accepted.settle("failed");
        const failed = yield* waitFor((projection) =>
          projection.runs.some((run) => run.id === accepted.input.runId && run.status === "failed"),
        );
        assert.equal(
          failed.plans.find((candidate) => candidate.id === planId)?.status,
          "completed",
        );
      }),
  ),
);
