import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ProviderRuntimePolicy,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProviderInstances from "../provider/Services/ProviderInstanceRegistry.ts";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  OrchestratorV2,
  OrchestratorProviderWorkDeferredError,
  type OrchestratorV2Error,
} from "./Orchestrator.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { checkpointRefForScopeOrdinal } from "./CheckpointService.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  ProviderContinuationRequests,
  type ProviderContinuationRequest,
} from "./ProviderContinuationRequests.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import { makeLayerEffect } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("pi");
const instanceId = ProviderInstanceId.make("pi-initiated-fixture");
const selection = { instanceId, model: "fixture-model" };
const threadId = ThreadId.make("thread:provider-initiated");
const projectId = ProjectId.make("project:provider-initiated");

// Ordinary prompts include the complete empty Scient scope on the native wire.
// Keep exact text and prompt-count assertions while native work adds no prompt.
const expectedNativePrompt = (text: string) =>
  `${text}\n\n[Scient skill scope for this turn is complete and empty (0 skills). No Scient-managed skills are available in this scope; no \`scient_skills_list\` call is needed. Provider-native skills are separate.]`;

type WorkOverrides = Omit<Partial<ProviderContinuationRequest>, "initiated"> & {
  initiated?: Partial<NonNullable<ProviderContinuationRequest["initiated"]>>;
};

