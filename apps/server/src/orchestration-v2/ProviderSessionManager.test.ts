import { ProjectId } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as TestClock from "effect/testing/TestClock";
import {
  makeProviderThread,
  makeBrowserAccessProject,
} from "./testkit/ProviderSessionManagerTestHarness.ts";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type ProviderSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { scientInvocationForMcp } from "../mcp/ScientMcpInvocation.ts";
import { AgentInvocationContext } from "../scient/operations/AgentInvocationContext.ts";
import { dispatchScientOperation } from "../scient/operations/AgentOperationDispatcher.ts";
import { skillReleaseKey } from "@scientfactory/scient-skills";
import { BUILT_IN_SKILL_RELEASES } from "../scient/skills/BuiltInSkillReleases.ts";
import { prepareScientV2SkillTurn } from "../scient/skills/ScientV2SkillTurn.ts";
import { ScientSkillSessionPlanner } from "../scient/skills/ScientSkillSession.ts";
import { readScientThreadForInvocation } from "../mcp/toolkits/threads/handlers.ts";
import {
  loadScientSkillForInvocation,
  listScientSkillsForInvocation,
} from "../mcp/toolkits/skills/handlers.ts";
import { listScientComputeInventory } from "../mcp/toolkits/compute/handlers.ts";
import { ComputeMcpGateway } from "../mcp/toolkits/compute/ComputeMcpGateway.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  type TestProviderRuntimeState,
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
  makeThreadCreatedEvent,
  makeTestLayer,
  TestLegacyImporterLayer,
} from "./testkit/ProviderSessionManagerTestHarness.ts";

it.effect("ProviderSessionManagerV2 opens independent sessions concurrently", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const secondOpenStarted = yield* Deferred.make<void>();
    const releaseOpens = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Effect.gen(function* () {
        const openNumber = yield* Ref.modify(openStartedCount, (count) => [count + 1, count + 1]);
        yield* Deferred.succeed(openNumber === 1 ? firstOpenStarted : secondOpenStarted, undefined);
        yield* Deferred.await(releaseOpens);
      });

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-concurrent-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-concurrent-b");
      const firstProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const secondProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: secondThreadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      const firstFiber = yield* manager
        .open({
          threadId: firstThreadId,
          providerSessionId: firstProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* manager
        .open({
          threadId: secondThreadId,
          providerSessionId: secondProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);

      yield* Deferred.await(secondOpenStarted);
      assert.equal(yield* Ref.get(openStartedCount), 2);
      yield* Deferred.succeed(releaseOpens, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.notStrictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 closes every live session for a provider instance", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-logout-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-logout-b");
      const firstProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const secondProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: secondThreadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId: firstProviderSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId: secondThreadId,
        providerSessionId: secondProviderSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* manager.closeInstance(modelSelection.instanceId);

      assert.isTrue(Option.isNone(yield* manager.get(firstProviderSessionId)));
      assert.isTrue(Option.isNone(yield* manager.get(secondProviderSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 records provider session and turn metrics", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-metrics");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });

      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn({
        appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
        threadId,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
        rootNodeId: idAllocator.derive.rootNode({ runId }),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
          text: "hello",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn",
        }),
      });
      yield* manager.close(providerSessionId);

      const snapshots = yield* Metric.snapshot;
      const has = (id: string, attributes: Readonly<Record<string, string>>) =>
        snapshots.some(
          (snapshot) =>
            snapshot.id === id &&
            Object.entries(attributes).every(
              ([key, value]) => snapshot.attributes?.[key] === value,
            ),
        );
      assert.isTrue(
        has("t3_provider_sessions_total", {
          provider: "codex",
          operation: "open",
          outcome: "success",
        }),
      );
      assert.isTrue(
        has("t3_provider_sessions_total", {
          provider: "codex",
          operation: "release",
          reason: "manual_shutdown",
          outcome: "success",
        }),
      );
      assert.isTrue(
        has("t3_provider_turns_total", {
          provider: "codex",
          operation: "send",
          modelFamily: "gpt",
          outcome: "success",
        }),
      );
      assert.isTrue(has("t3_provider_turn_duration", { provider: "codex", operation: "send" }));
      assert.isTrue(
        has("t3_provider_turns_total", {
          provider: "codex",
          operation: "interrupt",
          outcome: "success",
        }),
      );
    });

    yield* effect.pipe(
      Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })),
      // A private registry keeps other tests' provider metrics out of the assertions.
      Effect.provideService(Metric.MetricRegistry, new Map()),
    );
  }),
);

