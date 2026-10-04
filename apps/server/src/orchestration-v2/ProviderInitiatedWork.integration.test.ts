import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorV2, type OrchestratorV2Error } from "./Orchestrator.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
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

type Offer = { input: ProviderAdapterV2TurnInput; finish: Effect.Effect<void> };
const withInitiatedWork = <A, E, R>(
  run: (h: {
    orchestrator: OrchestratorV2["Service"];
    emitWork: (
      workId: string,
      overrides?: Partial<ProviderContinuationRequest>,
    ) => Effect.Effect<void>;
    takeOffer: Effect.Effect<Offer, Cause.TimeoutError>;
    prompts: ReadonlyArray<string>;
    adopted: ReadonlyArray<string>;
    dropped: () => number;
    closes: () => number;
    waitFor: (
      predicate: (p: OrchestrationV2ThreadProjection) => boolean,
    ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("provider-initiated-work");
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const offers = yield* Queue.unbounded<Offer>();
      const buffered = new Map<string, string>();
      const prompts: string[] = [];
      const adopted: string[] = [];
      let closed = 0;
      let dropped = 0;
      let emitWork: (
        workId: string,
        overrides?: Partial<ProviderContinuationRequest>,
      ) => Effect.Effect<void> = () => Effect.die("Native session must be open");
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
                      initiated: {
                        providerInstanceId: instanceId,
                        providerSessionId: input.providerSessionId,
                        workId,
                      },
                      clearIfCurrent: () =>
                        Effect.sync(() => {
                          buffered.delete(workId);
                          dropped++;
                        }),
                      ...overrides,
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
                  providerSession: {
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
                  },
                  events: Stream.fromQueue(events),
                  ensureThread: (thread) =>
                    Effect.sync(() => {
                      nativeThread = {
                        ...nativeThread,
                        id: thread.existingProviderThread?.id ?? nativeThread.id,
                      };
                      return nativeThread;
                    }),
                  resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
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
                      } else prompts.push(turn.message.text);
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
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "provider-initiated-work", runtimePolicyOverride: { cwd } },
        registry,
        { runContinuationWorker: true, configureMcp: false },
      );
      return yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:initiated"),
          threadId,
          projectId,
          title: "Native work",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
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
            return yield* Effect.die("Missing durable initiated-work receipt");
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
        const first = yield* Queue.take(offers).pipe(Effect.timeout("10 seconds"));
        yield* first.finish;
        yield* waitFor((p) => p.runs[0]?.status === "completed");
        return yield* run({
          orchestrator,
          emitWork: (id, override) => emitWork(id, override),
          takeOffer: Queue.take(offers).pipe(Effect.timeout("10 seconds")),
          prompts,
          adopted,
          closes: () => closed,
          dropped: () => dropped,
          waitFor,
        });
      }).pipe(Effect.provide(layer));
    }),
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
        assert.deepEqual(background.input.message.notification?.source, {
          kind: "provider_work",
          workId: "extension-work-1",
        });
        assert.deepEqual(prompts, ["First user message"]);
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
        assert.equal(next.input.message.text, "Next user message");
        yield* next.finish;
        yield* waitFor((p) => p.runs.length === 3 && p.runs.every((r) => r.status === "completed"));
        assert.deepEqual(adopted, ["extension-work-1"]);
        assert.deepEqual(prompts, ["First user message", "Next user message"]);
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
] as const)("rejects unsolicited work with no current native owner: %s", (scenario) =>
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
      const overrides: Partial<ProviderContinuationRequest> =
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
        scenario === "busy" ? ["First user message", "Busy user message"] : ["First user message"],
      );
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).runs,
        scenario === "busy" ? 2 : 1,
      );
      if (active !== undefined) yield* active.finish;
    }),
  ),
);
