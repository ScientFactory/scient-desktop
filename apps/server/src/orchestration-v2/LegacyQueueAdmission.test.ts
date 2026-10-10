import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ChatAttachmentId,
  EventId,
  PlanId,
  NodeId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  OrchestrationV2Command,
  ScientThreadQueueItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import {
  layerFromAdapters as makeLayer,
  ProviderAdapterRegistryV2,
  ProviderAdapterRegistryLookupError,
} from "./ProviderAdapterRegistry.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { cutOverLegacyQueue, cutOverLegacyQueues } from "./legacy/LegacyQueueCutover.ts";
import { readQueue, writeQueue } from "./legacy/LegacyQueueLedger.ts";
import {
  layer as legacyImporterLayer,
  LegacyV1ThreadImporter,
} from "./legacy/LegacyV1ThreadImporter.ts";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { legacyQueueFilePath } from "../scient/threadQueue/Store.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { persistChatAttachments } from "../AttachmentPersistence.ts";
import { makeLegacyQueueCompatibility } from "./legacy/LegacyQueueCompatibility.ts";
import { layer as threadManagementLayer } from "./ThreadManagementService.ts";
import {
  CommandReceiptStoreV2,
  CommandReceiptStoreReadError,
  layer as commandReceiptStoreLayer,
} from "./CommandReceiptStore.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const isClientCommand = Schema.is(OrchestrationV2Command);
const encodeQueueSource = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      formatVersion: Schema.Literal(1),
      threadId: ThreadId,
      items: Schema.Array(ScientThreadQueueItem),
    }),
  ),
);
const testLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "legacy-held-admission" },
  makeLayer([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Provider execution is paused for receipt inspection"),
    },
  ]),
  { runEffectWorker: false },
).pipe(Layer.provideMerge(commandReceiptStoreLayer.pipe(Layer.provide(SqlitePersistenceMemory))));

const recoveryLayer = threadManagementLayer.pipe(
  Layer.provideMerge(
    legacyImporterLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(testLayer, SqlitePersistenceMemory).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  ),
);

const stageRecoveryUpload = Effect.fn("LegacyQueueAdmission.stageRecoveryUpload")(function* (
  threadId: ThreadId,
) {
  const orchestrator = yield* OrchestratorV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("receipt-project"),
    title: "Recovery",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const pendingId = createPendingAttachmentId();
  assert.ok(pendingId);
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
  const pendingPath = `${config.attachmentsDir}/${pendingId}.png`;
  yield* fs.writeFileString(pendingPath, "hi");
  yield* writeQueue(threadId, {
    ...(yield* readQueue(threadId)),
    migrated: true,
    items: [
      {
        queueItemId: "qitem_recovery",
        threadId,
        text: "Retained evidence",
        modelSelection,
        attachments: [
          {
            type: "image",
            id: ChatAttachmentId.make(pendingId),
            name: "evidence.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  return { fs, config, orchestrator, pendingPath };
});

it.effect.each(
  (["rejected", "interrupted-before", "interrupted-after", "ambiguous"] as const).map(
    (boundary) => ({
      caseTitle: `reconciles legacy upload claims at the ${boundary} admission boundary`,
      boundary,
    }),
  ),
)("$caseTitle", ({ boundary }) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(`claim-${boundary}`);
    const { fs, config, orchestrator, pendingPath } = yield* stageRecoveryUpload(threadId);
    const sql = yield* SqlClient.SqlClient;
    const receipts = yield* CommandReceiptStoreV2;
    const commandId = CommandId.make(`legacy-queue:${threadId}:qitem_recovery`);
    const entered = yield* Deferred.make<void>();
    const service = yield* makeLegacyQueueCompatibility;
    const before = yield* orchestrator.getThreadProjection(threadId);
    const recovery = yield* service
      .execute({ method: "list", payload: { threadId } })
      .pipe(Effect.flip);
    assert.equal(recovery._tag, "ScientThreadQueueOperationError");
    assert.include(recovery.message, "restart Scient");
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
    if (boundary === "rejected" || boundary === "ambiguous") {
      yield* sql.unsafe(`CREATE TRIGGER reject_legacy_commit BEFORE INSERT ON orchestration_events
        WHEN NEW.command_id = '${commandId}' BEGIN SELECT RAISE(FAIL, 'controlled acceptance failure'); END`);
    }
    let receiptReads = 0;
    const observedReceipts = {
      ...receipts,
      getByCommandId: (id: CommandId) => {
        if (id === commandId && ++receiptReads > 1 && boundary === "ambiguous")
          return Effect.fail(new CommandReceiptStoreReadError({ commandId: id }));
        return receipts.getByCommandId(id);
      },
    };
    const observed = {
      ...orchestrator,
      dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) => {
        if (command.type !== "legacy-queue.import") return orchestrator.dispatch(command);
        if (boundary === "interrupted-before")
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
        if (boundary === "interrupted-after")
          return orchestrator
            .dispatch(command)
            .pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Effect.never),
            );
        return orchestrator.dispatch(command);
      },
    };
    const admission = cutOverLegacyQueue(threadId).pipe(
      Effect.provideService(OrchestratorV2, observed),
      Effect.provideService(CommandReceiptStoreV2, observedReceipts),
    );
    if (boundary.startsWith("interrupted")) {
      const fiber = yield* Effect.forkScoped(admission);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
    } else assert.equal(Exit.isFailure(yield* Effect.exit(admission)), true);
    assert.equal((yield* readQueue(threadId)).items.length, 1);
    assert.equal(yield* fs.readFileString(pendingPath), "hi");
    const files = yield* fs.readDirectory(config.attachmentsDir);
    assert.equal(
      files.length,
      boundary === "interrupted-after" || boundary === "ambiguous" ? 2 : 1,
    );
    if (boundary === "rejected" || boundary === "ambiguous")
      yield* sql`DROP TRIGGER reject_legacy_commit`;
    if (boundary === "ambiguous") return; // Uncertain evidence retains its copy for recovery.
    assert.equal(yield* cutOverLegacyQueue(threadId), 1);
    const accepted = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(accepted.messages.length, 1);
    assert.equal(accepted.runs[0]?.queueHeld, true);
    assert.equal((yield* readQueue(threadId)).items.length, 0);
    assert.equal((yield* fs.readDirectory(config.attachmentsDir)).length, 2);
    const attachment = accepted.messages[0]!.attachments[0]!;
    assert.equal(
      yield* fs.readFileString(
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
      ),
      "hi",
    );
    assert.equal(
      (yield* service.execute({ method: "list", payload: { threadId } })).items.length,
      1,
    );
  }).pipe(Effect.provide(recoveryLayer)),
);

it.effect("releases only unused claims when two legacy admissions race the same receipt", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("claim-raced-replay");
    const { fs, config, orchestrator } = yield* stageRecoveryUpload(threadId);
    const bothEntered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let count = 0;
    const observed = {
      ...orchestrator,
      dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) =>
        command.type !== "legacy-queue.import"
          ? orchestrator.dispatch(command)
          : Effect.gen(function* () {
              if (++count === 2) yield* Deferred.succeed(bothEntered, undefined);
              yield* Deferred.await(release);
              return yield* orchestrator.dispatch(command);
            }),
    };
    const first = yield* Effect.forkScoped(
      cutOverLegacyQueue(threadId).pipe(Effect.provideService(OrchestratorV2, observed)),
    );
    const second = yield* Effect.forkScoped(
      cutOverLegacyQueue(threadId).pipe(Effect.provideService(OrchestratorV2, observed)),
    );
    yield* Deferred.await(bothEntered);
    assert.equal((yield* fs.readDirectory(config.attachmentsDir)).length, 3);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    const accepted = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(accepted.messages.length, 1);
    assert.equal(accepted.runs.length, 1);
    assert.equal((yield* readQueue(threadId)).items.length, 0);
    assert.equal((yield* fs.readDirectory(config.attachmentsDir)).length, 2);
    assert.equal(
      yield* fs.readFileString(
        resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: accepted.messages[0]!.attachments[0]!,
        })!,
      ),
      "hi",
    );
  }).pipe(Effect.provide(recoveryLayer)),
);

