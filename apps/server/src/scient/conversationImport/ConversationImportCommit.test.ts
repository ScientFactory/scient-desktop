import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { buildConversationSnapshot } from "@scientfactory/conversation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Receipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Executor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Maintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import { planConversationFork } from "../../orchestration-v2/scient-fork/ConversationForkPlan.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { conversationSnapshotProjection } from "../conversationExport/conversationSnapshotProjection.ts";
import {
  buildConversationImportCommand,
  mintConversationImportIds,
} from "./conversationImportPlan.ts";
import {
  destination,
  importFixture,
  principal,
  testLease,
  PROVIDER_ID,
  PROJECT_ID,
} from "./conversationImport.test-fixtures.ts";
import * as Commit from "./ConversationImportCommit.ts";
import * as ImporterLive from "./ConversationImporterLive.ts";
import { ConversationImporter } from "./ConversationImporter.ts";
import { readConversationImportJournal } from "./ConversationImportJournal.ts";
import * as Snapshot from "../conversationExport/ConversationSnapshotService.ts";
import * as LegacyImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ProjectCloneTracker } from "../../project/ProjectCloneTracker.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

const stores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
  Receipts.layer,
  Executor.layer,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const TestLayer = Layer.mergeAll(Commit.layer, Maintenance.layer).pipe(
  Layer.provideMerge(sink),
  Layer.provideMerge(NodeServices.layer),
);

const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${PROJECT_ID}, 'Import project', '/tmp/import-project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
});

it.effect(
  "portable import commits once as V2 history, round-trips its content and forks exact historical boundaries",
  () =>
    Effect.gen(function* () {
      yield* seedProject;
      const fixture = importFixture({
        turns: 2,
        reasoning: true,
        workLog: true,
        attachments: true,
      });
      const command = buildConversationImportCommand({
        validated: fixture.input,
        ids: yield* mintConversationImportIds(fixture.input),
        destination: destination(),
        importedAt: "2026-09-28T12:00:00.000Z",
      });
      const commit = yield* Commit.ConversationImportCommit;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = Commit.conversationImportEvents(command);
      for (const event of events) assert.isTrue(isDomainEvent(event));
      yield* commit.dispatch(command);
      const projection = yield* projections.getThreadProjection(command.threadId);
      assert.equal(projection.thread.historyOrigin, "conversation_import");
      assert.equal(projection.messages.length, 4);
      assert.deepEqual(projection.runs, []);
      assert.deepEqual(projection.providerSessions, []);
      assert.deepEqual(projection.runtimeRequests, []);
      assert.equal(projection.plans.length, command.proposedPlans.length);
      assert.isTrue(projection.nodes.every((node) => !node.countsForRun && node.runId === null));
      assert.isTrue(
        projection.turnItems.every((item) => item.runId === null && item.nativeItemRef === null),
      );
      const source = conversationSnapshotProjection(projection, "/tmp/import-project");
      const snapshot = buildConversationSnapshot({
        thread: source,
        snapshotSequence: 1,
        threadSequence: 1,
        capturedAt: command.createdAt,
        selection: { workLog: true, reasoning: true, throughMessageId: null },
        isAttachmentAvailable: () => true,
      });
      assert.equal(snapshot.messages.length, fixture.input.snapshot.messages.length);
      assert.equal(snapshot.reasoning.length, fixture.input.snapshot.reasoning.length);
      assert.equal(snapshot.workLog.length, fixture.input.snapshot.workLog.length);
      assert.equal(snapshot.questionAnswers.length, fixture.input.snapshot.questionAnswers.length);
      assert.equal(snapshot.proposedPlans.length, fixture.input.snapshot.proposedPlans.length);
      assert.deepEqual(
        snapshot.workLog.map((entry) => (entry._tag === "tool" ? entry.output?.text : null)),
        fixture.input.snapshot.workLog.map((entry) =>
          entry._tag === "tool" ? entry.output?.text : null,
        ),
      );
      const secondPrompt = projection.turnItems.filter((item) => item.type === "user_message")[1];
      if (secondPrompt?.type !== "user_message") return assert.fail("Missing second prompt");
      const plan = yield* planConversationFork({
        projection,
        targetThreadId: ThreadId.make("import-prefix-fork"),
        source: { kind: "user-message", messageId: secondPrompt.messageId },
      });
      // Settled imported history is shared by reference, not copied.
      assert.deepEqual(plan.messages, []);
      assert.equal(plan.retained.filter((item) => item.type === "user_message").length, 1);
      assert.equal(plan.retained.filter((item) => item.type === "assistant_message").length, 1);
      assert.lengthOf(plan.history, plan.retained.length);
      yield* commit.dispatch(command);
      assert.deepEqual(yield* projections.getThreadProjection(command.threadId), projection);
      yield* (yield* Maintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(yield* projections.getThreadProjection(command.threadId), projection);
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("delete-import"),
            type: "thread.deleted",
            threadId: command.threadId,
            occurredAt: now,
            payload: { ...projection.thread, deletedAt: now },
          },
        ],
      });
      yield* commit.dispatch(command);
      assert.isNotNull((yield* projections.getThread(command.threadId)).deletedAt);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "a missing destination records a rejected import receipt without publishing history",
  () =>
    Effect.gen(function* () {
      const fixture = importFixture({ turns: 1 });
      const command = buildConversationImportCommand({
        validated: fixture.input,
        ids: yield* mintConversationImportIds(fixture.input),
        destination: destination(),
        importedAt: "2026-09-28T12:00:00.000Z",
      });
      const result = yield* Effect.result(
        (yield* Commit.ConversationImportCommit).dispatch(command),
      );
      assert.equal(result._tag, "Failure");
      const receipt = yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(
        CommandId.make(command.commandId),
      );
      assert.equal(receipt._tag === "Some" ? receipt.value.status : null, "rejected");
      assert.equal(
        yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(command.threadId),
        null,
      );
    }).pipe(Effect.provide(TestLayer)),
);

