import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CheckpointRef,
  ComposerContextId,
  EnvironmentId,
  RunId,
  ChatAttachmentId,
  EventId,
  NodeId,
  PlanId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  ProviderTurnId,
  TurnItemId,
  ThreadId,
  VcsProcessExitError,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../config.ts";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import { EventSinkV2, EventSinkWriteError } from "./EventSink.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { OrchestrationEffectWorkerV2, runDaemonWithOptions } from "./EffectWorker.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  CheckpointStore,
  layer as checkpointStoreLayer,
} from "../checkpointing/CheckpointStore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import { CheckpointRefUnavailableError } from "../checkpointing/Errors.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { RunFinalizationObserver } from "./RunFinalizationService.ts";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import {
  makeNativeSessionAdapterV2,
  NativeSessionOperationError,
  type NativeSessionUpdate,
} from "./Adapters/NativeSessionAdapterV2.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import {
  OrchestratorV2,
  OrchestratorProjectionError,
  type OrchestratorV2Error,
} from "./Orchestrator.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2Event,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  layerFromAdapters as makeLayer,
  ProviderAdapterRegistryMetadataError,
  ProviderAdapterRegistryV2,
} from "./ProviderAdapterRegistry.ts";
import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./testkit/ProviderReplayHarness.ts";
import { nativeSettlementTrace } from "./testkit/OmpNativeConjunctions.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { sourcePlanFingerprint } from "./SourcePlan.ts";
import { checkpointRefForScopeOrdinal } from "./CheckpointService.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  ThreadCommandExecutor,
  layer as threadCommandExecutorLayer,
} from "./ThreadCommandExecutor.ts";

import * as NetAddress from "effect/net/NetAddress";
import { HttpServer } from "effect/http";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ScientSkillSession from "../scient/skills/ScientSkillSession.ts";
import * as ScientSkillRegistry from "../scient/skills/ScientSkillRegistry.ts";
import * as ScientSkillPolicy from "../scient/skills/ScientSkillPolicy.ts";
import { BUILT_IN_SKILL_RELEASES } from "../scient/skills/BuiltInSkillReleases.ts";
import { toSkillReleaseRef } from "@scientfactory/scient-skills";

const promotionMcpRegistryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Layer.succeed(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("queued-promotion-fixture")),
          getDescriptor: Effect.die("No environment descriptor in this fixture"),
        }),
      ),
      NodeServices.layer,
    ),
  ),
);

const instanceId = ProviderInstanceId.make("omp");

// The production registry also reports whether each instance is turned on.
const withProviderEnabled = (
  registry: Layer.Layer<ProviderAdapterRegistryV2>,
  enabled: ((instanceId: ProviderInstanceId) => boolean) | undefined,
) =>
  enabled === undefined
    ? registry
    : Layer.effect(
        ProviderAdapterRegistryV2,
        Effect.map(ProviderAdapterRegistryV2, (adapters) =>
          ProviderAdapterRegistryV2.of({
            ...adapters,
            getMetadata: (instanceId) =>
              adapters.get(instanceId).pipe(
                Effect.flatMap((adapter) =>
                  adapter.getCapabilities().pipe(
                    Effect.mapError(
                      (cause) => new ProviderAdapterRegistryMetadataError({ instanceId, cause }),
                    ),
                    Effect.map((capabilities) => ({
                      driver: adapter.driver,
                      continuationKey: `${adapter.driver}:instance:${instanceId}`,
                      enabled: enabled(instanceId),
                      capabilities,
                    })),
                  ),
                ),
              ),
          }),
        ),
      ).pipe(Layer.provide(registry));
const modelSelection = { instanceId, model: "queue-policy-model" };

interface NativeOffer {
  readonly input: ProviderAdapterV2TurnInput;
  readonly releaseSend: Effect.Effect<void>;
  readonly answer: (text: string) => Effect.Effect<void>;
  readonly settle: (status: "completed" | "failed") => Effect.Effect<void>;
}

const withNativeQueue = <A, E, R>(
  name: string,
  body: (controls: {
    readonly threadId: ThreadId;
    readonly orchestrator: OrchestratorV2["Service"];
    readonly offers: ReadonlyArray<string>;
    readonly steers: ReadonlyArray<ProviderAdapterV2SteerInput>;
    readonly takeSteer: Effect.Effect<ProviderAdapterV2SteerInput, Cause.TimeoutError>;
    readonly injectEvent: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
    readonly preparationReady: Effect.Effect<void>;
    readonly releasePreparation: Effect.Effect<void>;
    readonly preparationAttempts: () => number;
    readonly failNextStarts: (count: number) => void;
    readonly nativeInterruptions: () => number;
    readonly delegatedStops: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
    }>;
    readonly interruptEntered: Effect.Effect<void>;
    readonly releaseInterrupt: Effect.Effect<void>;
    readonly takeOffer: Effect.Effect<NativeOffer, Cause.TimeoutError>;
    readonly captureEntered: Effect.Effect<void>;
    readonly releaseCapture: Effect.Effect<void>;
    readonly beforeOffer: (
      check: (input: ProviderAdapterV2TurnInput) => Effect.Effect<void>,
    ) => void;
    readonly waitForThread: (
      threadId: ThreadId,
      predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
    ) => Effect.Effect<
      OrchestrationV2ThreadProjection,
      OrchestratorV2Error | Cause.TimeoutError,
      Scope.Scope
    >;
    readonly waitFor: (
      predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
    ) => Effect.Effect<
      OrchestrationV2ThreadProjection,
      OrchestratorV2Error | Cause.TimeoutError,
      Scope.Scope
    >;
  }) => Effect.Effect<A, E, R>,
  options: {
    readonly cwd?: string;
    readonly existingThread?: boolean;
    readonly databaseLayer?: NonNullable<
      Parameters<typeof makeOrchestratorV2ReplayLayerWithRegistry>[2]
    >["databaseLayer"];
    readonly serverConfigLayer?: NonNullable<
      Parameters<typeof makeOrchestratorV2ReplayLayerWithRegistry>[2]
    >["layerServerConfig"];
    readonly runEffectWorker?: boolean;
    readonly runtimePolicyLayer?: Layer.Layer<RuntimePolicy.RuntimePolicyV2>;
    readonly holdFirstSend?: boolean;
    readonly holdSendOrdinal?: number;
    readonly refuseSend?: number;
    readonly ambiguousSend?: number;
    readonly synchronousFailSend?: number;
    readonly acceptBeforeSyncFailure?: boolean;
    readonly holdSyncFailure?: boolean;
    readonly ingestSyncAcceptance?: boolean;
    readonly holdPreparation?: boolean;
    readonly refusePreparation?: boolean;
    readonly failCheckpointDiff?: boolean;
    readonly holdCheckpointCapture?: boolean;
    readonly injectEvents?: boolean;
    readonly holdInterrupt?: boolean;
    readonly controlStartupFailures?: boolean;
    readonly nativeSteering?: boolean;
    readonly mcpSessionRegistryLayer?: Layer.Layer<McpSessionRegistry.McpSessionRegistry>;
    readonly decorateProjectionStore?: (
      store: ProjectionStore.ProjectionStoreV2Shape,
    ) => ProjectionStore.ProjectionStoreV2Shape;
    readonly providerEnabled?: (instanceId: ProviderInstanceId) => boolean;
    readonly decorateEventSink?: (sink: EventSinkV2["Service"]) => EventSinkV2["Service"];
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = options.cwd ?? (yield* checkpointWorkspace(name));
      const stopBoundary = yield* Deferred.make<{
        readonly orchestrator: OrchestratorV2["Service"];
        readonly outbox: EffectOutboxV2["Service"];
      }>();
      const delegatedStops: Array<{ readonly threadId: ThreadId; readonly commandId: CommandId }> =
        [];
      let startupRefusals = 0;
      const allocator = yield* IdAllocatorV2;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const scope = yield* Scope.Scope;
      const offered = yield* Queue.unbounded<NativeOffer>();
      const steering = yield* Queue.unbounded<ProviderAdapterV2SteerInput>();
      const steers: ProviderAdapterV2SteerInput[] = [];
      const injected = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const firstSendReleased = yield* Deferred.make<void>();
      const interruptEntered = yield* Deferred.make<void>();
      const interruptReleased = yield* Deferred.make<void>();
      const preparationReady = yield* Deferred.make<void>();
      const preparationReleased = yield* Deferred.make<void>();
      const captureEntered = yield* Deferred.make<void>();
      const captureReleased = yield* Deferred.make<void>();
      let heldCapture = false;
      let beforeOffer: (input: ProviderAdapterV2TurnInput) => Effect.Effect<void> = () =>
        Effect.void;
      const heldSendOrdinal = options.holdSendOrdinal ?? (options.holdFirstSend ? 1 : undefined);
      let preparationAttempts = 0;
      const offers: string[] = [];
      let nativeInterruptions = 0;
      const adapterOptions = {
        instanceId,
        driver: ProviderDriverKind.make("omp"),
        capabilities: options.nativeSteering
          ? {
              ...AcpProviderCapabilitiesV2,
              sessions: {
                ...AcpProviderCapabilitiesV2.sessions,
                supportsRuntimeModeSwitchInSession: true,
              },
              turns: { ...AcpProviderCapabilitiesV2.turns, supportsActiveSteering: true },
            }
          : AcpProviderCapabilitiesV2,
        mcpSessionInjection: options.mcpSessionRegistryLayer !== undefined,
        idAllocator: allocator,
        defaultCwd: cwd,
        continuations: { offer: () => Effect.die("No background continuation in queue fixture") },
        open: (input, publish) =>
          Effect.succeed({
            nativeId: `queue-policy:${input.providerSessionId}`,
            nativeThreadKnown: true,
            send: (turn, nativeTurnId) =>
              Effect.gen(function* () {
                // Observe the real send boundary before recording/offering the prompt.
                yield* beforeOffer(turn);
                offers.push(turn.message.text);
                const nativeAccepted = yield* Deferred.make<void>();
                const released =
                  heldSendOrdinal === offers.length
                    ? firstSendReleased
                    : yield* Deferred.make<void>();
                yield* Queue.offer(offered, {
                  input: turn,
                  releaseSend: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
                  answer: (text) =>
                    Deferred.await(nativeAccepted).pipe(
                      Effect.andThen(publish({ type: "text", id: "native-answer", delta: text })),
                    ),
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
                if (heldSendOrdinal === offers.length) yield* Deferred.await(released);
                yield* publish({ type: "accepted", nativeTurnId });
                yield* Deferred.succeed(nativeAccepted, undefined);
              }),
            ...(options.nativeSteering
              ? {
                  steer: (input: ProviderAdapterV2SteerInput) =>
                    Effect.sync(() => {
                      steers.push(input);
                    }).pipe(Effect.andThen(Queue.offer(steering, input)), Effect.asVoid),
                }
              : {}),
            resume: () => Effect.void,
            respond: () => Effect.die("No native question in queue fixture"),
            interrupt: Effect.sync(() => {
              nativeInterruptions += 1;
            }).pipe(
              Effect.andThen(Deferred.succeed(interruptEntered, undefined)),
              Effect.andThen(
                options.holdInterrupt ? Deferred.await(interruptReleased) : Effect.void,
              ),
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
          heldSendOrdinal !== undefined ||
          options.synchronousFailSend !== undefined ||
          options.controlStartupFailures ||
          options.injectEvents
            ? {
                ...adapter,
                openSession: (input) =>
                  Effect.suspend(() =>
                    startupRefusals-- > 0
                      ? Effect.fail(
                          new ProviderAdapterOpenSessionError({
                            driver: adapter.driver,
                            providerSessionId: input.providerSessionId,
                            cause: "Current request startup diagnostic",
                          }),
                        )
                      : adapter.openSession(input),
                  ).pipe(
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
                            : heldSendOrdinal !== undefined &&
                                event.type === "provider_turn.updated" &&
                                event.providerTurn.ordinal === heldSendOrdinal &&
                                event.providerTurn.status === "running"
                              ? Deferred.await(firstSendReleased).pipe(Effect.as(event))
                              : Effect.succeed(event),
                        ),
                        Stream.merge(
                          options.injectEvents ? Stream.fromQueue(injected) : Stream.empty,
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
        ]).pipe((registry) => withProviderEnabled(registry, options.providerEnabled)),
        {
          configureMcp: options.mcpSessionRegistryLayer !== undefined,
          mcpProviderSessionsLayer: Layer.succeed(
            McpProviderSessions.McpProviderSessions,
            mcpSessions,
          ),
          ...(options.mcpSessionRegistryLayer
            ? { mcpSessionRegistryLayer: options.mcpSessionRegistryLayer }
            : {}),
          ...(options.failCheckpointDiff || options.holdCheckpointCapture
            ? {
                vcsProcessLayer: Layer.effect(
                  VcsProcess.VcsProcess,
                  Effect.gen(function* () {
                    const real = yield* VcsProcess.VcsProcess;
                    return {
                      run: (input: VcsProcess.VcsProcessInput) =>
                        Effect.gen(function* () {
                          if (
                            options.failCheckpointDiff &&
                            input.operation === "GitVcsDriver.checkpoints.diffCheckpoints"
                          )
                            return yield* new VcsProcessExitError({
                              operation: input.operation,
                              command: input.command,
                              cwd: input.cwd,
                              exitCode: 1,
                              detail: "Synthetic external Git diff failure",
                            });
                          // Park the first real completion capture immediately before
                          // Git imports its ref, after the actual tree/commit are built.
                          if (
                            options.holdCheckpointCapture &&
                            !heldCapture &&
                            input.operation === VcsProcess.CHECKPOINT_CAPTURE_OPERATION &&
                            input.args.includes("fetch") &&
                            input.args.some((arg) => arg.endsWith("/ordinal/1"))
                          ) {
                            heldCapture = true;
                            yield* Deferred.succeed(captureEntered, undefined);
                            yield* Deferred.await(captureReleased);
                          }
                          return yield* real.run(input);
                        }),
                    };
                  }),
                ).pipe(Layer.provide(VcsProcess.layer), Layer.provide(NodeServices.layer)),
              }
            : {}),
          threads: {
            stopDelegatedTasks: (input) =>
              Effect.gen(function* () {
                const { orchestrator, outbox } = yield* Deferred.await(stopBoundary);
                const { subagents } = yield* orchestrator.getThreadRecords(input.threadId, [
                  "subagents",
                ]);
                // The delegated-child cases stop the child itself, which has no grandchildren.
                // Never substitute an empty parent model when that parent owns a real child.
                assert.isEmpty(
                  subagents.filter(
                    (task) => task.origin === "app_owned" && task.childThreadId !== null,
                  ),
                );
                const effects = yield* outbox.listByCommandId(input.commandId).pipe(Effect.orDie);
                const stops = effects.filter(
                  (effect) => effect.request.type === "delegated-tasks.stop",
                );
                assert.lengthOf(stops, 1);
                const stop = stops[0]!;
                assert.ok(stop.request.type === "delegated-tasks.stop");
                assert.deepEqual(input, {
                  threadId: stop.threadId,
                  commandId: stop.commandId,
                  reason: stop.request.reason,
                });
                assert.isEmpty(
                  delegatedStops.filter(
                    (prior) =>
                      prior.threadId === input.threadId && prior.commandId === input.commandId,
                  ),
                );
                delegatedStops.push({ threadId: input.threadId, commandId: input.commandId });
              }),
          },
          ...(options.databaseLayer === undefined ? {} : { databaseLayer: options.databaseLayer }),
          ...(options.serverConfigLayer === undefined
            ? {}
            : { layerServerConfig: options.serverConfigLayer }),
          ...(options.runEffectWorker === undefined
            ? {}
            : { runEffectWorker: options.runEffectWorker }),
          ...(options.runtimePolicyLayer === undefined
            ? {}
            : { runtimePolicyLayer: options.runtimePolicyLayer }),
          ...(options.decorateProjectionStore === undefined
            ? {}
            : { decorateProjectionStore: options.decorateProjectionStore }),
          ...(options.decorateEventSink === undefined
            ? {}
            : { decorateEventSink: options.decorateEventSink }),
        },
      ).pipe(
        Layer.provideMerge(options.mcpSessionRegistryLayer ?? McpSessionRegistryTestkit.layer),
      );
      return yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const outbox = yield* EffectOutboxV2;
        yield* Deferred.succeed(stopBoundary, { orchestrator, outbox });
        const threadId = ThreadId.make(`thread:${name}`);
        if (!options.existingThread)
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
        const waitForThread = Effect.fnUntraced(function* (
          threadId: ThreadId,
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
          steers,
          takeSteer: Queue.take(steering).pipe(Effect.timeout("15 seconds")),
          injectEvent: (event) => Queue.offer(injected, event).pipe(Effect.asVoid),
          preparationReady: Deferred.await(preparationReady),
          releasePreparation: Deferred.succeed(preparationReleased, undefined).pipe(Effect.asVoid),
          preparationAttempts: () => preparationAttempts,
          failNextStarts: (count) => {
            startupRefusals = count;
          },
          takeOffer,
          captureEntered: Deferred.await(captureEntered),
          releaseCapture: Deferred.succeed(captureReleased, undefined).pipe(Effect.asVoid),
          beforeOffer: (check) => {
            beforeOffer = check;
          },
          waitForThread,
          waitFor: (predicate) => waitForThread(threadId, predicate),
          nativeInterruptions: () => nativeInterruptions,
          delegatedStops,
          interruptEntered: Deferred.await(interruptEntered),
          releaseInterrupt: Deferred.succeed(interruptReleased, undefined).pipe(Effect.asVoid),
        });
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(threadCommandExecutorLayer))));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, idAllocatorLayer, McpProviderSessions.layer),
      ),
    ),
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