it.effect("ProviderSessionManagerV2 opens a duplicate session only once", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const releaseOpen = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Ref.updateAndGet(openStartedCount, (count) => count + 1).pipe(
        Effect.tap(() => Deferred.succeed(firstOpenStarted, undefined)),
        Effect.andThen(Deferred.await(releaseOpen)),
      );

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-single-flight");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const open = manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const firstFiber = yield* open.pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* open.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(openStartedCount), 1);

      yield* Deferred.succeed(releaseOpen, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.strictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 cleans up an open interrupted mid-handshake", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const handshakeStarted = yield* Deferred.make<void>();
    const holdHandshake = yield* Ref.make(true);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-interrupted-open");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });

      const opening = yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(handshakeStarted);
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);
      assert.isDefined(yield* registry.resolve(token!));

      // A Stop while the provider is still starting.
      yield* Fiber.interrupt(opening);

      // The process started for this open is stopped, and the credential minted
      // for it revoked.
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

      // Nothing of the interrupted open is left behind: the next open starts a
      // fresh process with a fresh credential that a later release revokes,
      // which a leaked reservation would prevent.
      yield* Ref.set(holdHandshake, false);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
      const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(replacementToken);
      assert.notEqual(replacementToken, token);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.providerSessions.at(-1)?.status, "ready");

      yield* manager.close(providerSessionId);
      assert.isUndefined(yield* registry.resolve(replacementToken!));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          mcpConfigs,
          beforeOpen: () =>
            Ref.get(holdHandshake).pipe(
              Effect.flatMap((hold) =>
                hold
                  ? Deferred.succeed(handshakeStarted, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void,
              ),
            ),
          // The process is spawned before the handshake that is interrupted.
          spawnBeforeOpen: true,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 holds an interrupted open until physical scope close finishes",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const handshakeStarted = yield* Deferred.make<void>();
      const scopeCloseReached = yield* Deferred.make<void>();
      const releaseRetry = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-interrupted-hung-open");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });

        const opening = yield* manager
          .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
          .pipe(Effect.forkChild);
        yield* Deferred.await(handshakeStarted);
        const issued = (yield* Ref.get(mcpConfigs)).at(-1);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);

        // The interrupt starts cleanup; the scope close then never finishes.
        const interrupter = yield* Fiber.interrupt(opening).pipe(Effect.forkChild);
        yield* Deferred.await(scopeCloseReached);

        // The session cleanup already ran, ahead of the stuck close.
        assert.isUndefined(yield* registry.resolve(token!));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        // A timed-out physical close must not release the session generation.
        yield* TestClock.adjust("30 seconds");
        assert.isUndefined(interrupter.pollUnsafe());
        yield* Deferred.succeed(releaseClose, undefined);
        yield* Fiber.join(interrupter);
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        yield* Deferred.succeed(releaseRetry, undefined);
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        // The interrupted handshake already spawned one process; the retry is a fresh second open.
        assert.equal((yield* Ref.get(state)).openCount, 2);

        // Its close hangs as well; release it while the test clock can still move.
        const stopping = yield* manager.shutdown.pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        yield* Fiber.join(stopping);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            mcpConfigs,
            // The first open hangs in its handshake; the retry completes.
            beforeOpen: () =>
              Deferred.isDone(handshakeStarted).pipe(
                Effect.flatMap((retry) =>
                  retry
                    ? Deferred.await(releaseRetry)
                    : Deferred.succeed(handshakeStarted, undefined).pipe(
                        Effect.andThen(Effect.never),
                      ),
                ),
              ),
            spawnBeforeOpen: true,
            closeSession: () =>
              Deferred.succeed(scopeCloseReached, undefined).pipe(
                Effect.andThen(Deferred.await(releaseClose)),
              ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 releases an idle session whose turn start was stopped", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const startTurnReached = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-stopped-turn-start");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      const starting = yield* runtime
        .startTurn({
          appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId }),
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "stopped before the provider accepted it",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(startTurnReached);

      // Stop lands while the provider is still accepting the turn. No terminal
      // event follows, so the session must count itself idle again.
      yield* Fiber.interrupt(starting);
      yield* TestClock.adjust("2 seconds");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          startTurn: () =>
            Deferred.succeed(startTurnReached, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a shared session busy when another thread's start is stopped early",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const projectId = ProjectId.make("project-provider-session-manager-shared-stopped-start");
      // Blocks the next project read, so a re-attach can be stopped before its
      // start marks the session busy.
      const holdProjectRead = yield* Ref.make(false);
      const projectReadHeld = yield* Deferred.make<void>();
      const projectServiceLayer = Layer.mock(ProjectService.ProjectService)({
        getById: (requestedProjectId) =>
          Ref.get(holdProjectRead).pipe(
            Effect.flatMap((hold) =>
              hold
                ? Deferred.succeed(projectReadHeld, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(Option.some(makeBrowserAccessProject(requestedProjectId))),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadA = ThreadId.make("thread-provider-session-manager-shared-stopped-a");
        const threadB = ThreadId.make("thread-provider-session-manager-shared-stopped-b");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now, projectId }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now, projectId }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: threadB,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const startTurn = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
            return yield* runtime.startTurn({
              appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
              threadId,
              runId,
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
              rootNodeId: idAllocator.derive.rootNode({ runId }),
              providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
                text: "turn",
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            });
          });

        // B's turn is accepted and still running.
        yield* startTurn(threadB);

        // A detaches, and its next start is stopped while re-attaching, before
        // it marks the session busy.
        yield* manager.detach({ providerSessionId, threadId: threadA });
        yield* Ref.set(holdProjectRead, true);
        const startingA = yield* startTurn(threadA).pipe(Effect.forkChild);
        yield* Deferred.await(projectReadHeld);
        yield* Fiber.interrupt(startingA);

        // B's running turn keeps the session busy past the idle timeout.
        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1000,
            projectServiceLayer,
            serverSettingsLayer: ServerSettings.layerTest({
              projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: true } },
            }),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a shared session busy when a stopped start still ends its turn",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      // A's adapter start installs its turn, then is stopped mid-request; like
      // OpenCode2, the adapter still ends that turn with turn.terminal later.
      const holdStart = yield* Ref.make(false);
      const startHeld = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadA = ThreadId.make("thread-provider-session-manager-stopped-ended-a");
        const threadB = ThreadId.make("thread-provider-session-manager-stopped-ended-b");
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: threadB,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const providerThreadOf = (threadId: ThreadId) =>
          makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
            nativeThreadId: `native-${threadId}`,
          });
        const startTurn = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
            return yield* runtime.startTurn({
              appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
              threadId,
              runId,
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
              rootNodeId: idAllocator.derive.rootNode({ runId }),
              providerThread: providerThreadOf(threadId),
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
                text: "turn",
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            });
          });

        // B's turn is accepted and still running.
        yield* startTurn(threadB);

        // A's start is stopped after the adapter began the turn.
        yield* Ref.set(holdStart, true);
        const startingA = yield* startTurn(threadA).pipe(Effect.forkChild);
        yield* Deferred.await(startHeld);
        yield* Fiber.interrupt(startingA);

        // The adapter ends A's turn anyway.
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThreadOf(threadA).id,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: "native-turn-stopped-a",
          }),
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });

        // B's running turn keeps the session busy past the idle timeout.
        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1000,
            startTurn: () =>
              Ref.get(holdStart).pipe(
                Effect.flatMap((hold) =>
                  hold
                    ? Deferred.succeed(startHeld, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.void,
                ),
              ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 stops a session still opening when its layer shuts down", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const handshakeStarted = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown-during-open");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      // Detached, like an open the layer does not own: only the session
      // scope's parent can stop its process when the layer closes.
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.forkDetach);
      yield* Deferred.await(handshakeStarted);
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen: () =>
            Deferred.succeed(handshakeStarted, undefined).pipe(Effect.andThen(Effect.never)),
          spawnBeforeOpen: true,
        }),
      ),
    );

    assert.equal((yield* Ref.get(state)).closeCount, 1);
  }),
);