type Offer = { input: ProviderAdapterV2TurnInput; finish: Effect.Effect<void> };
const withInitiatedWork = <A, E, R>(
  run: (h: {
    orchestrator: OrchestratorV2["Service"];
    workspaceA: string;
    workspaceB: string;
    relocateProject: (cwd: string) => Effect.Effect<void, ProjectStore.ProjectStoreV2Error>;
    emitWork: (workId: string, overrides?: WorkOverrides) => Effect.Effect<void>;
    clearStoppedWork: (workId: string) => Effect.Effect<void>;
    takeOffer: Effect.Effect<Offer, Cause.TimeoutError>;
    prompts: ReadonlyArray<string>;
    adopted: ReadonlyArray<string>;
    dropped: () => number;
    closes: () => number;
    loads: () => number;
    markNativeRunning: Effect.Effect<void>;
    captureEntered: Effect.Effect<void>;
    releaseCapture: Effect.Effect<void>;
    resolvePolicy: Effect.Effect<
      Option.Option<Pick<OrchestrationV2ProviderRuntimePolicy, "runtimeMode" | "interactionMode">>
    >;
    waitFor: (
      predicate: (p: OrchestrationV2ThreadProjection) => boolean,
    ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  }) => Effect.Effect<A, E, R>,
  options: {
    manualWorker?: boolean;
    restricted?: boolean;
    unknownNativeCwd?: boolean;
    holdCaptureOrdinal?: number;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("provider-initiated-work", {
        "native-answer.txt": "Initial A\n",
      });
      const workspaceB = yield* checkpointWorkspace("provider-initiated-other", {
        "native-answer.txt": "Initial B\n",
      });
      const fs = yield* FileSystem.FileSystem;
      const captureEntered = yield* Deferred.make<void>();
      const captureReleased = yield* Deferred.make<void>();
      const profile = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "initiated-gate" }),
        (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.orDie),
      );
      const database =
        options.holdCaptureOrdinal === undefined
          ? SqlitePersistenceMemory
          : makeSqlitePersistenceLive(`${profile}/state.sqlite`).pipe(
              Layer.provide(NodeServices.layer),
            );
      const projectsLayer = ProjectStore.layer.pipe(Layer.provide(database));
      const policyLayer = RuntimePolicy.layerFromProjectStore.pipe(
        Layer.provide(
          Layer.mergeAll(
            projectsLayer,
            Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed(undefined),
            }),
          ),
        ),
      );
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const offers = yield* Queue.unbounded<Offer>();
      const buffered = new Map<string, string>();
      const prompts: string[] = [];
      const adopted: string[] = [];
      let closed = 0;
      let dropped = 0;
      let loads = 0;
      let markNativeRunning: Effect.Effect<void> = Effect.die("Native session must be open");
      let emitWork: (workId: string, overrides?: WorkOverrides) => Effect.Effect<void> = () =>
        Effect.die("Native session must be open");
      const unused = () =>
        Effect.fail(
          new ProviderAdapterProtocolError({ driver, detail: "Unused initiated-work operation" }),
        );
      const registry = makeLayerEffect(
        Effect.gen(function* () {
          const continuations = yield* ProviderContinuationRequests;
          const adapter: ProviderAdapterV2Shape = {
            instanceId,
            driver,
            mcpSessionInjection: true,
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
            openSession: (input) =>
              Effect.gen(function* () {
                const now = yield* DateTime.now;
                let nativeThread = {
                  id: ProviderThreadId.make("native-provider-thread:initiated"),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: "native:pi-session-file",
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef: null,
                  status: "idle" as const,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                };
                const nativeSession = {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready" as const,
                  cwd,
                  model: selection.model,
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                };
                markNativeRunning = Effect.gen(function* () {
                  yield* Queue.offer(events, {
                    type: "provider_session.updated",
                    driver,
                    providerSession: {
                      ...nativeSession,
                      status: "running",
                      updatedAt: yield* DateTime.now,
                    },
                  });
                });
                let applied = {
                  modelSelection: input.modelSelection,
                  runtimePolicy: input.runtimePolicy,
                };
                emitWork = (workId, overrides = {}) =>
                  Effect.gen(function* () {
                    if (!adopted.includes(workId))
                      buffered.set(workId, `Unsolicited answer ${workId}`);
                    yield* continuations.offer({
                      threadId,
                      providerThreadId: nativeThread.id,
                      driver,
                      detail: `Extension work ${workId}`,
                      dispatchIfCurrent: (dispatch) => dispatch.pipe(Effect.asSome),
                      ...overrides,
                      initiated: {
                        providerInstanceId: instanceId,
                        providerSessionId: input.providerSessionId,
                        workId,
                        ...applied,
                        ...(options.unknownNativeCwd
                          ? { runtimePolicy: { ...applied.runtimePolicy, cwd: null } }
                          : {}),
                        ...overrides.initiated,
                      },
                      clearIfCurrent: () =>
                        Effect.sync(() => {
                          buffered.delete(workId);
                          dropped++;
                        }),
                    });
                  });
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    closed++;
                  }),
                );
                return {
                  instanceId,
                  driver,
                  providerSessionId: input.providerSessionId,
                  mcpSessionInjection: true,
                  providerSession: nativeSession,
                  events: Stream.fromQueue(events),
                  ensureThread: (thread) =>
                    Effect.sync(() => {
                      loads++;
                      nativeThread = {
                        ...nativeThread,
                        id: thread.existingProviderThread?.id ?? nativeThread.id,
                      };
                      return nativeThread;
                    }),
                  resumeThread: ({ providerThread }) =>
                    Effect.sync(() => {
                      loads++;
                      return providerThread;
                    }),
                  startTurn: (turn) =>
                    Effect.gen(function* () {
                      const source = turn.message.notification?.source;
                      let answer = "User answer";
                      if (source?.kind === "provider_work") {
                        const owned = buffered.get(source.workId);
                        if (owned === undefined) return yield* unused();
                        answer = owned;
                        buffered.delete(source.workId);
                        adopted.push(source.workId);
                        assert.deepEqual(turn.modelSelection, applied.modelSelection);
                        assert.deepEqual(turn.runtimePolicy, applied.runtimePolicy);
                      } else {
                        prompts.push(turn.message.text);
                        applied = {
                          modelSelection: turn.modelSelection,
                          runtimePolicy: turn.runtimePolicy,
                        };
                      }
                      const stamp = yield* DateTime.now;
                      const providerTurnId = ProviderTurnId.make(`native-turn:${turn.attemptId}`);
                      yield* Queue.offer(events, {
                        type: "provider_turn.updated",
                        driver,
                        providerTurn: {
                          id: providerTurnId,
                          providerThreadId: nativeThread.id,
                          nodeId: turn.rootNodeId,
                          runAttemptId: turn.attemptId,
                          nativeTurnRef: {
                            driver,
                            nativeId: `native:${turn.runOrdinal}`,
                            strength: "strong",
                          },
                          ordinal: turn.providerTurnOrdinal,
                          status: "running",
                          startedAt: stamp,
                          completedAt: null,
                        },
                      });
                      const finish = Effect.gen(function* () {
                        const completedAt = yield* DateTime.now;
                        yield* Queue.offer(events, {
                          type: "message.updated",
                          driver,
                          message: {
                            id: MessageId.make(`answer:${turn.runId}`),
                            threadId,
                            runId: turn.runId,
                            nodeId: turn.rootNodeId,
                            role: "assistant",
                            text: answer,
                            attachments: [],
                            streaming: false,
                            createdBy: "agent",
                            creationSource: "provider",
                            createdAt: completedAt,
                            updatedAt: completedAt,
                          },
                        });
                        yield* Queue.offer(events, {
                          type: "turn.terminal",
                          driver,
                          providerThreadId: nativeThread.id,
                          providerTurnId,
                          runOrdinal: turn.runOrdinal,
                          status: "completed",
                          failure: null,
                          threadDisposition: "reusable",
                        });
                      });
                      yield* Queue.offer(offers, { input: turn, finish });
                    }),
                  steerTurn: unused,
                  interruptTurn: unused,
                  respondToRuntimeRequest: unused,
                  readThreadSnapshot: unused,
                  rollbackThread: unused,
                  forkThread: unused,
                };
              }),
          };
          return [adapter];
        }),
      );
      const runtimePolicyLayer = policyLayer.pipe(Layer.orDie);
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "provider-initiated-work" },
        registry,
        {
          databaseLayer: database,
          runtimePolicyLayer,
          runContinuationWorker: true,
          configureMcp: true,
          runEffectWorker: !options.manualWorker,
          ...(options.holdCaptureOrdinal === undefined
            ? {}
            : {
                vcsProcessLayer: Layer.effect(
                  VcsProcess.VcsProcess,
                  Effect.gen(function* () {
                    const real = yield* VcsProcess.VcsProcess;
                    let held = false;
                    return VcsProcess.VcsProcess.of({
                      run: (input) =>
                        Effect.gen(function* () {
                          if (
                            !held &&
                            input.operation === VcsProcess.CHECKPOINT_CAPTURE_OPERATION &&
                            input.args.includes("fetch") &&
                            input.args.some((arg) =>
                              arg.endsWith(`/ordinal/${options.holdCaptureOrdinal}`),
                            )
                          ) {
                            held = true;
                            yield* Deferred.succeed(captureEntered, undefined);
                            yield* Deferred.await(captureReleased);
                          }
                          return yield* real.run(input);
                        }),
                    });
                  }),
                ).pipe(Layer.provide(VcsProcess.layer), Layer.provide(NodeServices.layer)),
              }),
        },
      );
      return yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const now = DateTime.formatIso(yield* DateTime.now);
        let projectSequence = 1;
        yield* projects.apply({
          sequence: projectSequence,
          eventId: EventId.make("initiated-project:1"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Native project",
            workspaceRoot: cwd,
            defaultModelSelection: selection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        const relocateProject = (workspaceRoot: string) =>
          projects.apply({
            sequence: ++projectSequence,
            eventId: EventId.make(`initiated-project:${projectSequence}`),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.meta-updated",
            payload: { projectId, workspaceRoot, updatedAt: now },
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:initiated"),
          threadId,
          projectId,
          title: "Native work",
          modelSelection: selection,
          runtimeMode: options.restricted ? "approval-required" : "full-access",
          interactionMode: options.restricted ? "plan" : "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const waitFor = (predicate: (p: OrchestrationV2ThreadProjection) => boolean) =>
          Effect.gen(function* () {
            for (let n = 0; n < 1000; n++) {
              const p = yield* orchestrator.getThreadProjection(threadId);
              if (predicate(p)) return p;
              yield* Effect.sleep("5 millis");
            }
            const last = yield* orchestrator.getThreadProjection(threadId);
            return yield* Effect.die(
              `Missing durable initiated-work receipt: runs ${last.runs.map((run) => `${run.ordinal}:${run.status}`).join(",")}; sessions ${last.providerSessions.map((session) => session.status).join(",")}; closes ${closed}`,
            );
          });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first:initiated"),
          threadId,
          messageId: MessageId.make("first-message:initiated"),
          text: "First user message",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const worker = yield* OrchestrationEffectWorkerV2;
        if (options.manualWorker) yield* worker.drain(12);
        const first = yield* Queue.take(offers).pipe(Effect.timeout("10 seconds"));
        yield* first.finish;
        if (options.manualWorker) {
          yield* waitFor((p) => p.runs[0]?.status === "waiting");
          yield* worker.drain(12);
        }
        yield* waitFor((p) => p.runs[0]?.status === "completed");
        return yield* run({
          orchestrator,
          workspaceA: cwd,
          workspaceB,
          relocateProject,
          emitWork: (id, override) => emitWork(id, override),
          clearStoppedWork: (workId) =>
            Effect.sync(() => {
              buffered.delete(workId);
              dropped++;
            }),
          takeOffer: Queue.take(offers).pipe(Effect.timeout("10 seconds")),
          prompts,
          adopted,
          closes: () => closed,
          loads: () => loads,
          markNativeRunning: Effect.suspend(() => markNativeRunning),
          captureEntered: Deferred.await(captureEntered).pipe(
            Effect.timeout("10 seconds"),
            Effect.orDie,
          ),
          releaseCapture: Deferred.succeed(captureReleased, undefined).pipe(Effect.asVoid),
          resolvePolicy: (yield* ProviderSessionManagerV2)
            .resolveMcpInvocationPolicy({
              threadId,
              providerInstanceId: instanceId,
              providerSessionId: `mcp-test:${threadId}`,
            })
            .pipe(Effect.orDie),
          dropped: () => dropped,
          waitFor,
        });
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(runtimePolicyLayer))));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

it.live(
  "admits unsolicited native work as its own turn without a user prompt or session teardown",
  () =>
    withInitiatedWork(({ orchestrator, emitWork, takeOffer, prompts, adopted, closes, waitFor }) =>
      Effect.gen(function* () {
        yield* emitWork("extension-work-1");
        const background = yield* takeOffer;
        assert.equal(background.input.message.createdBy, "agent");
        assert.equal(background.input.message.creationSource, "provider");
        assert.equal(background.input.message.notification?.source.kind, "provider_work");
        const source = background.input.message.notification!.source;
        assert.isTrue(source.kind === "provider_work" && source.workId === "extension-work-1");
        assert.deepEqual(prompts, [expectedNativePrompt("First user message")]);
        assert.deepEqual(adopted, ["extension-work-1"]);
        yield* background.finish;
        const settled = yield* waitFor(
          (p) => p.runs.length === 2 && p.runs[1]?.status === "completed",
        );
        const anchor = settled.messages.find((m) => m.id === background.input.message.messageId)!;
        assert.equal(anchor.role, "system");
        assert.equal(anchor.createdBy, "agent");
        assert.lengthOf(
          settled.messages.filter((m) => m.createdBy === "user"),
          1,
        );
        assert.equal(
          settled.messages.find((m) => m.runId === background.input.runId && m.role === "assistant")
            ?.text,
          "Unsolicited answer extension-work-1",
        );
        assert.isTrue(
          settled.turnItems.some(
            (item) => item.runId === background.input.runId && item.type === "notification",
          ),
        );
        assert.isFalse(
          settled.turnItems.some(
            (item) => item.runId === background.input.runId && item.type === "user_message",
          ),
        );
        assert.equal(closes(), 0);
        yield* emitWork("extension-work-1");
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("next:initiated"),
          threadId,
          messageId: MessageId.make("next-message:initiated"),
          text: "Next user message",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const next = yield* takeOffer;
        assert.equal(next.input.message.text, expectedNativePrompt("Next user message"));
        yield* next.finish;
        yield* waitFor((p) => p.runs.length === 3 && p.runs.every((r) => r.status === "completed"));
        assert.deepEqual(adopted, ["extension-work-1"]);
        assert.deepEqual(prompts, [
          expectedNativePrompt("First user message"),
          expectedNativePrompt("Next user message"),
        ]);
        assert.equal(closes(), 0);
      }),
    ),
);

it.live.each([
  "foreign-driver",
  "foreign-session",
  "foreign-thread",
  "stopped-generation",
  "archived",
  "busy",
] as const)("refuses premature unsolicited work without a current idle owner: %s", (scenario) =>
  withInitiatedWork(({ orchestrator, emitWork, takeOffer, dropped, adopted, prompts, waitFor }) =>
    Effect.gen(function* () {
      let active: Offer | undefined;
      if (scenario === "busy") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("busy:work"),
          threadId,
          messageId: MessageId.make("busy-message:work"),
          text: "Busy user message",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        active = yield* takeOffer;
      }
      if (scenario === "archived")
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive:initiated"),
          threadId,
        });
      const overrides: WorkOverrides =
        scenario === "foreign-driver"
          ? { driver: ProviderDriverKind.make("foreign") }
          : scenario === "foreign-thread"
            ? { providerThreadId: ProviderThreadId.make("foreign-native-thread") }
            : scenario === "foreign-session"
              ? {
                  initiated: {
                    providerInstanceId: instanceId,
                    providerSessionId: ProviderSessionId.make("foreign-session"),
                    workId: scenario,
                  },
                }
              : scenario === "stopped-generation"
                ? {
                    dispatchIfCurrent: () =>
                      Effect.sync(() => {
                        return Option.none();
                      }),
                  }
                : {};
      // A producer acknowledges the dropped generation explicitly; no arbitrary sleep
      // stands in for continuation processing.
      const observed = yield* Queue.unbounded<void>();
      const original = overrides.dispatchIfCurrent;
      yield* emitWork(scenario, {
        ...overrides,
        dispatchIfCurrent: (dispatch) =>
          (original === undefined ? dispatch.pipe(Effect.asSome) : original(dispatch)).pipe(
            Effect.ensuring(Queue.offer(observed, undefined)),
          ),
      });
      if (scenario !== "archived") yield* Queue.take(observed).pipe(Effect.timeout("10 seconds"));
      else yield* waitFor(() => dropped() === 1);
      assert.deepEqual(adopted, []);
      assert.deepEqual(
        prompts,
        scenario === "busy"
          ? [expectedNativePrompt("First user message"), expectedNativePrompt("Busy user message")]
          : [expectedNativePrompt("First user message")],
      );
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).runs,
        scenario === "busy" ? 2 : 1,
      );
      if (active !== undefined) yield* active.finish;
    }),
  ),
);

