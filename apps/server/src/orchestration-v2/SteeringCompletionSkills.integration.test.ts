import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AcpProviderCapabilitiesV2 } from "./Adapters/AcpAdapterV2.ts";
import { makeNativeSessionAdapterV2 } from "./Adapters/NativeSessionAdapterV2.ts";
import { OrchestrationEffectWorkerV2, runDaemonWithOptions } from "./EffectWorker.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

class SteeringFixtureWaitError extends Schema.TaggedError<SteeringFixtureWaitError>()(
  "SteeringFixtureWaitError",
  { phase: Schema.String, state: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `${this.phase}: ${this.state}`;
  }
}

for (const selection of [
  { label: "explicit selection", names: ["explicitly-selected"] },
  { label: "explicit empty selection", names: [] },
  { label: "omitted selection", names: undefined },
]) {
  it.live(
    `preserves ${selection.label} when completed native steering redispatches through the durable worker`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("steer-completion-skills");
          const allocator = yield* IdAllocatorV2;
          const offered = yield* Queue.unbounded<string>();
          const finish = yield* Deferred.make<Effect.Effect<void>>();
          const instanceId = ProviderInstanceId.make("omp");
          const modelSelection = { instanceId, model: "steer-completion-model" };
          let nativeSteers = 0;
          const adapter = makeNativeSessionAdapterV2({
            instanceId,
            driver: ProviderDriverKind.make("omp"),
            capabilities: {
              ...AcpProviderCapabilitiesV2,
              turns: { ...AcpProviderCapabilitiesV2.turns, supportsActiveSteering: true },
            },
            idAllocator: allocator,
            defaultCwd: cwd,
            continuations: { offer: () => Effect.die("No continuation in this fixture") },
            open: (input, publish) =>
              Effect.succeed({
                nativeId: `steer-completion:${input.providerSessionId}`,
                nativeThreadKnown: true,
                resume: () => Effect.void,
                respond: () => Effect.die("No question in this fixture"),
                interrupt: publish({ type: "terminal", status: "cancelled" }),
                steer: () =>
                  Effect.sync(() => {
                    nativeSteers += 1;
                  }),
                send: (turn) =>
                  Effect.gen(function* () {
                    yield* Queue.offer(offered, turn.message.text);
                    yield* Deferred.succeed(
                      finish,
                      publish({ type: "terminal", status: "completed" }),
                    );
                  }),
              }),
          });
          const layer = makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "steer-completion-skills", runtimePolicyOverride: { cwd } },
            makeLayer([adapter]),
            { configureMcp: false, runEffectWorker: false },
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            const threadId = ThreadId.make("steer-completion-thread");
            const followupId = MessageId.make("steer-completion-followup");
            const takeOffer = (phase: string) =>
              Queue.take(offered).pipe(
                Effect.timeout("10 seconds"),
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    const projection = yield* orchestrator.getThreadProjection(threadId);
                    return yield* new SteeringFixtureWaitError({
                      phase,
                      state:
                        projection.runs.map((run) => `run${run.ordinal}:${run.status}`).join(",") +
                        "; " +
                        projection.turnItems
                          .flatMap((item) =>
                            item.type === "error"
                              ? [`${item.title}:${item.failure.message.slice(0, 300)}`]
                              : [],
                          )
                          .join(","),
                      cause,
                    });
                  }),
                ),
              );
            const waitFor = Effect.fnUntraced(function* (
              predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
            ) {
              const cursor = yield* orchestrator.getThreadEventSequence(threadId);
              const pull = yield* Stream.toPull(
                orchestrator.streamStoredEventsFrom({
                  threadId,
                  afterSequence: cursor,
                }),
              );
              const result = yield* Stream.concat(
                Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
                Stream.fromPull(Effect.succeed(pull)).pipe(
                  Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
                ),
              ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("10 seconds"));
              assert.isTrue(Option.isSome(result));
              if (Option.isNone(result)) return yield* Effect.die("Projection did not converge");
              return result.value;
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("steer-completion-create"),
              threadId,
              projectId: ProjectId.make("steer-completion-project"),
              title: "Steer race",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("steer-completion-start"),
              threadId,
              messageId: MessageId.make("steer-completion-first"),
              text: "Foreground",
              attachments: [],
              selectedScientSkillNames: ["prior-foreground-selection"],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain(8);
            assert.equal(yield* takeOffer("foreground native offer"), "Foreground");
            const active = yield* waitFor((projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const run = active.runs.find((candidate) => candidate.status === "running");
            assert.ok(run);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("steer-completion-steer"),
              threadId,
              messageId: followupId,
              text: "Follow-up with selected skill",
              attachments: [],
              ...(selection.names === undefined
                ? {}
                : { selectedScientSkillNames: selection.names }),
              dispatchMode: { type: "steer_active", targetRunId: run.id },
              createdBy: "user",
              creationSource: "web",
            });
            // The real native terminal commits before the durable steer effect is claimed.
            yield* yield* Deferred.await(finish);
            yield* waitFor((projection) =>
              projection.providerTurns.some(
                (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "completed",
              ),
            );
            // Start the production worker only after the exact terminal receipt. Its
            // post-commit wake also processes finalization effects admitted afterward.
            yield* runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
            assert.equal(
              yield* takeOffer("follow-up native offer"),
              "Follow-up with selected skill",
            );
            const projection = yield* waitFor((current) => current.providerTurns.length === 2);
            assert.equal(nativeSteers, 0);
            const message = projection.messages.find((candidate) => candidate.id === followupId);
            assert.ok(message);
            assert.deepEqual(message.selectedScientSkillNames, selection.names);
            assert.equal(
              projection.messages.filter((candidate) => candidate.id === followupId).length,
              1,
            );
            assert.notEqual(message.runId, run.id);
            assert.deepEqual(
              (yield* orchestrator.getThreadProjection(threadId)).messages.find(
                (candidate) => candidate.id === followupId,
              )?.selectedScientSkillNames,
              selection.names,
            );
          }).pipe(Effect.provide(layer));
        }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, idAllocatorLayer))),
      ),
  );
}