const configuredProvider: ServerProvider = {
  instanceId: PROVIDER_ID,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-03T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const importerDependencies = Layer.mergeAll(
  Layer.mock(ProviderRegistry, { getProviders: Effect.succeed([configuredProvider]) }),
  Layer.mock(ProjectCloneTracker, { get: () => Effect.succeed(null) }),
);
const NativeImportLayer = Layer.mergeAll(
  ImporterLive.layer.pipe(Layer.provide(Commit.layer), Layer.provide(importerDependencies)),
  Snapshot.layer.pipe(Layer.provide(LegacyImporter.layer)),
).pipe(
  Layer.provideMerge(sink),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scient-native-import-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "publishes owned attachment bytes, exports native history and settles an accepted journal after deletion",
  () =>
    Effect.gen(function* () {
      yield* seedProject;
      const fixture = importFixture({
        turns: 2,
        reasoning: true,
        workLog: true,
        attachments: true,
      });
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { lease, copied } = testLease({
        fixture,
        attemptDirectory: path.join(config.stateDir, "native-import-attempt"),
      });
      const importer = yield* ConversationImporter;
      const request = { destination: destination(), principal: principal() };
      const completion = yield* importer.importConversation(lease, request);
      const journal = yield* readConversationImportJournal(lease.attemptDirectory);
      if (journal._tag !== "Some") return assert.fail("The committed journal is absent");
      assert.equal(copied.length, fixture.resources.size);
      for (const attachment of journal.value.attachments) {
        assert.deepEqual(
          yield* fs.readFile(attachment.path),
          fixture.resources.get(attachment.resourceId),
        );
      }
      const captured = yield* (yield* Snapshot.ConversationSnapshotService).capture({
        threadId: completion.result.threadId,
        selection: { workLog: true, reasoning: true, throughMessageId: null },
      });
      assert.equal(captured.snapshot.messages.length, fixture.input.snapshot.messages.length);
      assert.equal(
        captured.snapshot.questionAnswers.length,
        fixture.input.snapshot.questionAnswers.length,
      );
      assert.equal(captured.attachmentFiles.size, fixture.resources.size);
      assert.deepEqual(yield* importer.importConversation(lease, request), completion);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* projections.getThreadProjection(completion.result.threadId);
      assert.deepEqual(projection.runtimeRequests, []);
      assert.deepEqual(projection.providerSessions, []);
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("delete-published-import"),
            type: "thread.deleted",
            threadId: projection.thread.id,
            occurredAt: now,
            payload: { ...projection.thread, deletedAt: now },
          },
        ],
      });
      const settled = yield* importer.settleAttempt({
        importId: lease.importId,
        attemptDirectory: lease.attemptDirectory,
        reason: "startup",
      });
      assert.deepEqual(settled, { _tag: "committed", completion });
      assert.deepEqual(yield* importer.importConversation(lease, request), completion);
      for (const attachment of journal.value.attachments)
        assert.isTrue(yield* fs.exists(attachment.path));
      assert.isNotNull((yield* projections.getThread(projection.thread.id)).deletedAt);
    }).pipe(Effect.provide(NativeImportLayer)),
);