it.live(
  "adopts captured native settings after defaults change before offer and before execution",
  () =>
    withInitiatedWork(
      ({
        orchestrator,
        emitWork,
        takeOffer,
        prompts,
        adopted,
        closes,
        loads,
        resolvePolicy,
        markNativeRunning,
        waitFor,
        workspaceA,
        workspaceB,
        relocateProject,
      }) =>
        Effect.gen(function* () {
          const original = yield* orchestrator.getThreadProjection(threadId);
          const nativeOwner = original.providerThreads.find(
            (row) => row.id === original.thread.activeProviderThreadId,
          )!;
          const initialLoads = loads();
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const git = (cwd: string, args: ReadonlyArray<string>) =>
            spawner.string(ChildProcess.make("git", args, { cwd }));
          const otherRefs = yield* git(workspaceB, ["for-each-ref"]);
          const otherObjects = yield* git(workspaceB, ["count-objects", "-v"]);
          const otherIndex = yield* fs.readFile(`${workspaceB}/.git/index`);
          const nextSelection = { ...selection, model: "next-user-model" };
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("defaults:model"),
            threadId,
            modelSelection: nextSelection,
          });
          yield* orchestrator.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("defaults:interaction"),
            threadId,
            interactionMode: "default",
          });
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("defaults:runtime"),
            threadId,
            runtimeMode: "full-access",
          });
          yield* markNativeRunning;
          yield* waitFor((p) =>
            p.providerSessions.some(
              (row) => row.id === nativeOwner.providerSessionId && row.status === "running",
            ),
          );
          yield* relocateProject(workspaceB);
          assert.equal(
            (yield* (yield* RuntimePolicy.RuntimePolicyV2).resolve({
              thread: original.thread,
              modelSelection: selection,
            })).cwd,
            workspaceB,
          );
          yield* emitWork("captured-generation");
          const admitted = yield* waitFor((p) => p.runs.length === 2);
          const run = admitted.runs[1]!;
          assert.equal(run.status, "starting");
          const scope = admitted.checkpointScopes.find(
            (scope) =>
              scope.id ===
              admitted.nodes.find((node) => node.id === run.rootNodeId)?.checkpointScopeId,
          )!;
          assert.equal(scope.cwd, workspaceA);
          assert.equal(admitted.thread.worktreePath, null);
          assert.deepEqual(run.modelSelection, selection);
          assert.equal(run.runtimeMode, "approval-required");
          assert.equal(run.interactionMode, "plan");
          assert.equal(run.providerThreadId, nativeOwner.id);
          assert.deepEqual(admitted.thread.modelSelection, nextSelection);
          assert.equal(admitted.thread.runtimeMode, "full-access");
          assert.equal(admitted.thread.interactionMode, "default");
          const laterSelection = { ...selection, model: "later-user-model" };
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("defaults:later-model"),
            threadId,
            modelSelection: laterSelection,
          });
          // Relocate again while the durable start effect is parked; execution
          // must follow the captured scope even when current authority ends at B.
          yield* relocateProject(workspaceA);
          yield* relocateProject(workspaceB);
          yield* fs.writeFileString(
            `${workspaceA}/native-answer.txt`,
            "Captured native work in A\n",
          );
          const worker = yield* OrchestrationEffectWorkerV2;
          yield* worker.drain(12);
          const adoptedWork = yield* takeOffer;
          assert.deepEqual(adoptedWork.input.modelSelection, selection);
          assert.equal(adoptedWork.input.runtimePolicy.runtimeMode, "approval-required");
          assert.equal(adoptedWork.input.runtimePolicy.interactionMode, "plan");
          assert.equal(
            adoptedWork.input.runtimePolicy.cwd,
            original.providerSessions.find((row) => row.id === nativeOwner.providerSessionId)!.cwd,
          );
          assert.equal(adoptedWork.input.providerThread.id, nativeOwner.id);
          assert.equal(
            adoptedWork.input.providerThread.providerSessionId,
            nativeOwner.providerSessionId,
          );
          assert.deepEqual(
            yield* resolvePolicy,
            Option.some({ runtimeMode: "approval-required", interactionMode: "plan" }),
          );
          const executing = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(executing.thread.modelSelection, laterSelection);
          assert.deepEqual(prompts, [expectedNativePrompt("First user message")]);
          assert.deepEqual(adopted, ["captured-generation"]);
          assert.equal(loads(), initialLoads);
          assert.equal(closes(), 0);
          yield* adoptedWork.finish;
          yield* waitFor((p) => p.runs[1]?.status === "waiting");
          yield* worker.drain(12);
          const completed = yield* waitFor((p) => p.runs[1]?.status === "completed");
          const checkpoint = completed.checkpoints.find(
            (row) => row.id === completed.runs[1]!.checkpointId,
          )!;
          assert.equal(checkpoint.status, "ready");
          assert.equal(checkpoint.scopeId, scope.id);
          assert.equal(
            completed.checkpointScopes.find((row) => row.id === scope.id)!.cwd,
            workspaceA,
          );
          const store = yield* CheckpointStore;
          assert.isTrue(
            yield* store.hasCheckpointRef({ cwd: workspaceA, checkpointRef: checkpoint.ref }),
          );
          assert.isFalse(
            yield* store.hasCheckpointRef({ cwd: workspaceB, checkpointRef: checkpoint.ref }),
          );
          assert.equal(
            yield* git(workspaceA, ["show", `${checkpoint.ref}:native-answer.txt`]),
            "Captured native work in A\n",
          );
          assert.equal(yield* fs.readFileString(`${workspaceB}/native-answer.txt`), "Initial B\n");
          assert.equal(yield* git(workspaceB, ["for-each-ref"]), otherRefs);
          assert.equal(yield* git(workspaceB, ["count-objects", "-v"]), otherObjects);
          assert.deepEqual(yield* fs.readFile(`${workspaceB}/.git/index`), otherIndex);
          assert.equal(yield* git(workspaceB, ["status", "--porcelain"]), "");
          assert.deepEqual(prompts, [expectedNativePrompt("First user message")]);
          assert.equal(loads(), initialLoads);
          assert.equal(closes(), 0);
        }),
      { manualWorker: true, restricted: true },
    ),
);