it.live.each(
  [
    { bytes: false, refused: true },
    { bytes: false, refused: false },
    { bytes: true, refused: true },
    { bytes: true, refused: false },
  ].map(({ bytes, refused }) => ({
    caseTitle: `reserves queued ${bytes ? "bytes" : "count"} through preparation until ${refused ? "held failure" : "native acceptance"}`,
    bytes,
    refused,
  })),
)("$caseTitle", ({ bytes, refused }) =>
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
          assert.equal(edit._tag, "Failure", "A queued edit must retain the starting head's bytes");
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
          assert.equal(held.runs.filter((run) => run.status === "queued").length, bytes ? 2 : 20);
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

it.live.each(
  [
    { queued: false, ambiguous: false },
    { queued: true, ambiguous: false },
    { queued: true, ambiguous: true },
  ].map(({ queued, ambiguous }) => ({
    caseTitle: `${queued ? "queued" : "immediate"} ${ambiguous ? "ambiguous native failure is not replayed" : "plan refusal preserves the plan until an exact native acceptance"}`,
    queued,
    ambiguous,
  })),
)("$caseTitle", ({ queued, ambiguous }) =>
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
        const run = admitted.runs.find((candidate) => candidate.sourcePlanRef?.planId === planId);
        assert.ok(run);
        assert.equal(run.sourcePlanFingerprint, sourcePlanFingerprint(plan));
        assert.equal(admitted.plans[0]?.status, "active");
        if (foreground !== null) yield* foreground.settle("completed");
        const refused = yield* takeOffer;
        assert.equal(refused.input.runId, run.id);
        yield* waitFor((projection) =>
          projection.providerTurns.some(
            (turn) =>
              turn.runAttemptId === refused.input.attemptId && turn.nativeAcceptance === "unknown",
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
            (candidate) => candidate.id === accepted.input.runId && candidate.status === "failed",
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

it.live.each(
  [
    { accepted: false, ingested: false },
    { accepted: true, ingested: false },
    { accepted: true, ingested: true },
  ].map(({ accepted, ingested }) => ({
    caseTitle: `persists ${accepted ? "accepted" : "unknown"} synchronous start failure with ${ingested ? "already persisted acceptance" : "blocked offer ingestion"}`,
    accepted,
    ingested,
  })),
)("$caseTitle", ({ accepted, ingested }) =>
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
            failed.providerTurns.filter((turn) => turn.runAttemptId === failedOffer.input.attemptId)
              .length,
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
    ({
      orchestrator,
      threadId,
      takeOffer,
      offers,
      waitFor,
      captureEntered,
      releaseCapture,
      beforeOffer,
    }) =>
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        yield* send(orchestrator, threadId, "foreground");
        const foreground = yield* takeOffer;
        let guardedOffers = 0;
        beforeOffer((input) =>
          Effect.gen(function* () {
            const atDelivery = yield* orchestrator.getThreadProjection(threadId);
            const predecessor = atDelivery.runs.find(
              (run) => run.ordinal === input.runOrdinal - 1,
            )!;
            assert.equal(predecessor.status, "completed");
            const checkpoint = atDelivery.checkpoints.find(
              (row) => row.id === predecessor.checkpointId,
            )!;
            assert.equal(checkpoint.status, "ready");
            const scope = atDelivery.checkpointScopes.find((row) => row.id === checkpoint.scopeId)!;
            assert.isTrue(
              yield* store.hasCheckpointRef({ cwd: scope.cwd, checkpointRef: checkpoint.ref }),
            );
            if (input.message.text === "first") {
              const answer = atDelivery.messages.find(
                (row) => row.runId === foreground.input.runId && row.role === "assistant",
              )!;
              assert.equal(answer.text, "Persisted native foreground answer");
              assert.isFalse(answer.streaming);
            }
            guardedOffers++;
          }).pipe(Effect.orDie),
        );
        yield* send(orchestrator, threadId, "first", true);
        yield* send(orchestrator, threadId, "second", true);
        const admitted = yield* orchestrator.getThreadProjection(threadId);
        const queued = admitted.runs.filter((run) => run.status === "queued");
        assert.equal(queued.length, 2);
        assert.isTrue(queued.every((run) => run.queueHeld !== true));
        yield* foreground.answer("Persisted native foreground answer");
        yield* foreground.settle("completed");
        yield* captureEntered.pipe(Effect.timeout("15 seconds"));
        const parked = yield* orchestrator.getThreadProjection(threadId);
        const answer = parked.messages.find(
          (row) => row.runId === foreground.input.runId && row.role === "assistant",
        )!;
        assert.equal(answer.text, "Persisted native foreground answer");
        assert.isFalse(answer.streaming);
        assert.equal(
          parked.runs.find((run) => run.id === foreground.input.runId)!.status,
          "waiting",
        );
        const root = parked.nodes.find((node) => node.id === foreground.input.rootNodeId)!;
        const scope = parked.checkpointScopes.find((row) => row.id === root.checkpointScopeId)!;
        assert.isFalse(
          yield* store.hasCheckpointRef({
            cwd: scope.cwd,
            checkpointRef: yield* checkpointRefForScopeOrdinal({
              scopeId: scope.id,
              ordinalWithinScope: 1,
            }),
          }),
        );
        // Drain other claimable effects while the real capture still owns its lease.
        yield* (yield* OrchestrationEffectWorkerV2).drain(12);
        assert.deepEqual(offers, ["foreground"]);
        assert.equal(guardedOffers, 0);
        assert.isTrue(
          (yield* orchestrator.getThreadProjection(threadId)).runs
            .filter((run) => queued.some((row) => row.id === run.id))
            .every((run) => run.status === "queued"),
        );
        yield* releaseCapture;
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
        assert.equal(guardedOffers, 2);
      }),
    { holdCheckpointCapture: true },
  ),
);

it.live(
  "a queued run's provider start follows the previous answer and checkpoint.captured with no client open",
  () =>
    withNativeQueue(
      "queue-policy-delivery-barrier",
      ({
        orchestrator,
        threadId,
        takeOffer,
        offers,
        captureEntered,
        releaseCapture,
        beforeOffer,
      }) =>
        Effect.gen(function* () {
          const eventStore = yield* EventStore.EventStoreV2;
          yield* send(orchestrator, threadId, "foreground");
          const foreground = yield* takeOffer;
          let deliveredAfterSequence: number | undefined;
          beforeOffer((input) =>
            input.message.text === "next"
              ? eventStore.latestSequence({ threadId }).pipe(
                  Effect.map((sequence) => {
                    deliveredAfterSequence = sequence;
                  }),
                  Effect.orDie,
                )
              : Effect.void,
          );
          yield* send(orchestrator, threadId, "next", true);
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.status === "queued",
          );
          assert.ok(queued);
          yield* foreground.answer("Durable foreground answer");
          yield* foreground.settle("completed");
          // The real capture is parked before Git publishes its ref. Nothing that
          // can be claimed meanwhile delivers the queued message.
          yield* captureEntered.pipe(Effect.timeout("15 seconds"));
          yield* (yield* OrchestrationEffectWorkerV2).drain(12);
          assert.deepEqual(offers, ["foreground"]);
          assert.isUndefined(deliveredAfterSequence);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id === queued.id,
            )?.status,
            "queued",
          );
          yield* releaseCapture;
          const next = yield* takeOffer;
          assert.equal(next.input.runId, queued.id);
          assert.ok(deliveredAfterSequence !== undefined);

          // Durable order: the answer, then the capture, then the queued start.
          const history = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
          const sequenceOf = (
            predicate: (event: (typeof history)[number]["event"]) => boolean,
          ): number | undefined => history.find((entry) => predicate(entry.event))?.sequence;
          const answered = sequenceOf(
            (event) =>
              event.type === "message.updated" &&
              event.payload.runId === foreground.input.runId &&
              event.payload.role === "assistant" &&
              event.payload.text === "Durable foreground answer" &&
              !event.payload.streaming,
          );
          const captured = sequenceOf(
            (event) =>
              event.type === "checkpoint.captured" &&
              event.payload.runId === foreground.input.runId &&
              event.payload.status === "ready",
          );
          const started = sequenceOf(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === queued.id &&
              event.payload.status !== "queued",
          );
          assert.ok(answered !== undefined && captured !== undefined && started !== undefined);
          assert.isBelow(answered, captured);
          assert.isBelow(captured, started);
          assert.isAtMost(started, deliveredAfterSequence);
          // Exactly one delivery.
          yield* next.settle("completed");
          assert.deepEqual(offers, ["foreground", "next"]);
        }),
      { holdCheckpointCapture: true },
    ),
);

it.live("native failure holds queued work until a direct send, which the queue then follows", () =>
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
        // The direct send released the hold in the same command.
        const released = yield* orchestrator.getThreadProjection(threadId);
        const remaining = released.runs.filter((run) => run.status === "queued");
        assert.equal(remaining.length, 2);
        assert.isTrue(remaining.every((run) => run.queueHeld === false));
        yield* later.settle("completed");
        // The earlier failure must not hold the queue again after the direct send.
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
  "Stop holds native queued work; Send on a non-head message starts it and the rest continue",
  () =>
    withNativeQueue(
      "queue-policy-stop-hold",
      ({
        orchestrator,
        threadId,
        takeOffer,
        offers,
        waitFor,
        nativeInterruptions,
        delegatedStops,
      }) =>
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
          // After the reorder, `first` is no longer the head. Send on it starts it
          // now, and the rest of the queue continues after it without a Resume.
          yield* orchestrator.dispatch({
            type: "queue.resume",
            threadId,
            runId: first.id,
            commandId: CommandId.make(`${threadId}:send-non-head`),
          });
          const sent = yield* takeOffer;
          assert.equal(sent.input.runId, first.id);
          const afterSend = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(afterSend.runs.find((run) => run.id === second.id)?.status, "queued");
          assert.isFalse(afterSend.runs.find((run) => run.id === second.id)?.queueHeld);
          yield* sent.settle("completed");
          const rest = yield* takeOffer;
          assert.equal(rest.input.runId, second.id);
          yield* rest.settle("completed");
          yield* waitFor(
            (projection) =>
              projection.runs.find((run) => run.id === second.id)?.status === "completed",
          );
          assert.deepEqual(offers, ["foreground", "first", "second"]);
          assert.deepEqual(delegatedStops, [
            { threadId, commandId: CommandId.make(`${threadId}:stop`) },
          ]);
        }),
      { holdFirstSend: true },
    ),
);

it.live("a direct send after Stop resumes the held queue, and its failure holds it again", () =>
  withNativeQueue(
    "queue-policy-direct-send-release",
    ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
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
          holdQueue: true,
          commandId: CommandId.make(`${threadId}:stop`),
        });
        const held = yield* waitFor(
          (projection) =>
            projection.runs.some(
              (run) => run.id === foreground.input.runId && run.status === "interrupted",
            ) && projection.runs.some((run) => run.status === "queued" && run.queueHeld === true),
        );
        const queued = held.runs.find((run) => run.status === "queued");
        assert.ok(queued);
        yield* send(orchestrator, threadId, "direct");
        const direct = yield* takeOffer;
        assert.equal(direct.input.message.text, "direct");
        const released = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(released.runs.find((run) => run.id === queued.id)?.queueHeld);
        // A message queued during the direct turn does not inherit the old hold.
        yield* send(orchestrator, threadId, "during", true);
        const during = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make(`${threadId}:message:during`),
        );
        assert.ok(during);
        assert.notEqual(during.queueHeld, true);
        // The direct turn fails after the release, so the queue is held again.
        yield* direct.settle("failed");
        const reheld = yield* waitFor(
          (projection) =>
            projection.runs.find((run) => run.id === direct.input.runId)?.status === "failed" &&
            projection.runs
              .filter((run) => run.status === "queued")
              .every((run) => run.queueHeld === true),
        );
        assert.equal(reheld.runs.filter((run) => run.status === "queued").length, 2);
        assert.deepEqual(offers, ["foreground", "direct"]);
      }),
  ),
);

