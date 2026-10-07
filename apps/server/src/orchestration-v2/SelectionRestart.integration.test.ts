import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { GrokProviderCapabilitiesV2 } from "./Adapters/GrokAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2RuntimePolicy,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex-restart-test");
const initialSelection = {
  instanceId: providerInstanceId,
  model: "restart-model-a",
} satisfies ModelSelection;
const replacementSelection = {
  instanceId: providerInstanceId,
  model: "restart-model-b",
} satisfies ModelSelection;
const seedSelection = {
  instanceId: providerInstanceId,
  model: "seed-model",
} satisfies ModelSelection;
const handoffDriver = ProviderDriverKind.make("claudeAgent");
const handoffProviderInstanceId = ProviderInstanceId.make("claude-handoff-test");
const handoffSelection = {
  instanceId: handoffProviderInstanceId,
  model: "handoff-model",
} satisfies ModelSelection;
const pooledCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const exclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
  },
};

interface ActiveTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
}

interface RestartAdapterState {
  readonly offeredPolicies?: ReadonlyArray<ProviderAdapterV2RuntimePolicy>;
  readonly activeTurn: ActiveTurn | null;
  readonly opened: ReadonlyArray<{
    readonly model: string | null;
    readonly cwd: string | null;
    readonly runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"];
  }>;
  readonly started: ReadonlyArray<{
    readonly model: string;
    readonly cwd: string | null;
    readonly attemptId: string;
  }>;
  readonly closedSessionCount: number;
  readonly failedReplacementOpen: boolean;
}