it.effect("ProviderSessionManagerV2 releases live sessions when its layer shuts down", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      const liveState = yield* Ref.get(state);
      assert.equal(liveState.openCount, 1);
      assert.equal(liveState.closeCount, 0);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
        }),
      ),
    );

    assert.equal((yield* Ref.get(state)).closeCount, 1);
  }),
);

it.effect("ProviderSessionManagerV2 closes event subscriptions normally on server shutdown", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown-subscription");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const bufferedSubscription = yield* runtime.subscribeEvents!;
      const activeSubscription = yield* runtime.subscribeEvents!;
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: runtime.providerSession,
      });
      assert.isTrue(Option.isSome(yield* activeSubscription.events.pipe(Stream.runHead)));

      yield* manager.shutdown;

      assert.isEmpty(yield* bufferedSubscription.events.pipe(Stream.runCollect));
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
  }),
);

it.effect("ProviderSessionManagerV2 drains subscribers when the provider stops", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-provider-stop");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const subscription = yield* runtime.subscribeEvents!;
      const collected = yield* subscription.events.pipe(Stream.runCollect, Effect.forkScoped);
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "provider-stop-thread",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "provider-stop-turn",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "turn.terminal",
        driver: CODEX_DRIVER,
        providerThreadId,
        providerTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: {
          ...runtime.providerSession,
          status: "stopped",
          updatedAt: now,
        },
      });
      yield* Queue.end(adapterQueue!);

      const events = Array.from(yield* Fiber.join(collected));
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.terminal", "provider_session.updated"],
      );
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 issues MCP credentials before opening and revokes them on close",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-mcp");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.threadId, threadId);
        assert.equal(captured?.providerInstanceId, modelSelection.instanceId);
        assert.equal(captured?.endpoint, "http://127.0.0.1:43123/mcp");
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);
        const resolved = yield* registry.resolve(token!);
        assert.equal(resolved?.thread.threadId, threadId);
        assert.deepEqual(
          resolved?.capabilities,
          new Set([
            "preview",
            "orchestration",
            "worktree",
            "pull-requests",
            "documents:build",
            "compute:inventory",
            "sources:read",
            "sources:write",
            "threads:read",
            "skills:read",
          ]),
        );

        if (resolved === undefined)
          return yield* Effect.die("The manager-issued token must resolve");
        const invocation = scientInvocationForMcp(resolved);
        const discovery = yield* dispatchScientOperation(
          "skills.list",
          listScientSkillsForInvocation(),
        ).pipe(Effect.provideService(AgentInvocationContext, invocation));
        assert.equal(discovery.scope.status, "pending");
        const inventory = yield* dispatchScientOperation(
          "compute.inventory",
          listScientComputeInventory(),
        ).pipe(
          Effect.provideService(AgentInvocationContext, invocation),
          Effect.provideService(ComputeMcpGateway, {
            runtimeInventory: () => Effect.succeed({ languages: [] }),
          }),
        );
        assert.deepEqual(inventory, { languages: [] });
        const history = yield* dispatchScientOperation(
          "threads.read",
          readScientThreadForInvocation({ threadId }),
        ).pipe(Effect.provideService(AgentInvocationContext, invocation));
        assert.equal(history.thread.threadId, threadId);
        assert.deepEqual(history.items, []);
        const release = BUILT_IN_SKILL_RELEASES.find(
          (candidate) => candidate.name === "improve-workspace-readiness",
        );
        if (release === undefined)
          return yield* Effect.die("Expected the immutable built-in skill release");
        const releaseKey = skillReleaseKey(release);
        const descriptor = {
          releaseKey,
          id: release.id,
          name: release.name,
          description: release.description,
          origin: release.origin,
          activationScope: "user" as const,
          invocationPolicy: "explicit" as const,
        };
        const planner = {
          resolve: () =>
            Effect.succeed({
              delivery: "mcp" as const,
              catalogStatus: "complete" as const,
              releases: new Map([[releaseKey, release]]),
              skills: [descriptor],
              diagnostics: [],
            }),
        };
        yield* prepareScientV2SkillTurn({
          threadId,
          driver: CODEX_DRIVER,
          mcpSessionInjection: true,
          projectRoot: undefined,
          text: "Prepare selected skill",
          selectedScientSkillNames: [release.name],
        }).pipe(Effect.provideService(ScientSkillSessionPlanner, planner));
        const selectedScope = yield* registry.resolve(token!);
        if (selectedScope === undefined)
          return yield* Effect.die("Stable native credential was lost");
        const loaded = yield* dispatchScientOperation(
          "skills.load",
          loadScientSkillForInvocation({ name: release.name }),
        ).pipe(
          Effect.provideService(AgentInvocationContext, scientInvocationForMcp(selectedScope)),
        );
        assert.equal(loaded.instructions, release.instructions);
        assert.equal(loaded.skill.releaseKey, releaseKey);
        yield* prepareScientV2SkillTurn({
          threadId,
          driver: CODEX_DRIVER,
          mcpSessionInjection: true,
          projectRoot: undefined,
          text: "Clear selection",
          selectedScientSkillNames: [],
        }).pipe(Effect.provideService(ScientSkillSessionPlanner, planner));
        const clearedScope = yield* registry.resolve(token!);
        if (clearedScope === undefined)
          return yield* Effect.die("Stable native credential was lost");
        const unavailable = yield* dispatchScientOperation(
          "skills.load",
          loadScientSkillForInvocation({ name: release.name }),
        ).pipe(
          Effect.provideService(AgentInvocationContext, scientInvocationForMcp(clearedScope)),
          Effect.flip,
        );
        assert.equal(unavailable._tag, "ScientSkillToolError");

        yield* manager.close(providerSessionId);
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
      });

      yield* effect.pipe(
        Effect.provide(
          Layer.merge(
            makeTestLayer({
              state,
              idleTimeoutMs: 1_000,
              mcpConfigs,
            }),
            TestLegacyImporterLayer,
          ),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 withholds the preview capability when agent browser access is off",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-no-browser");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.capabilities.has("preview"), false);
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        const resolved = yield* registry.resolve(token!);
        assert.deepEqual(
          resolved?.capabilities,
          new Set([
            "orchestration",
            "worktree",
            "pull-requests",
            "documents:build",
            "compute:inventory",
            "sources:read",
            "sources:write",
            "threads:read",
            "skills:read",
          ]),
        );

        yield* manager.close(providerSessionId);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            // orDie: the test layer's settings-normalization error cannot
            // occur for a literal override and the slot requires error never.
            serverSettingsLayer: ServerSettings.layerTest({
              enableAgentBrowserAccess: false,
            }).pipe(Layer.orDie),
          }),
        ),
      );
    }),
);