it.live("refuses to reopen the captured native owner when it closes before buffered adoption", () =>
  withInitiatedWork(
    ({ orchestrator, emitWork, prompts, adopted, closes, loads, waitFor }) =>
      Effect.gen(function* () {
        const original = yield* orchestrator.getThreadProjection(threadId);
        const nativeOwner = original.providerThreads.find(
          (row) => row.id === original.thread.activeProviderThreadId,
        )!;
        const initialLoads = loads();
        yield* emitWork("closed-generation");
        yield* waitFor((p) => p.runs.length === 2 && p.runs[1]?.status === "starting");
        yield* (yield* ProviderSessionManagerV2).close(nativeOwner.providerSessionId!);
        yield* (yield* OrchestrationEffectWorkerV2).drain(12);
        const failed = yield* waitFor((p) => p.runs[1]?.status === "failed");
        assert.deepEqual(adopted, []);
        assert.deepEqual(prompts, [expectedNativePrompt("First user message")]);
        assert.equal(loads(), initialLoads);
        assert.equal(closes(), 1);
        assert.equal(failed.runs[1]!.providerThreadId, nativeOwner.id);
        assert.isTrue(
          failed.attempts
            .filter((a) => a.runId === failed.runs[1]!.id)
            .every((a) => a.status === "failed"),
        );
      }),
    { manualWorker: true },
  ),
);

