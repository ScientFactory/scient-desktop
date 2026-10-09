import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type RunId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as CodexReplay from "effect-codex-app-server/replay";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import {
  CodexOrchestratorReplayHarness,
  layer as makeCodexProviderAdapterRegistryReplayLayer,
} from "./Adapters/CodexAdapterV2.testkit.ts";
import {
  makeNativeSessionAdapterV2,
  nativeSessionFailure,
} from "./Adapters/NativeSessionAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import { THREAD_FORK_NATIVE_SOURCE_PROMPT } from "./testkit/fixtures/shared.ts";
import { ConversationForkService } from "./scient-fork/ConversationForkService.ts";

const frameJson = Schema.fromJsonString(Schema.Unknown);
const encodeFrame = Schema.encodeEffect(frameJson);
const decodeFrame = Schema.decodeEffect(frameJson);

it.live.each(
  (
    [
      "missed native receipt",
      "portable resume fallback",
      "recovery projection",
      "displaced recovery owner",
    ] as const
  ).map((recovery) => ({
    caseTitle: `${recovery}: history preparation failure never becomes an orphan running attempt and retains the queued payload for explicit retry`,
    recovery,
  })),
)("$caseTitle", ({ recovery }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("start-history-failure");
      const allocator = yield* IdAllocatorV2;
      const nativeOffer = yield* Deferred.make<string>();
      const nativeFinish = yield* Deferred.make<Effect.Effect<void>>();
      let nativeOffers = 0;
      let nativeResumeFailures = 0;
      let observeResume = false;
      const stoppedDelegatedTaskParents: Array<ThreadId> = [];
      const admissionReads: Array<{
        operation: "readiness" | "records";
        outcome: "Success" | "Failure";
        ready?: boolean;
        fields?: ReadonlyArray<string>;
        turnItemTypes?: ReadonlyArray<string>;
        turnItemRunIds?: ReadonlyArray<RunId | null>;
        errors?: ReadonlyArray<string>;
      }> = [];
      const instanceId = ProviderInstanceId.make("omp");
      const modelSelection = { instanceId, model: "history-failure-model" };
      const adapter = makeNativeSessionAdapterV2({
        instanceId,
        driver: ProviderDriverKind.make("omp"),
        capabilities: AcpProviderCapabilitiesV2,
        idAllocator: allocator,
        defaultCwd: cwd,
        continuations: {
          offer: () => Effect.die("No continuation in history failure fixture"),
        },
        open: (input, publish) =>
          Effect.succeed({
            nativeId: `history-failure:${input.providerSessionId}`,
            nativeThreadKnown: true,
            resume: () =>
              Effect.suspend(() => {
                if (recovery !== "portable resume fallback") return Effect.void;
                nativeResumeFailures += 1;
                return Effect.fail(nativeSessionFailure("Recorded native resume failure"));
              }),
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
        {
          configureMcp: false,
          runEffectWorker: false,
          layerDatabase: SqlitePersistenceMemory,
          threads: {
            // These recovery cases have no delegated children; retain real Stop delivery.
            stopDelegatedTasks: (input) =>
              Effect.sync(() => {
                assert.equal(input.threadId, ThreadId.make("history-failure-thread"));
                assert.equal(input.commandId, CommandId.make("history-failure-stop"));
                stoppedDelegatedTaskParents.push(input.threadId);
              }),
          },
          decorateProjectionStore: (store) => ({
            ...store,
            canStartQueuedRun: (threadId) =>
              Effect.onExit(store.canStartQueuedRun(threadId), (exit) =>
                Effect.sync(() => {
                  if (!observeResume || admissionReads.length >= 64) return;
                  admissionReads.push({
                    operation: "readiness",
                    outcome: exit._tag,
                    ...(exit._tag === "Success"
                      ? { ready: exit.value }
                      : {
                          errors: exit.cause.reasons.map((reason) =>
                            reason._tag === "Fail" ? reason.error._tag : reason._tag,
                          ),
                        }),
                  });
                }),
              ),
            getThreadRecords: (threadId, fields, filter) =>
              Effect.onExit(store.getThreadRecords(threadId, fields, filter), (exit) =>
                Effect.sync(() => {
                  if (!observeResume || admissionReads.length >= 64) return;
                  admissionReads.push({
                    operation: "records",
                    outcome: exit._tag,
                    fields,
                    ...(filter?.turnItemTypes === undefined
                      ? {}
                      : { turnItemTypes: filter.turnItemTypes }),
                    ...(filter?.turnItemRunIds === undefined
                      ? {}
                      : { turnItemRunIds: filter.turnItemRunIds }),
                    ...(exit._tag === "Failure"
                      ? {
                          errors: exit.cause.reasons.map((reason) =>
                            reason._tag === "Fail" ? reason.error._tag : reason._tag,
                          ),
                        }
                      : {}),
                  });
                }),
              ),
          }),
        },
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
      return yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const outbox = yield* EffectOutboxV2;
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const eventSink = yield* EventSinkV2;
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
        const path = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        });
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
        assert.isEmpty(admitted.subagents);
        const recoveryRead =
          recovery === "recovery projection" || recovery === "displaced recovery owner";
        if (recoveryRead) {
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: yield* allocator.allocate.event({ threadId }),
                type: "turn-item.updated",
                threadId,
                runId: foreground.id,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("retained-pending-background-tool"),
                  threadId,
                  runId: foreground.id,
                  nodeId: null,
                  providerThreadId: foreground.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 50,
                  status: "running",
                  title: "Retained background tool",
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  type: "dynamic_tool",
                  toolName: "retained_background_tool",
                  input: { diagnostic: "disposable recovery fixture" },
                },
              },
            ],
          });
        }
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("history-failure-stop"),
          threadId,
          runId: foreground.id,
          holdQueue: true,
        });
        if (recovery === "portable resume fallback") {
          const priorProviderThread = admitted.providerThreads.find(
            (candidate) => candidate.id === queued.providerThreadId,
          );
          assert.ok(priorProviderThread);
          const occurredAt = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: yield* allocator.allocate.event({ threadId }),
                type: "provider-thread.updated",
                threadId,
                providerInstanceId: instanceId,
                occurredAt,
                payload: {
                  ...priorProviderThread,
                  nativeThreadRef: {
                    driver: adapter.driver,
                    nativeId: "retained-unavailable-native-history",
                    strength: "strong",
                  },
                  updatedAt: occurredAt,
                },
              },
            ],
          });
        }
        const [history] = yield* sql<{ turn_item_id: string; payload_json: string }>`
        SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND run_id = ${foreground.id}
          AND type = ${recoveryRead ? "dynamic_tool" : "run_interrupt_result"}`;
        assert.ok(history);
        // Fail the real typed history decoder without affecting current execution
        // metadata, and retain the original bytes for a controlled recovery.
        if (!recoveryRead) {
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{}'
        WHERE thread_id = ${threadId} AND turn_item_id = ${history.turn_item_id}`;
        }
        let resumeExit:
          | { tag: "Success"; resultSequence: number; storedEventCount: number }
          | { tag: "Failure"; errors: ReadonlyArray<string> }
          | undefined;
        const observeMissingStart = Effect.fnUntraced(function* (
          boundary: "resume-failed" | "missing-start",
        ) {
          const receipt = yield* sql<{
            status: string;
            command_type: string;
            result_sequence: number;
          }>`SELECT status, command_type, result_sequence FROM orchestration_command_receipts
                  WHERE command_id = 'history-failure-resume'`;
          const runs = yield* sql<{
            run_id: string;
            status: string;
            queue_held: number | null;
            active_attempt_id: string | null;
            root_node_id: string | null;
            provider_thread_id: string | null;
            provider_instance_id: string | null;
          }>`SELECT run_id, status, json_extract(payload_json, '$.queueHeld') AS queue_held,
                  json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id,
                  json_extract(payload_json, '$.rootNodeId') AS root_node_id,
                  json_extract(payload_json, '$.providerThreadId') AS provider_thread_id,
                  json_extract(payload_json, '$.providerInstanceId') AS provider_instance_id
                  FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
                    AND run_id IN (${foreground.id}, ${queued.id}) ORDER BY ordinal`;
          const thread = yield* sql<{ active_provider_thread_id: string | null }>`
                  SELECT json_extract(payload_json, '$.activeProviderThreadId') AS active_provider_thread_id
                  FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
          const starts = yield* sql<{
            effect_id: string;
            status: string;
            attempt_count: number;
            run_id: string | null;
            expected_attempt_id: string | null;
            claimed: number;
          }>`SELECT effect_id, status, attempt_count,
                  json_extract(payload_json, '$.runId') AS run_id,
                  json_extract(payload_json, '$.expectedAttemptId') AS expected_attempt_id,
                  lease_owner IS NOT NULL AS claimed
                  FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
                    AND effect_type = 'provider-turn.start' ORDER BY created_at, effect_id LIMIT 8`;
          yield* Effect.log(
            "history-start-causal-witness",
            yield* encodeFrame({
              recovery,
              boundary,
              resumeExit,
              receipt,
              runs,
              thread,
              starts,
              admissionReads,
              truncated: admissionReads.length === 64,
            }),
          );
        });
        observeResume = true;
        yield* Effect.onExit(
          orchestrator.dispatch({
            type: "queue.resume",
            threadId,
            runId: queued.id,
            commandId: CommandId.make("history-failure-resume"),
          }),
          (exit) =>
            Effect.gen(function* () {
              resumeExit =
                exit._tag === "Success"
                  ? {
                      tag: "Success",
                      resultSequence: exit.value.sequence,
                      storedEventCount: exit.value.storedEvents.length,
                    }
                  : {
                      tag: "Failure",
                      errors: exit.cause.reasons.map((reason) =>
                        reason._tag === "Fail" ? reason.error._tag : reason._tag,
                      ),
                    };
              if (exit._tag === "Failure") yield* observeMissingStart("resume-failed");
            }),
        );
        observeResume = false;
        if (recoveryRead) {
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{}'
        WHERE thread_id = ${threadId} AND turn_item_id = ${history.turn_item_id}`;
        }
        const [start] = yield* sql<{ effect_id: string }>`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.start' AND status = 'pending'`;
        if (start === undefined) yield* observeMissingStart("missing-start");
        assert.ok(start);
        let replacementAttemptId: typeof queued.activeAttemptId | undefined;
        const replacementEffectId = "history-failure-current-owner-start";
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          if (attempt === 5 && recovery === "displaced recovery owner") {
            const current = yield* orchestrator.getThreadRecords(threadId, ["runs", "attempts"]);
            const currentRun = current.runs.find((run) => run.id === queued.id);
            const oldAttempt = current.attempts.find(
              (entry) => entry.id === queued.activeAttemptId,
            );
            assert.ok(currentRun && oldAttempt);
            replacementAttemptId = allocator.derive.runAttempt({
              runId: queued.id,
              attemptOrdinal: oldAttempt.attemptOrdinal + 1,
            });
            const now = yield* DateTime.now;
            yield* eventSink.writeWithEffects({
              events: [
                {
                  id: yield* allocator.allocate.event({ threadId }),
                  type: "run-attempt.updated",
                  threadId,
                  runId: queued.id,
                  occurredAt: now,
                  payload: {
                    ...oldAttempt,
                    id: replacementAttemptId,
                    attemptOrdinal: oldAttempt.attemptOrdinal + 1,
                    reason: "retry",
                    status: "pending",
                    startedAt: null,
                    completedAt: null,
                  },
                },
                {
                  id: yield* allocator.allocate.event({ threadId }),
                  type: "run.updated",
                  threadId,
                  runId: queued.id,
                  occurredAt: now,
                  payload: { ...currentRun, activeAttemptId: replacementAttemptId },
                },
              ],
              effects: [
                {
                  id: replacementEffectId,
                  commandId: CommandId.make("history-failure-current-owner"),
                  threadId,
                  availableAt: DateTime.add(now, { hours: 1 }),
                  request: {
                    type: "provider-turn.start",
                    runId: queued.id,
                    expectedAttemptId: replacementAttemptId,
                  },
                },
              ],
            });
          }
          // Make only the recorded retry deadline due. The real worker still owns
          // claiming, attempts, execution and settlement; no fixed sleep is proof.
          yield* sql`UPDATE orchestration_v2_effect_outbox SET available_at = created_at
          WHERE effect_id = ${start.effect_id}`;
          yield* worker.drain(8);
          assert.deepEqual(stoppedDelegatedTaskParents, [threadId]);
          const effect = yield* outbox.get(start.effect_id);
          assert.isTrue(Option.isSome(effect));
          if (Option.isNone(effect)) return assert.fail("Missing native start effect");
          assert.equal(effect.value.attemptCount, attempt);
          assert.equal(effect.value.status, attempt < 5 ? "pending" : "succeeded");
          if (attempt < 5) {
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
        if (replacementAttemptId !== undefined) {
          const current = yield* orchestrator.getThreadRecords(
            threadId,
            ["runs", "attempts", "nodes", "messages", "providerTurns"],
            { turnItemTypes: [] },
          );
          const currentRun = current.runs.find((run) => run.id === queued.id);
          assert.equal(currentRun?.activeAttemptId, replacementAttemptId);
          assert.equal(currentRun?.status, "starting");
          assert.equal(
            current.attempts.find((entry) => entry.id === replacementAttemptId)?.status,
            "pending",
          );
          assert.equal(
            current.attempts.find((entry) => entry.id === queued.activeAttemptId)?.status,
            "pending",
          );
          assert.equal(
            current.nodes.find((node) => node.id === queued.rootNodeId)?.status,
            "pending",
          );
          assert.isEmpty(current.providerTurns);
          const retained = current.messages.find((message) => message.id === queuedMessageId);
          assert.equal(retained?.text, "Retained queued history payload");
          assert.deepEqual(retained?.attachments, [attachment]);
          assert.deepEqual(retained?.selectedScientSkillNames, ["retained-selection"]);
          const pending = yield* outbox.get(replacementEffectId);
          assert.ok(Option.isSome(pending));
          assert.equal(pending.value.attemptCount, 0);
          assert.equal(pending.value.status, "pending");
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${history.payload_json}
                WHERE thread_id = ${threadId} AND turn_item_id = ${history.turn_item_id}`;
          yield* sql`UPDATE orchestration_v2_effect_outbox SET available_at = created_at WHERE effect_id = ${replacementEffectId}`;
          yield* worker.drain(8);
          assert.include(
            yield* Deferred.await(nativeOffer).pipe(Effect.timeout("15 seconds")),
            "Retained queued history payload",
          );
          assert.equal(nativeOffers, 1);
          const started = yield* orchestrator.getThreadRecords(threadId, [
            "runs",
            "attempts",
            "providerTurns",
          ]);
          assert.equal(
            started.runs.find((run) => run.id === queued.id)?.activeAttemptId,
            replacementAttemptId,
          );
          assert.equal(started.runs.find((run) => run.id === queued.id)?.status, "running");
          yield* yield* Deferred.await(nativeFinish);
          return;
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
        const failedItems = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunIds: [queued.id],
        });
        assert.ok(
          failedItems.turnItems.some(
            (item) =>
              item.type === "error" &&
              item.nodeId === queued.rootNodeId &&
              item.title ===
                (recoveryRead
                  ? "Provider recovery state could not be prepared"
                  : "Provider history could not be prepared"),
          ),
        );
        if (recoveryRead) {
          const failedFacts = yield* eventSink.stream({ threadId }).pipe(
            Stream.filter(
              ({ event }) =>
                event.runId === queued.id &&
                ((event.type === "run.updated" &&
                  event.payload.status === "failed" &&
                  event.payload.activeAttemptId === queued.activeAttemptId) ||
                  (event.type === "run-attempt.updated" &&
                    event.payload.status === "failed" &&
                    event.payload.id === queued.activeAttemptId) ||
                  (event.type === "node.updated" &&
                    event.payload.status === "failed" &&
                    event.payload.id === queued.rootNodeId)),
            ),
            Stream.take(3),
            Stream.runCollect,
            Effect.timeout("15 seconds"),
          );
          assert.sameMembers(
            failedFacts.map(({ event }) => event.type),
            ["run.updated", "run-attempt.updated", "node.updated"],
          );
        }
        if (recovery === "portable resume fallback") assert.isAbove(nativeResumeFailures, 0);
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

it.live(
  "failed native clone exhausts portable-prefix history reads with fenced settlement and holds the untouched follow-up",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "native-clone-history-failure";
        const cwd = yield* checkpointWorkspace(name);
        const recorded = yield* readProviderReplayTranscript(
          new URL("./testkit/fixtures/thread_fork_native/codex_transcript.ndjson", import.meta.url),
        );
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(recorded, cwd),
        );
        const forkIndex = transcript.entries.findIndex(
          (entry) => entry.type === "expect_outbound" && entry.label === "thread/fork",
        );
        const forkRequest = transcript.entries[forkIndex];
        const sourceStart = transcript.entries.find(
          (entry) => entry.type === "emit_inbound" && entry.label === "thread/start/source",
        );
        assert.ok(forkIndex > 0 && forkRequest?.type === "expect_outbound");
        assert.ok(sourceStart?.type === "emit_inbound");
        const entries = transcript.entries.slice(0, forkIndex);
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const forkRequestId = 2 + attempt * 2;
          const startRequestId = forkRequestId + 1;
          const nativeId = `native-portable-attempt-${attempt}`;
          const forkFrame = yield* decodeFrame(
            (yield* encodeFrame(forkRequest.frame)).replace('"id":4', `"id":${forkRequestId}`),
          );
          const startFrame = yield* decodeFrame(
            (yield* encodeFrame(sourceStart.frame))
              .replace('"id":2', `"id":${startRequestId}`)
              .replaceAll("native-source-thread", nativeId),
          );
          entries.push(
            { ...forkRequest, label: `thread/fork/attempt-${attempt}`, frame: forkFrame },
            {
              type: "emit_inbound",
              label: `thread/fork/failure-${attempt}`,
              frame: {
                id: forkRequestId,
                error: { code: -32000, message: "Recorded clone refusal" },
              },
            },
            {
              type: "expect_outbound",
              label: `thread/start/fallback-${attempt}`,
              frame: {
                id: startRequestId,
                method: "thread/start",
                params: { config: { "tools.update_plan.enabled": true } },
              },
            },
            { ...sourceStart, label: `thread/start/fallback-${attempt}`, frame: startFrame },
          );
        }
        // A failed prepared run releases its exact app-thread binding. No target
        // turn/start exists in this strict transcript: preparation must never send.
        entries.push(
          {
            type: "expect_outbound",
            label: "thread/unsubscribe/failed-target",
            frame: {
              id: 14,
              method: "thread/unsubscribe",
              params: { threadId: "native-portable-attempt-5" },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/unsubscribe/failed-target",
            frame: { id: 14, result: {} },
          },
          { type: "runtime_exit", status: "success" },
        );
        const replayTranscript = { ...transcript, entries };
        const driver = yield* CodexReplay.makeReplayDriver(replayTranscript);
        const layer = makeOrchestratorV2ReplayLayerWithRegistry(
          { name, runtimePolicyOverride: { cwd } },
          makeCodexProviderAdapterRegistryReplayLayer({ transcript: replayTranscript, driver }),
          { configureMcp: false, runEffectWorker: false, layerDatabase: SqlitePersistenceMemory },
        ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
        return yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const outbox = yield* EffectOutboxV2;
          const sink = yield* EventSinkV2;
          const forks = yield* ConversationForkService;
          const sql = yield* SqlClient.SqlClient;
          const now = yield* DateTime.now;
          const sourceId = ThreadId.make("clone-history-source");
          const targetId = ThreadId.make("clone-history-target");
          const projectId = ProjectId.make("clone-history-project");
          const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
          yield* sink.commitProjectCommand({
            commandId: CommandId.make("clone-history-project-create"),
            projectId,
            commandType: "project.create",
            acceptedAt: now,
            event: {
              eventId: EventId.make("clone-history-project-created"),
              type: "project.created",
              aggregateKind: "project",
              aggregateId: projectId,
              occurredAt: DateTime.formatIso(now),
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: {
                projectId,
                title: "Native history preparation",
                workspaceRoot: cwd,
                scripts: [],
                defaultModelSelection: modelSelection,
                createdAt: DateTime.formatIso(now),
                updatedAt: DateTime.formatIso(now),
              },
            },
          });
          const waitFor = (
            threadId: ThreadId,
            accept: (status: string | undefined) => boolean,
            heldRunId?: RunId,
          ) =>
            Effect.gen(function* () {
              const cursor = yield* orchestrator.getThreadEventSequence(threadId);
              const pull = yield* Stream.toPull(
                orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
              );
              const read = () =>
                orchestrator.getThreadRecords(threadId, [
                  "runs",
                  "attempts",
                  "nodes",
                  "providerTurns",
                  "messages",
                ]);
              const result = yield* Stream.concat(
                Stream.fromEffect(read()),
                Stream.fromPull(Effect.succeed(pull)).pipe(Stream.mapEffect(read)),
              ).pipe(
                Stream.filter(
                  (projection) =>
                    accept(projection.runs[0]?.status) &&
                    (heldRunId === undefined ||
                      projection.runs.some(
                        (run) =>
                          run.id === heldRunId && run.status === "queued" && run.queueHeld === true,
                      )),
                ),
                Stream.runHead,
                Effect.timeout("15 seconds"),
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    const current = yield* read();
                    const replay = yield* Ref.get(driver.state);
                    return yield* Effect.die(
                      `History fixture ${threadId} did not settle: runs=${current.runs.map((run) => `${run.ordinal}:${run.status}`).join(",")}; replayCursor=${replay.cursor}; replayFailure=${replay.failure?._tag ?? "none"}; cause=${cause._tag}`,
                    );
                  }),
                ),
              );
              if (Option.isNone(result))
                return yield* Effect.die("Missing prepared-run settlement");
              return result.value;
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("clone-history-source-create"),
            threadId: sourceId,
            projectId,
            title: "Completed native source",
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
            commandId: CommandId.make("clone-history-source-send"),
            threadId: sourceId,
            messageId: MessageId.make("clone-history-source-message"),
            text: THREAD_FORK_NATIVE_SOURCE_PROMPT,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain(8);
          // RunExecution publishes the waiting run and its finalize effect in
          // one EventSink transaction. Observe that durable boundary before
          // draining asynchronous finalization, without starting a second worker.
          yield* waitFor(sourceId, (status) => status === "waiting" || status === "completed");
          yield* worker.drain(8);
          yield* waitFor(sourceId, (status) => status === "completed");
          const source = yield* orchestrator.getThreadProjection(sourceId);
          const answer = source.turnItems.find((item) => item.type === "assistant_message");
          assert.ok(answer?.type === "assistant_message");
          // The public fork dispatch waits for provisioning. Observe its
          // post-commit receipt before driving the real outbox worker, so the
          // disabled background worker cannot deadlock this controlled fixture.
          const forkCursor = yield* sink.latestSequence();
          const forkPull = yield* Stream.toPull(
            sink.stream({ threadId: targetId, afterSequence: forkCursor }),
          );
          const pendingFork = yield* forks
            .dispatch({
              type: "thread.fork",
              commandId: CommandId.make("clone-history-fork"),
              originThreadId: sourceId,
              newThreadId: targetId,
              sourceAssistantMessageId: answer.messageId,
              workspaceMode: "local",
            })
            .pipe(Effect.forkScoped);
          const acceptedFork = yield* Stream.fromPull(Effect.succeed(forkPull)).pipe(
            Stream.filter((stored) => stored.event.type === "thread.created"),
            Stream.runHead,
            Effect.timeout("15 seconds"),
          );
          assert.ok(Option.isSome(acceptedFork));
          // A local fork shares its history by reference and is ready at once.
          assert.isTrue(
            Option.isNone(yield* outbox.get("scient-fork:clone-history-fork:provision")),
          );
          yield* Fiber.join(pendingFork);
          const frozen = yield* orchestrator.getThreadProjection(targetId);
          assert.equal(frozen.contextTransfers[0]?.status, "pending");
          assert.equal(
            frozen.contextTransfers[0]?.frozenSource?.providerTurnId,
            source.providerTurns[0]?.id,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("clone-history-target-send"),
            threadId: targetId,
            messageId: MessageId.make("clone-history-target-message"),
            text: "First child request must not reach the provider",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const queuedMessageId = MessageId.make("clone-history-follow-up");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("clone-history-follow-up-admit"),
            threadId: targetId,
            messageId: queuedMessageId,
            text: "Untouched queued child follow-up",
            attachments: [],
            selectedScientSkillNames: ["retained-child-skill"],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const before = yield* orchestrator.getThreadProjection(targetId);
          const run = before.runs.find((candidate) => candidate.status === "starting");
          const queued = before.runs.find(
            (candidate) => candidate.userMessageId === queuedMessageId,
          );
          assert.ok(run && queued);
          assert.equal(before.contextTransfers[0]?.targetRunId, run.id);
          // The fork reads its history from the source's answer.
          const [history] = yield* sql<{ turn_item_id: string; payload_json: string }>`
            SELECT i.turn_item_id, i.payload_json FROM scient_fork_history h
            JOIN orchestration_v2_projection_turn_items i
              ON i.thread_id = h.source_thread_id AND i.turn_item_id = h.source_item_id
            WHERE h.thread_id = ${targetId} AND i.type = 'assistant_message'`;
          assert.ok(history);
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{}'
            WHERE thread_id = ${sourceId} AND turn_item_id = ${history.turn_item_id}`;
          const [start] = yield* sql<{ effect_id: string }>`
            SELECT effect_id FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${targetId} AND effect_type = 'provider-turn.start' AND status = 'pending'`;
          assert.ok(start);
          for (let attempt = 1; attempt <= 5; attempt += 1) {
            yield* sql`UPDATE orchestration_v2_effect_outbox SET available_at = created_at
              WHERE effect_id = ${start.effect_id}`;
            yield* worker.drain(8);
            const effect = yield* outbox.get(start.effect_id);
            assert.ok(Option.isSome(effect));
            assert.equal(effect.value.attemptCount, attempt);
            assert.equal(effect.value.status, attempt < 5 ? "pending" : "succeeded");
            const current = yield* orchestrator.getThreadRecords(targetId, [
              "runs",
              "attempts",
              "providerTurns",
            ]);
            assert.isEmpty(current.providerTurns);
            if (attempt < 5) {
              assert.equal(
                current.runs.find((candidate) => candidate.id === run.id)?.status,
                "starting",
              );
              assert.equal(
                current.attempts.find((candidate) => candidate.id === run.activeAttemptId)?.status,
                "pending",
              );
            }
          }
          const settled = yield* waitFor(targetId, (status) => status === "failed", queued.id);
          assert.equal(
            settled.runs.find((candidate) => candidate.id === run.id)?.activeAttemptId,
            run.activeAttemptId,
          );
          assert.equal(
            settled.attempts.find((candidate) => candidate.id === run.activeAttemptId)?.status,
            "failed",
          );
          assert.equal(
            settled.nodes.find((candidate) => candidate.id === run.rootNodeId)?.status,
            "failed",
          );
          assert.isEmpty(settled.providerTurns);
          const held = settled.runs.find((candidate) => candidate.id === queued.id);
          assert.ok(held);
          assert.equal(held.status, "queued");
          assert.isTrue(held.queueHeld);
          assert.equal(held.queuePosition, queued.queuePosition);
          const retained = settled.messages.find((message) => message.id === queuedMessageId);
          assert.equal(retained?.text, "Untouched queued child follow-up");
          assert.deepEqual(retained?.selectedScientSkillNames, ["retained-child-skill"]);
          // Restore only the deliberate decoder fault; native execution remains held.
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${history.payload_json}
            WHERE thread_id = ${sourceId} AND turn_item_id = ${history.turn_item_id}`;
          const after = yield* orchestrator.getThreadProjection(targetId);
          assert.equal(after.contextTransfers[0]?.status, "pending");
          assert.equal(after.contextTransfers[0]?.resolution, null);
          assert.ok(
            after.turnItems.some(
              (item) =>
                item.type === "error" &&
                item.runId === run.id &&
                item.title === "Provider history could not be prepared",
            ),
          );
          assert.equal(
            (yield* orchestrator.getThreadProjection(sourceId)).runs[0]?.status,
            "completed",
          );
          const replay = yield* Ref.get(driver.state);
          assert.isNull(replay.failure);
          assert.isAtLeast(
            replay.cursor,
            forkIndex + 20,
            "All five actual native clone refusals and fallback creations must occur before history exhaustion settles.",
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