it.effect(
  "retains accepted bytes after a V2 edit clears references before claim reconciliation",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("claim-edited-after-acceptance");
      const { fs, config, orchestrator } = yield* stageRecoveryUpload(threadId);
      const edited = yield* Deferred.make<string>();
      const observed = {
        ...orchestrator,
        dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) =>
          command.type !== "legacy-queue.import"
            ? orchestrator.dispatch(command)
            : Effect.gen(function* () {
                yield* orchestrator.dispatch(command);
                const accepted = yield* orchestrator.getThreadProjection(threadId);
                const acceptedPath = resolveAttachmentPath({
                  attachmentsDir: config.attachmentsDir,
                  attachment: accepted.messages[0]!.attachments[0]!,
                });
                assert.ok(acceptedPath);
                yield* orchestrator.dispatch({
                  type: "queued-run.edit",
                  commandId: CommandId.make("clear-accepted-claims"),
                  threadId,
                  runId: accepted.runs[0]!.id,
                  text: "Edited after acceptance",
                  attachments: [],
                  selectedScientSkillNames: [],
                  context: null,
                });
                yield* Deferred.succeed(edited, acceptedPath);
                return yield* Effect.never;
              }),
      };
      const fiber = yield* Effect.forkScoped(
        cutOverLegacyQueue(threadId).pipe(Effect.provideService(OrchestratorV2, observed)),
      );
      const acceptedPath = yield* Deferred.await(edited);
      yield* Fiber.interrupt(fiber);
      assert.equal(yield* fs.readFileString(acceptedPath), "hi");
      assert.equal(yield* cutOverLegacyQueue(threadId), 1);
      const current = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(current.messages[0]?.text, "Edited after acceptance");
      assert.deepEqual(current.messages[0]?.attachments, []);
      assert.deepEqual(current.messages[0]?.selectedScientSkillNames, []);
      assert.equal(current.messages[0]?.context, undefined);
      assert.equal(yield* fs.readFileString(acceptedPath), "hi");
      assert.equal((yield* readQueue(threadId)).items.length, 0);
    }).pipe(Effect.provide(recoveryLayer)),
);