it.live("refuses unknown captured cwd without assigning the relocated project workspace", () =>
  withInitiatedWork(
    ({
      orchestrator,
      emitWork,
      adopted,
      dropped,
      prompts,
      relocateProject,
      workspaceB,
      loads,
      closes,
      waitFor,
    }) =>
      Effect.gen(function* () {
        const before = yield* orchestrator.getThreadProjection(threadId);
        const initialLoads = loads();
        yield* relocateProject(workspaceB);
        const observed = yield* Queue.unbounded<void>();
        const refusals: string[] = [];
        yield* emitWork("unknown-workspace", {
          dispatchIfCurrent: (dispatch) =>
            dispatch.pipe(
              Effect.tapCause((cause) =>
                Effect.sync(() => {
                  refusals.push(Cause.pretty(cause));
                }),
              ),
              Effect.asSome,
              Effect.ensuring(Queue.offer(observed, undefined)),
            ),
        });
        yield* Queue.take(observed).pipe(Effect.timeout("10 seconds"));
        const after = yield* waitFor(() => dropped() === 1);
        assert.lengthOf(after.runs, 1);
        assert.deepEqual(after.checkpointScopes, before.checkpointScopes);
        assert.deepEqual(adopted, []);
        assert.deepEqual(prompts, [expectedNativePrompt("First user message")]);
        assert.equal(dropped(), 1);
        assert.lengthOf(refusals, 1);
        assert.include(refusals[0]!, "known absolute execution directory");
        assert.equal(loads(), initialLoads);
        assert.equal(closes(), 0);
      }),
    { unknownNativeCwd: true },
  ),
);