function makeRestartAdapter(
  state: Ref.Ref<RestartAdapterState>,
  sessionCapabilities: OrchestrationV2ProviderCapabilities = pooledCapabilities,
  providerInstanceId = initialSelection.instanceId,
  driver = ProviderDriverKind.make("codex"),
): ProviderAdapterV2Shape {
  return {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(sessionCapabilities),
    planSelectionTransition: ({ current, target }) =>
      Effect.succeed(
        current.model === target.model
          ? ({ type: "apply_on_next_turn" } as const)
          : ({ type: "restart_session" } as const),
      ),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const failThisOpen = yield* Ref.modify(state, (current) => {
          const shouldFail =
            sessionInput.modelSelection.model === replacementSelection.model &&
            !current.failedReplacementOpen;
          return [
            shouldFail,
            {
              ...current,
              failedReplacementOpen: current.failedReplacementOpen || shouldFail,
              opened: [
                ...current.opened,
                {
                  model: sessionInput.modelSelection.model,
                  cwd: sessionInput.runtimePolicy.cwd,
                  runtimeMode: sessionInput.runtimePolicy.runtimeMode,
                },
              ],
            },
          ] as const;
        });
        if (failThisOpen) {
          return yield* new ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: sessionInput.providerSessionId,
            cause: "simulated replacement open failure",
          });
        }

        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
          model: sessionInput.modelSelection.model,
          capabilities: sessionCapabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        yield* Effect.addFinalizer(() =>
          Ref.update(state, (current) => ({
            ...current,
            closedSessionCount: current.closedSessionCount + 1,
          })),
        );

        const publishTerminal = (active: ActiveTurn, status: "completed" | "interrupted") =>
          Effect.gen(function* () {
            const occurredAt = yield* DateTime.now;
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: active.providerTurnId,
                providerThreadId: active.input.providerThread.id,
                nodeId: active.input.rootNodeId,
                runAttemptId: active.input.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${active.providerTurnId}`,
                  strength: "strong",
                },
                ordinal: active.input.providerTurnOrdinal,
                status,
                startedAt: occurredAt,
                completedAt: occurredAt,
              },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: active.input.providerThread.id,
              providerTurnId: active.providerTurnId,
              runOrdinal: active.input.runOrdinal,
              status,
              failure: null,
              threadDisposition: "reusable",
            });
          });

        return {
          instanceId: providerInstanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                offeredPolicies: [...(current.offeredPolicies ?? []), input.runtimePolicy],
                started: [
                  ...current.started,
                  {
                    model: input.modelSelection.model,
                    cwd: input.runtimePolicy.cwd,
                    attemptId: input.attemptId,
                  },
                ],
              }));
              const active = {
                input,
                providerTurnId: ProviderTurnId.make(`provider-turn:${input.attemptId}`),
              } satisfies ActiveTurn;
              if (input.modelSelection.model === initialSelection.model) {
                const occurredAt = yield* DateTime.now;
                yield* Ref.update(state, (current) => ({ ...current, activeTurn: active }));
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: active.providerTurnId,
                    providerThreadId: input.providerThread.id,
                    nodeId: input.rootNodeId,
                    runAttemptId: input.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${active.providerTurnId}`,
                      strength: "strong",
                    },
                    ordinal: input.providerTurnOrdinal,
                    status: "running",
                    startedAt: occurredAt,
                    completedAt: null,
                  },
                });
                return;
              }
              yield* publishTerminal(active, "completed");
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Effect.gen(function* () {
              const active = (yield* Ref.get(state)).activeTurn;
              if (active !== null) {
                const updatedAt = yield* DateTime.now;
                yield* Queue.offer(events, {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...active.input.providerThread,
                    status: "idle",
                    updatedAt,
                  },
                });
                yield* publishTerminal(active, "interrupted");
                yield* Ref.update(state, (current) => ({ ...current, activeTurn: null }));
              }
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

function makeCompletingHandoffAdapter(startCount: Ref.Ref<number>): ProviderAdapterV2Shape {
  return {
    instanceId: handoffProviderInstanceId,
    driver: handoffDriver,
    getCapabilities: () => Effect.succeed(exclusiveCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        return {
          instanceId: handoffProviderInstanceId,
          driver: handoffDriver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver: handoffDriver,
            providerInstanceId: handoffProviderInstanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
            model: sessionInput.modelSelection.model,
            capabilities: exclusiveCapabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:handoff:${threadInput.threadId}`),
                driver: handoffDriver,
                providerInstanceId: handoffProviderInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: handoffDriver,
                  nativeId: `native-thread:handoff:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(startCount, (count) => count + 1);
              const occurredAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:handoff:${input.attemptId}`,
              );
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver: handoffDriver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver: handoffDriver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: input.providerTurnOrdinal,
                  status: "completed",
                  startedAt: occurredAt,
                  completedAt: occurredAt,
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver: handoffDriver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

it.live("restarts selection as a new attempt and retries after old-session cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("selection-restart-lifecycle");
      const threadId = ThreadId.make("thread:selection-restart-lifecycle");
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: false,
      });
      const registry = ProviderAdapterRegistry.layerSingle(makeRestartAdapter(state));

      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart:create"),
          threadId,
          projectId: ProjectId.make("project:selection-restart"),
          title: "Selection restart",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart:first"),
          threadId,
          messageId: MessageId.make("message:selection-restart:first"),
          text: "first",
          attachments: [],
          modelSelection: initialSelection,
          dispatchMode: { type: "start_immediately" },
        });
        for (let index = 0; index < 1_000; index += 1) {
          const current = yield* orchestrator.getThreadProjection(threadId);
          if (current.providerTurns.some((turn) => turn.status === "running")) break;
          yield* Effect.sleep("5 millis");
        }
        const activeProjection = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(activeProjection.providerTurns.some((turn) => turn.status === "running"));
        const activeRunId = activeProjection.runs[0]?.id;
        if (activeRunId === undefined) {
          return yield* Effect.die("active restart test run is missing");
        }

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart:second"),
          threadId,
          messageId: MessageId.make("message:selection-restart:second"),
          text: "second",
          attachments: [],
          modelSelection: replacementSelection,
          dispatchMode: { type: "restart_active", targetRunId: activeRunId },
        });
        for (let index = 0; index < 1_000; index += 1) {
          const current = yield* orchestrator.getThreadProjection(threadId);
          if (current.attempts.length === 2 && current.attempts[1]?.status === "completed") {
            const captured = yield* Ref.get(state);
            return { projection: current, captured };
          }
          yield* Effect.sleep("5 millis");
        }
        const current = yield* orchestrator.getThreadProjection(threadId);
        const adapterState = yield* Ref.get(state);
        yield* Effect.logError("selection restart did not complete", {
          runs: current.runs.map((run) => [run.status, run.activeAttemptId]),
          attempts: current.attempts.map((attempt) => [attempt.id, attempt.status]),
          providerTurns: current.providerTurns.map((turn) => [turn.id, turn.status]),
          providerThreads: current.providerThreads.map((thread) => [
            thread.providerSessionId,
            thread.status,
          ]),
          adapterState,
        });
        return yield* Effect.die("selection restart did not complete");
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "selection-restart-lifecycle" },
            registry,
          ),
        ),
      );
      const { projection, captured } = result;

      assert.lengthOf(projection.runs, 1);
      assert.lengthOf(projection.attempts, 2);
      assert.deepEqual(
        projection.attempts.map((attempt) => attempt.status),
        ["superseded", "completed"],
      );
      assert.deepEqual(
        projection.providerTurns.map((turn) => turn.status),
        ["interrupted", "completed"],
      );
      assert.isFalse(
        projection.turnItems.some(
          (item) => item.type === "run_interrupt_request" || item.type === "run_interrupt_result",
        ),
        "selection restart supersede must not project hard-Stop interrupt items",
      );
      assert.equal(projection.runs[0]?.modelSelection.model, replacementSelection.model);
      assert.isTrue(captured.failedReplacementOpen);
      // The old pooled process remains available to its other threads; this
      // thread moved to a freshly allocated replacement session.
      assert.equal(captured.closedSessionCount, 0);
      assert.deepEqual(
        captured.opened.map((open) => [open.model, open.cwd]),
        [
          [initialSelection.model, cwd],
          [replacementSelection.model, cwd],
          [replacementSelection.model, cwd],
        ],
      );
      assert.deepEqual(
        captured.started.map((turn) => [turn.model, turn.cwd]),
        [
          [initialSelection.model, cwd],
          [replacementSelection.model, cwd],
        ],
      );
      assert.notEqual(
        projection.providerSessions[0]?.id,
        projection.providerThreads[0]?.providerSessionId,
      );
      assert.equal(
        projection.providerThreads[0]?.providerSessionId,
        projection.providerSessions.find((session) => session.model === replacementSelection.model)
          ?.id,
      );
    }),
  ),
);

it.live.each(
  (["stopped", "error"] as const).map((deadStatus) => ({
    caseTitle: `restarts the live session on a model change when a newer ${deadStatus} session record exists`,
    deadStatus,
  })),
)("$caseTitle", ({ deadStatus }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `selection-restart-dead-${deadStatus}`;
      const cwd = yield* checkpointWorkspace(name);
      const threadId = ThreadId.make(`thread:${name}`);
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        // The dead record is seeded directly, so the adapter's one-shot
        // simulated replacement-open failure is skipped.
        failedReplacementOpen: true,
      });
      const registry = ProviderAdapterRegistry.layerSingle(
        makeRestartAdapter(state, exclusiveCapabilities),
      );

      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const dispatch = (step: string, modelSelection: ModelSelection) =>
          Effect.gen(function* () {
            const terminal = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) => event.type === "run.updated" && event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`${name}:${step}`),
              threadId,
              messageId: MessageId.make(`${name}:${step}`),
              text: step,
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
            });
            yield* worker.drain();
            yield* Fiber.join(terminal);
            yield* worker.drain();
            return yield* orchestrator.getThreadProjection(threadId);
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection: seedSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        const first = yield* dispatch("first", seedSelection);
        const liveSession = first.providerSessions.find(
          (session) => session.status !== "stopped" && session.status !== "error",
        );
        assert.isDefined(liveSession);

        // Dead session records stay bound in the projection until
        // detachment. A stale stopped/error record written after the
        // live session attached must not hide it.
        const deadAt = yield* DateTime.now;
        const deadSession: OrchestrationV2ProviderSession = {
          id: ProviderSessionId.make(`session:${name}:dead`),
          driver,
          providerInstanceId,
          status: "ready",
          cwd,
          model: seedSelection.model,
          capabilities: exclusiveCapabilities,
          createdAt: deadAt,
          updatedAt: deadAt,
          lastError: null,
        };
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`event:${name}:dead-attached`),
              type: "provider-session.attached",
              threadId,
              driver,
              providerInstanceId,
              occurredAt: deadAt,
              payload: deadSession,
            },
            {
              id: EventId.make(`event:${name}:dead-updated`),
              type: "provider-session.updated",
              threadId,
              driver,
              providerInstanceId,
              occurredAt: deadAt,
              payload: {
                ...deadSession,
                status: deadStatus,
                updatedAt: deadAt,
                lastError: deadStatus === "error" ? "Simulated session failure." : null,
              },
            },
          ],
        });

        const switchCommandId = CommandId.make(`${name}:switch`);
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: switchCommandId,
          threadId,
          modelSelection: replacementSelection,
        });
        yield* worker.drain();
        const storedSwitchEvents = yield* eventSink
          .readByCommandId({ commandId: switchCommandId })
          .pipe(Stream.runCollect);
        const detachedSessionIds = [...storedSwitchEvents].flatMap((stored) =>
          stored.event.type === "provider-session.detached"
            ? [stored.event.payload.providerSessionId]
            : [],
        );

        const second = yield* dispatch("second", replacementSelection);
        return {
          projection: second,
          captured: yield* Ref.get(state),
          liveSessionId: liveSession.id,
          detachedSessionIds,
        };
      }).pipe(Effect.provide(makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry)));

      const { projection, captured } = result;
      assert.lengthOf(projection.runs, 2);
      assert.equal(projection.runs[1]?.modelSelection.model, replacementSelection.model);
      // The exact released session is the older live one, never the newer
      // dead record.
      assert.deepEqual(result.detachedSessionIds, [result.liveSessionId]);
      assert.equal(captured.closedSessionCount, 1);
      assert.deepEqual(
        captured.opened.map((open) => open.model),
        [seedSelection.model, replacementSelection.model],
      );
      assert.deepEqual(
        captured.started.map((turn) => turn.model),
        [seedSelection.model, replacementSelection.model],
      );
      const servingSession = projection.providerSessions.find(
        (session) =>
          session.id ===
          projection.providerThreads.find(
            (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
          )?.providerSessionId,
      );
      assert.equal(servingSession?.model, replacementSelection.model);
    }),
  ),
);

it.live("detaches the old provider session after an active provider handoff", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("selection-provider-handoff-lifecycle");
      const threadId = ThreadId.make("thread:selection-provider-handoff-lifecycle");
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: false,
      });
      const targetStartCount = yield* Ref.make(0);
      const registry = ProviderAdapterRegistry.layerFromAdapters([
        makeRestartAdapter(state, exclusiveCapabilities),
        makeCompletingHandoffAdapter(targetStartCount),
      ]);

      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-handoff:create"),
          threadId,
          projectId: ProjectId.make("project:selection-handoff"),
          title: "Selection provider handoff",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-handoff:first"),
          threadId,
          messageId: MessageId.make("message:selection-handoff:first"),
          text: "first",
          attachments: [],
          modelSelection: initialSelection,
          dispatchMode: { type: "start_immediately" },
        });
        let activeRunId: RunId | null = null;
        for (let index = 0; index < 1_000; index += 1) {
          const current = yield* orchestrator.getThreadProjection(threadId);
          if (current.providerTurns.some((turn) => turn.status === "running")) {
            activeRunId = current.runs[0]?.id ?? null;
            break;
          }
          yield* Effect.sleep("5 millis");
        }
        if (activeRunId === null) {
          return yield* Effect.die("active provider-handoff run is missing");
        }

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-handoff:second"),
          threadId,
          messageId: MessageId.make("message:selection-handoff:second"),
          text: "second",
          attachments: [],
          modelSelection: handoffSelection,
          dispatchMode: { type: "restart_active", targetRunId: activeRunId },
        });
        for (let index = 0; index < 1_000; index += 1) {
          const current = yield* orchestrator.getThreadProjection(threadId);
          if (current.attempts.length === 2 && current.attempts[1]?.status === "completed") {
            const captured = yield* Ref.get(state);
            return { projection: current, captured };
          }
          yield* Effect.sleep("5 millis");
        }
        const current = yield* orchestrator.getThreadProjection(threadId);
        const adapterState = yield* Ref.get(state);
        const capturedTargetStartCount = yield* Ref.get(targetStartCount);
        yield* Effect.logError("active provider handoff did not complete", {
          runs: current.runs.map((run) => [run.status, run.activeAttemptId]),
          attempts: current.attempts.map((attempt) => [attempt.id, attempt.status]),
          providerTurns: current.providerTurns.map((turn) => [turn.id, turn.status]),
          providerThreads: current.providerThreads.map((thread) => [
            thread.providerInstanceId,
            thread.providerSessionId,
            thread.status,
          ]),
          targetStartCount: capturedTargetStartCount,
          adapterState,
        });
        return yield* Effect.die("active provider handoff did not complete");
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "selection-provider-handoff-lifecycle" },
            registry,
          ),
        ),
      );

      assert.lengthOf(result.projection.runs, 1);
      assert.lengthOf(result.projection.attempts, 2);
      assert.equal(result.projection.runs[0]?.providerInstanceId, handoffProviderInstanceId);
      assert.equal(result.projection.contextHandoffs.length, 1);
      assert.equal(result.captured.closedSessionCount, 1);
      assert.equal(yield* Ref.get(targetStartCount), 1);
    }),
  ),
);

it.live.each(
  (["active", "idle", "selection-command", "pooled", "separate-home"] as const).map((mode) => ({
    caseTitle: `preserves native history only for compatible account switches (${mode})`,
    mode,
  })),
)("$caseTitle", ({ mode }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `shared-home-${mode}`;
      const cwd = yield* checkpointWorkspace(name);
      const threadId = ThreadId.make(`thread:${name}`);
      const targetId = ProviderInstanceId.make("codex-shadow-account");
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: true,
      });
      const resumes: Array<{
        instanceId: ProviderInstanceId;
        nativeId: string | null | undefined;
      }> = [];
      const messages: string[] = [];
      const capabilities = mode === "pooled" ? pooledCapabilities : exclusiveCapabilities;
      const adapters = [providerInstanceId, targetId].map((instanceId) => {
        const base = makeRestartAdapter(state, capabilities, instanceId);
        return {
          ...base,
          openSession: (input) =>
            base.openSession(input).pipe(
              Effect.map((session) => ({
                ...session,
                resumeThread: (input) =>
                  Effect.gen(function* () {
                    resumes.push({
                      instanceId,
                      nativeId: input.providerThread.nativeThreadRef?.nativeId,
                    });
                    return yield* session.resumeThread(input);
                  }),
                startTurn: (input) =>
                  Effect.gen(function* () {
                    messages.push(input.message.text);
                    yield* session.startTurn(input);
                  }),
              })),
            ),
        } satisfies ProviderAdapterV2Shape;
      });
      const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
        get: (instanceId) =>
          Effect.succeed(adapters.find((adapter) => adapter.instanceId === instanceId)!),
        list: () => Effect.succeed([providerInstanceId, targetId]),
        getMetadata: (instanceId) =>
          Effect.succeed({
            driver,
            continuationKey:
              mode === "separate-home" ? `codex:home:/${instanceId}` : "codex:home:/shared",
            enabled: true,
            capabilities,
          }),
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const selection = {
          ...initialSelection,
          model: mode === "active" ? initialSelection.model : "complete",
        };
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const dispatch = (step: string, modelSelection: ModelSelection, targetRunId?: RunId) =>
          Effect.gen(function* () {
            const terminal = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter((event) =>
                mode === "active" && step === "first"
                  ? event.type === "provider-turn.updated" && event.payload.status === "running"
                  : event.type === "run.updated" && event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${name}:${step}`),
              threadId,
              messageId: MessageId.make(`${name}:${step}`),
              text: step,
              attachments: [],
              modelSelection,
              dispatchMode:
                targetRunId === undefined
                  ? { type: "start_immediately" }
                  : { type: "restart_active", targetRunId },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            yield* Fiber.join(terminal);
            yield* worker.drain();
            return yield* orchestrator.getThreadProjection(threadId);
          });
        const first = yield* dispatch("first", selection);
        const originalThread = first.providerThreads.find(
          (thread) => thread.id === first.thread.activeProviderThreadId,
        )!;
        const targetSelection = { instanceId: targetId, model: "complete" };
        if (mode === "selection-command") {
          yield* orchestrator.dispatch({
            type: "provider.switch",
            commandId: CommandId.make(`${name}:switch`),
            threadId,
            modelSelection: targetSelection,
          });
          yield* worker.drain();
        }
        const second = yield* dispatch(
          "second",
          targetSelection,
          mode === "active" ? first.runs[0]!.id : undefined,
        );
        const targetThread = second.providerThreads.find(
          (thread) => thread.id === second.thread.activeProviderThreadId,
        )!;
        if (mode === "separate-home") {
          assert.notEqual(targetThread.id, originalThread.id);
          assert.lengthOf(second.contextHandoffs, 1);
          assert.lengthOf(second.contextTransfers, 1);
          assert.isEmpty(resumes);
          assert.notEqual(messages[1], "second");
          return;
        }
        assert.equal(targetThread.id, originalThread.id);
        assert.deepEqual(targetThread.nativeThreadRef, originalThread.nativeThreadRef);
        assert.equal(targetThread.providerInstanceId, targetId);
        assert.notEqual(targetThread.providerSessionId, originalThread.providerSessionId);
        assert.isEmpty(second.contextHandoffs);
        assert.isEmpty(second.contextTransfers);
        assert.deepEqual(resumes, [
          { instanceId: targetId, nativeId: originalThread.nativeThreadRef?.nativeId },
        ]);
        assert.deepEqual(messages, ["first", "second"]);
        assert.equal((yield* Ref.get(state)).closedSessionCount, mode === "pooled" ? 0 : 1);
        if (mode === "pooled") {
          assert.isFalse(
            second.providerSessions.some(
              (session) => session.id === originalThread.providerSessionId,
            ),
          );
        }
        const third = yield* dispatch("third", { ...selection, model: "complete" });
        const returnedThread = third.providerThreads.find(
          (thread) => thread.id === third.thread.activeProviderThreadId,
        )!;
        assert.equal(returnedThread.id, originalThread.id);
        assert.deepEqual(returnedThread.nativeThreadRef, originalThread.nativeThreadRef);
        assert.equal(returnedThread.providerInstanceId, providerInstanceId);
        assert.isEmpty(third.contextHandoffs);
        assert.deepEqual(messages, ["first", "second", "third"]);
      }).pipe(Effect.provide(makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry)));
    }),
  ),
);