it.effect(
  "reports unreadable retained JSON recovery work without altering native pending runs",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("list-corrupt-recovery");
      const { fs, config, orchestrator } = yield* stageRecoveryUpload(threadId);
      yield* cutOverLegacyQueue(threadId);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM scient_thread_queue WHERE thread_id = ${threadId}`;
      const path = legacyQueueFilePath(config.stateDir, threadId);
      yield* fs.makeDirectory(`${config.stateDir}/scient/thread-queue`, { recursive: true });
      yield* fs.writeFileString(path, "broken source");
      const service = yield* makeLegacyQueueCompatibility;
      const before = yield* orchestrator.getThreadProjection(threadId);
      const error = yield* service
        .execute({ method: "list", payload: { threadId } })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ScientThreadQueueOperationError");
      assert.include(error.message, "retained");
      assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
      assert.equal(yield* fs.readFileString(path), "broken source");
      yield* writeQueue(threadId, { ...(yield* readQueue(threadId)), migrated: true });
      assert.equal(
        (yield* service.execute({ method: "list", payload: { threadId } })).items.length,
        1,
      );
    }).pipe(Effect.provide(recoveryLayer)),
);

it.effect(
  "uses V2 queue authority for compatibility admission, Send and versioned extraction",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const service = yield* makeLegacyQueueCompatibility;
      const threadId = ThreadId.make("compat-native-queue");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("compat-native-create"),
        threadId,
        projectId: ProjectId.make("receipt-project"),
        title: "Compatibility",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const enqueue = (queueItemId: string) =>
        service.execute({
          method: "enqueue",
          payload: {
            threadId,
            queueItemId,
            text: queueItemId,
            attachments: [],
            modelSelection,
            selectedScientSkillNames: ["analysis"],
          },
        });
      yield* enqueue("qitem_first");
      yield* enqueue("qitem_second");
      yield* enqueue("qitem_first");
      const snapshot = yield* service.execute({ method: "list", payload: { threadId } });
      assert.equal(snapshot.nativeQueue, true);
      assert.deepEqual(
        snapshot.items.map((item) => item.queueItemId),
        ["qitem_first", "qitem_second"],
      );
      assert.equal((yield* readQueue(threadId)).items.length, 0);
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 2);
      const reorder = {
        method: "reorder" as const,
        payload: {
          threadId,
          queueItemIds: ["qitem_second", "qitem_first"],
        },
      };
      const reordered = yield* service.execute(reorder);
      assert.deepEqual(
        reordered.items.map((item) => item.queueItemId),
        reorder.payload.queueItemIds,
      );
      const repeatedOrder = yield* service.execute(reorder);
      assert.deepEqual(repeatedOrder.items, reordered.items);
      const invalid = yield* service
        .execute({
          method: "reorder",
          payload: {
            threadId,
            queueItemIds: ["qitem_first", "unknown"],
          },
        })
        .pipe(Effect.exit);
      assert.equal(invalid._tag, "Failure");
      const unchanged = yield* service.execute({ method: "list", payload: { threadId } });
      assert.equal(unchanged.revision, repeatedOrder.revision);
      assert.deepEqual(unchanged.items, reordered.items);
      yield* service.execute({
        method: "reorder",
        payload: {
          threadId,
          queueItemIds: ["qitem_first", "qitem_second"],
        },
      });

      const stale = yield* Effect.exit(
        service.execute({
          method: "control",
          payload: {
            threadId,
            action: "extract",
            queueItemId: "qitem_second",
            editToken: "stale-editor",
            expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
          },
        }),
      );
      assert.equal(stale._tag, "Failure");
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[1]?.status, "queued");

      yield* service.execute({
        method: "control",
        payload: { threadId, action: "send", queueItemId: "qitem_first" },
      });
      const started = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(started.runs[0]?.status, "starting");
      assert.equal(started.runs[1]?.status, "queued");
      // Send on one message resumes the rest of the queue after it.
      assert.equal(started.runs[1]?.queueHeld, false);
      const busy = yield* Effect.exit(
        service.execute({
          method: "control",
          payload: { threadId, action: "send", queueItemId: "qitem_second" },
        }),
      );
      assert.equal(busy._tag, "Failure");
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[1]?.status, "queued");

      const extract = {
        method: "control" as const,
        payload: {
          threadId,
          action: "extract" as const,
          queueItemId: "qitem_second",
          editToken: "current-editor",
          expectedUpdatedAt: snapshot.items[1]!.updatedAt,
        },
      };
      yield* service.execute(extract);
      yield* service.execute(extract);
      const final = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(final.runs[1]?.status, "cancelled");
      assert.equal(
        final.messages.find((message) => message.id === final.runs[1]?.userMessageId)?.text,
        "qitem_second",
      );
      assert.equal((yield* readQueue(threadId)).items.length, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(legacyImporterLayer, threadManagementLayer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(testLayer, SqlitePersistenceMemory).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ),
);

it.effect(
  "imports an idle thread into held V2 runs and replays admission without losing edited payloads",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("legacy-held-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("legacy-held-create"),
        threadId,
        projectId: ProjectId.make("receipt-project"),
        title: "Held",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const initial = yield* readQueue(threadId);
      const item = {
        queueItemId: "qitem_retained",
        threadId,
        messageId: MessageId.make("legacy-held-message"),
        text: "Retained work",
        attachments: [],
        selectedScientSkillNames: ["analysis"],
        composerSnapshot: '{"draft":"original"}',
        modelSelection,
        runtimeMode: "approval-required" as const,
        interactionMode: "plan" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sendRequested: true,
        steerRequested: true,
        state: "editing" as const,
        editToken: "obsolete",
      };
      const source = yield* writeQueue(threadId, {
        ...initial,
        migrated: true,
        items: [
          item,
          {
            ...item,
            queueItemId: "qitem_second",
            messageId: MessageId.make("legacy-held-second"),
            text: "Second",
          },
        ],
      });
      assert.equal(yield* cutOverLegacyQueue(threadId), 2);
      let projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.runs.map((run) => [run.status, run.queueHeld, run.queuePosition]),
        [
          ["queued", true, 1],
          ["queued", true, 2],
        ],
      );
      assert.equal(projection.providerSessions.length, 0);
      assert.equal(projection.runtimeRequests.length, 0);
      assert.equal(projection.turnItems.length, 0);
      assert.deepEqual(projection.messages[0]?.selectedScientSkillNames, ["analysis"]);
      assert.equal(projection.messages[0]?.composerSnapshot, item.composerSnapshot);
      assert.equal(projection.runs[0]?.legacyQueue?.runtimeMode, "approval-required");
      assert.equal(projection.runs[0]?.legacyQueue?.interactionMode, "plan");
      assert.deepEqual(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`)[0]?.count,
        0,
      );
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
      const first = projection.runs[0]!;
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("legacy-held-edit"),
        threadId,
        runId: first.id,
        text: "Edited in V2",
        selectedScientSkillNames: [],
      });
      // Simulate the source-retirement crash boundary: old SQL payload survives
      // while accepted V2 work has already been edited.
      yield* writeQueue(threadId, source);
      const before = yield* sink.latestSequence();
      assert.equal(yield* cutOverLegacyQueue(threadId), 2);
      assert.equal(yield* sink.latestSequence(), before);
      projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 2);
      assert.equal(projection.messages[0]?.text, "Edited in V2");
      assert.deepEqual(projection.messages[0]?.selectedScientSkillNames, []);
      assert.equal((yield* readQueue(threadId)).items.length, 0);
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("legacy-held-resume"),
        threadId,
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.equal(projection.runs[1]?.queueHeld, false);
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-turn.start'`)[0]
          ?.count,
        1,
      );
    }).pipe(
      Effect.provide(
        legacyImporterLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(testLayer, SqlitePersistenceMemory).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ),
);

