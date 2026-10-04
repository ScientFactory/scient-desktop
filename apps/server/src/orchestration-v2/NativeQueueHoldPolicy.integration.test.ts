import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { AcpProviderCapabilitiesV2 } from "./Adapters/AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  type NativeSessionUpdate,
} from "./Adapters/NativeSessionAdapterV2.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2, type OrchestratorV2Error } from "./Orchestrator.ts";
import type { ProviderAdapterV2TurnInput } from "./ProviderAdapter.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

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
  options: { readonly holdFirstSend?: boolean } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const allocator = yield* IdAllocatorV2;
      const offered = yield* Queue.unbounded<NativeOffer>();
      const firstSendReleased = yield* Deferred.make<void>();
      const offers: string[] = [];
      let nativeInterruptions = 0;
      const adapter = makeNativeSessionAdapterV2({
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
            send: (turn) =>
              Effect.gen(function* () {
                offers.push(turn.message.text);
                const released =
                  options.holdFirstSend && offers.length === 1
                    ? firstSendReleased
                    : yield* Deferred.make<void>();
                yield* Queue.offer(offered, {
                  input: turn,
                  releaseSend: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
                  settle: (status) =>
                    publish({
                      type: "terminal",
                      status,
                      ...(status === "failed"
                        ? { detail: "Controlled native provider failure" }
                        : {}),
                    }),
                });
                if (options.holdFirstSend && offers.length === 1) yield* Deferred.await(released);
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
      });
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        {
          name,
          runtimePolicyOverride: { cwd },
        },
        makeLayer([
          options.holdFirstSend
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