// A durable cursor and SQL reread close the commit/read race without timing assumptions.
const awaitModesProjection = Effect.fn("test.awaitModesProjection")(function* (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  ready: (projection: OrchestrationV2ThreadProjection) => boolean,
  description: string,
) {
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const result = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(
    Stream.filter(ready),
    Stream.runHead,
    Effect.timeout("15 seconds"),
    Effect.tapError(() =>
      orchestrator.getThreadProjection(threadId).pipe(
        Effect.flatMap((p) =>
          Effect.logError(description, {
            runs: p.runs.map((r) => [r.id, r.status, r.queueHeld]),
            attempts: p.attempts.map((a) => [a.id, a.status]),
            turns: p.providerTurns.map((t) => [t.id, t.status]),
          }),
        ),
      ),
    ),
  );
  if (Option.isNone(result)) return yield* Effect.die("Missing durable execution-mode state");
  return result.value;
});

it.live("captures ordinary and queued execution modes before worker delivery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "captured-run-modes";
      const cwd = yield* checkpointWorkspace(name);
      const threadId = ThreadId.make(`thread:${name}`);
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${name}:first`),
          threadId,
          messageId: MessageId.make(`${name}:first`),
          text: "first",
          attachments: [],
          runtimeMode: "approval-required",
          interactionMode: "plan",
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        let projected = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projected.runs[0]?.runtimeMode, "approval-required");
        assert.equal(projected.runs[0]?.interactionMode, "plan");
        assert.lengthOf((yield* Ref.get(state)).started, 0);
        // A later metadata edit cannot change an already admitted run's policy.
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`${name}:later-mode`),
          threadId,
          runtimeMode: "full-access",
        });
        yield* orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(`${name}:later-interaction`),
          threadId,
          interactionMode: "default",
        });
        yield* worker.drain();
        projected = yield* awaitModesProjection(
          orchestrator,
          threadId,
          (p) => p.providerTurns.some((t) => t.status === "running"),
          "first captured run did not start",
        );
        assert.deepEqual(
          (yield* Ref.get(state)).offeredPolicies?.map((p) => [p.runtimeMode, p.interactionMode]),
          [["approval-required", "plan"]],
        );
        const activeRun = projected.runs[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${name}:queued`),
          threadId,
          messageId: MessageId.make(`${name}:queued`),
          text: "queued",
          attachments: [],
          modelSelection: seedSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        projected = yield* orchestrator.getThreadProjection(threadId);
        const queued = projected.runs.find((r) => r.status === "queued")!;
        assert.equal(queued.runtimeMode, "approval-required");
        assert.equal(queued.interactionMode, "plan");
        assert.equal(
          projected.thread.runtimeMode,
          "full-access",
          "Queue admission must leave active thread policy untouched",
        );
        assert.equal(projected.thread.interactionMode, "default");
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`${name}:interrupt`),
          threadId,
          runId: activeRun.id,
          holdQueue: true,
        });
        yield* worker.drain();
        yield* awaitModesProjection(
          orchestrator,
          threadId,
          (p) => !["starting", "running", "waiting"].includes(p.runs[0]!.status),
          "interrupted captured run did not settle",
        );
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${name}:resume`),
          threadId,
        });
        yield* worker.drain();
        yield* awaitModesProjection(
          orchestrator,
          threadId,
          (p) => p.attempts.find((a) => a.runId === queued.id)?.status === "completed",
          "resumed provider attempt did not settle",
        );
        yield* worker.drain();
        projected = yield* awaitModesProjection(
          orchestrator,
          threadId,
          (p) => p.runs.find((r) => r.id === queued.id)?.status === "completed",
          "resumed captured queue did not complete",
        );
        assert.deepEqual(
          (yield* Ref.get(state)).offeredPolicies?.map((p) => [p.runtimeMode, p.interactionMode]),
          [
            ["approval-required", "plan"],
            ["approval-required", "plan"],
          ],
        );
        assert.equal(projected.thread.runtimeMode, "approval-required");
        assert.equal(projected.thread.interactionMode, "plan");
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name },
            ProviderAdapterRegistry.layerSingle(makeRestartAdapter(state)),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);

it.live.each(
  [
    { olderRun: false, sameModes: false },
    { olderRun: true, sameModes: false },
    { olderRun: true, sameModes: true },
  ].map(({ olderRun, sameModes }) => {
    const requestedMode: "full-access" | "approval-required" = sameModes
      ? "full-access"
      : "approval-required";
    const requestedInteraction: "default" | "plan" = sameModes ? "default" : "plan";

    return {
      caseTitle: `restarts active steering with captured modes (older run ${olderRun}, same modes ${sameModes})`,
      olderRun,
      sameModes,
      requestedMode,
      requestedInteraction,
    };
  }),
)("$caseTitle", ({ olderRun, sameModes, requestedMode, requestedInteraction }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `captured-steer-modes-${olderRun}-${sameModes}`;
      const cwd = yield* checkpointWorkspace(name);
      const threadId = ThreadId.make(`thread:${name}`);
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: true,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${name}:first`),
          threadId,
          messageId: MessageId.make(`${name}:first`),
          text: "first",
          attachments: [],
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const original = yield* awaitModesProjection(
          orchestrator,
          threadId,
          (p) => p.providerTurns.some((t) => t.status === "running"),
          "first captured run did not start",
        );
        if (olderRun) {
          const sink = yield* EventSink.EventSinkV2;
          const priorRun = original.runs[0]!;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${name}:older-run`),
                type: "run.updated",
                threadId,
                runId: priorRun.id,
                ...(priorRun.rootNodeId === null ? {} : { nodeId: priorRun.rootNodeId }),
                providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...priorRun, runtimeMode: undefined, interactionMode: undefined },
              },
            ],
          });
          // The UI may already have persisted its next-turn settings. They do
          // not prove what permissions the older native turn was started with.
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(`${name}:next-mode`),
            threadId,
            runtimeMode: requestedMode,
          });
          yield* orchestrator.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(`${name}:next-interaction`),
            threadId,
            interactionMode: requestedInteraction,
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${name}:steer`),
          threadId,
          messageId: MessageId.make(`${name}:steer`),
          text: "second",
          attachments: [],
          runtimeMode: requestedMode,
          interactionMode: requestedInteraction,
          dispatchMode: { type: "steer_active", targetRunId: original.runs[0]!.id },
          createdBy: "user",
          creationSource: "web",
        });
        const admitted = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(admitted.runs[0]?.runtimeMode, requestedMode);
        assert.equal(admitted.runs[0]?.interactionMode, requestedInteraction);
        assert.equal(admitted.attempts[0]?.status, "superseded");
        yield* worker.drain();
        const restarted = yield* awaitModesProjection(
          orchestrator,
          threadId,
          (p) =>
            p.attempts.length === 2 &&
            p.attempts[1]?.status === "running" &&
            p.providerTurns.some(
              (turn) => turn.runAttemptId === p.attempts[1]?.id && turn.status === "running",
            ),
          "captured steer restart did not start",
        );
        assert.deepEqual(
          (yield* Ref.get(state)).offeredPolicies?.map((p) => [p.runtimeMode, p.interactionMode]),
          [
            ["full-access", "default"],
            [requestedMode, requestedInteraction],
          ],
        );
        assert.notEqual(
          restarted.providerThreads[0]?.providerSessionId,
          original.providerThreads[0]?.providerSessionId,
        );
        assert.equal(restarted.thread.runtimeMode, requestedMode);
        assert.equal(restarted.thread.interactionMode, requestedInteraction);
        if (sameModes) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}:next-steer`),
            threadId,
            messageId: MessageId.make(`${name}:next-steer`),
            text: "third",
            attachments: [],
            runtimeMode: requestedMode,
            interactionMode: requestedInteraction,
            dispatchMode: { type: "steer_active", targetRunId: restarted.runs[0]!.id },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          const continued = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(continued.attempts.length, 2);
          assert.equal((yield* Ref.get(state)).opened.length, 2);
          assert.equal((yield* Ref.get(state)).started.length, 2);
        }
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name },
            ProviderAdapterRegistry.layerSingle(makeRestartAdapter(state)),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);

it.live("replaces an idle Grok session before a direct send changes its access mode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "idle-grok-captured-send-mode";
      const cwd = yield* checkpointWorkspace(name);
      const threadId = ThreadId.make(`thread:${name}`);
      const instanceId = ProviderInstanceId.make("grok-captured-send-mode");
      const selection = { instanceId, model: "complete" };
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: true,
      });
      const adapter = makeRestartAdapter(
        state,
        GrokProviderCapabilitiesV2,
        instanceId,
        ProviderDriverKind.make("grok"),
      );
      const registry = ProviderAdapterRegistry.layerSingle(adapter);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        const dispatch = Effect.fn(function* (
          step: string,
          runtimeMode: "full-access" | "approval-required",
        ) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${name}:${step}`),
            threadId,
            messageId: MessageId.make(`${name}:${step}`),
            text: step,
            attachments: [],
            modelSelection: selection,
            runtimeMode,
            interactionMode: "default",
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          const projected = yield* awaitModesProjection(
            orchestrator,
            threadId,
            (p) =>
              p.runs.some((r) => r.userMessageId === `${name}:${step}` && r.status === "completed"),
            "idle Grok send did not complete",
          );
          yield* worker.drain();
          return projected;
        });
        const first = yield* dispatch("first", "full-access");
        const original = first.providerThreads.find(
          (t) => t.id === first.thread.activeProviderThreadId,
        )!;
        assert.isNotNull(original.providerSessionId);
        assert.equal(first.thread.runtimeMode, "full-access");
        // No thread.runtime-mode.set precedes this legal direct message command.
        const second = yield* dispatch("second", "approval-required");
        const replacement = second.providerThreads.find(
          (t) => t.id === second.thread.activeProviderThreadId,
        )!;
        assert.notEqual(replacement.providerSessionId, original.providerSessionId);
        assert.deepEqual(replacement.nativeThreadRef, original.nativeThreadRef);
        assert.isUndefined(
          second.providerSessions.find((s) => s.id === original.providerSessionId),
        );
        const sink = yield* EventSink.EventSinkV2;
        const stored = yield* sink
          .readByCommandId({ commandId: CommandId.make(`${name}:second`) })
          .pipe(Stream.runCollect);
        assert.deepEqual(
          stored.flatMap((row) =>
            row.event.type === "provider-session.detached"
              ? [row.event.payload.providerSessionId]
              : [],
          ),
          [original.providerSessionId],
        );
        assert.equal(second.thread.runtimeMode, "approval-required");
        assert.equal(
          second.runs.find((r) => r.userMessageId === `${name}:second`)?.runtimeMode,
          "approval-required",
        );
        const captured = yield* Ref.get(state);
        assert.equal(captured.closedSessionCount, 1);
        assert.deepEqual(
          captured.opened.map((p) => p.runtimeMode),
          ["full-access", "approval-required"],
        );
        assert.deepEqual(
          captured.offeredPolicies?.map((p) => p.runtimeMode),
          ["full-access", "approval-required"],
        );
      }).pipe(Effect.provide(makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry)));
    }),
  ),
);