it.live(
  "a manual continuation and Queue or Steer fallbacks on an idle thread leave a held queue held",
  () =>
    withNativeQueue(
      "queue-policy-indirect-starts",
      ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
        Effect.gen(function* () {
          yield* send(orchestrator, threadId, "foreground");
          const foreground = yield* takeOffer;
          yield* send(orchestrator, threadId, "first", true);
          yield* send(orchestrator, threadId, "second", true);
          yield* waitFor((projection) =>
            projection.providerTurns.some(
              (turn) =>
                turn.runAttemptId === foreground.input.attemptId && turn.status === "running",
            ),
          );
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            threadId,
            runId: foreground.input.runId,
            holdQueue: true,
            commandId: CommandId.make(`${threadId}:stop`),
          });
          yield* waitFor(
            (projection) =>
              projection.runs.some(
                (run) => run.id === foreground.input.runId && run.status === "interrupted",
              ) &&
              projection.runs.filter((run) => run.status === "queued" && run.queueHeld === true)
                .length === 2,
          );
          const assertHeld = (stage: string) =>
            orchestrator.getThreadProjection(threadId).pipe(
              Effect.map((projection) => {
                const queued = projection.runs.filter((run) => run.status === "queued");
                assert.equal(queued.length, 2, stage);
                assert.isTrue(
                  queued.every((run) => run.queueHeld === true),
                  `${stage}: the held queue stays held`,
                );
              }),
            );
          const starts = [
            {
              label: "continuation",
              manualContinuationOfRunId: foreground.input.runId,
              dispatchMode: { type: "start_immediately" as const },
            },
            { label: "queue-fallback", dispatchMode: { type: "queue_after_active" as const } },
            {
              label: "steer-fallback",
              deliveryIntent: "steer" as const,
              dispatchMode: { type: "start_immediately" as const },
            },
          ];
          for (const { label, ...start } of starts) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${threadId}:send:${label}`),
              threadId,
              messageId: MessageId.make(`${threadId}:message:${label}`),
              text: label,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              ...start,
            });
            const started = yield* takeOffer;
            assert.equal(started.input.message.text, label);
            yield* assertHeld(`${label} started`);
            yield* started.settle("completed");
            yield* waitFor(
              (projection) =>
                projection.runs.find((run) => run.id === started.input.runId)?.status ===
                "completed",
            );
            yield* assertHeld(`${label} completed`);
          }
          assert.deepEqual(offers, [
            "foreground",
            "continuation",
            "queue-fallback",
            "steer-fallback",
          ]);
        }),
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

it.live.each(
  (["completed", "failed"] as const).map((outcome) => ({
    caseTitle: `a direct send before a delayed failure reaction keeps the queue released (direct ${outcome})`,
    outcome,
  })),
)("$caseTitle", ({ outcome }) =>
  withNativeQueue(
    `queue-policy-direct-send-pending-reactor:${outcome}`,
    ({ orchestrator, threadId, takeOffer, waitFor, waitForThread, offers }) =>
      Effect.gen(function* () {
        const locks = yield* ThreadCommandExecutor;
        yield* send(orchestrator, threadId, "parent");
        const parent = yield* takeOffer;
        yield* waitFor((projection) =>
          projection.providerTurns.some((turn) => turn.runAttemptId === parent.input.attemptId),
        );
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`${threadId}:child`),
          parentThreadId: threadId,
          parentRunId: parent.input.runId,
          parentNodeId: parent.input.rootNodeId,
          task: "child-foreground",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "settled_only",
          createdBy: "user",
          creationSource: "web",
        });
        const child = yield* takeOffer;
        const childThreadId = child.input.threadId;
        yield* waitForThread(childThreadId, (projection) =>
          projection.providerTurns.some((turn) => turn.runAttemptId === child.input.attemptId),
        );
        yield* send(orchestrator, childThreadId, "first", true);
        yield* send(orchestrator, childThreadId, "second", true);
        const entered = yield* Deferred.make<void>();
        const unlock = yield* Deferred.make<void>();
        // The child's terminal reactor takes its parent's lock first, so
        // holding that lock delays the hold reaction to the child failure.
        const parentLock = yield* locks
          .withLock(
            threadId,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(unlock))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* child.settle("failed");
        const failed = yield* waitForThread(childThreadId, (projection) =>
          projection.runs.some((run) => run.id === child.input.runId && run.status === "failed"),
        );
        const queuedIds = failed.runs.filter((run) => run.status === "queued").map((run) => run.id);
        assert.equal(queuedIds.length, 2);
        assert.isTrue(
          failed.runs
            .filter((run) => queuedIds.includes(run.id))
            .every((run) => run.queueHeld !== true),
          "The failure's hold has not been written yet",
        );
        yield* send(orchestrator, childThreadId, "direct");
        const direct = yield* takeOffer;
        assert.equal(direct.input.message.text, "direct");
        const released = yield* orchestrator.getThreadProjection(childThreadId);
        assert.isTrue(
          released.runs
            .filter((run) => queuedIds.includes(run.id))
            .every((run) => run.queueHeld === false),
          "The direct send releases every queued run",
        );
        yield* Deferred.succeed(unlock, undefined);
        yield* Fiber.join(parentLock);
        yield* direct.settle(outcome);
        if (outcome === "completed") {
          // The earlier failure's late reaction must not hold the queue.
          for (const text of ["first", "second"]) {
            const next = yield* takeOffer;
            assert.equal(next.input.message.text, text);
            yield* next.settle("completed");
          }
          yield* waitForThread(childThreadId, (projection) =>
            projection.runs
              .filter((run) => queuedIds.includes(run.id))
              .every((run) => run.status === "completed"),
          );
          assert.deepEqual(offers, ["parent", "child-foreground", "direct", "first", "second"]);
        } else {
          // A failure after the direct send holds the queue again.
          yield* waitForThread(
            childThreadId,
            (projection) =>
              projection.runs.find((run) => run.id === direct.input.runId)?.status === "failed" &&
              projection.runs
                .filter((run) => queuedIds.includes(run.id))
                .every((run) => run.status === "queued" && run.queueHeld === true),
          );
          assert.deepEqual(offers, ["parent", "child-foreground", "direct"]);
        }
      }),
  ),
);

it.live.each(
  (["whole", "head", "newer-failure", "new-admission"] as const).map((release) => ({
    caseTitle: `delayed interrupted child checkpoint cannot supersede ${release} queue release`,
    release,
  })),
)("$caseTitle", ({ release }) =>
  withNativeQueue(
    `queue-policy-terminal-echo:${release}`,
    ({ orchestrator, threadId, takeOffer, waitFor, waitForThread, offers }) =>
      Effect.gen(function* () {
        let stage = "parent offer";
        const locks = yield* ThreadCommandExecutor;
        yield* send(orchestrator, threadId, "parent");
        const parent = yield* takeOffer;
        yield* waitFor((projection) =>
          projection.providerTurns.some((turn) => turn.runAttemptId === parent.input.attemptId),
        );
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`${threadId}:child`),
          parentThreadId: threadId,
          parentRunId: parent.input.runId,
          parentNodeId: parent.input.rootNodeId,
          task: "child-foreground",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "settled_only",
          createdBy: "user",
          creationSource: "web",
        });
        stage = "child offer";
        const child = yield* takeOffer;
        const childThreadId = child.input.threadId;
        assert.notEqual(childThreadId, threadId);
        yield* waitForThread(childThreadId, (projection) =>
          projection.providerTurns.some((turn) => turn.runAttemptId === child.input.attemptId),
        );
        yield* send(orchestrator, childThreadId, "first", true);
        yield* send(orchestrator, childThreadId, "second", true);
        const before = yield* orchestrator.getThreadProjection(childThreadId);
        const first = before.runs.find((run) => run.ordinal === 2);
        const second = before.runs.find((run) => run.ordinal === 3);
        assert.ok(first);
        assert.ok(second);
        const entered = yield* Deferred.make<void>();
        const unlock = yield* Deferred.make<void>();
        const parentLock = yield* locks
          .withLock(
            threadId,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(unlock))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Effect.gen(function* () {
          // The terminal reactor must finalize this real app-owned child under
          // its parent's lock before it can react to the child's queue.
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            threadId: childThreadId,
            runId: child.input.runId,
            holdQueue: true,
            commandId: CommandId.make(`${childThreadId}:stop`),
          });
          stage = "child interrupted checkpoint";
          const stopped = yield* waitForThread(childThreadId, (projection) =>
            projection.runs.some(
              (run) =>
                run.id === child.input.runId &&
                run.status === "interrupted" &&
                run.checkpointId !== null,
            ),
          );
          assert.isTrue(
            stopped.runs.filter((run) => run.status === "queued").every((run) => run.queueHeld),
          );
          const resume = {
            type: "queue.resume" as const,
            threadId: childThreadId,
            commandId: CommandId.make(`${childThreadId}:resume`),
            ...(release === "head" ? { runId: first.id } : {}),
          };
          yield* orchestrator.dispatch(resume);
          stage = "resumed head offer";
          const resumed = yield* takeOffer;
          assert.equal(resumed.input.runId, first.id);
          // The original accepted command remains the release boundary on retry.
          yield* orchestrator.dispatch(resume);
          if (release === "new-admission") yield* send(orchestrator, childThreadId, "third", true);
          const released = yield* orchestrator.getThreadProjection(childThreadId);
          // Send on one message resumes the whole queue, like Resume.
          assert.isFalse(released.runs.find((run) => run.id === second.id)?.queueHeld);
          let settledUnderParentLock = false;
          if (release === "newer-failure") {
            settledUnderParentLock = true;
            // Commit the newer real failure while the older terminal reactor
            // is still fenced by the parent lock. Failed runs do not capture.
            yield* resumed.settle("failed");
            stage = "newer failure committed under parent lock";
            const failed = yield* waitForThread(
              childThreadId,
              (projection) =>
                projection.runs.some((run) => run.id === first.id && run.status === "failed") &&
                projection.attempts.some(
                  (attempt) =>
                    attempt.id === resumed.input.attemptId && attempt.status === "failed",
                ) &&
                projection.nodes.some(
                  (node) => node.id === resumed.input.rootNodeId && node.status === "failed",
                ),
            );
            assert.equal(failed.runs.find((run) => run.id === second.id)?.status, "queued");
            assert.equal(failed.runs.find((run) => run.id === second.id)?.queueHeld, false);
            const eventStore = yield* EventStore.EventStoreV2;
            const throughSequence = yield* eventStore.latestSequence({ threadId: childThreadId });
            const history = yield* eventStore
              .read({ threadId: childThreadId, eventType: "run.updated", throughSequence })
              .pipe(Stream.runCollect);
            const terminals = history
              .flatMap((entry) =>
                entry.event.type === "run.updated"
                  ? [
                      {
                        sequence: entry.sequence,
                        commandId: entry.commandId,
                        runId: entry.event.payload.id,
                        attemptId: entry.event.payload.activeAttemptId,
                        rootNodeId: entry.event.payload.rootNodeId,
                        providerThreadId: entry.event.payload.providerThreadId,
                        status: entry.event.payload.status,
                      },
                    ]
                  : [],
              )
              .toSorted((left, right) => left.sequence - right.sequence);
            const interrupted = terminals.find(
              (entry) =>
                entry.runId === child.input.runId &&
                entry.attemptId === child.input.attemptId &&
                entry.status === "interrupted",
            );
            const newer = terminals.find(
              (entry) =>
                entry.runId === first.id &&
                entry.attemptId === resumed.input.attemptId &&
                entry.status === "failed",
            );
            assert.ok(interrupted);
            assert.ok(newer);
            const receipt = yield* (yield* CommandReceiptStoreV2).getByCommandId(resume.commandId);
            assert.isTrue(Option.isSome(receipt));
            if (Option.isNone(receipt)) return yield* Effect.die("Missing accepted Resume receipt");
            assert.equal(receipt.value.status, "accepted");
            assert.equal(receipt.value.threadId, childThreadId);
            assert.equal(receipt.value.commandType, "queue.resume");
            assert.isBelow(interrupted.sequence, receipt.value.resultSequence);
            assert.isBelow(receipt.value.resultSequence, newer.sequence);
            assert.deepEqual(offers, ["parent", "child-foreground", "first"]);
            yield* Effect.logInfo("Queue promotion deciding terminal boundaries", {
              interrupted,
              resume: {
                commandId: resume.commandId,
                resultSequence: receipt.value.resultSequence,
              },
              newer,
              tail: { runId: second.id, status: "queued", held: false },
            });
          }
          yield* Deferred.succeed(unlock, undefined);
          yield* Fiber.join(parentLock);
          if (!settledUnderParentLock)
            yield* resumed.settle(release === "newer-failure" ? "failed" : "completed");
          stage = "resumed head terminal";
          const completed = yield* waitForThread(childThreadId, (projection) =>
            projection.runs.some(
              (run) =>
                run.id === first.id &&
                run.status === (release === "newer-failure" ? "failed" : "completed"),
            ),
          );
          assert.equal(
            completed.runs.find((run) => run.id === child.input.runId)?.status,
            "interrupted",
          );
          if (release === "newer-failure") {
            stage = "newer terminal re-holds tail";
            yield* waitForThread(childThreadId, (projection) =>
              projection.runs.some(
                (run) => run.id === second.id && run.status === "queued" && run.queueHeld === true,
              ),
            );
            assert.deepEqual(offers, ["parent", "child-foreground", "first"]);
            yield* orchestrator.dispatch({
              type: "queue.resume",
              threadId: childThreadId,
              commandId: CommandId.make(`${childThreadId}:resume-rest`),
            });
          }
          stage = "tail offer";
          const tail = yield* takeOffer;
          assert.equal(tail.input.runId, second.id);
          yield* tail.settle("completed");
          yield* waitForThread(childThreadId, (projection) =>
            projection.runs.some((run) => run.id === second.id && run.status === "completed"),
          );
          if (release === "new-admission") {
            const third = yield* takeOffer;
            assert.equal(third.input.message.text, "third");
            yield* third.settle("completed");
            yield* waitForThread(childThreadId, (projection) =>
              projection.runs.some(
                (run) => run.id === third.input.runId && run.status === "completed",
              ),
            );
          }
          assert.deepEqual(offers, [
            "parent",
            "child-foreground",
            "first",
            "second",
            ...(release === "new-admission" ? ["third"] : []),
          ]);
        }).pipe(
          Effect.tapError(() =>
            release === "newer-failure"
              ? Effect.gen(function* () {
                  const eventStore = yield* EventStore.EventStoreV2;
                  const throughSequence = yield* eventStore.latestSequence({
                    threadId: childThreadId,
                  });
                  const history = yield* eventStore
                    .read({ threadId: childThreadId, eventType: "run.updated", throughSequence })
                    .pipe(Stream.runCollect);
                  yield* Effect.logError(
                    "Queue promotion failed deciding stored timeline",
                    history.flatMap((entry) =>
                      entry.event.type === "run.updated"
                        ? [
                            {
                              sequence: entry.sequence,
                              commandId: entry.commandId,
                              runId: entry.event.payload.id,
                              attemptId: entry.event.payload.activeAttemptId,
                              rootNodeId: entry.event.payload.rootNodeId,
                              providerThreadId: entry.event.payload.providerThreadId,
                              status: entry.event.payload.status,
                              held: entry.event.payload.queueHeld,
                            },
                          ]
                        : [],
                    ),
                  );
                })
              : Effect.void,
          ),
          Effect.tapError(() =>
            orchestrator.getThreadProjection(childThreadId).pipe(
              Effect.flatMap((projection) =>
                Effect.logError("Terminal ordering regression stage", {
                  stage,
                  runs: projection.runs.map((run) => ({
                    ordinal: run.ordinal,
                    status: run.status,
                    held: run.queueHeld,
                    checkpoint: run.checkpointId !== null,
                  })),
                }),
              ),
            ),
          ),
          Effect.ensuring(Deferred.succeed(unlock, undefined)),
        );
      }),
  ),
);

it.live("restarted queue reactor preserves durable Resume across an older pending checkpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "queue-policy-restart-checkpoint";
      const cwd = yield* checkpointWorkspace(name);
      const fs = yield* FileSystem.FileSystem;
      const profile = yield* Effect.acquireRelease(fs.makeTempDirectory({ prefix: name }), (path) =>
        fs.remove(path, { recursive: true }).pipe(Effect.orDie),
      );
      const databaseLayer = makeSqlitePersistenceLive(`${profile}/state.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const config = yield* makeReplayServerConfig(name);
      const serverConfigLayer = Layer.succeed(ServerConfig, config);
      const options = { databaseLayer, serverConfigLayer, cwd };
      yield* withNativeQueue(
        name,
        ({ orchestrator, threadId, takeOffer, waitFor }) =>
          Effect.gen(function* () {
            const worker = yield* OrchestrationEffectWorkerV2;
            yield* send(orchestrator, threadId, "foreground");
            yield* worker.drain();
            const foreground = yield* takeOffer;
            yield* waitFor((projection) =>
              projection.providerTurns.some(
                (turn) => turn.runAttemptId === foreground.input.attemptId,
              ),
            );
            yield* send(orchestrator, threadId, "first", true);
            yield* send(orchestrator, threadId, "second", true);
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              threadId,
              runId: foreground.input.runId,
              holdQueue: true,
              commandId: CommandId.make(`${threadId}:stop`),
            });
            yield* worker.drain(1);
            const interrupted = yield* waitFor((projection) =>
              projection.runs.some(
                (run) => run.id === foreground.input.runId && run.status === "interrupted",
              ),
            );
            assert.equal(interrupted.runs[0]?.checkpointId, null);
            yield* orchestrator.dispatch({
              type: "queue.resume",
              threadId,
              commandId: CommandId.make(`${threadId}:resume`),
            });
            const accepted = yield* orchestrator.getThreadProjection(threadId);
            assert.isTrue(
              accepted.runs.filter((run) => run.ordinal > 1).every((run) => run.queueHeld !== true),
            );
            assert.equal(accepted.runs[0]?.checkpointId, null);
          }),
        { ...options, runEffectWorker: false },
      );
      // Construct a fresh runtime with the same disposable SQL/profile. Neither
      // the accepted Resume nor native interruption is reissued after restart.
      yield* withNativeQueue(
        name,
        ({ takeOffer, waitFor, offers }) =>
          Effect.gen(function* () {
            const first = yield* takeOffer;
            assert.equal(first.input.message.text, "first");
            yield* waitFor((projection) => projection.runs[0]?.checkpointId !== null);
            yield* first.settle("completed");
            const second = yield* takeOffer;
            assert.equal(second.input.message.text, "second");
            yield* second.settle("completed");
            const final = yield* waitFor((projection) =>
              projection.runs.every((run) =>
                run.ordinal === 1 ? run.status === "interrupted" : run.status === "completed",
              ),
            );
            assert.isTrue(final.runs.every((run) => run.queueHeld !== true));
            assert.deepEqual(offers, ["first", "second"]);
          }),
        { ...options, existingThread: true },
      );
    }).pipe(Effect.provide(NodeServices.layer)),
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

it.live("competing native sends admit once across the provider acknowledgement gap", () =>
  withNativeQueue(
    "queue-competing-native-sends",
    ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
      Effect.gen(function* () {
        yield* Effect.all(
          [send(orchestrator, threadId, "first"), send(orchestrator, threadId, "first")],
          { concurrency: 2 },
        );
        const first = yield* takeOffer;
        yield* Effect.all(
          [send(orchestrator, threadId, "second"), send(orchestrator, threadId, "third")],
          { concurrency: 2 },
        );
        const pending = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(pending.runs.length, 3);
        assert.equal(pending.runs.filter((run) => run.status === "running").length, 1);
        assert.equal(pending.runs.filter((run) => run.status === "queued").length, 2);
        assert.equal(pending.messages.filter((message) => message.text === "first").length, 1);
        assert.equal(pending.providerTurns.length, 0);
        assert.deepEqual(offers, ["first"]);
        yield* first.releaseSend;
        yield* first.settle("completed");
        const second = yield* takeOffer;
        yield* second.settle("completed");
        const third = yield* takeOffer;
        yield* third.settle("completed");
        const settled = yield* waitFor((projection) =>
          projection.runs.every((run) => run.status === "completed"),
        );
        yield* send(orchestrator, threadId, "first");
        assert.equal(settled.messages.filter((message) => message.role === "user").length, 3);
        assert.equal(offers.length, 3);
        assert.deepEqual(new Set(offers), new Set(["first", "second", "third"]));
      }),
    { holdFirstSend: true },
  ),
);

