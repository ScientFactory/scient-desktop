import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexOrchestratorReplayHarness } from "./Adapters/CodexAdapterV2.testkit.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import { PROPOSED_PLAN_PROMPT } from "./testkit/fixtures/shared.ts";

it.live.each(["run.interrupt", "thread.stop"] as const)(
  "public %s cancels a blocked Git baseline before any native message offer",
  (stopType) =>
    Effect.gen(function* () {
      const name = `stop-during-preparation-${stopType}`;
      const cwd = yield* checkpointWorkspace(name);
      yield* (yield* FileSystem.FileSystem).writeFileString(
        `${cwd}/untracked.txt`,
        "Pending checkpoint\n",
      );
      const captureStarted = yield* Deferred.make<void>();
      const releaseCapture = yield* Deferred.make<void>();
      const captureInterrupted = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseCapture, undefined));
      let gated = false;
      const vcsProcessLayer = Layer.effect(
        VcsProcess.VcsProcess,
        Effect.map(VcsProcess.VcsProcess, (process) => ({
          run: (input) =>
            process.run({
              ...input,
              ...(input.operation !== VcsProcess.CHECKPOINT_CAPTURE_OPERATION ||
              !input.args.includes("--porcelain=v1")
                ? {}
                : {
                    onStdoutChunkEffect: (chunk: Uint8Array) =>
                      Effect.gen(function* () {
                        if (!gated) {
                          gated = true;
                          yield* Deferred.succeed(captureStarted, undefined);
                          yield* Deferred.await(releaseCapture).pipe(
                            Effect.onInterrupt(() =>
                              Deferred.succeed(captureInterrupted, undefined),
                            ),
                          );
                        }
                        yield* input.onStdoutChunkEffect?.(chunk) ?? Effect.void;
                      }),
                  }),
            }),
        })),
      ).pipe(Layer.provide(VcsProcess.layer), Layer.provide(NodeServices.layer));
      const recorded = yield* readProviderReplayTranscript(
        new URL("./testkit/fixtures/proposed_plan/codex_transcript.ndjson", import.meta.url),
      );
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(recorded, cwd),
      );
      let nativeOffers = 0;
      const registry = Layer.effect(
        ProviderAdapterRegistryV2,
        Effect.map(ProviderAdapterRegistryV2, (registry) => ({
          ...registry,
          get: (instanceId) =>
            registry.get(instanceId).pipe(
              Effect.map((adapter) => ({
                ...adapter,
                openSession: (input) =>
                  adapter.openSession(input).pipe(
                    Effect.map((session) => ({
                      ...session,
                      startTurn: (input) =>
                        Effect.sync(() => {
                          nativeOffers += 1;
                        }).pipe(Effect.andThen(session.startTurn(input))),
                    })),
                  ),
              })),
            ),
        })),
      ).pipe(
        Layer.provide(CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript)),
      );
      const layer = layerWithRegistry(
        {
          name,
          runtimePolicyOverride: {
            cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
        },
        registry,
        { configureMcp: false, runEffectWorker: false, vcsProcessLayer },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const sink = yield* EventSinkV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(name);
        const projectId = ProjectId.make(`${name}-project`);
        const now = yield* DateTime.now;
        yield* sink.commitProjectCommand({
          commandId: CommandId.make(`${name}-project`),
          projectId,
          commandType: "project.created",
          acceptedAt: now,
          event: {
            eventId: EventId.make(`${name}-project`),
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
              workspaceRoot: cwd,
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}-thread`),
          threadId,
          projectId,
          title: name,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${name}-prompt`),
          threadId,
          messageId: MessageId.make(`${name}-prompt`),
          text: PROPOSED_PLAN_PROMPT,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const starting = yield* worker.drain(12).pipe(Effect.forkScoped);
        yield* Deferred.await(captureStarted).pipe(Effect.timeout("15 seconds"));
        const before = yield* orchestrator.getThreadProjection(threadId);
        const run = before.runs[0]!;
        assert.equal(run.status, "running");
        assert.isEmpty(before.providerTurns);
        const cursor = yield* orchestrator.getThreadEventSequence(threadId);
        const pull = yield* Stream.toPull(
          orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
        );
        for (const commandId of [
          CommandId.make(`${name}-stop`),
          CommandId.make(`${name}-stop-again`),
        ]) {
          yield* orchestrator.dispatch(
            stopType === "run.interrupt"
              ? {
                  type: stopType,
                  commandId,
                  threadId,
                  runId: run.id,
                  holdQueue: true,
                }
              : { type: stopType, commandId, threadId },
          );
        }
        yield* Deferred.await(captureInterrupted).pipe(Effect.timeout("5 seconds"));
        const stopped = yield* Stream.fromPull(Effect.succeed(pull)).pipe(
          Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
          Stream.filter((projection) => projection.runs[0]?.status === "interrupted"),
          Stream.runHead,
          Effect.timeout("5 seconds"),
        );
        assert.isTrue(Option.isSome(stopped));
        assert.equal(nativeOffers, 0);
        assert.isFalse(yield* Deferred.isDone(releaseCapture));
        yield* Fiber.join(starting).pipe(Effect.timeout("5 seconds"));
        assert.isEmpty((yield* orchestrator.getThreadProjection(threadId)).providerTurns);
        const scopeId = before.nodes.find((node) => node.id === run.rootNodeId)!.checkpointScopeId;
        const scope = before.checkpointScopes.find((scope) => scope.id === scopeId)!;
        // A subsequent real capture proves the interrupted operation released the workspace lock.
        yield* (yield* CheckpointServiceV2)
          .captureBaseline({ scope, ordinalWithinScope: 0 })
          .pipe(Effect.timeout("5 seconds"));
        assert.equal(
          yield* (yield* FileSystem.FileSystem).readFileString(`${cwd}/untracked.txt`),
          "Pending checkpoint\n",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
