import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AcpProviderCapabilitiesV2 } from "./Adapters/AcpAdapterV2.ts";
import { makeNativeSessionAdapterV2 } from "./Adapters/NativeSessionAdapterV2.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

it.live(
  "history preparation failure never becomes an orphan running attempt and retains the queued payload for explicit retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("start-history-failure");
        const allocator = yield* IdAllocatorV2;
        const nativeOffer = yield* Deferred.make<string>();
        const nativeFinish = yield* Deferred.make<Effect.Effect<void>>();
        let nativeOffers = 0;
        const instanceId = ProviderInstanceId.make("omp");
        const modelSelection = { instanceId, model: "history-failure-model" };
        const adapter = makeNativeSessionAdapterV2({
          instanceId,
          driver: ProviderDriverKind.make("omp"),
          capabilities: AcpProviderCapabilitiesV2,
          idAllocator: allocator,
          defaultCwd: cwd,
          continuations: { offer: () => Effect.die("No continuation in history failure fixture") },
          open: (input, publish) =>
            Effect.succeed({
              nativeId: `history-failure:${input.providerSessionId}`,
              nativeThreadKnown: true,
              resume: () => Effect.void,
              respond: () => Effect.die("No question in history failure fixture"),
              interrupt: publish({ type: "terminal", status: "cancelled" }),
              send: (turn) =>
                Effect.gen(function* () {
                  nativeOffers += 1;
                  yield* Deferred.succeed(nativeOffer, turn.message.text);
                  yield* Deferred.succeed(
                    nativeFinish,
                    publish({ type: "terminal", status: "completed" }),
                  );
                }),
            }),
        });
        const layer = makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "start-history-failure", runtimePolicyOverride: { cwd } },
          makeLayer([adapter]),
          { configureMcp: false, runEffectWorker: false, databaseLayer: SqlitePersistenceMemory },
        ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
        return yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const outbox = yield* EffectOutboxV2;
          const sql = yield* SqlClient.SqlClient;
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig;
          const threadId = ThreadId.make("history-failure-thread");
          const queuedMessageId = MessageId.make("history-failure-queued-message");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("history-failure-create"),
            threadId,
            projectId: ProjectId.make("history-failure-project"),
            title: "History retry",
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
            commandId: CommandId.make("history-failure-foreground"),
            threadId,
            messageId: MessageId.make("history-failure-foreground-message"),
            text: "Prior undelivered foreground",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const attachmentId = createAttachmentId(threadId);
          assert.ok(attachmentId);
          const attachment = {
            type: "image" as const,
            id: ChatAttachmentId.make(attachmentId),
            name: "retained.png",
            mimeType: "image/png",
            sizeBytes: 8,
          };
          const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
          assert.ok(path);
          yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
          yield* fs.writeFileString(path, "evidence");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("history-failure-admit"),
            threadId,
            messageId: queuedMessageId,
            text: "Retained queued history payload",
            attachments: [attachment],
            selectedScientSkillNames: ["retained-selection"],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const admitted = yield* orchestrator.getThreadProjection(threadId);
          const foreground = admitted.runs.find((run) => run.status === "starting");
          const queued = admitted.runs.find((run) => run.userMessageId === queuedMessageId);
          assert.ok(foreground);
          assert.ok(queued);
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("history-failure-stop"),
            threadId,
            runId: foreground.id,
            holdQueue: true,
          });
          const [history] = yield* sql<{ turn_item_id: string; payload_json: string }>`
        SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND run_id = ${foreground.id}
          AND type = 'run_interrupt_result'`;
          assert.ok(history);
          // Fail the real typed history decoder without affecting current execution
          // metadata, and retain the original bytes for a controlled recovery.
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{}'
        WHERE thread_id = ${threadId} AND turn_item_id = ${history.turn_item_id}`;
          yield* orchestrator.dispatch({
            type: "queue.resume",
            threadId,
            runId: queued.id,
            commandId: CommandId.make("history-failure-resume"),
          });
          const [start] = yield* sql<{ effect_id: string }>`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.start' AND status = 'pending'`;
          assert.ok(start);
          for (let attempt = 1; attempt <= 5; attempt += 1) {
            // Make only the recorded retry deadline due. The real worker still owns
            // claiming, attempts, execution and settlement; no fixed sleep is proof.
            yield* sql`UPDATE orchestration_v2_effect_outbox SET available_at = created_at
          WHERE effect_id = ${start.effect_id}`;
            yield* worker.drain(8);
            const effect = yield* outbox.get(start.effect_id);
            assert.isTrue(Option.isSome(effect));
            if (Option.isNone(effect)) return assert.fail("Missing native start effect");
            assert.equal(effect.value.attemptCount, attempt);
            if (attempt < 5) {
              assert.equal(effect.value.status, "pending");
              const current = yield* orchestrator.getThreadRecords(threadId, [
                "runs",
                "attempts",
                "nodes",
                "providerTurns",
              ]);
              assert.equal(current.runs.find((run) => run.id === queued.id)?.status, "starting");
              assert.equal(
                current.attempts.find((entry) => entry.id === queued.activeAttemptId)?.status,
                "pending",
              );
              assert.isEmpty(current.providerTurns);
            }
            assert.equal(nativeOffers, 0);
          }
          const cursor = yield* orchestrator.getThreadEventSequence(threadId);
          const pull = yield* Stream.toPull(
            orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
          );
          const read = () =>
            orchestrator.getThreadRecords(threadId, [
              "runs",
              "messages",
              "attempts",
              "nodes",
              "providerTurns",
            ]);
          const held = yield* Stream.concat(
            Stream.fromEffect(read()),
            Stream.fromPull(Effect.succeed(pull)).pipe(Stream.mapEffect(read)),
          ).pipe(
            Stream.filter((projection) =>
              projection.runs.some(
                (run) => run.id === queued.id && run.status === "queued" && run.queueHeld === true,
              ),
            ),
            Stream.runHead,
            Effect.timeout("15 seconds"),
          );
          assert.isTrue(Option.isSome(held));
          if (Option.isNone(held)) return assert.fail("Queued failure did not settle truthfully");
          const heldRun = held.value.runs.find((run) => run.id === queued.id);
          assert.ok(heldRun);
          assert.equal(heldRun.queuePosition, queued.queuePosition);
          assert.equal(
            held.value.attempts.find((entry) => entry.id === queued.activeAttemptId)?.status,
            "failed",
          );
          assert.equal(
            held.value.nodes.find((node) => node.id === queued.rootNodeId)?.status,
            "pending",
          );
          assert.isEmpty(held.value.providerTurns);
          const retained = held.value.messages.find((message) => message.id === queuedMessageId);
          assert.ok(retained);
          assert.equal(retained.text, "Retained queued history payload");
          assert.deepEqual(retained.attachments, [attachment]);
          assert.deepEqual(retained.selectedScientSkillNames, ["retained-selection"]);
          assert.equal(yield* fs.readFileString(path), "evidence");
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${history.payload_json}
        WHERE thread_id = ${threadId} AND turn_item_id = ${history.turn_item_id}`;
          yield* orchestrator.dispatch({
            type: "queue.resume",
            threadId,
            runId: queued.id,
            commandId: CommandId.make("history-failure-repaired-resume"),
          });
          yield* worker.drain(8);
          const offeredText = yield* Deferred.await(nativeOffer).pipe(Effect.timeout("15 seconds"));
          assert.include(offeredText, "Retained queued history payload");
          assert.equal(nativeOffers, 1);
          const retryCursor = yield* orchestrator.getThreadEventSequence(threadId);
          const retryPull = yield* Stream.toPull(
            orchestrator.streamStoredEventsFrom({ threadId, afterSequence: retryCursor }),
          );
          const retry = yield* Stream.concat(
            Stream.fromEffect(read()),
            Stream.fromPull(Effect.succeed(retryPull)).pipe(Stream.mapEffect(read)),
          ).pipe(
            Stream.filter((projection) => projection.providerTurns.length === 1),
            Stream.runHead,
            Effect.timeout("15 seconds"),
          );
          assert.isTrue(Option.isSome(retry));
          if (Option.isNone(retry)) return assert.fail("Native retry receipt did not converge");
          assert.notEqual(
            retry.value.runs.find((run) => run.id === queued.id)?.activeAttemptId,
            queued.activeAttemptId,
          );
          assert.equal(retry.value.runs.find((run) => run.id === queued.id)?.status, "running");
          const finish = yield* Deferred.await(nativeFinish);
          yield* finish;
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, idAllocatorLayer))),
    ),
);