it.live(
  "native extraction rejects foreign and changed payloads and replays only its durable receipt",
  () =>
    Clock.clockWith((clock) =>
      withNativeQueue(
        "queue-native-extraction-races",
        ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
          Effect.gen(function* () {
            yield* send(orchestrator, threadId, "foreground");
            const foreground = yield* takeOffer;
            yield* send(orchestrator, threadId, "first", true);
            yield* send(orchestrator, threadId, "second", true);
            const before = yield* orchestrator.getThreadProjection(threadId);
            const first = before.runs.find(
              (run) => run.userMessageId === MessageId.make(`${threadId}:message:first`),
            );
            const second = before.runs.find(
              (run) => run.userMessageId === MessageId.make(`${threadId}:message:second`),
            );
            assert.ok(first && second);
            const captured = before.messages.find((message) => message.id === first.userMessageId);
            assert.ok(captured);
            const foreignId = ThreadId.make(`${threadId}:foreign`);
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`${threadId}:foreign:create`),
              threadId: foreignId,
              projectId: ProjectId.make(`project:${threadId}`),
              title: "Foreign",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            assert.equal(
              (yield* Effect.result(
                orchestrator.dispatch({
                  type: "queued-run.cancel",
                  commandId: CommandId.make(`${threadId}:foreign:extract`),
                  threadId: foreignId,
                  runId: first.id,
                  expectedUpdatedAt: captured.updatedAt,
                }),
              ))._tag,
              "Failure",
            );
            yield* orchestrator.dispatch({
              type: "queued-run.edit",
              commandId: CommandId.make(`${threadId}:edit`),
              threadId,
              runId: first.id,
              text: "Edited first",
            });
            const edited = (yield* orchestrator.getThreadProjection(threadId)).messages.find(
              (message) => message.id === captured.id,
            );
            assert.ok(edited);
            assert.equal(DateTime.toEpochMillis(captured.updatedAt), 1776739349000);
            assert.equal(
              (yield* Effect.result(
                orchestrator.dispatch({
                  type: "queued-run.cancel",
                  commandId: CommandId.make(`${threadId}:stale:extract`),
                  threadId,
                  runId: first.id,
                  expectedUpdatedAt: captured.updatedAt,
                }),
              ))._tag,
              "Failure",
            );
            assert.isAbove(
              DateTime.toEpochMillis(edited.updatedAt),
              DateTime.toEpochMillis(captured.updatedAt),
            );
            const preserved = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              preserved.messages.find((message) => message.id === captured.id)?.text,
              "Edited first",
            );
            assert.equal(preserved.runs.find((run) => run.id === first.id)?.status, "queued");
            yield* orchestrator.dispatch({
              type: "queued-run.edit",
              commandId: CommandId.make(`${threadId}:edit-again`),
              threadId,
              runId: first.id,
              text: "Edited first again",
            });
            const revised = (yield* orchestrator.getThreadProjection(threadId)).messages.find(
              (message) => message.id === captured.id,
            );
            assert.ok(revised);
            assert.isAbove(
              DateTime.toEpochMillis(revised.updatedAt),
              DateTime.toEpochMillis(edited.updatedAt),
            );
            assert.equal(
              (yield* Effect.result(
                orchestrator.dispatch({
                  type: "queued-run.cancel",
                  commandId: CommandId.make(`${threadId}:stale-second-editor`),
                  threadId,
                  runId: first.id,
                  expectedUpdatedAt: edited.updatedAt,
                }),
              ))._tag,
              "Failure",
            );
            const afterStaleEdit = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              afterStaleEdit.messages.find((message) => message.id === captured.id)?.text,
              "Edited first again",
            );
            assert.equal(afterStaleEdit.runs.find((run) => run.id === first.id)?.status, "queued");
            const extract = {
              type: "queued-run.cancel" as const,
              commandId: CommandId.make(`${threadId}:extract`),
              threadId,
              runId: first.id,
              expectedUpdatedAt: revised.updatedAt,
            };
            const receipt = yield* orchestrator.dispatch(extract);
            assert.equal((yield* orchestrator.dispatch(extract)).sequence, receipt.sequence);
            assert.equal(
              (yield* Effect.result(
                orchestrator.dispatch({
                  type: "queued-run.edit",
                  commandId: CommandId.make(`${threadId}:other-editor`),
                  threadId,
                  runId: first.id,
                  text: "Overwrite extracted bytes",
                }),
              ))._tag,
              "Failure",
            );
            yield* foreground.settle("completed");
            const delivered = yield* takeOffer;
            assert.equal(delivered.input.runId, second.id);
            yield* delivered.settle("completed");
            const after = yield* waitFor(
              (projection) =>
                projection.runs.find((run) => run.id === second.id)?.status === "completed",
            );
            assert.equal(after.runs.find((run) => run.id === first.id)?.status, "cancelled");
            assert.equal(
              after.messages.find((message) => message.id === captured.id)?.text,
              "Edited first again",
            );
            assert.deepEqual(offers, ["foreground", "second"]);
          }),
      ).pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillisUnsafe: () => 1776739349000,
          currentTimeMillis: Effect.succeed(1776739349000),
          currentTimeNanosUnsafe: () => 1776739349000000000n,
          currentTimeNanos: Effect.succeed(1776739349000000000n),
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: (duration) => clock.sleep(duration),
        }),
      ),
    ),
);

it.live(
  "explicit head Send cannot bypass an active native run and repeated Resume drains once",
  () =>
    withNativeQueue(
      "queue-native-resume-barrier",
      ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
        Effect.gen(function* () {
          yield* send(orchestrator, threadId, "foreground");
          const foreground = yield* takeOffer;
          yield* send(orchestrator, threadId, "first", true);
          yield* send(orchestrator, threadId, "second", true);
          const before = yield* orchestrator.getThreadProjection(threadId);
          const first = before.runs.find(
            (run) => run.userMessageId === MessageId.make(`${threadId}:message:first`),
          );
          const second = before.runs.find(
            (run) => run.userMessageId === MessageId.make(`${threadId}:message:second`),
          );
          assert.ok(first && second);
          assert.equal(
            (yield* Effect.result(
              orchestrator.dispatch({
                type: "queue.resume",
                commandId: CommandId.make(`${threadId}:send-active`),
                threadId,
                runId: first.id,
              }),
            ))._tag,
            "Failure",
          );
          const resume = {
            type: "queue.resume" as const,
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          };
          yield* Effect.all([orchestrator.dispatch(resume), orchestrator.dispatch(resume)], {
            concurrency: 2,
          });
          assert.deepEqual(offers, ["foreground"]);
          yield* foreground.settle("completed");
          const head = yield* takeOffer;
          assert.equal(head.input.runId, first.id);
          yield* head.settle("completed");
          const rest = yield* takeOffer;
          assert.equal(rest.input.runId, second.id);
          yield* rest.settle("completed");
          yield* waitFor((projection) =>
            projection.runs.every((run) => run.status === "completed"),
          );
          assert.deepEqual(offers, ["foreground", "first", "second"]);
        }),
    ),
);

it.live(
  "failed native recovery: Send on a non-head message, Stop re-holds, a direct send resumes the queue",
  () =>
    withNativeQueue(
      "queue-native-repeated-stop",
      ({ orchestrator, threadId, takeOffer, offers, waitFor, nativeInterruptions }) => {
        let phase = "foreground-dispatch";
        return Effect.gen(function* () {
          yield* send(orchestrator, threadId, "foreground");
          phase = "foreground-offer";
          const foreground = yield* takeOffer;
          phase = "queue-first";
          yield* send(orchestrator, threadId, "first", true);
          phase = "queue-second";
          yield* send(orchestrator, threadId, "second", true);
          phase = "foreground-failure";
          yield* foreground.settle("failed");
          phase = "failed-run-and-held-queue";
          const held = yield* waitFor(
            (projection) =>
              projection.runs.find((run) => run.id === foreground.input.runId)?.status ===
                "failed" &&
              projection.runs
                .filter((run) => run.status === "queued")
                .every((run) => run.queueHeld),
          );
          const first = held.runs.find(
            (run) => run.userMessageId === MessageId.make(`${threadId}:message:first`),
          );
          const second = held.runs.find(
            (run) => run.userMessageId === MessageId.make(`${threadId}:message:second`),
          );
          assert.ok(first && second);
          phase = "send-non-head";
          yield* orchestrator.dispatch({
            type: "queue.resume",
            threadId,
            runId: second.id,
            commandId: CommandId.make(`${threadId}:non-head`),
          });
          phase = "recovery-offer";
          const recovery = yield* takeOffer;
          assert.equal(recovery.input.runId, second.id);
          phase = "recovery-provider-running";
          yield* waitFor((projection) =>
            projection.providerTurns.some(
              (turn) => turn.runAttemptId === recovery.input.attemptId && turn.status === "running",
            ),
          );
          const stop = {
            type: "run.interrupt" as const,
            threadId,
            runId: second.id,
            holdQueue: true,
            commandId: CommandId.make(`${threadId}:stop-recovery`),
          };
          phase = "repeated-stop-dispatch";
          yield* Effect.all([orchestrator.dispatch(stop), orchestrator.dispatch(stop)], {
            concurrency: 2,
          });
          phase = "recovery-interrupted";
          // The Stop came after the Send released the queue, so it holds it again.
          const stopped = yield* waitFor(
            (projection) =>
              projection.runs.find((run) => run.id === second.id)?.status === "interrupted" &&
              projection.runs.find((run) => run.id === first.id)?.queueHeld === true,
          );
          assert.equal(stopped.runs.find((run) => run.id === first.id)?.status, "queued");
          phase = "later-recovery-dispatch";
          // A message sent directly on the idle thread resumes the held queue.
          yield* send(orchestrator, threadId, "later-recovery");
          phase = "later-recovery-offer";
          const later = yield* takeOffer;
          const direct = yield* orchestrator.getThreadProjection(threadId);
          assert.isFalse(direct.runs.find((run) => run.id === first.id)?.queueHeld);
          phase = "later-recovery-terminal";
          yield* later.settle("completed");
          phase = "held-queue-continues";
          // The Stop before the direct send must not hold the queue again.
          const rest = yield* takeOffer;
          assert.equal(rest.input.runId, first.id);
          yield* rest.settle("completed");
          yield* waitFor(
            (projection) =>
              projection.runs.find((run) => run.id === first.id)?.status === "completed",
          );
          assert.deepEqual(offers, ["foreground", "second", "later-recovery", "first"]);
        }).pipe(
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const outbox = yield* EffectOutboxV2;
              const receipts = yield* CommandReceiptStoreV2;
              const trace = nativeSettlementTrace(threadId, { orchestrator, outbox, receipts });
              trace.admissionCommands.push(
                ...[
                  "send:foreground",
                  "send:first",
                  "send:second",
                  "non-head",
                  "stop-recovery",
                  "send:later-recovery",
                ].map((suffix) => CommandId.make(`${threadId}:${suffix}`)),
              );
              yield* trace.failure(cause, {
                phase,
                offers,
                nativeInterruptions: nativeInterruptions(),
              });
            }),
          ),
        );
      },
    ),
);

it.live("a real checkpoint capture failure settles the native answer and drains queued work", () =>
  withNativeQueue(
    "queue-native-checkpoint-failure",
    ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* send(orchestrator, threadId, "foreground");
        const foreground = yield* takeOffer;
        yield* send(orchestrator, threadId, "first", true);
        const running = yield* waitFor((projection) =>
          projection.providerTurns.some(
            (turn) => turn.runAttemptId === foreground.input.attemptId && turn.status === "running",
          ),
        );
        const root = running.nodes.find(
          (node) =>
            node.id === running.runs.find((run) => run.id === foreground.input.runId)?.rootNodeId,
        );
        const scope = running.checkpointScopes.find(
          (scope) => scope.id === root?.checkpointScopeId,
        );
        assert.ok(scope);
        const ref = yield* checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 1,
        });
        const lock = `${scope.cwd}/.git/${ref}.lock`;
        yield* fs.writeFileString(lock, "Synthetic competing checkpoint writer\n");
        yield* foreground.settle("completed");
        const next = yield* takeOffer;
        assert.equal(next.input.message.text, "first");
        const after = yield* orchestrator.getThreadProjection(threadId);
        const checkpoint = after.checkpoints.find(
          (checkpoint) => checkpoint.runId === foreground.input.runId,
        );
        assert.equal(
          after.runs.find((run) => run.id === foreground.input.runId)?.status,
          "completed",
        );
        assert.equal(checkpoint?.status, "error");
        assert.isFalse(
          after.turnItems.some(
            (item) => item.runId === foreground.input.runId && item.type === "error",
          ),
        );
        assert.equal(yield* fs.readFileString(lock), "Synthetic competing checkpoint writer\n");
        yield* fs.remove(lock);
        yield* next.settle("completed");
        yield* waitFor((projection) => projection.runs.every((run) => run.status === "completed"));
        assert.deepEqual(offers, ["foreground", "first"]);
      }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a checkpoint capture that fails on every attempt completes the answered run and drains the queue",
  () =>
    withNativeQueue(
      "queue-native-capture-precondition-failure",
      ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
        Effect.gen(function* () {
          yield* send(orchestrator, threadId, "foreground");
          const foreground = yield* takeOffer;
          yield* send(orchestrator, threadId, "first", true);
          yield* foreground.answer("Answer before an uncapturable checkpoint");
          yield* foreground.settle("completed");
          // Every capture attempt fails before Git runs; the worker retries, then gives up.
          const next = yield* takeOffer.pipe(Effect.option);
          const after = yield* orchestrator.getThreadProjection(threadId);
          const run = after.runs.find((candidate) => candidate.id === foreground.input.runId);
          assert.equal(run?.status, "completed");
          assert.isTrue(Option.isSome(next));
          if (Option.isNone(next)) return;
          assert.equal(next.value.input.message.text, "first");
          const checkpoint = after.checkpoints.find((row) => row.id === run?.checkpointId);
          assert.equal(checkpoint?.status, "error");
          assert.deepEqual(checkpoint?.files, []);
          assert.equal(
            after.nodes.find((node) => node.id === foreground.input.rootNodeId)?.status,
            "completed",
          );
          assert.equal(
            after.messages.find(
              (row) => row.runId === foreground.input.runId && row.role === "assistant",
            )?.text,
            "Answer before an uncapturable checkpoint",
          );
          yield* next.value.settle("completed");
          yield* waitFor((projection) =>
            projection.runs.every((candidate) => candidate.status === "completed"),
          );
          assert.deepEqual(offers, ["foreground", "first"]);
        }),
      {
        // The stored workspace no longer matches the checkpoint scope's identity,
        // a precondition the capture checks before it touches Git.
        decorateProjectionStore: (store) => ({
          ...store,
          getCheckpointCaptureContext: (threadId, target) =>
            store.getCheckpointCaptureContext(threadId, target).pipe(
              Effect.map((context) =>
                context.scope === undefined
                  ? context
                  : {
                      ...context,
                      scope: { ...context.scope, cwd: `${context.scope.cwd}-moved` },
                    },
              ),
            ),
        }),
      },
    ),
);

it.live.each(
  (["read", "commit"] as const).map((failing) => ({
    caseTitle: `a transient ${failing} failure while settling an uncapturable checkpoint still completes the run once`,
    failing,
  })),
)("$caseTitle", ({ failing }) => {
  // The capture's precondition always fails, so every attempt ends in the
  // last-attempt settlement once the attempts run out.
  let contextReads = 0;
  let failedOnce = false;
  const failOnce = () => {
    if (failedOnce) return false;
    failedOnce = true;
    return true;
  };
  return withNativeQueue(
    `queue-native-capture-settlement-${failing}-failure`,
    ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
      Effect.gen(function* () {
        yield* send(orchestrator, threadId, "foreground");
        const foreground = yield* takeOffer;
        yield* send(orchestrator, threadId, "first", true);
        yield* foreground.answer("Answer kept through a busy database");
        yield* foreground.settle("completed");
        const next = yield* takeOffer.pipe(Effect.option);
        const after = yield* orchestrator.getThreadProjection(threadId);
        const run = after.runs.find((candidate) => candidate.id === foreground.input.runId);
        assert.isTrue(failedOnce);
        assert.equal(run?.status, "completed");
        assert.isTrue(Option.isSome(next));
        if (Option.isNone(next)) return;
        assert.equal(next.value.input.message.text, "first");
        assert.equal(
          after.checkpoints.find((row) => row.id === run?.checkpointId)?.status,
          "error",
        );
        // Exactly one settlement was committed.
        const history = yield* (yield* EventStore.EventStoreV2)
          .read({ threadId })
          .pipe(Stream.runCollect);
        assert.equal(
          history.filter(
            (entry) =>
              entry.event.type === "run.updated" &&
              entry.event.payload.id === foreground.input.runId &&
              entry.event.payload.status === "completed",
          ).length,
          1,
        );
        assert.equal(
          history.filter(
            (entry) =>
              entry.event.type === "checkpoint.captured" &&
              entry.event.payload.runId === foreground.input.runId,
          ).length,
          1,
        );
        yield* next.value.settle("completed");
        yield* waitFor((projection) =>
          projection.runs.every((candidate) => candidate.status === "completed"),
        );
        assert.deepEqual(offers, ["foreground", "first"]);
      }),
    {
      decorateProjectionStore: (store) => ({
        ...store,
        getCheckpointCaptureContext: (threadId, target) =>
          Effect.suspend(() => {
            contextReads++;
            // Reads 1-5 are the capture attempts; read 6 is the settlement's.
            return failing === "read" && contextReads === 6 && failOnce()
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: "Synthetic busy database during settlement read",
                  }),
                )
              : store.getCheckpointCaptureContext(threadId, target);
          }).pipe(
            Effect.map((context) =>
              context.scope === undefined
                ? context
                : {
                    ...context,
                    scope: { ...context.scope, cwd: `${context.scope.cwd}-moved` },
                  },
            ),
          ),
      }),
      decorateEventSink: (sink) => ({
        ...sink,
        commitCommand: (input) =>
          failing === "commit" && input.commandType === "checkpoint.capture" && failOnce()
            ? Effect.fail(
                new EventSinkWriteError({
                  eventCount: input.events.length,
                  commandId: input.commandId,
                  cause: "Synthetic busy database during settlement commit",
                }),
              )
            : sink.commitCommand(input),
      }),
    },
  );
});