it.live.each(["fork", "merge_back"] as const)(
  "retains captured workspace during pending %s transfer admission",
  (type) =>
    withInitiatedWork(
      ({
        orchestrator,
        emitWork,
        waitFor,
        workspaceA,
        workspaceB,
        relocateProject,
        prompts,
        adopted,
        loads,
      }) =>
        Effect.gen(function* () {
          const before = yield* orchestrator.getThreadProjection(threadId);
          const sourceRun = before.runs[0]!;
          const now = yield* DateTime.now;
          const initialLoads = loads();
          yield* (yield* EventSinkV2).write({
            events: [
              {
                id: EventId.make(`pending-transfer:${type}`),
                type: "context-transfer.created",
                threadId,
                occurredAt: now,
                payload: {
                  id: ContextTransferId.make(`pending-transfer:${type}`),
                  type,
                  sourceThreadId: threadId,
                  targetThreadId: threadId,
                  sourcePoint: { threadId, runId: sourceRun.id },
                  basePoint: null,
                  sourceProviderInstanceId: instanceId,
                  targetProviderInstanceId: instanceId,
                  targetRunId: null,
                  status: "pending",
                  resolution: null,
                  createdBy: "system",
                  error: null,
                  createdAt: now,
                  updatedAt: now,
                  consumedAt: null,
                },
              },
            ],
          });
          yield* relocateProject(workspaceB);
          yield* emitWork(`captured-transfer:${type}`);
          const admitted = yield* waitFor((p) => p.runs.length === 2);
          const root = admitted.nodes.find((node) => node.id === admitted.runs[1]!.rootNodeId)!;
          assert.equal(
            admitted.checkpointScopes.find((scope) => scope.id === root.checkpointScopeId)!.cwd,
            workspaceA,
          );
          assert.deepEqual(admitted.runs[1]!.modelSelection, selection);
          assert.isTrue(
            admitted.contextTransfers.some(
              (row) =>
                row.id === ContextTransferId.make(`pending-transfer:${type}`) &&
                row.targetRunId === admitted.runs[1]!.id,
            ),
          );
          assert.deepEqual(prompts, [expectedNativePrompt("First user message")]);
          assert.deepEqual(adopted, []);
          assert.equal(loads(), initialLoads);
        }),
      { manualWorker: true },
    ),
);