function runIdleThreadUnloadScenario(
  name: string,
  scenario: (input: {
    readonly state: Ref.Ref<TestProviderRuntimeState>;
    readonly manager: ProviderSessionManager.ProviderSessionManagerV2Shape;
    readonly providerSessionId: ProviderSessionId;
    readonly threadA: ThreadId;
    readonly threadB: ThreadId;
    readonly reopen: Effect.Effect<void, ProviderSessionManager.ProviderSessionManagerV2Error>;
    /** Starts run `ordinal` on a thread and returns once the provider accepted it. */
    readonly startTurn: (threadId: ThreadId, ordinal: number) => Effect.Effect<void>;
    /** Ends run `ordinal` on a thread and waits for the session to process it. */
    readonly endTurn: (threadId: ThreadId, ordinal: number) => Effect.Effect<void>;
    readonly resume: (threadId: ThreadId) => Effect.Effect<void>;
  }) => Effect.Effect<void, ProviderSessionManager.ProviderSessionManagerV2Error>,
  options: { readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean> } = {},
) {
  return Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadA = ThreadId.make(`thread-provider-session-manager-${name}-a`);
      const threadB = ThreadId.make(`thread-provider-session-manager-${name}-b`);
      const providerSessionId = idAllocator.derive.providerSession({
        providerInstanceId: modelSelection.instanceId,
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now }),
        ],
      });
      let runtime = yield* manager.open({
        threadId: threadA,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({ threadId: threadB, providerSessionId, modelSelection, runtimePolicy });
      const reopen = Effect.gen(function* () {
        yield* manager.closeInstance(modelSelection.instanceId);
        runtime = yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: threadB,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
      });
      const providerThreadOf = (threadId: ThreadId) =>
        makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
          nativeThreadId: `native-${threadId}`,
        });
      const resume = (threadId: ThreadId) =>
        runtime
          .resumeThread({
            providerThread: providerThreadOf(threadId),
            threadId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.asVoid, Effect.orDie);
      const startTurn = (threadId: ThreadId, ordinal: number) =>
        Effect.gen(function* () {
          yield* resume(threadId);
          const runId = idAllocator.derive.run({ threadId, ordinal });
          yield* runtime.startTurn({
            appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
            threadId,
            runId,
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
            rootNodeId: idAllocator.derive.rootNode({ runId }),
            providerThread: providerThreadOf(threadId),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal }),
              text: "turn",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          });
        }).pipe(Effect.orDie);
      const endTurn = (threadId: ThreadId, ordinal: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            // The pump hands an event to subscribers only after the session
            // has processed it, so receiving it is the receipt.
            const subscribe = runtime.subscribeEvents;
            assert.isDefined(subscribe);
            const subscription = yield* Effect.acquireRelease(subscribe!, (sub) => sub.close);
            const received = yield* subscription.events.pipe(
              Stream.filter((event) => event.type === "turn.terminal"),
              Stream.runHead,
              Effect.forkScoped,
            );
            const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
            assert.isDefined(queue);
            yield* Queue.offer(queue!, {
              type: "turn.terminal",
              driver: CODEX_DRIVER,
              providerThreadId: providerThreadOf(threadId).id,
              providerTurnId: idAllocator.derive.providerTurn({
                driver: CODEX_DRIVER,
                nativeTurnId: `native-turn-${threadId}-${ordinal}`,
              }),
              runOrdinal: ordinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(received);
          }),
        ).pipe(Effect.orDie);

      // B's running turn keeps the shared runtime itself busy throughout.
      yield* startTurn(threadB, 1);
      yield* scenario({
        state,
        manager,
        providerSessionId,
        threadA,
        threadB,
        reopen,
        startTurn,
        endTurn,
        resume,
      });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          ...(options.hasPendingBackgroundWorkForThread === undefined
            ? {}
            : { hasPendingBackgroundWorkForThread: options.hasPendingBackgroundWorkForThread }),
        }),
      ),
    );
  });
}