it.live("a deferred start does not open a provider that was turned off after admission", () => {
  let enabled = true;
  return withNativeQueue(
    "queue-native-provider-disabled-after-admission",
    ({ orchestrator, threadId, offers, takeOffer }) =>
      Effect.gen(function* () {
        const worker = yield* OrchestrationEffectWorkerV2;
        yield* send(orchestrator, threadId, "after disable");
        const admitted = yield* orchestrator.getThreadProjection(threadId);
        const run = admitted.runs.find((candidate) => candidate.status === "starting");
        assert.ok(run);
        // Settings turn the provider off before the durable start effect runs.
        enabled = false;
        yield* worker.drain();
        const settled = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(offers, []);
        assert.equal(settled.runs.find((candidate) => candidate.id === run.id)?.status, "failed");
        const failure = settled.turnItems.find(
          (item) => item.runId === run.id && item.type === "error",
        );
        assert.ok(failure?.type === "error");
        assert.equal(failure.title, "Provider is turned off");
        assert.match(failure.failure.message, /turned off/);
        assert.deepEqual(settled.providerTurns, []);
        // Turning it back on lets the next message start normally.
        enabled = true;
        yield* send(orchestrator, threadId, "after enable");
        yield* worker.drain();
        const next = yield* takeOffer;
        assert.include(next.input.message.text, "after enable");
      }),
    { runEffectWorker: false, providerEnabled: () => enabled },
  );
});

it.live(
  "native checkpoint comparison failure preserves the captured ref and reports its diagnostic",
  () => {
    const diagnostics: unknown[] = [];
    return withNativeQueue(
      "queue-native-checkpoint-diff-failure",
      ({ orchestrator, threadId, takeOffer, waitFor }) =>
        Effect.gen(function* () {
          yield* send(orchestrator, threadId, "foreground");
          const foreground = yield* takeOffer;
          const fs = yield* FileSystem.FileSystem;
          const cwd = foreground.input.runtimePolicy.cwd;
          assert.ok(cwd);
          const capturedContent = "Captured native output survives a comparison failure\n";
          yield* fs.writeFileString(`${cwd}/README.md`, capturedContent);
          yield* foreground.settle("completed");
          const after = yield* waitFor(
            (projection) =>
              projection.runs.find((run) => run.id === foreground.input.runId)?.status ===
              "completed",
          );
          const checkpoint = after.checkpoints.find(
            (checkpoint) => checkpoint.runId === foreground.input.runId,
          );
          assert.ok(checkpoint);
          assert.equal(checkpoint.status, "ready");
          assert.deepEqual(checkpoint.files, []);
          const store = yield* CheckpointStore;
          const scope = after.checkpointScopes.find((scope) => scope.id === checkpoint.scopeId);
          assert.ok(scope);
          assert.isTrue(
            yield* store.hasCheckpointRef({ cwd: scope.cwd, checkpointRef: checkpoint.ref }),
          );
          const vcs = yield* VcsProcess.VcsProcess;
          const captured = yield* vcs.run({
            operation: "NativeQueueHoldPolicy.readCapturedCheckpoint",
            command: "git",
            args: ["show", `${checkpoint.ref}:README.md`],
            cwd: scope.cwd,
          });
          assert.equal(captured.stdout, capturedContent);
          assert.ok(
            diagnostics.some((message) =>
              String(message).includes("checkpoint diff summary failed"),
            ),
          );
          assert.isFalse(
            after.turnItems.some(
              (item) => item.runId === foreground.input.runId && item.type === "error",
            ),
          );
        }),
      { failCheckpointDiff: true },
    ).pipe(
      Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.withLogger(
        Logger.make(({ message }) => {
          diagnostics.push(message);
        }),
      ),
    );
  },
);