it.live.each(["complete", "stopped-generation", "foreign-owner", "replaced-owner"] as const)(
  "reoffers one native generation only after its held real checkpoint: %s",
  (scenario) =>
    withInitiatedWork(
      ({
        orchestrator,
        workspaceA,
        emitWork,
        clearStoppedWork,
        takeOffer,
        prompts,
        adopted,
        dropped,
        waitFor,
        captureEntered,
        releaseCapture,
      }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const worker = yield* OrchestrationEffectWorkerV2;
          const receipts = yield* CommandReceiptStoreV2;
          const store = yield* CheckpointStore;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("gate:predecessor"),
            threadId,
            messageId: MessageId.make("gate:predecessor"),
            text: "Held predecessor",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain(12);
          const predecessor = yield* takeOffer;
          yield* fs.writeFileString(
            `${workspaceA}/native-answer.txt`,
            "Durable predecessor bytes\n",
          );
          yield* predecessor.finish;
          const waiting = yield* waitFor(
            (p) => p.runs.find((run) => run.id === predecessor.input.runId)?.status === "waiting",
          );
          assert.equal(
            waiting.messages.find(
              (message) => message.id === MessageId.make(`answer:${predecessor.input.runId}`),
            )?.text,
            "User answer",
          );
          const capture = yield* worker.drain(12).pipe(Effect.forkScoped);
          yield* captureEntered;
          const deferred = yield* Queue.unbounded<OrchestratorProviderWorkDeferredError>();
          const observed = yield* Queue.unbounded<void>();
          const observedNoncurrent = yield* Deferred.make<void>();
          let current = true;
          const guard: NonNullable<ProviderContinuationRequest["dispatchIfCurrent"]> = (dispatch) =>
            Effect.suspend(() => {
              if (!current) {
                return Deferred.succeed(observedNoncurrent, undefined).pipe(
                  Effect.andThen(Effect.succeedNone),
                );
              }
              return dispatch.pipe(
                Effect.tapError((cause) =>
                  Schema.is(OrchestratorProviderWorkDeferredError)(cause)
                    ? Queue.offer(deferred, cause).pipe(Effect.asVoid)
                    : Effect.void,
                ),
                Effect.asSome,
              );
            }).pipe(Effect.ensuring(Queue.offer(observed, undefined)));
          const workId = `held:${scenario}`;
          yield* emitWork(workId, { dispatchIfCurrent: guard });
          const refusal = yield* Queue.take(deferred).pipe(Effect.timeout("10 seconds"));
          assert.equal(refusal.workId, workId);
          assert.equal(refusal.threadId, threadId);
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(refusal.commandId)));
          const before = yield* orchestrator.getThreadProjection(threadId);
          assert.lengthOf(before.runs, 2);
          assert.lengthOf(
            before.messages.filter(
              (message) => message.notification?.source.kind === "provider_work",
            ),
            0,
          );
          assert.deepEqual(adopted, []);
          assert.equal(dropped(), 0);
          assert.deepEqual(prompts, [
            expectedNativePrompt("First user message"),
            expectedNativePrompt("Held predecessor"),
          ]);
          const root = before.nodes.find((node) => node.id === before.runs[1]!.rootNodeId)!;
          const scope = before.checkpointScopes.find((row) => row.id === root.checkpointScopeId)!;
          assert.isFalse(
            yield* store.hasCheckpointRef({
              cwd: scope.cwd,
              checkpointRef: checkpointRefForScopeOrdinal({
                scopeId: scope.id,
                ordinalWithinScope: 2,
              }),
            }),
          );

          if (scenario === "stopped-generation") {
            current = false; // The producer's Stop fence invalidates this buffered generation.
            yield* clearStoppedWork(workId);
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("gate:stop"),
              threadId,
              runId: predecessor.input.runId,
            });
          } else if (scenario === "foreign-owner") {
            const sink = yield* EventSinkV2;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("gate:foreign-owner"),
                  type: "thread.metadata-updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...before.thread,
                    activeProviderThreadId: ProviderThreadId.make("foreign:held-owner"),
                    updatedAt: yield* DateTime.now,
                  },
                },
              ],
            });
          } else if (scenario === "replaced-owner") {
            yield* (yield* ProviderSessionManagerV2).closeInstance(instanceId);
          }
          yield* releaseCapture;
          yield* Fiber.join(capture);
          if (scenario === "complete") {
            const ready = yield* waitFor(
              (p) =>
                p.runs.find((run) => run.id === predecessor.input.runId)?.status === "completed" &&
                p.runs.length === 3,
            );
            const checkpoint = ready.checkpoints.find(
              (row) => row.id === ready.runs[1]!.checkpointId,
            )!;
            assert.equal(checkpoint.status, "ready");
            assert.isTrue(
              yield* store.hasCheckpointRef({ cwd: scope.cwd, checkpointRef: checkpoint.ref }),
            );
            assert.equal(
              ready.messages.find(
                (message) => message.id === MessageId.make(`answer:${predecessor.input.runId}`),
              )?.text,
              "User answer",
            );
            const receipt = yield* receipts.getByCommandId(refusal.commandId);
            assert.isTrue(Option.isSome(receipt));
            if (Option.isSome(receipt)) assert.equal(receipt.value.status, "accepted");
            yield* worker.drain(12);
            const adoptedOffer = yield* takeOffer;
            assert.equal(adoptedOffer.input.message.notification?.source.kind, "provider_work");
            assert.deepEqual(adopted, [workId]);
            assert.deepEqual(prompts, [
              expectedNativePrompt("First user message"),
              expectedNativePrompt("Held predecessor"),
            ]);
            yield* adoptedOffer.finish;
            yield* waitFor((p) => p.runs[2]?.status === "waiting");
            yield* worker.drain(12);
            const completed = yield* waitFor((p) => p.runs[2]?.status === "completed");

            while (Option.isSome(yield* Queue.poll(observed))) {
              /* consume earlier attempt receipts */
            }
            yield* emitWork(workId, { dispatchIfCurrent: guard });
            yield* Queue.take(observed).pipe(Effect.timeout("10 seconds"));
            const replayed = yield* orchestrator.getThreadProjection(threadId);
            assert.lengthOf(replayed.runs, 3);
            assert.deepEqual(replayed, completed);
            assert.deepEqual(adopted, [workId]);
            assert.isTrue(
              Option.isNone(
                yield* receipts.getByCommandId(
                  CommandId.make(`${refusal.commandId}:different-generation`),
                ),
              ),
            );
          } else {
            if (scenario !== "stopped-generation") yield* waitFor(() => dropped() === 1);
            else {
              yield* Deferred.await(observedNoncurrent).pipe(Effect.timeout("10 seconds"));
              assert.isTrue(Option.isNone(yield* receipts.getByCommandId(refusal.commandId)));
              assert.equal(dropped(), 1);
            }
            const after = yield* orchestrator.getThreadProjection(threadId);
            assert.lengthOf(after.runs, 2);
            assert.deepEqual(adopted, []);
            assert.deepEqual(prompts, [
              expectedNativePrompt("First user message"),
              expectedNativePrompt("Held predecessor"),
            ]);
            if (scenario !== "stopped-generation") {
              const receipt = yield* receipts.getByCommandId(refusal.commandId);
              assert.isTrue(Option.isSome(receipt));
              if (Option.isSome(receipt)) assert.equal(receipt.value.status, "rejected");
              yield* emitWork(workId, { dispatchIfCurrent: guard });
              yield* waitFor(() => dropped() === 2);
              assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
            }
          }
        }),
      { manualWorker: true, holdCaptureOrdinal: 2 },
    ),
);