it.effect(
  "ProviderSessionManagerV2 unloads a shared-runtime thread left idle, and reloads it on its next turn",
  () =>
    runIdleThreadUnloadScenario(
      "idle-unload",
      ({ state, manager, providerSessionId, threadA, startTurn, endTurn, resume }) =>
        Effect.gen(function* () {
          yield* startTurn(threadA, 1);
          assert.equal((yield* Ref.get(state)).resumeCount, 2);
          yield* endTurn(threadA, 1);

          // A follow-up before the timeout keeps the thread loaded.
          yield* TestClock.adjust("500 millis");
          yield* startTurn(threadA, 2);
          yield* TestClock.adjust("1 second");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);

          // Idle for the full timeout after its last turn, A is unloaded while
          // the runtime stays up for B.
          yield* endTurn(threadA, 2);
          yield* TestClock.adjust("1 second");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
          assert.equal((yield* Ref.get(state)).closeCount, 0);

          // The next turn's resume reaches the provider and reloads A.
          const resumes = (yield* Ref.get(state)).resumeCount;
          yield* resume(threadA);
          assert.equal((yield* Ref.get(state)).resumeCount, resumes + 1);
        }),
    ),
);

it.effect(
  "ProviderSessionManagerV2 keeps an idle shared-runtime thread loaded while its background work runs",
  () =>
    Effect.gen(function* () {
      const pendingWork = yield* Ref.make(true);
      yield* runIdleThreadUnloadScenario(
        "idle-unload-pinned",
        ({ state, threadA, startTurn, endTurn }) =>
          Effect.gen(function* () {
            yield* startTurn(threadA, 1);
            yield* endTurn(threadA, 1);
            yield* TestClock.adjust("3 seconds");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);

            yield* Ref.set(pendingWork, false);
            yield* TestClock.adjust("1 second");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
              `native-${threadA}`,
            ]);
          }),
        { hasPendingBackgroundWorkForThread: Ref.get(pendingWork) },
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 does not let a retired runtime's idle-thread timer unload its replacement",
  () =>
    runIdleThreadUnloadScenario(
      "idle-unload-replacement",
      ({ state, threadA, threadB, reopen, startTurn, endTurn }) =>
        Effect.gen(function* () {
          yield* startTurn(threadA, 1);
          yield* endTurn(threadA, 1);
          yield* TestClock.adjust("500 millis");
          yield* reopen;
          yield* startTurn(threadB, 1);
          yield* startTurn(threadA, 1);
          yield* endTurn(threadA, 1);
          // Both owners used the same native thread IDs and timer generation. The
          // earlier deadline belongs solely to the physically closed runtime.
          yield* TestClock.adjust("500 millis");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
          assert.equal((yield* Ref.get(state)).closeCount, 1);
          yield* TestClock.adjust("500 millis");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
        }),
    ),
);