it.live("foreign and previous native terminals cannot release a newer run or its queue", () =>
  withNativeQueue(
    "native-stale-terminals",
    ({ orchestrator, threadId, takeOffer, injectEvent, offers, waitFor }) =>
      Effect.gen(function* () {
        yield* send(orchestrator, threadId, "previous");
        const previous = yield* takeOffer;
        const old = yield* waitFor((projection) =>
          projection.providerTurns.some(
            (turn) => turn.runAttemptId === previous.input.attemptId && turn.status === "running",
          ),
        );
        const oldTurn = old.providerTurns.find(
          (turn) => turn.runAttemptId === previous.input.attemptId,
        )!;
        yield* previous.settle("completed");
        yield* waitFor(
          (projection) =>
            projection.runs.find((run) => run.id === previous.input.runId)?.status === "completed",
        );
        yield* send(orchestrator, threadId, "current");
        const current = yield* takeOffer;
        yield* send(orchestrator, threadId, "waiting", true);
        const running = yield* waitFor((projection) =>
          projection.providerTurns.some(
            (turn) => turn.runAttemptId === current.input.attemptId && turn.status === "running",
          ),
        );
        const turn = running.providerTurns.find(
          (turn) => turn.runAttemptId === current.input.attemptId,
        )!;
        for (const [index, terminal] of [
          { ...turn, id: ProviderTurnId.make("foreign-native-turn") },
          oldTurn,
        ].entries()) {
          yield* injectEvent({
            type: "turn.terminal",
            driver: current.input.providerThread.driver,
            providerThreadId: terminal.providerThreadId,
            providerTurnId: terminal.id,
            runOrdinal: index === 0 ? current.input.runOrdinal : previous.input.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          const now = yield* DateTime.now;
          const marker = TurnItemId.make(`native-stale-terminal-observed:${index}`);
          // A subsequent owned item is the ingestion receipt for the rejected
          // terminal; assertions never rely on a delay or an unconsumed stream.
          yield* injectEvent({
            type: "turn_item.updated",
            driver: current.input.providerThread.driver,
            turnItem: {
              id: marker,
              threadId,
              runId: current.input.runId,
              nodeId: current.input.rootNodeId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 100 + index,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "system_notice",
              message: "Owned ingestion receipt",
            },
          });
          const after = yield* waitFor((projection) =>
            projection.turnItems.some((item) => item.id === marker),
          );
          assert.equal(after.runs.find((run) => run.id === current.input.runId)?.status, "running");
          assert.equal(
            after.runs.find(
              (run) => run.userMessageId === MessageId.make(`${threadId}:message:waiting`),
            )?.status,
            "queued",
          );
          assert.equal(
            after.providerTurns.find((entry) => entry.id === turn.id)?.status,
            "running",
          );
          assert.deepEqual(offers, ["previous", "current"]);
        }
        yield* current.settle("completed");
        const queued = yield* takeOffer;
        yield* queued.settle("completed");
        yield* waitFor((projection) => projection.runs.every((run) => run.status === "completed"));
      }),
    { injectEvents: true },
  ),
);

it.live(
  "native queue promotion rejects a failed target and receipts cannot be replayed by another thread",
  () =>
    withNativeQueue(
      "native-failed-steer-receipt",
      ({ orchestrator, threadId, takeOffer, waitFor, offers }) =>
        Effect.gen(function* () {
          yield* send(orchestrator, threadId, "foreground");
          const foreground = yield* takeOffer;
          yield* send(orchestrator, threadId, "waiting", true);
          yield* foreground.settle("failed");
          const before = yield* waitFor(
            (projection) =>
              projection.runs.find((run) => run.id === foreground.input.runId)?.status ===
                "failed" &&
              projection.runs.some(
                (run) =>
                  run.userMessageId === MessageId.make(`${threadId}:message:waiting`) &&
                  run.status === "queued" &&
                  run.queueHeld === true,
              ),
          );
          const queued = before.runs.find((run) => run.status === "queued")!;
          assert.equal(
            (yield* Effect.result(
              orchestrator.dispatch({
                type: "queued-message.promote-to-steer",
                threadId,
                commandId: CommandId.make(`${threadId}:stale-steer`),
                queuedRunId: queued.id,
                targetRunId: foreground.input.runId,
              }),
            ))._tag,
            "Failure",
          );
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(after.runs, before.runs);
          assert.deepEqual(after.messages, before.messages);
          assert.deepEqual(offers, ["foreground"]);
          const foreign = ThreadId.make(`${threadId}:foreign`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${foreign}:create`),
            threadId: foreign,
            projectId: before.thread.projectId,
            title: "Foreign",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          const reused = yield* Effect.result(
            orchestrator.dispatch({
              type: "message.dispatch",
              threadId: foreign,
              commandId: CommandId.make(`${threadId}:send:waiting`),
              messageId: MessageId.make(`${foreign}:message`),
              text: "waiting",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
            }),
          );
          assert.equal(reused._tag, "Failure");
          if (reused._tag === "Failure")
            assert.equal(reused.failure._tag, "OrchestratorCommandIdConflictError");
          assert.lengthOf((yield* orchestrator.getThreadProjection(foreign)).messages, 0);
          assert.deepEqual(
            (yield* orchestrator.getThreadProjection(threadId)).messages,
            before.messages,
          );
        }),
    ),
);

it.live("distinct repeated native Stops share one interruption and retain the held queue", () =>
  withNativeQueue(
    "native-repeated-stops",
    ({
      orchestrator,
      threadId,
      takeOffer,
      waitFor,
      interruptEntered,
      releaseInterrupt,
      nativeInterruptions,
    }) =>
      Effect.gen(function* () {
        yield* send(orchestrator, threadId, "foreground");
        const foreground = yield* takeOffer;
        yield* send(orchestrator, threadId, "waiting", true);
        yield* waitFor((projection) =>
          projection.providerTurns.some(
            (turn) => turn.runAttemptId === foreground.input.attemptId && turn.status === "running",
          ),
        );
        const stop = (name: string) =>
          orchestrator.dispatch({
            type: "run.interrupt",
            threadId,
            runId: foreground.input.runId,
            holdQueue: true,
            commandId: CommandId.make(`${threadId}:${name}`),
          });
        yield* stop("first-stop");
        yield* interruptEntered;
        yield* stop("second-stop");
        assert.equal(nativeInterruptions(), 1);
        yield* releaseInterrupt;
        const stopped = yield* waitFor(
          (projection) =>
            projection.runs.find((run) => run.id === foreground.input.runId)?.status ===
            "interrupted",
        );
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        assert.equal(nativeInterruptions(), 1);
        assert.isTrue(stopped.runs.find((run) => run.status === "queued")?.queueHeld);
        assert.equal(
          stopped.messages.find(
            (message) => message.id === MessageId.make(`${threadId}:message:waiting`),
          )?.text,
          "waiting",
        );
      }),
    { holdInterrupt: true },
  ),
);

it.live("native immediate admission preserves committed composer modes in its durable run", () =>
  withNativeQueue("native-composer-admission", ({ orchestrator, threadId, takeOffer, waitFor }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        threadId,
        commandId: CommandId.make(`${threadId}:supervised`),
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        threadId,
        commandId: CommandId.make(`${threadId}:plan`),
        interactionMode: "plan",
      });
      yield* send(orchestrator, threadId, "foreground");
      const foreground = yield* takeOffer;
      const admitted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(admitted.thread.runtimeMode, "approval-required");
      assert.equal(admitted.thread.interactionMode, "plan");
      const run = admitted.runs.find((run) => run.id === foreground.input.runId)!;
      assert.equal(run.runtimeMode, "approval-required");
      assert.equal(run.interactionMode, "plan");
      assert.equal(foreground.input.runtimePolicy.runtimeMode, "approval-required");
      assert.equal(foreground.input.runtimePolicy.interactionMode, "plan");
      yield* foreground.settle("completed");
      yield* waitFor(
        (projection) =>
          projection.runs.find((entry) => entry.id === run.id)?.status === "completed",
      );
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        threadId,
        commandId: CommandId.make(`${threadId}:unrestricted`),
        runtimeMode: "full-access",
      });
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        threadId,
        commandId: CommandId.make(`${threadId}:default`),
        interactionMode: "default",
      });
      const changed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        changed.runs.find((entry) => entry.id === run.id)?.runtimeMode,
        "approval-required",
      );
      assert.equal(changed.runs.find((entry) => entry.id === run.id)?.interactionMode, "plan");
    }),
  ),
);

it.live("old native terminals cannot release a newer unadopted start or its queue", () =>
  withNativeQueue(
    "native-unadopted-stale-terminal",
    ({ orchestrator, threadId, takeOffer, injectEvent, offers, waitFor }) =>
      Effect.gen(function* () {
        yield* send(orchestrator, threadId, "previous");
        const previous = yield* takeOffer;
        const owned = yield* waitFor((projection) =>
          projection.providerTurns.some(
            (turn) => turn.runAttemptId === previous.input.attemptId && turn.status === "running",
          ),
        );
        const oldTurn = owned.providerTurns.find(
          (turn) => turn.runAttemptId === previous.input.attemptId,
        )!;
        yield* previous.settle("completed");
        yield* waitFor(
          (projection) =>
            projection.runs.find((run) => run.id === previous.input.runId)?.status === "completed",
        );
        yield* send(orchestrator, threadId, "current");
        const current = yield* takeOffer;
        yield* send(orchestrator, threadId, "waiting", true);
        const pending = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          pending.attempts.find((attempt) => attempt.id === current.input.attemptId)
            ?.providerTurnId,
          null,
        );
        assert.isFalse(
          pending.providerTurns.some((turn) => turn.runAttemptId === current.input.attemptId),
        );
        yield* injectEvent({
          type: "turn.terminal",
          driver: current.input.providerThread.driver,
          providerThreadId: oldTurn.providerThreadId,
          providerTurnId: oldTurn.id,
          runOrdinal: previous.input.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* injectEvent({
          type: "provider_turn.updated",
          driver: current.input.providerThread.driver,
          providerTurn: { ...oldTurn, status: "completed" },
        });
        const providerThread = pending.providerThreads.find(
          (thread) => thread.id === current.input.providerThread.id,
        )!;
        const marker = "Observed old terminals before native adoption";
        // This ordered native thread update proves both terminal frames were
        // consumed while the actual acceptance lifecycle is still held.
        yield* injectEvent({
          type: "provider_thread.updated",
          driver: current.input.providerThread.driver,
          providerThread: {
            ...providerThread,
            nativeMetadata: { ...providerThread.nativeMetadata, title: marker },
          },
        });
        const blocked = yield* waitFor((projection) =>
          projection.providerThreads.some((thread) => thread.nativeMetadata?.title === marker),
        );
        assert.equal(blocked.runs.find((run) => run.id === current.input.runId)?.status, "running");
        assert.equal(
          blocked.attempts.find((attempt) => attempt.id === current.input.attemptId)
            ?.providerTurnId,
          null,
        );
        assert.isFalse(
          blocked.providerTurns.some((turn) => turn.runAttemptId === current.input.attemptId),
        );
        assert.equal(
          blocked.runs.find(
            (run) => run.userMessageId === MessageId.make(`${threadId}:message:waiting`),
          )?.status,
          "queued",
        );
        assert.deepEqual(offers, ["previous", "current"]);
        yield* current.releaseSend;
        yield* current.settle("completed");
        const queued = yield* takeOffer;
        assert.equal(queued.input.message.text, "waiting");
        yield* queued.settle("completed");
        yield* waitFor((projection) => projection.runs.every((run) => run.status === "completed"));
        assert.deepEqual(offers, ["previous", "current", "waiting"]);
      }),
    { holdSendOrdinal: 2, injectEvents: true },
  ),
);

it.live(
  "native PR refresh failure still captures a checkpoint and starts the next queued message once",
  () => {
    const refreshed: ProjectId[] = [];
    return withNativeQueue(
      "native-pr-refresh-checkpoint-barrier",
      ({ orchestrator, threadId, takeOffer, offers, waitFor }) =>
        Effect.gen(function* () {
          const checkpointStore = yield* CheckpointStore;
          yield* send(orchestrator, threadId, "first");
          const first = yield* takeOffer;
          yield* send(orchestrator, threadId, "waiting", true);
          yield* first.settle("completed");
          const queued = yield* takeOffer;
          assert.equal(queued.input.message.text, "waiting");
          const released = yield* orchestrator.getThreadProjection(threadId);
          const run = released.runs.find((candidate) => candidate.id === first.input.runId)!;
          assert.equal(run.status, "completed");
          const checkpoint = released.checkpoints.find(
            (candidate) => candidate.id === run.checkpointId,
          );
          assert.ok(checkpoint);
          assert.equal(checkpoint.status, "ready");
          const scope = released.checkpointScopes.find(
            (candidate) => candidate.id === checkpoint.scopeId,
          )!;
          assert.isTrue(
            yield* checkpointStore.hasCheckpointRef({
              cwd: scope.cwd,
              checkpointRef: checkpoint.ref,
            }),
          );
          assert.deepEqual(refreshed, [released.thread.projectId]);
          assert.isFalse(
            released.turnItems.some(
              (item) => item.runId === first.input.runId && item.type === "error",
            ),
          );
          yield* queued.settle("completed");
          const complete = yield* waitFor((projection) =>
            projection.runs.every((candidate) => candidate.status === "completed"),
          );
          assert.deepEqual(refreshed, [complete.thread.projectId, complete.thread.projectId]);
          assert.deepEqual(offers, ["first", "waiting"]);
          assert.ok(complete.runs.every((candidate) => candidate.checkpointId !== null));
        }),
    ).pipe(
      Effect.provideService(RunFinalizationObserver, {
        refresh: () => Effect.void,
        refreshAfterTurn: (projectId) =>
          Effect.sync(() => {
            refreshed.push(projectId);
          }).pipe(Effect.andThen(Effect.die("Synthetic PR refresh observer failure"))),
      }),
    );
  },
);

it.live(
  "settles a failed native startup by its own diagnostic despite an older failure and permits retry",
  () =>
    withNativeQueue(
      "inherited-startup-diagnostic",
      ({ orchestrator, threadId, takeOffer, waitFor, offers, failNextStarts }) =>
        Effect.gen(function* () {
          yield* send(orchestrator, threadId, "older failure");
          const old = yield* takeOffer;
          yield* old.settle("failed");
          const seeded = yield* waitFor(
            (p) => p.runs.find((run) => run.id === old.input.runId)?.status === "failed",
          );
          const oldErrors = seeded.turnItems.filter(
            (item) => item.runId === old.input.runId && item.type === "error",
          );
          assert.isAbove(oldErrors.length, 0);
          yield* (yield* ProviderSessionManagerV2).close(
            old.input.providerThread.providerSessionId!,
          );
          failNextStarts(5);
          yield* send(orchestrator, threadId, "fail current startup");
          const admitted = yield* orchestrator.getThreadProjection(threadId);
          const current = admitted.runs.at(-1)!;
          assert.notEqual(current.id, old.input.runId);
          const observeFailure = waitFor(
            (p) =>
              p.runs.find((run) => run.id === current.id)?.status === "failed" &&
              p.turnItems.some(
                (item) =>
                  item.runId === current.id &&
                  item.type === "error" &&
                  item.title === "Provider session failed to open",
              ),
          );
          const failed = yield* observeFailure;
          const diagnostic = failed.turnItems.find(
            (item) => item.runId === current.id && item.type === "error",
          );
          assert.ok(diagnostic?.type === "error");
          assert.match(diagnostic.failure.message, /open/i);
          assert.isFalse(
            oldErrors.some(
              (item) =>
                item.type === "error" && item.failure.message === diagnostic.failure.message,
            ),
          );
          assert.deepEqual(
            failed.turnItems.filter(
              (item) => item.runId === old.input.runId && item.type === "error",
            ),
            oldErrors,
          );
          assert.isFalse(
            failed.providerTurns.some((turn) => turn.runAttemptId === current.activeAttemptId),
          );
          assert.deepEqual(offers, ["older failure"]);
          yield* send(orchestrator, threadId, "clean retry");
          const retry = yield* takeOffer;
          assert.notEqual(retry.input.runId, current.id);
          yield* retry.settle("completed");
          const recovered = yield* waitFor(
            (p) => p.runs.find((run) => run.id === retry.input.runId)?.status === "completed",
          );
          assert.isFalse(
            recovered.turnItems.some(
              (item) => item.runId === retry.input.runId && item.type === "error",
            ),
          );
          assert.equal(recovered.runs.find((run) => run.id === current.id)?.status, "failed");
          assert.lengthOf(offers, 2);
          assert.equal(offers[0], "older failure");
          assert.isTrue(offers[1]!.endsWith("User message:\nclean retry"));
        }),
      { controlStartupFailures: true },
    ),
);

it.live(
  "promotes the original queued payload once through command commit and native Steer while retaining the tail",
  () =>
    Effect.gen(function* () {
      const release = BUILT_IN_SKILL_RELEASES.find((release) =>
        release.supportedScopes.includes("user"),
      );
      assert.ok(release);
      const planner = yield* ScientSkillSession.ScientSkillSessionPlanner.pipe(
        Effect.provide(
          ScientSkillSession.layer.pipe(
            Layer.provide(
              Layer.merge(
                ScientSkillRegistry.layerFromCatalog({ releases: [release], diagnostics: [] }),
                ScientSkillPolicy.layerFromSnapshot({
                  userSkills: [
                    {
                      release: toSkillReleaseRef(release),
                      active: true,
                      invocationPolicy: "explicit",
                    },
                  ],
                  projectSkills: [],
                  trustedProjects: [],
                }),
              ),
            ),
          ),
        ),
      );
      yield* withNativeQueue(
        "queued-promotion-positive",
        ({ orchestrator, threadId, takeOffer, takeSteer, offers, steers, waitFor }) =>
          Effect.gen(function* () {
            const worker = yield* OrchestrationEffectWorkerV2;
            const outbox = yield* EffectOutboxV2;
            const fs = yield* FileSystem.FileSystem;
            const config = yield* ServerConfig;
            yield* send(orchestrator, threadId, "foreground");
            yield* worker.drain(12);
            const foreground = yield* takeOffer;
            const active = yield* waitFor((p) =>
              p.providerTurns.some(
                (turn) =>
                  turn.runAttemptId === foreground.input.attemptId &&
                  turn.nativeAcceptance === "accepted",
              ),
            );
            const nativeTurn = active.providerTurns.find(
              (turn) => turn.runAttemptId === foreground.input.attemptId,
            )!;
            const historicalAt = yield* DateTime.now;
            const historicalStopId = (yield* IdAllocatorV2).derive.runSignalTurnItem({
              runId: foreground.input.runId,
              signal: "interrupt-request",
            });
            // Historical controls must not fence the current root or native turn.
            yield* (yield* EventSinkV2).write({
              events: [
                {
                  id: historicalStopId,
                  nodeId: NodeId.make(`${threadId}:historical-root`),
                  providerTurnId: null,
                },
                {
                  id: TurnItemId.make(`${threadId}:historical-native-Stop`),
                  nodeId: foreground.input.rootNodeId,
                  providerTurnId: ProviderTurnId.make(`${threadId}:historical-native-turn`),
                },
              ].map((owner, index) => ({
                id: EventId.make(`${threadId}:historical-Stop:${index}`),
                type: "turn-item.updated" as const,
                threadId,
                runId: foreground.input.runId,
                providerInstanceId: active.runs[0]!.providerInstanceId,
                occurredAt: historicalAt,
                payload: {
                  ...owner,
                  threadId,
                  runId: foreground.input.runId,
                  providerThreadId: nativeTurn.providerThreadId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: Math.max(...active.turnItems.map((item) => item.ordinal)) + index + 1,
                  status: "completed" as const,
                  title: "Interrupt requested",
                  startedAt: historicalAt,
                  completedAt: historicalAt,
                  updatedAt: historicalAt,
                  type: "run_interrupt_request" as const,
                  message: "Historical owner Stop",
                },
              })),
            });
            const messageId = MessageId.make(`${threadId}:original-queued-message`);
            const attachment = {
              type: "file" as const,
              id: ChatAttachmentId.make(createAttachmentId(threadId)!),
              name: "queued-evidence.txt",
              mimeType: "text/plain",
              sizeBytes: 21,
            };
            const path = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            });
            assert.ok(path);
            yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
            yield* fs.writeFileString(path, "owned queued evidence");
            const context = {
              version: 1 as const,
              records: [
                {
                  version: 1 as const,
                  kind: "terminal" as const,
                  contextId: ComposerContextId.make("promotion-terminal"),
                  label: "Captured terminal",
                  terminalId: "fixture-terminal",
                  terminalLabel: "Promotion evidence",
                  lineStart: 0,
                  lineEnd: 1,
                  text: "Unique captured promotion context",
                },
              ],
            };
            const queuedInstruction =
              "Compare the queued zirconium evidence before recommending a revision.";
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${threadId}:queue-selected`),
              threadId,
              messageId,
              text: `${queuedInstruction} [Captured terminal](t3-context://v1/terminal/promotion-terminal)`,
              attachments: [attachment],
              context,
              selectedScientSkillNames: [release.name],
              runtimeMode: "full-access",
              interactionMode: "default",
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "mobile",
            });
            yield* send(orchestrator, threadId, "untouched tail", true);
            const queued = yield* orchestrator.getThreadProjection(threadId);
            const selected = queued.runs.find((run) => run.userMessageId === messageId)!;
            const tail = queued.runs.find(
              (run) => run.status === "queued" && run.id !== selected.id,
            )!;
            const original = queued.messages.find((message) => message.id === messageId)!;
            assert.equal(selected.status, "queued");
            assert.equal(selected.runtimeMode, "full-access");
            assert.equal(selected.interactionMode, "default");
            assert.deepEqual(original.context, context);
            assert.deepEqual(original.attachments, [attachment]);
            // Future composer defaults must not replace the queued request's captured modes.
            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              threadId,
              commandId: CommandId.make(`${threadId}:future-runtime`),
              runtimeMode: "approval-required",
            });
            yield* orchestrator.dispatch({
              type: "thread.interaction-mode.set",
              threadId,
              commandId: CommandId.make(`${threadId}:future-interaction`),
              interactionMode: "plan",
            });
            const before = yield* orchestrator.getThreadProjection(threadId);
            const refusedId = CommandId.make(`${threadId}:missing-target-promotion`);
            assert.equal(
              (yield* Effect.result(
                orchestrator.dispatch({
                  type: "queued-message.promote-to-steer",
                  commandId: refusedId,
                  threadId,
                  queuedRunId: selected.id,
                  targetRunId: RunId.make("missing-target-run"),
                }),
              ))._tag,
              "Failure",
            );
            assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
            assert.deepEqual(yield* outbox.listByCommandId(refusedId), []);
            assert.lengthOf(steers, 0);
            const command = {
              type: "queued-message.promote-to-steer" as const,
              commandId: CommandId.make(`${threadId}:accepted-promotion`),
              threadId,
              queuedRunId: selected.id,
              targetRunId: foreground.input.runId,
            };
            const receipt = yield* orchestrator.dispatch(command);
            const committed = yield* orchestrator.getThreadProjection(threadId);
            const moved = committed.messages.find((message) => message.id === messageId)!;
            assert.equal(moved.runId, foreground.input.runId);
            assert.equal(moved.nodeId, foreground.input.rootNodeId);
            for (const key of [
              "id",
              "text",
              "attachments",
              "context",
              "selectedScientSkillNames",
              "createdBy",
              "creationSource",
            ] as const) {
              assert.deepEqual(moved[key], original[key]);
            }
            assert.equal(committed.runs.find((run) => run.id === selected.id)?.status, "cancelled");
            assert.isNull(committed.runs.find((run) => run.id === selected.id)?.queuePosition);
            assert.equal(
              committed.nodes.find((node) => node.id === selected.rootNodeId)?.status,
              "cancelled",
            );
            assert.equal(
              committed.attempts.find((attempt) => attempt.id === selected.activeAttemptId)?.status,
              "cancelled",
            );
            assert.deepEqual(
              committed.runs.find((run) => run.id === tail.id),
              tail,
            );
            const item = committed.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === messageId,
            );
            assert.ok(item?.type === "user_message");
            assert.equal(item.inputIntent, "promoted_queued_to_steer");
            assert.equal(item.runId, foreground.input.runId);
            assert.equal(item.providerTurnId, nativeTurn.id);
            const effects = yield* outbox.listByCommandId(command.commandId);
            assert.lengthOf(effects, 1);
            assert.equal(effects[0]?.request.type, "provider-turn.steer");
            assert.equal(effects[0]?.status, "pending");
            assert.lengthOf(steers, 0);
            assert.lengthOf(offers, 1);
            assert.equal((yield* orchestrator.dispatch(command)).sequence, receipt.sequence);
            assert.deepEqual(yield* outbox.listByCommandId(command.commandId), effects);
            yield* worker.drain(12);
            const delivered = yield* takeSteer;
            assert.equal(delivered.providerTurnId, nativeTurn.id);
            assert.equal(delivered.runId, foreground.input.runId);
            assert.equal(delivered.message.messageId, messageId);
            assert.equal(delivered.message.creationSource, "mobile");
            const credential = yield* (yield* McpProviderSessions.McpProviderSessions).read(
              threadId,
            );
            assert.ok(credential);
            const scope = yield* (yield* McpSessionRegistry.McpSessionRegistry).resolve(
              credential.authorizationHeader.replace(/^Bearer\s+/, ""),
            );
            assert.ok(scope);
            assert.deepEqual(
              scope.skillScope?.skills.map((skill) => skill.name),
              [release.name],
            );
            assert.deepEqual(delivered.message.attachments, original.attachments);
            assert.include(delivered.message.text, queuedInstruction);
            assert.include(delivered.message.text, "Unique captured promotion context");
            assert.include(delivered.message.text, `\`${release.name}\` (selected by the user)`);
            assert.equal(yield* fs.readFileString(path), "owned queued evidence");
            assert.equal(
              (yield* outbox.listByCommandId(command.commandId))[0]?.status,
              "succeeded",
            );
            assert.lengthOf(steers, 1);
            assert.lengthOf(offers, 1);
            const after = yield* orchestrator.getThreadProjection(threadId);
            const historical = after.turnItems.filter(
              (item) => item.type === "run_interrupt_request",
            );
            assert.lengthOf(historical, 2);
            assert.equal(
              historical.find((item) => item.id === historicalStopId)?.nodeId,
              NodeId.make(`${threadId}:historical-root`),
            );
            assert.equal(
              historical.find((item) => item.nodeId === foreground.input.rootNodeId)
                ?.providerTurnId,
              ProviderTurnId.make(`${threadId}:historical-native-turn`),
            );
            assert.lengthOf(after.providerTurns, 1);
            assert.lengthOf(
              after.attempts.filter((attempt) => attempt.runId === foreground.input.runId),
              1,
            );
            assert.equal((yield* orchestrator.dispatch(command)).sequence, receipt.sequence);
            yield* worker.drain(12);
            assert.lengthOf(steers, 1);
            assert.lengthOf(offers, 1);
            yield* runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
            yield* foreground.settle("completed");
            const next = yield* takeOffer;
            assert.equal(next.input.message.messageId, tail.userMessageId);
            assert.include(next.input.message.text, "untouched tail");
            yield* next.settle("completed");
            const settled = yield* waitFor(
              (p) => p.runs.find((run) => run.id === tail.id)?.status === "completed",
            );
            assert.equal(settled.runs.find((run) => run.id === selected.id)?.status, "cancelled");
            assert.lengthOf(offers, 2);
            assert.lengthOf(steers, 1);
            assert.equal(yield* fs.readFileString(path), "owned queued evidence");
          }),
        {
          runEffectWorker: false,
          nativeSteering: true,
          mcpSessionRegistryLayer: promotionMcpRegistryLayer,
        },
      ).pipe(Effect.provideService(ScientSkillSession.ScientSkillSessionPlanner, planner));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a promotion that loses to native queue extraction leaves the started request intact", () =>
  withNativeQueue(
    "queued-promotion-extraction-race",
    ({ orchestrator, threadId, takeOffer, waitFor, offers, steers }) =>
      Effect.gen(function* () {
        const outbox = yield* EffectOutboxV2;
        yield* send(orchestrator, threadId, "foreground");
        const foreground = yield* takeOffer;
        yield* send(orchestrator, threadId, "extracted queued request", true);
        const queued = yield* orchestrator.getThreadProjection(threadId);
        const selected = queued.runs.find((run) => run.status === "queued")!;
        yield* foreground.settle("completed");
        const started = yield* takeOffer;
        const before = yield* waitFor((p) =>
          p.providerTurns.some(
            (turn) =>
              turn.runAttemptId === started.input.attemptId && turn.nativeAcceptance === "accepted",
          ),
        );
        assert.equal(started.input.runId, selected.id);
        const commandId = CommandId.make(`${threadId}:losing-promotion`);
        assert.equal(
          (yield* Effect.result(
            orchestrator.dispatch({
              type: "queued-message.promote-to-steer",
              commandId,
              threadId,
              queuedRunId: selected.id,
              targetRunId: foreground.input.runId,
            }),
          ))._tag,
          "Failure",
        );
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        assert.lengthOf(steers, 0);
        assert.lengthOf(offers, 2);
        yield* started.settle("completed");
        yield* waitFor((p) => p.runs.find((run) => run.id === selected.id)?.status === "completed");
      }),
    { nativeSteering: true },
  ),
);

