import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import { makeOmpAdapterV2 } from "../Adapters/OmpAdapterV2.ts";
import { validateProviderCurrentInput } from "../ScientCurrentInput.ts";
import { NativeSessionOperationError } from "../Adapters/NativeSessionAdapterV2.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { EventStoreV2 } from "../EventStore.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "../Orchestrator.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import type { ProviderAdapterV2Error } from "@t3tools/provider-core/server/ProviderAdapter";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const waitFor = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const found = yield* Stream.concat(
    Stream.succeed(yield* orchestrator.getThreadProjection(threadId)),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  return Option.getOrThrow(found);
});

it.live.each(
  (["composed-frame-overflow", "configuration-command"] as const).map((scenario) => ({
    caseTitle: `persists an owned never-offered native OMP ${scenario} preflight failure`,
    scenario,
  })),
)("$caseTitle", ({ scenario }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `native-preflight-${scenario}`;
      const cwd = yield* checkpointWorkspace(name);
      const config = yield* makeReplayServerConfig(name);
      const instanceId = ProviderInstanceId.make(name);
      const threadId = ThreadId.make(name);
      const modelSelection = { instanceId, model: "test/selected" };
      const fs = yield* FileSystem.FileSystem;
      const peer = scriptedOmpRpc({
        models: [{ provider: "test", id: "selected", input: ["text"] }],
        initial: { provider: "test", id: "selected" },
        maxFrameBytes: 1024,
      });
      const adapter = makeOmpAdapterV2({
        instanceId,
        settings: { binaryPath: "controlled-omp-peer" },
        environment: {},
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        fileSystem: fs,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        serverConfig: config,
        idAllocator: yield* IdAllocatorV2,
        continuations: { offer: () => Effect.die("No unsolicited work in preflight fixture") },
        makeProcess: peer.makeProcess,
      });
      const startFailures: ProviderAdapterV2Error[] = [];
      const observedAdapter = {
        ...adapter,
        openSession: (input: Parameters<typeof adapter.openSession>[0]) =>
          adapter.openSession(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              startTurn: (turn: Parameters<typeof runtime.startTurn>[0]) =>
                runtime.startTurn(turn).pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      startFailures.push(error);
                    }),
                  ),
                ),
            })),
          ),
      };
      const attachments: ChatAttachment[] = [];
      if (scenario === "composed-frame-overflow") {
        // Even the file-backed prompt fallback cannot fit these intact descriptors.
        for (let index = 0; index < 8; index++) {
          const id = createAttachmentId(threadId);
          assert.ok(id);
          const attachment = {
            type: "file" as const,
            id: ChatAttachmentId.make(id),
            name: `archive-${index}.zip`,
            mimeType: "application/zip",
            sizeBytes: 1024,
          };
          const stored = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          assert.ok(stored);
          yield* fs.writeFile(stored, new Uint8Array(1024));
          attachments.push(attachment);
        }
      }
      const text = scenario === "composed-frame-overflow" ? "u".repeat(10_000) : "/model";
      assert.isTrue(
        Result.isSuccess(
          validateProviderCurrentInput({
            text,
            attachments,
            attachmentsDir: config.attachmentsDir,
          }),
        ),
        "The fixture must pass complete-current-input validation before native preflight",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const planId = PlanId.make(`${name}:plan`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId: ProjectId.make(`${name}:project`),
          title: name,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* (yield* EventSinkV2).write({
          events: [
            {
              id: EventId.make(`${name}:plan-event`),
              threadId,
              type: "plan.updated",
              occurredAt: yield* DateTime.now,
              payload: {
                id: planId,
                threadId,
                runId: null,
                nodeId: NodeId.make(`${name}:plan-node`),
                kind: "proposed_plan",
                status: "active",
                markdown: "# Preserve before acceptance",
              },
            },
          ],
        });
        const admission = yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${name}:send`),
          threadId,
          messageId: MessageId.make(`${name}:message`),
          text,
          attachments,
          modelSelection,
          sourcePlanRef: { threadId, planId },
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const created = admission.storedEvents.find(
          ({ event }) => event.type === "run.created",
        )?.event;
        assert.ok(created?.type === "run.created");
        const failed = yield* waitFor(threadId, (projection) =>
          projection.runs.some((run) => run.id === created.payload.id && run.status === "failed"),
        );
        const run = failed.runs.find((candidate) => candidate.id === created.payload.id);
        assert.ok(run);
        const receipt = failed.providerTurns.find(
          (turn) => turn.runAttemptId === run.activeAttemptId,
        );
        assert.ok(
          receipt,
          "The real adapter must propagate its owned pre-wire receipt through the worker",
        );
        assert.equal(receipt.nativeAcceptance, "pending");
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.acceptedAt, undefined);
        assert.equal(receipt.nodeId, run.rootNodeId);
        assert.equal(receipt.providerThreadId, run.providerThreadId);
        const attempt = failed.attempts.find((candidate) => candidate.id === run.activeAttemptId);
        assert.ok(attempt);
        assert.equal(attempt.runId, run.id);
        assert.equal(attempt.rootNodeId, receipt.nodeId);
        assert.equal(attempt.providerThreadId, receipt.providerThreadId);
        assert.equal(attempt.status, "failed");
        assert.lengthOf(
          failed.providerTurns.filter((turn) => turn.runAttemptId === run.activeAttemptId),
          1,
        );
        assert.equal(receipt.nativeTurnRef?.strength, "weak");
        assert.equal(failed.plans.find((plan) => plan.id === planId)?.status, "active");
        const plan = failed.plans.find((candidate) => candidate.id === planId);
        assert.ok(plan?.kind === "proposed_plan");
        assert.equal(plan.consumedBy, undefined);
        const message = failed.turnItems.find(
          (item) =>
            item.type === "user_message" && item.messageId === MessageId.make(`${name}:message`),
        );
        assert.ok(message?.type === "user_message");
        assert.equal(message.text, text);
        assert.deepEqual(message.attachments, attachments);
        assert.lengthOf(peer.state.prompts, 0);
        assert.isFalse(
          peer.state.frames.some(
            (frame) =>
              frame.type === "prompt" || frame.type === "steer" || frame.type === "follow_up",
          ),
        );
        assert.isTrue(
          peer.state.frames.some((frame) => frame.type === "get_state"),
          "A genuine native session opened before the turn's preflight failed",
        );
        const failure = failed.turnItems.find(
          (item) => item.type === "error" && item.runId === run.id,
        );
        assert.ok(failure?.type === "error");
        assert.equal(failure.failure.class, "provider_error");
        assert.lengthOf(startFailures, 1);
        const startFailure = startFailures[0]!;
        assert.equal(startFailure._tag, "ProviderAdapterTurnStartError");
        if (startFailure._tag !== "ProviderAdapterTurnStartError")
          return yield* Effect.die("Missing trusted native start receipt");
        assert.equal(startFailure.runId, run.id);
        assert.equal(startFailure.threadId, threadId);
        assert.equal(startFailure.providerThreadId, receipt.providerThreadId);
        assert.equal(startFailure.providerTurn?.id, receipt.id);
        assert.equal(startFailure.providerTurn?.nativeAcceptance, "pending");
        const isNativeFailure = Schema.is(NativeSessionOperationError);
        assert.isTrue(isNativeFailure(startFailure.cause));
        if (!isNativeFailure(startFailure.cause))
          return yield* Effect.die("Missing real native preflight failure");
        assert.include(
          startFailure.cause.detail,
          scenario === "composed-frame-overflow" ? "frame limit" : "provider configuration",
        );
        const stored = yield* (yield* EventStoreV2)
          .read({ threadId, eventType: "provider-turn.updated" })
          .pipe(Stream.runCollect);
        assert.isTrue(
          stored.some(
            ({ event }) =>
              event.type === "provider-turn.updated" &&
              event.payload.id === receipt.id &&
              event.payload.nativeAcceptance === "pending",
          ),
        );
        yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
        const rebuilt = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          rebuilt.providerTurns.find((turn) => turn.id === receipt.id),
          receipt,
        );
        assert.lengthOf(peer.state.prompts, 0);
      }).pipe(
        Effect.provide(
          ProjectionMaintenance.layer.pipe(
            Layer.provideMerge(
              makeOrchestratorV2ReplayLayerWithRegistry(
                { name, runtimePolicyOverride: { cwd } },
                makeLayer([observedAdapter]),
                { layerServerConfig: Layer.succeed(ServerConfig, config) },
              ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, idAllocatorLayer))),
  ),
);