it.effect.each(
  (["changed", "removed"] as const).map((pendingState) => ({
    caseTitle: `retires accepted admission without reclaiming a ${pendingState} pending upload`,
    pendingState,
  })),
)("$caseTitle", ({ pendingState }) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const threadId = ThreadId.make(`accepted-upload-${pendingState}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("receipt-project"),
      title: "Pending upload",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const pendingId = createPendingAttachmentId();
    assert.ok(pendingId);
    const pendingPath = `${config.attachmentsDir}/${pendingId}.png`;
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFileString(pendingPath, "hi");
    const source = yield* writeQueue(threadId, {
      ...(yield* readQueue(threadId)),
      migrated: true,
      items: [
        {
          queueItemId: "qitem_pending",
          threadId,
          text: "Retained evidence",
          modelSelection,
          attachments: [
            {
              type: "image",
              id: ChatAttachmentId.make(pendingId),
              name: "evidence.png",
              mimeType: "image/png",
              sizeBytes: 2,
            },
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    assert.equal(yield* cutOverLegacyQueue(threadId), 1);
    const accepted = yield* orchestrator.getThreadProjection(threadId);
    const attachment = accepted.messages[0]?.attachments[0];
    assert.ok(attachment);
    const acceptedPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    assert.ok(acceptedPath);
    assert.equal(yield* fs.readFileString(acceptedPath), "hi");
    // Acceptance survived, but the source-retirement write did not.
    yield* writeQueue(threadId, source);
    if (pendingState === "removed") yield* fs.remove(pendingPath);
    else yield* fs.writeFileString(pendingPath, "ha");
    const filesBefore = yield* fs.readDirectory(config.attachmentsDir);
    const sequenceBefore = yield* sink.latestSequence();
    assert.equal(yield* cutOverLegacyQueue(threadId), 1);
    assert.equal((yield* readQueue(threadId)).items.length, 0);
    assert.equal(yield* sink.latestSequence(), sequenceBefore);
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), accepted);
    assert.equal(yield* fs.readFileString(acceptedPath), "hi");
    assert.deepEqual(yield* fs.readDirectory(config.attachmentsDir), filesBefore);
  }).pipe(
    Effect.provide(
      legacyImporterLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(testLayer, SqlitePersistenceMemory).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  ),
);

it.effect(
  "admits JSON and copied SQL entries in order while retaining the original image bytes and source file",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const threadId = ThreadId.make("legacy-json-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("legacy-json-create"),
        threadId,
        projectId: ProjectId.make("receipt-project"),
        title: "Held JSON",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const item = {
        queueItemId: "qitem_sql",
        text: "Copied SQL first",
        attachments: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      yield* writeQueue(threadId, { ...(yield* readQueue(threadId)), items: [item] });
      const filename = legacyQueueFilePath(config.stateDir, threadId);
      yield* fs.makeDirectory(config.stateDir + "/scient/thread-queue", { recursive: true });
      const source = encodeQueueSource({
        formatVersion: 1,
        threadId,
        items: [
          item,
          {
            ...item,
            queueItemId: "qitem_image",
            text: "Image second",
            selectedScientSkillNames: ["analysis"],
            sendRequested: true,
            steerRequested: true,
            state: "editing",
            editToken: "obsolete",
            attachments: [
              {
                type: "image",
                name: "evidence.png",
                mimeType: "image/png",
                sizeBytes: 2,
                dataUrl: "data:image/png;base64,aGk=",
              },
            ],
          },
        ],
      });
      yield* fs.writeFileString(filename, source);
      assert.equal(yield* cutOverLegacyQueue(threadId), 2);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.runs.map(
          (run) => projection.messages.find((message) => message.id === run.userMessageId)?.text,
        ),
        ["Copied SQL first", "Image second"],
      );
      assert.ok(projection.runs.every((run) => run.status === "queued" && run.queueHeld));
      const attachment = projection.messages.find((message) => message.text === "Image second")!
        .attachments[0]!;
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      assert.ok(attachmentPath);
      assert.equal(yield* fs.readFileString(attachmentPath), "hi");
      // A retry must never overwrite attachment bytes already referenced by V2.
      const conflict = yield* Effect.exit(
        persistChatAttachments({
          threadId,
          messageId: projection.messages.find((message) => message.text === "Image second")!.id,
          attachments: [
            {
              type: "image",
              name: "evidence.png",
              mimeType: "image/png",
              sizeBytes: 2,
              dataUrl: "data:image/png;base64,aGE=",
            },
          ],
        }),
      );
      assert.equal(conflict._tag, "Failure");
      assert.equal(yield* fs.readFileString(attachmentPath), "hi");
      assert.equal(yield* fs.readFileString(filename), source);
      assert.equal(yield* cutOverLegacyQueue(threadId), 0);
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 2);
      assert.equal(yield* fs.readFileString(filename), source);
    }).pipe(
      Effect.provide(
        legacyImporterLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(testLayer, SqlitePersistenceMemory).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ),
);

it.effect(
  "preserves a held message for an unavailable instance without exposing migration admission to clients",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("legacy-unavailable-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("legacy-unavailable-create"),
        threadId,
        projectId: ProjectId.make("receipt-project"),
        title: "Unavailable",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const command = {
        type: "legacy-queue.import" as const,
        commandId: CommandId.make("legacy-unavailable-import"),
        threadId,
        queueItemId: "qitem_unavailable",
        messageId: MessageId.make("legacy-unavailable-message"),
        text: "Keep until the runtime is configured",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("removed-account"),
          model: "retained-model",
        },
        selectedScientSkillNames: ["analysis"],
        createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      };
      assert.equal(isClientCommand(command), false);
      yield* orchestrator.dispatch(command);
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "queued");
      assert.equal(projection.runs[0]?.queueHeld, true);
      assert.deepEqual(projection.runs[0]?.modelSelection, command.modelSelection);
      assert.equal(projection.providerThreads.length, 0);
      assert.equal(projection.providerSessions.length, 0);
      assert.equal(projection.runtimeRequests.length, 0);
      assert.equal(projection.messages[0]?.text, command.text);
      const resumed = yield* orchestrator
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make("legacy-unavailable-resume"),
          threadId,
        })
        .pipe(Effect.exit);
      assert.equal(resumed._tag, "Failure");
      const stillHeld = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stillHeld.runs[0]?.queueHeld, true);
      assert.equal(stillHeld.runs[0]?.status, "queued");
      assert.equal(stillHeld.messages[0]?.text, command.text);
      const replay = yield* orchestrator.dispatch(command);
      assert.ok(replay.storedEvents.length > 0);
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(
  (["active", "renamed", "completed", "foreign-project"] as const).map((scenario) => ({
    caseTitle: `releases held legacy title and plan metadata only on authorized Resume: ${scenario}`,
    scenario,
  })),
)("$caseTitle", ({ scenario }) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make(`held-metadata:${scenario}`);
    const sourceThreadId = ThreadId.make(`held-plan:${scenario}`);
    const projectId = ProjectId.make("receipt-project");
    const create = (id: ThreadId, project: ProjectId, title: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: id,
        projectId: project,
        title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    yield* create(threadId, projectId, "Original title");
    yield* create(
      sourceThreadId,
      scenario === "foreign-project" ? ProjectId.make("other-project") : projectId,
      "Plan source",
    );
    const now = yield* DateTime.now;
    const planId = PlanId.make(`plan:${scenario}`);
    yield* sink.writeWithEffects({
      effects: [],
      events: [
        {
          id: EventId.make(`plan-event:${scenario}`),
          type: "plan.updated",
          threadId: sourceThreadId,
          occurredAt: now,
          payload: {
            id: planId,
            threadId: sourceThreadId,
            runId: null,
            nodeId: NodeId.make(`historical-plan:${scenario}`),
            kind: "proposed_plan",
            status: scenario === "completed" ? "completed" : "active",
            markdown: "# Plan\nImplement the requested change.",
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "legacy-queue.import",
      commandId: CommandId.make(`admit:${scenario}`),
      threadId,
      queueItemId: `qitem_${scenario}`,
      messageId: MessageId.make(`held-message:${scenario}`),
      text: "Implement the plan",
      attachments: [],
      titleSeed: "Captured title",
      sourceProposedPlan: { threadId: sourceThreadId, planId },
      createdAt: now,
    });
    const read = () => orchestrator.getThreadProjection(threadId);
    const admitted = yield* read();
    assert.equal(admitted.thread.title, "Original title");
    assert.equal(
      (yield* orchestrator.getThreadProjection(sourceThreadId)).plans[0]?.status,
      scenario === "completed" ? "completed" : "active",
    );
    assert.equal(
      (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`)[0]?.count,
      0,
    );
    if (scenario === "renamed")
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`rename:${scenario}`),
        threadId,
        title: "User's chosen title",
      });
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`resume:${scenario}`),
      threadId,
    });
    const after = yield* read();
    const canDeliver = scenario === "active" || scenario === "renamed";
    assert.equal(after.runs[0]?.status, canDeliver ? "starting" : "queued");
    if (!canDeliver) {
      assert.equal(after.runs[0]?.queueHeld, true);
      assert.equal(after.runs[0]?.queuePosition, admitted.runs[0]?.queuePosition);
      assert.deepEqual(after.messages, admitted.messages);
      assert.ok(
        after.turnItems.some(
          (item) => item.type === "error" && item.failure.code === "queued_start_failed",
        ),
      );
    }
    assert.equal(
      after.thread.title,
      scenario === "active"
        ? "Captured title"
        : scenario === "renamed"
          ? "User's chosen title"
          : "Original title",
    );
    assert.equal(
      (yield* orchestrator.getThreadProjection(sourceThreadId)).plans[0]?.status,
      scenario === "completed" ? "completed" : "active",
    );
    const effectCount = (effectType: string) =>
      sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE effect_type = ${effectType}`;
    assert.equal((yield* effectCount("provider-turn.start"))[0]?.count, canDeliver ? 1 : 0);
    assert.equal(
      (yield* effectCount("thread-title.generate"))[0]?.count,
      scenario === "active" ? 1 : 0,
    );
    assert.equal(after.messages[0]?.text, "Implement the plan");
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`resume:${scenario}`),
      threadId,
    });
    assert.equal((yield* effectCount("provider-turn.start"))[0]?.count, canDeliver ? 1 : 0);
  }).pipe(Effect.provide(testLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

it.effect(
  "invalid queues and deleted destinations preserve pending work while other threads cut over",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const corruptId = ThreadId.make("a-corrupt-queue");
      const validId = ThreadId.make("b-valid-queue");
      const deletedId = ThreadId.make("a-deleted-queue");
      const attachmentId = ThreadId.make("a-invalid-attachment-queue");
      for (const threadId of [corruptId, validId, deletedId, attachmentId]) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("receipt-project"),
          title: "Pending work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-stale-queue"),
        threadId: deletedId,
      });
      for (const threadId of [deletedId, attachmentId]) {
        yield* writeQueue(threadId, {
          ...(yield* readQueue(threadId)),
          migrated: true,
          items: [
            {
              queueItemId: threadId === deletedId ? "qitem_stale" : "qitem_badattachment",
              threadId,
              text: "Recover this pending work",
              modelSelection,
              attachments:
                threadId === attachmentId
                  ? [
                      {
                        type: "image",
                        name: "corrupt.png",
                        mimeType: "image/png",
                        sizeBytes: 3,
                        dataUrl: "data:image/png;base64,aGk=",
                      },
                    ]
                  : [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      yield* sql`INSERT INTO scient_thread_queue (thread_id, document, revision) VALUES (${corruptId}, 'invalid-json', 1)`;
      yield* writeQueue(validId, {
        ...(yield* readQueue(validId)),
        migrated: true,
        items: [
          {
            queueItemId: "qitem_valid",
            threadId: validId,
            text: "Preserved work",
            attachments: [],
            modelSelection,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      assert.equal(yield* cutOverLegacyQueues, 1);
      const [source] = yield* sql<{
        document: string;
      }>`SELECT document FROM scient_thread_queue WHERE thread_id = ${corruptId}`;
      assert.equal(source?.document, "invalid-json");
      assert.equal((yield* orchestrator.getThreadProjection(corruptId)).runs.length, 0);
      for (const threadId of [deletedId, attachmentId]) {
        const retained = yield* readQueue(threadId);
        assert.equal(retained.items.length, 1);
        assert.equal(retained.items[0]?.text, "Recover this pending work");
        const refused = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(refused.runs.length, 0);
        assert.equal(refused.messages.length, 0);
      }
      const admitted = yield* orchestrator.getThreadProjection(validId);
      assert.equal(admitted.runs[0]?.queueHeld, true);
      assert.equal(admitted.messages[0]?.text, "Preserved work");
      assert.equal(yield* cutOverLegacyQueues, 0);
      assert.equal((yield* orchestrator.getThreadProjection(validId)).runs.length, 1);
    }).pipe(
      Effect.provide(
        legacyImporterLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(testLayer, SqlitePersistenceMemory).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ),
);

it.effect("a finished cutover skips its threads on the next boot; pending work still retries", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const importer = yield* LegacyV1ThreadImporter;
    const finishedId = ThreadId.make("a-finished-json-queue");
    const pendingId = ThreadId.make("b-pending-sql-queue");
    for (const threadId of [finishedId, pendingId]) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("receipt-project"),
        title: "Cutover",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    // The pending queue cannot be admitted: its destination is deleted.
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-pending-queue"),
      threadId: pendingId,
    });
    yield* writeQueue(pendingId, {
      ...(yield* readQueue(pendingId)),
      migrated: true,
      items: [
        {
          queueItemId: "qitem_pending",
          threadId: pendingId,
          text: "Still pending",
          attachments: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    yield* fs.makeDirectory(config.stateDir + "/scient/thread-queue", { recursive: true });
    yield* fs.writeFileString(
      legacyQueueFilePath(config.stateDir, finishedId),
      encodeQueueSource({
        formatVersion: 1,
        threadId: finishedId,
        items: [
          {
            queueItemId: "qitem_finished",
            text: "Admitted once",
            attachments: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const hydrated: ThreadId[] = [];
    const boot = cutOverLegacyQueues.pipe(
      Effect.provideService(LegacyV1ThreadImporter, {
        ...importer,
        ensureTranscript: (threadId) =>
          Effect.sync(() => hydrated.push(threadId)).pipe(
            Effect.andThen(importer.ensureTranscript(threadId)),
          ),
      }),
    );
    assert.equal(yield* boot, 1);
    assert.deepEqual(hydrated.toSorted(), [finishedId, pendingId]);
    hydrated.length = 0;
    assert.equal(yield* boot, 0);
    assert.deepEqual(hydrated, [pendingId]);
    assert.equal((yield* orchestrator.getThreadProjection(finishedId)).runs.length, 1);
    assert.equal((yield* readQueue(pendingId)).items.length, 1);
  }).pipe(
    Effect.provide(
      legacyImporterLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(testLayer, SqlitePersistenceMemory).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  ),
);

it.effect("schema-invalid migrated documents stay on the cutover retry path", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter;
    const documents = {
      "numeric-migrated-flag":
        '{"revision":1,"migrated":1,"items":[],"blocked":false,"turnId":null,"paused":null}',
      "missing-ledger-fields": '{"migrated":true,"items":[]}',
    };
    for (const [name, document] of Object.entries(documents)) {
      const threadId = ThreadId.make(name);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("receipt-project"),
        title: "Damaged ledger",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* sql`INSERT INTO scient_thread_queue (thread_id, document, revision) VALUES (${threadId}, ${document}, 1)`;
    }
    const hydrated: ThreadId[] = [];
    const imported = yield* cutOverLegacyQueues.pipe(
      Effect.provideService(LegacyV1ThreadImporter, {
        ...importer,
        ensureTranscript: (threadId) =>
          Effect.sync(() => hydrated.push(threadId)).pipe(
            Effect.andThen(importer.ensureTranscript(threadId)),
          ),
      }),
    );
    assert.equal(imported, 0);
    assert.deepEqual(hydrated.toSorted(), Object.keys(documents).toSorted());
    for (const [name, document] of Object.entries(documents)) {
      const [row] = yield* sql<{
        document: string;
      }>`SELECT document FROM scient_thread_queue WHERE thread_id = ${name}`;
      assert.equal(row?.document, document);
    }
  }).pipe(
    Effect.provide(
      legacyImporterLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(testLayer, SqlitePersistenceMemory).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  ),
);

it.effect("refuses staged message identities owned by another conversation", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    const ownerId = ThreadId.make("queue-message-owner");
    const targetId = ThreadId.make("queue-message-target");
    const messageId = MessageId.make("globally-owned-message");
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    for (const threadId of [ownerId, targetId]) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("receipt-project"),
        title: "Identity owner",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    yield* sink.write({
      events: [
        {
          id: EventId.make("owned-history-message"),
          type: "message.updated",
          threadId: ownerId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId: ownerId,
            role: "user",
            text: "Keep this history",
            createdBy: "user",
            creationSource: "server",
            runId: null,
            nodeId: null,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    const ownerBefore = yield* orchestrator.getThreadProjection(ownerId);
    const targetBefore = yield* orchestrator.getThreadProjection(targetId);
    const source = yield* writeQueue(targetId, {
      ...(yield* readQueue(targetId)),
      migrated: true,
      items: [
        {
          queueItemId: "qitem_foreign-message",
          threadId: targetId,
          messageId,
          text: "Do not replace another conversation",
          attachments: [],
          modelSelection,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const result = yield* cutOverLegacyQueue(targetId).pipe(Effect.exit);
    assert.equal(result._tag, "Failure");
    // Internal admission also fences the global identity at commit, even when
    // the staging preflight was bypassed or another import won after it.
    const commandId = CommandId.make("foreign-message-direct-admission");
    const direct = yield* orchestrator
      .dispatch({
        type: "legacy-queue.import",
        commandId,
        threadId: targetId,
        queueItemId: "qitem_direct-foreign-message",
        messageId,
        text: "Do not replace another conversation",
        attachments: [],
        modelSelection,
        createdAt: now,
      })
      .pipe(Effect.exit);
    assert.equal(direct._tag, "Failure");
    const receipts = yield* CommandReceiptStoreV2;
    assert.equal(Option.isNone(yield* receipts.getByCommandId(commandId)), true);
    assert.deepEqual(yield* orchestrator.getThreadProjection(ownerId), ownerBefore);
    assert.deepEqual(yield* orchestrator.getThreadProjection(targetId), targetBefore);
    assert.deepEqual(yield* readQueue(targetId), source);
  }).pipe(
    Effect.provide(
      legacyImporterLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(testLayer, SqlitePersistenceMemory).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  ),
);

it.effect("refuses queued identity collisions with portable historical messages", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    const threadId = ThreadId.make("queue-history-collision");
    const messageId = MessageId.make("existing-portable-message");
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-queue-history"),
      threadId,
      projectId: ProjectId.make("receipt-project"),
      title: "Imported history",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make("portable-history-message"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            role: "user",
            text: "Historical user text",
            createdBy: "user",
            creationSource: "server",
            runId: null,
            nodeId: null,
            selectedScientSkillNames: ["retained"],
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    const before = yield* orchestrator.getThreadProjection(threadId);
    const result = yield* orchestrator
      .dispatch({
        type: "legacy-queue.import",
        commandId: CommandId.make("import-queue-history-collision"),
        threadId,
        queueItemId: "qitem_history-collision",
        messageId,
        text: "Pending text must not replace history",
        attachments: [],
        selectedScientSkillNames: [],
        modelSelection,
        createdAt: now,
      })
      .pipe(Effect.exit);
    assert.equal(result._tag, "Failure");
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a deleted destination rejects new migration authority without publishing a queued message",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("deleted-queue-destination");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("deleted-queue-create"),
        threadId,
        projectId: ProjectId.make("receipt-project"),
        title: "Deleted",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("deleted-queue-delete"),
        threadId,
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const rejected = yield* orchestrator
        .dispatch({
          type: "legacy-queue.import",
          commandId: CommandId.make("deleted-queue-import"),
          threadId,
          queueItemId: "qitem_deleted",
          messageId: MessageId.make("deleted-queue-message"),
          text: "Do not restore this destination",
          attachments: [],
          modelSelection,
          createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        })
        .pipe(Effect.exit);
      assert.equal(rejected._tag, "Failure");
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(after.thread.deletedAt, before.thread.deletedAt);
      assert.equal(after.runs.length, 0);
      assert.equal(after.messages.length, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "restoring a removed provider lets an explicit Resume deliver the original held work",
  () => {
    let available = false;
    const registry = Layer.succeed(ProviderAdapterRegistryV2, {
      get: (id) =>
        available || id === instanceId
          ? Effect.succeed({
              instanceId: id,
              driver: ProviderDriverKind.make("codex"),
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
              planSelectionTransition: () =>
                Effect.succeed({ type: "apply_on_next_turn" as const }),
              openSession: () => Effect.die("Worker is paused for durable delivery inspection"),
            })
          : Effect.fail(new ProviderAdapterRegistryLookupError({ instanceId: id })),
      list: () => Effect.succeed([instanceId]),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("recover-provider-queue");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("recover-provider-create"),
        threadId,
        projectId: ProjectId.make("receipt-project"),
        title: "Retained",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const selection = {
        instanceId: ProviderInstanceId.make("restored-account"),
        model: "retained-model",
      };
      yield* orchestrator.dispatch({
        type: "legacy-queue.import",
        commandId: CommandId.make("recover-provider-import"),
        threadId,
        queueItemId: "qitem_restore",
        messageId: MessageId.make("recover-provider-message"),
        text: "Original work",
        attachments: [],
        modelSelection: selection,
        selectedScientSkillNames: ["analysis"],
        createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      });
      const rejected = yield* orchestrator
        .dispatch({
          type: "queue.resume",
          threadId,
          commandId: CommandId.make("recover-provider-unavailable"),
        })
        .pipe(Effect.exit);
      assert.equal(rejected._tag, "Failure");
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[0]?.queueHeld, true);
      available = true;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        threadId,
        commandId: CommandId.make("recover-provider-resume"),
      });
      const delivered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(delivered.runs[0]?.status, "starting");
      assert.equal(delivered.runs[0]?.queueHeld, false);
      assert.deepEqual(delivered.runs[0]?.modelSelection, selection);
      assert.equal(delivered.messages[0]?.text, "Original work");
      assert.deepEqual(delivered.messages[0]?.selectedScientSkillNames, ["analysis"]);
    }).pipe(
      Effect.provide(
        makeOrchestratorV2ReplayLayerWithRegistry({ name: "restore-provider-queue" }, registry, {
          runEffectWorker: false,
        }),
      ),
    );
  },
);

it.effect("targeted Send uses the same automatic-completion priority as queue delivery", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const sink = yield* EventSinkV2;
    const threadId = ThreadId.make("priority-queue-thread");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("priority-queue-create"),
      threadId,
      projectId: ProjectId.make("receipt-project"),
      title: "Priority",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    for (const suffix of ["ordinary", "automatic"]) {
      yield* orchestrator.dispatch({
        type: "legacy-queue.import",
        commandId: CommandId.make(`priority-admit:${suffix}`),
        threadId,
        queueItemId: `qitem_${suffix}`,
        messageId: MessageId.make(`priority-message:${suffix}`),
        text: suffix,
        attachments: [],
        modelSelection,
        createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      });
    }
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const automatic = projection.messages.find(
      (message) => message.id === MessageId.make("priority-message:automatic"),
    )!;
    yield* sink.writeWithEffects({
      effects: [],
      events: [
        {
          id: EventId.make("priority-automatic-delivery"),
          type: "message.updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: {
            ...automatic,
            delegatedCompletion: {
              parentRunId: projection.runs[0]!.id,
              generation: 1,
              taskIds: [NodeId.make("completed-task")],
            },
          },
        },
      ],
    });
    const automaticSend = yield* orchestrator
      .dispatch({
        type: "queue.resume",
        threadId,
        commandId: CommandId.make("priority-send-automatic"),
        runId: projection.runs[1]!.id,
      })
      .pipe(Effect.exit);
    assert.equal(automaticSend._tag, "Failure");
    const held = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      held.runs.map((run) => [run.status, run.queueHeld]),
      [
        ["queued", true],
        ["queued", true],
      ],
    );
    // Send on the ordinary message: the automatic completion still goes first.
    yield* orchestrator.dispatch({
      type: "queue.resume",
      threadId,
      commandId: CommandId.make("priority-send-ordinary"),
      runId: projection.runs[0]!.id,
    });
    const delivered = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(delivered.runs[1]?.status, "starting");
    assert.equal(delivered.runs[0]?.status, "queued");
    assert.equal(delivered.runs[0]?.queueHeld, false);
  }).pipe(Effect.provide(testLayer)),
);