it.live(
  "keeps an active root checkpoint in A across future B admission and reuses A after reopen",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "workspace-bound-root-overlap";
        let reopenPhase = "native-runtime";
        const workspaceA = yield* checkpointWorkspace(`${name}-A`, {
          "evidence.txt": "Initial A\n",
        });
        const workspaceB = yield* checkpointWorkspace(`${name}-B`, {
          "evidence.txt": "Initial B\n",
        });
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: name }),
          (path) => fs.remove(path, { recursive: true }).pipe(Effect.orDie),
        );
        const databaseLayer = makeSqlitePersistenceLive(`${profile}/state.sqlite`).pipe(
          Layer.provide(NodeServices.layer),
        );
        const policyLayer = RuntimePolicy.layerFromProjectStore.pipe(
          Layer.provide(
            Layer.mergeAll(
              ProjectStore.layer.pipe(Layer.provide(databaseLayer)),
              Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
                getInstance: () => Effect.succeed(undefined),
              }),
            ),
          ),
          Layer.orDie,
        );
        const serverConfigLayer = Layer.succeed(ServerConfig, yield* makeReplayServerConfig(name));
        const options = {
          cwd: workspaceA,
          databaseLayer,
          serverConfigLayer,
          runtimePolicyLayer: policyLayer,
          holdCheckpointCapture: true,
          runEffectWorker: false,
        };
        const threadId = ThreadId.make(`thread:${name}`);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (cwd: string, args: ReadonlyArray<string>) =>
          spawner.string(ChildProcess.make("git", args, { cwd }));
        const snapshotB = Effect.gen(function* () {
          return {
            refs: yield* git(workspaceB, ["for-each-ref"]),
            objects: yield* git(workspaceB, ["count-objects", "-v"]),
            index: Array.from(yield* fs.readFile(`${workspaceB}/.git/index`)),
            files: yield* git(workspaceB, ["ls-files", "--others", "--exclude-standard"]),
            text: yield* fs.readFileString(`${workspaceB}/evidence.txt`),
          };
        });
        const untouchedB = yield* snapshotB;
        const finished = yield* withNativeQueue(
          name,
          ({
            orchestrator,
            takeOffer,
            offers,
            waitFor,
            beforeOffer,
            captureEntered,
            releaseCapture,
          }) =>
            Effect.gen(function* () {
              const sink = yield* EventSinkV2;
              const worker = yield* OrchestrationEffectWorkerV2;
              const store = yield* CheckpointStore;
              const checkpoints = yield* CheckpointServiceV2;
              const outbox = yield* EffectOutboxV2;
              const receipts = yield* CommandReceiptStoreV2;
              const trace = nativeSettlementTrace(threadId, { orchestrator, outbox, receipts });
              return yield* Effect.gen(function* () {
                const projectId = ProjectId.make(`project:${name}`);
                const now = yield* DateTime.now;
                yield* sink.commitProjectCommand({
                  commandId: CommandId.make(`${name}:project-create`),
                  projectId,
                  commandType: "project.created",
                  acceptedAt: now,
                  event: {
                    eventId: EventId.make(`${name}:project-create`),
                    aggregateKind: "project",
                    aggregateId: projectId,
                    occurredAt: DateTime.formatIso(now),
                    commandId: null,
                    causationEventId: null,
                    correlationId: null,
                    metadata: {},
                    type: "project.created",
                    payload: {
                      projectId,
                      title: name,
                      workspaceRoot: workspaceA,
                      defaultModelSelection: modelSelection,
                      scripts: [],
                      createdAt: DateTime.formatIso(now),
                      updatedAt: DateTime.formatIso(now),
                    },
                  },
                });
                let relocation = 0;
                const relocate = (workspaceRoot: string) =>
                  sink.commitProjectCommand({
                    commandId: CommandId.make(`${name}:relocate:${++relocation}`),
                    projectId,
                    commandType: "project.meta-updated",
                    acceptedAt: now,
                    event: {
                      eventId: EventId.make(`${name}:relocate:${relocation}`),
                      aggregateKind: "project",
                      aggregateId: projectId,
                      occurredAt: DateTime.formatIso(now),
                      commandId: null,
                      causationEventId: null,
                      correlationId: null,
                      metadata: {},
                      type: "project.meta-updated",
                      payload: { projectId, workspaceRoot, updatedAt: DateTime.formatIso(now) },
                    },
                  });
                trace.admissionCommands.push(CommandId.make(`${threadId}:send:write in A`));
                yield* send(orchestrator, threadId, "write in A");
                yield* trace.drain("initial-A-start-drain", 12, worker.drain(12));
                const first = yield* trace.at("initial-A-offer", takeOffer);
                assert.equal(first.input.runtimePolicy.cwd, workspaceA);
                const active = yield* trace.at(
                  "initial-A-running",
                  waitFor((p) => p.runs[0]?.status === "running"),
                );
                const scopeA = active.checkpointScopes.find(
                  (scope) =>
                    scope.id ===
                    active.nodes.find((node) => node.id === first.input.rootNodeId)
                      ?.checkpointScopeId,
                )!;
                assert.equal(scopeA.cwd, workspaceA);
                const baselineA = yield* checkpointRefForScopeOrdinal({
                  scopeId: scopeA.id,
                  ordinalWithinScope: 0,
                });
                assert.isTrue(
                  yield* store.hasCheckpointRef({ cwd: workspaceA, checkpointRef: baselineA }),
                );
                // A remains live and writes to its captured workspace while future admission uses B.
                yield* first.answer("Exact native A answer");
                yield* fs.writeFileString(`${workspaceA}/evidence.txt`, "Native A output\n");
                yield* relocate(workspaceB);
                trace.admissionCommands.push(CommandId.make(`${threadId}:send:write in B`));
                yield* send(orchestrator, threadId, "write in B", true);
                const admitted = yield* orchestrator.getThreadProjection(threadId);
                const queuedB = admitted.runs.find((run) => run.status === "queued")!;
                const scopeB = admitted.checkpointScopes.find(
                  (scope) =>
                    scope.id ===
                    admitted.nodes.find((node) => node.id === queuedB.rootNodeId)
                      ?.checkpointScopeId,
                )!;
                assert.notEqual(scopeA.id, scopeB.id);
                assert.equal(scopeB.cwd, workspaceB);
                assert.deepEqual(
                  admitted.checkpointScopes.find((scope) => scope.id === scopeA.id),
                  scopeA,
                );
                assert.equal(
                  admitted.nodes.find((node) => node.id === first.input.rootNodeId)
                    ?.checkpointScopeId,
                  scopeA.id,
                );
                assert.equal(admitted.runs[0]?.status, "running");
                assert.deepEqual(yield* snapshotB, untouchedB);
                assert.lengthOf(offers, 1);
                yield* first.settle("completed");
                yield* trace.at(
                  "initial-A-waiting",
                  waitFor((p) => p.runs[0]?.status === "waiting"),
                );
                yield* trace.capture("A-checkpoint-before-drain", { offers });
                const draining = yield* trace
                  .drain("A-checkpoint-drain", 12, worker.drain(12))
                  .pipe(Effect.forkScoped);
                yield* trace.at(
                  "A-checkpoint-capture-entered",
                  captureEntered.pipe(Effect.timeout("15 seconds")),
                );
                const parked = yield* orchestrator.getThreadProjection(threadId);
                assert.equal(
                  parked.messages.find(
                    (message) =>
                      message.runId === first.input.runId && message.role === "assistant",
                  )?.text,
                  "Exact native A answer",
                );
                assert.isNull(parked.runs[0]!.checkpointId);
                assert.lengthOf(offers, 1);
                assert.deepEqual(yield* snapshotB, untouchedB);
                beforeOffer((input) =>
                  Effect.gen(function* () {
                    if (input.runId !== queuedB.id) return;
                    const boundary = yield* orchestrator.getThreadProjection(threadId);
                    const prior = boundary.runs.find((run) => run.id === first.input.runId)!;
                    const checkpoint = boundary.checkpoints.find(
                      (row) => row.id === prior.checkpointId,
                    )!;
                    assert.equal(prior.status, "completed");
                    assert.equal(checkpoint.status, "ready");
                    assert.equal(checkpoint.scopeId, scopeA.id);
                    assert.equal(
                      boundary.messages.find(
                        (message) => message.runId === prior.id && message.role === "assistant",
                      )?.text,
                      "Exact native A answer",
                    );
                    assert.equal(
                      yield* git(workspaceA, ["show", `${checkpoint.ref}:evidence.txt`]),
                      "Native A output\n",
                    );
                    assert.isFalse(
                      yield* store.hasCheckpointRef({
                        cwd: workspaceB,
                        checkpointRef: checkpoint.ref,
                      }),
                    );
                  }).pipe(Effect.orDie),
                );
                yield* releaseCapture;
                yield* trace.at("A-checkpoint-drain-join", Fiber.join(draining));
                yield* trace.capture("A-checkpoint-after-drain", { offers });
                // The terminal reactor commits the successor after checkpoint execution.
                // With the daemon disabled, wait for that admission before claiming its work.
                yield* trace.at(
                  "B-start-committed",
                  waitFor((p) =>
                    p.runs.some(
                      (run) =>
                        run.id === queuedB.id &&
                        (run.status === "starting" || run.status === "running"),
                    ),
                  ),
                );
                yield* trace.drain("B-start-drain", 12, worker.drain(12));
                const second = yield* trace.at("B-offer", takeOffer);
                assert.equal(second.input.runId, queuedB.id);
                assert.equal(second.input.runtimePolicy.cwd, workspaceB);
                assert.lengthOf(offers, 2);
                const startedB = yield* orchestrator.getThreadProjection(threadId);
                const checkpointA = startedB.checkpoints.find(
                  (row) => row.id === startedB.runs[0]!.checkpointId,
                )!;
                assert.include(
                  yield* store.diffCheckpoints({
                    cwd: workspaceA,
                    fromCheckpointRef: baselineA,
                    toCheckpointRef: checkpointA.ref,
                    fallbackFromToHead: false,
                    ignoreWhitespace: false,
                    format: "patch",
                  }),
                  "+Native A output",
                );
                const baselineB = yield* checkpointRefForScopeOrdinal({
                  scopeId: scopeB.id,
                  ordinalWithinScope: 1,
                });
                assert.equal(
                  yield* git(workspaceB, ["show", `${baselineB}:evidence.txt`]),
                  "Initial B\n",
                );
                yield* fs.writeFileString(`${workspaceB}/evidence.txt`, "Native B output\n");
                yield* second.answer("Exact native B answer");
                yield* relocate(workspaceA);
                trace.admissionCommands.push(CommandId.make(`${threadId}:send:return to A`));
                yield* send(orchestrator, threadId, "return to A", true);
                const returnQueued = yield* orchestrator.getThreadProjection(threadId);
                const thirdRun = returnQueued.runs.find((run) => run.ordinal === 3)!;
                assert.equal(
                  returnQueued.nodes.find((node) => node.id === thirdRun.rootNodeId)
                    ?.checkpointScopeId,
                  scopeA.id,
                );
                const retainedRefsA = yield* git(workspaceA, ["for-each-ref"]);
                yield* second.settle("completed");
                yield* trace.at(
                  "B-waiting",
                  waitFor(
                    (p) =>
                      p.runs.find((run) => run.id === second.input.runId)?.status === "waiting",
                  ),
                );
                yield* trace.capture("B-checkpoint-before-drain", { offers });
                yield* trace.drain("B-checkpoint-drain", 12, worker.drain(12));
                yield* trace.capture("B-checkpoint-after-drain", { offers });
                yield* trace.at(
                  "return-A-start-committed",
                  waitFor((p) =>
                    p.runs.some(
                      (run) =>
                        run.id === thirdRun.id &&
                        (run.status === "starting" || run.status === "running"),
                    ),
                  ),
                );
                yield* trace.drain("return-A-start-drain", 12, worker.drain(12));
                const third = yield* trace.at("return-A-offer", takeOffer);
                assert.equal(third.input.runId, thirdRun.id);
                assert.equal(third.input.runtimePolicy.cwd, workspaceA);
                const beforeThird = yield* orchestrator.getThreadProjection(threadId);
                const checkpointB = beforeThird.checkpoints.find(
                  (row) =>
                    row.id ===
                    beforeThird.runs.find((run) => run.id === second.input.runId)!.checkpointId,
                )!;
                assert.equal(checkpointB.scopeId, scopeB.id);
                assert.equal(
                  yield* git(workspaceB, ["show", `${checkpointB.ref}:evidence.txt`]),
                  "Native B output\n",
                );
                assert.include(yield* git(workspaceA, ["for-each-ref"]), retainedRefsA.trim());
                yield* fs.writeFileString(
                  `${workspaceA}/evidence.txt`,
                  "Returned native A output\n",
                );
                yield* third.answer("Exact returned A answer");
                yield* third.settle("completed");
                yield* trace.at(
                  "returned-A-waiting",
                  waitFor(
                    (p) => p.runs.find((run) => run.id === third.input.runId)?.status === "waiting",
                  ),
                );
                yield* trace.capture("returned-A-checkpoint-before-drain", { offers });
                yield* trace.drain("returned-A-checkpoint-drain", 12, worker.drain(12));
                yield* trace.capture("returned-A-checkpoint-after-drain", { offers });
                const completed = yield* trace.at(
                  "final-runs-completed",
                  waitFor((p) => p.runs.every((run) => run.status === "completed")),
                );
                const checkpointReturnA = completed.checkpoints.find(
                  (row) =>
                    row.id ===
                    completed.runs.find((run) => run.id === third.input.runId)!.checkpointId,
                )!;
                const returnParent = completed.checkpoints.find(
                  (row) => row.id === checkpointReturnA.parentCheckpointId,
                )!;
                assert.equal(checkpointReturnA.scopeId, scopeA.id);
                assert.equal(returnParent.scopeId, scopeA.id);
                assert.notEqual(returnParent.id, checkpointB.id);
                assert.equal(returnParent.status, "ready");
                assert.deepEqual(
                  completed.runs.map((run) => run.ordinal),
                  [1, 2, 3],
                );
                assert.lengthOf(offers, 3);
                // Future project authority is B, but restoring a captured A boundary must use A.
                yield* relocate(workspaceB);
                const capturedB = yield* snapshotB;
                yield* checkpoints.restore({ scope: scopeA, checkpoint: checkpointA });
                assert.equal(
                  yield* fs.readFileString(`${workspaceA}/evidence.txt`),
                  "Native A output\n",
                );
                assert.deepEqual(yield* snapshotB, capturedB);
                const sequence = yield* orchestrator.getThreadEventSequence(threadId);
                const beforeConflict = yield* orchestrator.getThreadProjection(threadId);
                const refsA = yield* git(workspaceA, ["for-each-ref"]);
                const rejected = yield* Effect.result(
                  sink.commitCommand({
                    commandId: CommandId.make(`${name}:corrupt-root`),
                    threadId,
                    commandType: "checkpoint-scope.created",
                    acceptedAt: now,
                    effects: [],
                    events: [
                      {
                        id: EventId.make(`${name}:corrupt-root`),
                        type: "checkpoint-scope.created",
                        threadId,
                        occurredAt: now,
                        payload: { ...scopeA, cwd: workspaceB },
                      },
                    ],
                  }),
                );
                assert.equal(rejected._tag, "Failure");
                assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
                assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), beforeConflict);
                assert.equal(yield* git(workspaceA, ["for-each-ref"]), refsA);
                assert.deepEqual(yield* snapshotB, capturedB);
                // Historical reader fixture: produce a real old-format ref without changing any
                // run's new scope or inventing a run completion/baseline receipt.
                const legacyId = yield* (yield* IdAllocatorV2).allocate.checkpointScope({
                  threadId,
                  name: "root",
                });
                const legacyScope = { ...scopeA, id: legacyId, runId: null };
                const legacyCheckpoint = yield* checkpoints.capture({
                  scope: legacyScope,
                  runId: null,
                  nodeId: first.input.rootNodeId,
                  ordinalWithinScope: 0,
                  appRunOrdinal: null,
                  capturedAt: now,
                });
                assert.equal(legacyCheckpoint.status, "ready");
                yield* sink.write({
                  events: [
                    ...[legacyScope, { ...legacyScope, cwd: workspaceB }, legacyScope].map(
                      (payload, index) => ({
                        id: EventId.make(`${name}:legacy-scope:${index}`),
                        type: "checkpoint-scope.created" as const,
                        threadId,
                        occurredAt: now,
                        payload,
                      }),
                    ),
                    {
                      id: EventId.make(`${name}:legacy-checkpoint`),
                      type: "checkpoint.captured",
                      threadId,
                      occurredAt: now,
                      payload: legacyCheckpoint,
                    },
                  ],
                });
                assert.deepEqual(yield* snapshotB, capturedB);
                yield* (yield* ProviderSessionManagerV2).closeInstance(instanceId);
                yield* trace.at(
                  "sessions-stopped-before-reopen",
                  waitFor((projection) =>
                    projection.providerSessions.every((session) => session.status === "stopped"),
                  ),
                );
                yield* trace.capture("runtime-settled-before-reopen", { offers });
                return {
                  projection: yield* orchestrator.getThreadProjection(threadId),
                  checkpointA,
                  checkpointB,
                  checkpointReturnA,
                  scopeA,
                  scopeB,
                  legacyScope,
                  legacyCheckpoint,
                };
              }).pipe(Effect.onError((cause) => trace.failure(cause, { offers })));
            }).pipe(Effect.ensuring(releaseCapture)),
          options,
        );
        // All worker/manager/database scopes are closed before the file-backed store reopens.
        reopenPhase = "reopen-projection";
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            assert.deepEqual(yield* projections.getThreadProjection(threadId), finished.projection);
            const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
            reopenPhase = "reopen-rebuild";
            assert.isTrue((yield* maintenance.rebuild).valid);
            reopenPhase = "reopen-Git-and-projection-assertions";
            assert.deepEqual(yield* projections.getThreadProjection(threadId), finished.projection);
            assert.equal(
              yield* git(workspaceA, ["show", `${finished.checkpointA.ref}:evidence.txt`]),
              "Native A output\n",
            );
            assert.equal(
              yield* git(workspaceB, ["show", `${finished.checkpointB.ref}:evidence.txt`]),
              "Native B output\n",
            );
            assert.equal(
              yield* git(workspaceA, ["show", `${finished.checkpointReturnA.ref}:evidence.txt`]),
              "Returned native A output\n",
            );
            assert.equal(
              yield* git(workspaceA, ["show", `${finished.legacyCheckpoint.ref}:evidence.txt`]),
              "Native A output\n",
            );
            const replayed = yield* projections.getThreadProjection(threadId);
            assert.deepEqual(
              replayed.checkpointScopes.find((scope) => scope.id === finished.legacyScope.id),
              finished.legacyScope,
            );
            assert.deepEqual(
              replayed.checkpoints.find(
                (checkpoint) => checkpoint.id === finished.legacyCheckpoint.id,
              ),
              finished.legacyCheckpoint,
            );
          }).pipe(
            Effect.onError((cause) =>
              Effect.gen(function* () {
                const projections = yield* ProjectionStore.ProjectionStoreV2;
                const sql = yield* SqlClient.SqlClient;
                yield* Effect.log("NATIVE_SETTLEMENT_REOPEN_FAILURE", {
                  lastWait: reopenPhase,
                  cause,
                  projection: yield* projections.getThreadProjection(threadId),
                  outbox:
                    yield* sql`SELECT effect_id, command_id, status, payload_json FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId} ORDER BY effect_id`,
                });
              }).pipe(
                Effect.timeout("2 seconds"),
                Effect.catchCause((observerCause) =>
                  Effect.logWarning("Native reopen observer failed", {
                    lastWait: reopenPhase,
                    cause,
                    observerCause,
                  }),
                ),
              ),
            ),
            Effect.provide(
              ProjectionMaintenance.layer.pipe(
                Layer.provideMerge(
                  Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
                    Layer.provideMerge(databaseLayer),
                  ),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.live(
  "reads actual ready workspace baselines and adjacent A-B-A ranges after reopen and rebuild",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "workspace-query-A-B-A";
        const workspaceA = yield* checkpointWorkspace(`${name}-A`, {
          "evidence.txt": "Initial A\n",
        });
        const workspaceB = yield* checkpointWorkspace(`${name}-B`, {
          "evidence.txt": "Initial B\n",
        });
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: name }),
          (path) => fs.remove(path, { recursive: true }).pipe(Effect.orDie),
        );
        const databaseLayer = makeSqlitePersistenceLive(`${profile}/state.sqlite`).pipe(
          Layer.provide(NodeServices.layer),
        );
        const serverConfigLayer = Layer.succeed(ServerConfig, yield* makeReplayServerConfig(name));
        const policyLayer = RuntimePolicy.layerFromProjectStore.pipe(
          Layer.provide(
            Layer.mergeAll(
              ProjectStore.layer.pipe(Layer.provide(databaseLayer)),
              Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
                getInstance: () => Effect.succeed(undefined),
              }),
            ),
          ),
          Layer.orDie,
        );
        const threadId = ThreadId.make(`thread:${name}`);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (cwd: string, args: ReadonlyArray<string>) =>
          spawner.string(ChildProcess.make("git", args, { cwd }));
        const snapshotB = Effect.gen(function* () {
          return {
            refs: yield* git(workspaceB, ["for-each-ref"]),
            objects: yield* git(workspaceB, ["count-objects", "-v"]),
            index: Array.from(yield* fs.readFile(`${workspaceB}/.git/index`)),
            text: yield* fs.readFileString(`${workspaceB}/evidence.txt`),
          };
        });
        const verifyQueries = (
          ranges: ReadonlyArray<{
            from: number;
            to: number;
            cwd: string;
            fromRef: CheckpointRef;
            toRef: CheckpointRef;
            added: string;
            removed: string;
          }>,
        ) =>
          Effect.gen(function* () {
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            const realStore = yield* CheckpointStore;
            const refsA = yield* git(workspaceA, ["for-each-ref"]);
            const beforeB = yield* snapshotB;
            const beforeA = yield* fs.readFileString(`${workspaceA}/evidence.txt`);
            for (const reversed of [false, true]) {
              const calls: Array<Parameters<typeof realStore.diffCheckpoints>[0]> = [];
              const query = yield* CheckpointDiffQuery.make.pipe(
                Effect.provide(
                  Layer.mergeAll(
                    Layer.mock(ThreadManagement.ThreadManagementService)({
                      getCheckpointContext: () =>
                        projections.getCheckpointContext(threadId).pipe(
                          Effect.map((context) => ({
                            ...context,
                            checkpointScopes: reversed
                              ? context.checkpointScopes.toReversed()
                              : context.checkpointScopes,
                          })),
                          Effect.mapError(
                            (cause) => new OrchestratorProjectionError({ threadId, cause }),
                          ),
                        ),
                    }),
                    Layer.succeed(CheckpointStore, {
                      ...realStore,
                      diffCheckpoints: (input) => {
                        calls.push(input);
                        const range = ranges[calls.length - 1]!;
                        assert.equal(input.cwd, range.cwd);
                        assert.equal(input.fromCheckpointRef, range.fromRef);
                        assert.equal(input.toCheckpointRef, range.toRef);
                        assert.isFalse(input.fallbackFromToHead);
                        return realStore.diffCheckpoints(input);
                      },
                    }),
                  ),
                ),
              );
              for (const range of ranges) {
                const result =
                  range.from === 0
                    ? yield* query.getFullThreadDiff({
                        threadId,
                        toTurnCount: range.to,
                        ignoreWhitespace: false,
                      })
                    : yield* query.getTurnDiff({
                        threadId,
                        fromTurnCount: range.from,
                        toTurnCount: range.to,
                        ignoreWhitespace: false,
                      });
                assert.include(result.diff, `+${range.added}`);
                assert.include(result.diff, `-${range.removed}`);
                assert.notInclude(result.diff, "Uncaptured query distraction");
              }
              assert.lengthOf(calls, ranges.length);
            }
            assert.equal(yield* git(workspaceA, ["for-each-ref"]), refsA);
            assert.equal(yield* fs.readFileString(`${workspaceA}/evidence.txt`), beforeA);
            assert.deepEqual(yield* snapshotB, beforeB);
          });
        const finished = yield* withNativeQueue(
          name,
          ({ orchestrator, takeOffer, waitFor, offers }) =>
            Effect.gen(function* () {
              const sink = yield* EventSinkV2;
              const worker = yield* OrchestrationEffectWorkerV2;
              const now = yield* DateTime.now;
              const projectId = ProjectId.make(`project:${name}`);
              yield* sink.commitProjectCommand({
                commandId: CommandId.make(`${name}:project`),
                projectId,
                commandType: "project.created",
                acceptedAt: now,
                event: {
                  eventId: EventId.make(`${name}:project`),
                  aggregateKind: "project",
                  aggregateId: projectId,
                  occurredAt: DateTime.formatIso(now),
                  commandId: null,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  type: "project.created",
                  payload: {
                    projectId,
                    title: name,
                    workspaceRoot: workspaceA,
                    defaultModelSelection: modelSelection,
                    scripts: [],
                    createdAt: DateTime.formatIso(now),
                    updatedAt: DateTime.formatIso(now),
                  },
                },
              });
              const relocate = (cwd: string, suffix: string) =>
                sink.commitProjectCommand({
                  commandId: CommandId.make(`${name}:${suffix}`),
                  projectId,
                  commandType: "project.meta-updated",
                  acceptedAt: now,
                  event: {
                    eventId: EventId.make(`${name}:${suffix}`),
                    aggregateKind: "project",
                    aggregateId: projectId,
                    occurredAt: DateTime.formatIso(now),
                    commandId: null,
                    causationEventId: null,
                    correlationId: null,
                    metadata: {},
                    type: "project.meta-updated",
                    payload: { projectId, workspaceRoot: cwd, updatedAt: DateTime.formatIso(now) },
                  },
                });
              const complete = Effect.fnUntraced(function* (
                text: string,
                cwd: string,
                output: string,
              ) {
                yield* send(orchestrator, threadId, text);
                yield* worker.drain(12);
                const offer = yield* takeOffer;
                assert.equal(offer.input.runtimePolicy.cwd, cwd);
                yield* fs.writeFileString(`${cwd}/evidence.txt`, `${output}\n`);
                yield* offer.answer(`${output} answer`);
                yield* offer.settle("completed");
                yield* waitFor(
                  (p) => p.runs.find((run) => run.id === offer.input.runId)?.status === "waiting",
                );
                yield* worker.drain(12);
                const projection = yield* waitFor(
                  (p) => p.runs.find((run) => run.id === offer.input.runId)?.status === "completed",
                );
                const checkpoint = projection.checkpoints.find(
                  (row) =>
                    row.id ===
                    projection.runs.find((run) => run.id === offer.input.runId)!.checkpointId,
                )!;
                assert.equal(checkpoint.status, "ready");
                return checkpoint;
              });
              const checkpointA = yield* complete("first A", workspaceA, "Native A output");
              const untouchedB = yield* snapshotB;
              yield* relocate(workspaceB, "B");
              assert.deepEqual(yield* snapshotB, untouchedB);
              const checkpointB = yield* complete("first B", workspaceB, "Native B output");
              yield* relocate(workspaceA, "return-A");
              const checkpointReturnA = yield* complete(
                "return A",
                workspaceA,
                "Returned native A output",
              );
              const projection = yield* orchestrator.getThreadProjection(threadId);
              const baselineA = projection.checkpoints.find(
                (row) => row.scopeId === checkpointA.scopeId && row.ordinalWithinScope === 0,
              )!;
              const baselineB = projection.checkpoints.find(
                (row) => row.scopeId === checkpointB.scopeId && row.ordinalWithinScope === 1,
              )!;
              const returnBaselineA = projection.checkpoints.find(
                (row) => row.id === checkpointReturnA.parentCheckpointId,
              )!;
              assert.equal(baselineA.status, "ready");
              assert.equal(baselineB.status, "ready");
              assert.equal(returnBaselineA.scopeId, checkpointA.scopeId);
              assert.equal(returnBaselineA.status, "ready");
              assert.equal(
                projection.checkpoints.find(
                  (row) => row.scopeId === checkpointB.scopeId && row.ordinalWithinScope === 0,
                )?.status,
                "missing",
              );
              assert.notEqual(checkpointA.scopeId, checkpointB.scopeId);
              assert.equal(checkpointReturnA.scopeId, checkpointA.scopeId);
              const ranges = [
                {
                  from: 0,
                  to: 1,
                  cwd: workspaceA,
                  fromRef: baselineA.ref,
                  toRef: checkpointA.ref,
                  added: "Native A output",
                  removed: "Initial A",
                },
                {
                  from: 0,
                  to: 2,
                  cwd: workspaceB,
                  fromRef: baselineB.ref,
                  toRef: checkpointB.ref,
                  added: "Native B output",
                  removed: "Initial B",
                },
                {
                  from: 0,
                  to: 3,
                  cwd: workspaceA,
                  fromRef: baselineA.ref,
                  toRef: checkpointReturnA.ref,
                  added: "Returned native A output",
                  removed: "Initial A",
                },
                {
                  from: 1,
                  to: 2,
                  cwd: workspaceB,
                  fromRef: baselineB.ref,
                  toRef: checkpointB.ref,
                  added: "Native B output",
                  removed: "Initial B",
                },
                {
                  from: 2,
                  to: 3,
                  cwd: workspaceA,
                  fromRef: returnBaselineA.ref,
                  toRef: checkpointReturnA.ref,
                  added: "Returned native A output",
                  removed: "Native A output",
                },
                {
                  from: 1,
                  to: 3,
                  cwd: workspaceA,
                  fromRef: checkpointA.ref,
                  toRef: checkpointReturnA.ref,
                  added: "Returned native A output",
                  removed: "Native A output",
                },
              ];
              yield* relocate(workspaceB, "future-B");
              yield* fs.writeFileString(
                `${workspaceA}/evidence.txt`,
                "Uncaptured query distraction A\n",
              );
              yield* fs.writeFileString(
                `${workspaceB}/evidence.txt`,
                "Uncaptured query distraction B\n",
              );
              yield* verifyQueries(ranges);
              assert.lengthOf(offers, 3);
              yield* (yield* ProviderSessionManagerV2).closeInstance(instanceId);
              yield* waitFor((p) => p.providerSessions.every((row) => row.status === "stopped"));
              return {
                ranges,
                projection: yield* orchestrator.getThreadProjection(threadId),
                baselineB,
              };
            }),
          {
            cwd: workspaceA,
            databaseLayer,
            serverConfigLayer,
            runtimePolicyLayer: policyLayer,
            runEffectWorker: false,
          },
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            assert.deepEqual(yield* projections.getThreadProjection(threadId), finished.projection);
            yield* verifyQueries(finished.ranges);
            assert.isTrue(
              (yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid,
            );
            assert.deepEqual(yield* projections.getThreadProjection(threadId), finished.projection);
            yield* verifyQueries(finished.ranges);
            const realStore = yield* CheckpointStore;
            const query = yield* CheckpointDiffQuery.make.pipe(
              Effect.provide(
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  getCheckpointContext: () =>
                    projections
                      .getCheckpointContext(threadId)
                      .pipe(
                        Effect.mapError(
                          (cause) => new OrchestratorProjectionError({ threadId, cause }),
                        ),
                      ),
                }),
              ),
            );
            const originalOid = (yield* git(workspaceB, [
              "rev-parse",
              finished.baselineB.ref,
            ])).trim();
            yield* git(workspaceB, ["update-ref", "-d", finished.baselineB.ref]);
            const missing = yield* query
              .getFullThreadDiff({ threadId, toTurnCount: 2 })
              .pipe(Effect.flip);
            assert.instanceOf(missing, CheckpointRefUnavailableError);
            assert.equal(missing.checkpoint, "from");
            yield* git(workspaceB, ["update-ref", finished.baselineB.ref, originalOid]);
            assert.isTrue(
              yield* realStore.hasCheckpointRef({
                cwd: workspaceB,
                checkpointRef: finished.baselineB.ref,
              }),
            );
            yield* verifyQueries(finished.ranges);
          }).pipe(
            Effect.provide(
              ProjectionMaintenance.layer.pipe(
                Layer.provideMerge(
                  Layer.mergeAll(
                    ProjectionStore.layer,
                    EventStore.layer,
                    checkpointStoreLayer.pipe(
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(
                          Layer.provide(Layer.mergeAll(VcsProcess.layer, serverConfigLayer)),
                          Layer.provide(NodeServices.layer),
                        ),
                      ),
                    ),
                  ).pipe(Layer.provideMerge(databaseLayer)),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
