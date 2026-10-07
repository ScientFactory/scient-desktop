import { assert, it } from "@effect/vitest";
import { ConversationSnapshotV1, EventId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import * as Receipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Commit from "./ConversationImportCommit.ts";
import {
  buildConversationImportCommand,
  mintConversationImportIds,
  ConversationImportIds,
} from "./conversationImportPlan.ts";
import {
  readConversationImportJournal,
  writeConversationImportJournal,
  CONVERSATION_IMPORT_JOURNAL_FILE,
} from "./ConversationImportJournal.ts";

import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Maintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as LegacyImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Snapshot from "../conversationExport/ConversationSnapshotService.ts";
import { PNG, makePackage, zipBytesPromise } from "../conversationFile/scic.test-fixtures.ts";
import { sha256Digest } from "../conversationFile/ScicWriter.ts";
import {
  ConversationImporter,
  ValidatedConversationImport,
  conversationContentDigest,
} from "./ConversationImporter.ts";
import * as Staging from "./ConversationImportStaging.ts";
import {
  createNativeProjects,
  nativeImportTestLayer,
} from "./conversationImport.native-test-harness.ts";
import {
  destination,
  importFixture,
  principal,
  testLease,
} from "./conversationImport.test-fixtures.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(ConversationSnapshotV1);
const decodeValidatedImport = Schema.decodeEffect(ValidatedConversationImport);
const decodeImportIds = Schema.decodeEffect(ConversationImportIds);
const encodeUnknownJournalJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const TestLayer = Layer.mergeAll(
  Staging.layer({ sweepOnTimer: false }).pipe(Layer.provide(Secrets.layer)),
  Maintenance.layer,
  Snapshot.layer.pipe(Layer.provide(LegacyImporter.layer)),
).pipe(Layer.provideMerge(nativeImportTestLayer()));

const orderedFixture = Effect.gen(function* () {
  const fixture = importFixture({ turns: 3, reasoning: true, workLog: true, attachments: true });
  const source = fixture.input.snapshot;
  const messages = source.messages.map((message, index) => ({
    ...message,
    text: message.role === "user" ? `Queued question ${index / 2 + 1}` : message.text,
    references: [],
    // Queued requests precede every answer in wall-clock time. Their exported
    // conversation sequence remains request/answer, request/answer.
    ...(message.role === "user"
      ? {
          createdAt: `2026-09-27T10:00:0${index / 2 + 1}.000Z`,
          updatedAt: `2026-09-27T10:00:0${index / 2 + 1}.000Z`,
        }
      : {}),
    attachments: message.attachments.map((attachment) =>
      attachment.localId === "attachment-1"
        ? { ...attachment, sizeBytes: PNG.byteLength }
        : attachment,
    ),
  }));
  const system = {
    n: 3,
    id: "source-system",
    role: "system",
    turnId: null,
    createdAt: "2026-09-27T10:00:17.000Z",
    updatedAt: "2026-09-27T10:00:17.000Z",
    text: "Historical system guidance",
    attachments: [],
    references: [],
  };
  const snapshot = yield* decodeSnapshot({
    ...source,
    messages: [...messages.slice(0, 2), system, ...messages.slice(2)].map((message, index) => ({
      ...message,
      n: index + 1,
    })),
    questionAnswers: source.questionAnswers.map((answer) => ({
      ...answer,
      items: answer.items.map((item) => ({
        ...item,
        attachments: item.attachments.map((attachment) => ({
          ...attachment,
          sizeBytes: PNG.byteLength,
        })),
      })),
    })),
    workLog: source.workLog.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            title: "Historical command approval",
            status: "completed",
            createdAt: "2026-09-27T10:00:30.000Z",
          }
        : entry,
    ),
  });
  return {
    snapshot: { ...snapshot, contentDigest: conversationContentDigest(snapshot) },
    attachments: new Map([
      ["attachment-1", { _tag: "bytes" as const, bytes: PNG, sha256: sha256Digest(PNG) }],
      [
        "attachment-2",
        {
          _tag: "bytes" as const,
          bytes: Uint8Array.from(fixture.resources.get("attachment-2")!),
          sha256: sha256Digest(fixture.resources.get("attachment-2")!),
        },
      ],
    ]),
  };
});

const stage = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const staging = yield* Staging.ConversationImportStaging;
  const upload = yield* staging.createUpload({
    fileName: "queued-conversation.scic",
    sizeBytes: bytes.byteLength,
  });
  const token = upload.relativeUrl.slice(
    Staging.CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX.length + 1,
  );
  const claims = yield* staging.validateUploadToken(token);
  assert(claims !== null);
  yield* staging.receiveUpload(claims, Stream.make(bytes));
  const preview = yield* staging.preview(upload.importId);
  assert.equal(preview.counts.messages, 7);
  return {
    importId: upload.importId,
    packageSha256: sha256Digest(bytes),
    destination: destination(),
  };
});

it.live(
  "preserves SCIC conversation order through public staging, native commit, retry, rebuild and reexport",
  () =>
    Effect.gen(function* () {
      yield* createNativeProjects;
      const fixture = yield* orderedFixture;
      const pkg = makePackage(fixture.snapshot, fixture.attachments);
      const bytes = yield* Effect.promise(() => zipBytesPromise(pkg.files));
      const request = yield* stage(bytes);
      const staging = yield* Staging.ConversationImportStaging;
      const result = yield* staging.confirm(request, principal());
      const projections = yield* Projections.ProjectionStoreV2;
      const projection = yield* projections.getThreadProjection(result.threadId);
      assert.deepEqual(
        projection.messages.map((message) => message.text),
        pkg.snapshot.messages
          .filter((message) => message.role !== "system")
          .map((message) => message.text),
      );
      assert.deepEqual(projection.runs, []);
      assert.deepEqual(projection.runtimeRequests, []);
      assert.deepEqual(projection.providerSessions, []);
      assert.isTrue(
        projection.turnItems.every(
          (item) =>
            item.runId === null &&
            item.providerThreadId === null &&
            item.providerTurnId === null &&
            item.nativeItemRef === null,
        ),
      );
      const yieldSnapshot = yield* Snapshot.ConversationSnapshotService;
      const capture = () =>
        yieldSnapshot.capture({
          threadId: result.threadId,
          selection: { workLog: true, reasoning: true, throughMessageId: null },
        });
      const captured = yield* capture();
      assert.deepEqual(
        captured.snapshot.messages.map((message) => message.text),
        pkg.snapshot.messages.map((message) => message.text),
      );
      assert.deepEqual(
        captured.snapshot.messages.map((message) => [
          message.role,
          message.createdAt,
          message.updatedAt,
        ]),
        pkg.snapshot.messages.map((message) => [
          message.role,
          message.createdAt,
          message.updatedAt,
        ]),
      );
      assert.equal(captured.snapshot.reasoning.length, 3);
      assert.equal(captured.snapshot.questionAnswers.length, 1);
      assert.equal(captured.snapshot.proposedPlans.length, 1);
      const approval = captured.snapshot.workLog.find(
        (entry) => entry._tag === "tool" && entry.title === "Historical command approval",
      );
      assert(approval?._tag === "tool");
      assert.equal(approval.status, "completed");
      const firstPrompt = projection.turnItems.find(
        (item) => item.type === "user_message" && item.text === "Queued question 1",
      );
      const secondPrompt = projection.turnItems.find(
        (item) => item.type === "user_message" && item.text === "Queued question 2",
      );
      assert(firstPrompt !== undefined && secondPrompt !== undefined);
      const firstTurnFacts = projection.turnItems.filter(
        (item) => item.historyTurnId === firstPrompt.historyTurnId,
      );
      assert.isTrue(firstTurnFacts.some((item) => item.type === "reasoning"));
      assert.isTrue(firstTurnFacts.some((item) => item.type === "user_input_request"));
      assert.isTrue(firstTurnFacts.some((item) => item.type === "dynamic_tool"));
      const secondPosition = projection.visibleTurnItems.find(
        (row) => row.item.id === secondPrompt.id,
      )?.position;
      assert(secondPosition !== undefined);
      assert.isTrue(
        firstTurnFacts.every((item) => {
          const row = projection.visibleTurnItems.find((row) => row.item.id === item.id);
          return row !== undefined && row.position < secondPosition;
        }),
      );
      const fs = yield* FileSystem.FileSystem;
      const attachments = new Map<
        string,
        {
          readonly _tag: "bytes";
          readonly bytes: Uint8Array<ArrayBuffer>;
          readonly sha256: ReturnType<typeof sha256Digest>;
        }
      >();
      for (const [id, path] of captured.attachmentFiles) {
        const content = yield* fs.readFile(path);
        attachments.set(id, {
          _tag: "bytes",
          bytes: Uint8Array.from(content),
          sha256: sha256Digest(content),
        });
      }
      assert.isTrue(
        [...attachments.values()].some(
          (attachment) => sha256Digest(attachment.bytes) === sha256Digest(PNG),
        ),
      );
      assert.deepEqual(yield* staging.confirm(request, principal()), result);
      assert.deepEqual(yield* projections.getThreadProjection(result.threadId), projection);
      yield* (yield* Maintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(yield* projections.getThreadProjection(result.threadId), projection);
      const exported = makePackage((yield* capture()).snapshot, attachments);
      const reimportRequest = yield* stage(
        yield* Effect.promise(() => zipBytesPromise(exported.files)),
      );
      const reimported = yield* staging.confirm(reimportRequest, principal());
      const roundtrip = yield* yieldSnapshot.capture({
        threadId: reimported.threadId,
        selection: { workLog: true, reasoning: true, throughMessageId: null },
      });
      assert.deepEqual(
        roundtrip.snapshot.messages.map((message) => [
          message.text,
          message.createdAt,
          message.updatedAt,
        ]),
        pkg.snapshot.messages.map((message) => [
          message.text,
          message.createdAt,
          message.updatedAt,
        ]),
      );
    }).pipe(Effect.provide(TestLayer)),
  { timeout: 30_000 },
);

it.live(
  "persists sequence ordering before a real SQL commit failure and retries the same journaled identities",
  () =>
    Effect.gen(function* () {
      yield* createNativeProjects;
      const fixture = yield* orderedFixture;
      const bytes = yield* Effect.promise(() =>
        zipBytesPromise(makePackage(fixture.snapshot, fixture.attachments).files),
      );
      const request = yield* stage(bytes);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER refuse_order_import BEFORE INSERT ON orchestration_v2_projection_threads BEGIN SELECT RAISE(ABORT, 'synthetic import commit failure'); END`;
      const staging = yield* Staging.ConversationImportStaging;
      const error = yield* Effect.flip(staging.confirm(request, principal()));
      assert.equal(error._tag, "ScientConversationImportError");
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const journal = Option.getOrThrow(
        yield* readConversationImportJournal(
          path.join(config.stateDir, "scient", "conversation-imports", request.importId, "attempt"),
        ),
      );
      assert.equal(journal.ids.historyOrderVersion, 1);
      assert.isTrue(
        Option.isNone(
          yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(journal.ids.commandId),
        ),
      );
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
        0,
      );
      yield* sql`DROP TRIGGER refuse_order_import`;
      const result = yield* staging.confirm(request, principal());
      assert.equal(result.threadId, journal.ids.threadId);
      const projection = yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(
        result.threadId,
      );
      assert.deepEqual(
        projection.messages.map((message) => message.id),
        fixture.snapshot.messages
          .filter((message) => message.role !== "system")
          .map((message) => journal.ids.messages[message.id]),
      );
      assert.deepEqual(
        projection.messages.map((message) => message.text),
        fixture.snapshot.messages
          .filter((message) => message.role !== "system")
          .map((message) => message.text),
      );
      assert.isTrue(
        Option.isSome(
          yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(journal.ids.commandId),
        ),
      );
      const firstMessage = projection.messages[0];
      assert(firstMessage !== undefined);
      const firstItem = projection.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === firstMessage.id,
      );
      assert(firstItem?.type === "user_message");
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("post-import-message-edit"),
            type: "message.updated",
            threadId: result.threadId,
            occurredAt: now,
            payload: { ...firstMessage, text: "Retained local V2 edit", updatedAt: now },
          },
          {
            id: EventId.make("post-import-item-edit"),
            type: "turn-item.updated",
            threadId: result.threadId,
            occurredAt: now,
            payload: { ...firstItem, text: "Retained local V2 edit", updatedAt: now },
          },
        ],
      });
      const edited = yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(
        result.threadId,
      );
      assert.equal(edited.messages[0]?.text, "Retained local V2 edit");
      assert.deepEqual(yield* staging.confirm(request, principal()), result);
      assert.deepEqual(
        yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(result.threadId),
        edited,
      );
      yield* (yield* Maintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(
        yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(result.threadId),
        edited,
      );
    }).pipe(Effect.provide(TestLayer)),
  { timeout: 30_000 },
);

it.live(
  "resumes an older ordering-version-absent journal with its original timestamp history",
  () =>
    Effect.gen(function* () {
      yield* createNativeProjects;
      const fixture = importFixture({ turns: 3, workLog: true });
      const source = fixture.input.snapshot;
      const snapshot = {
        ...source,
        workLog: source.workLog.map((entry, index) => ({
          ...entry,
          createdAt: "2026-09-27T10:01:00.000Z",
          title: `Old late step ${index + 1}`,
        })),
        messages: source.messages.map((message, index) =>
          message.role === "user"
            ? {
                ...message,
                createdAt: `2026-09-27T10:00:0${index / 2 + 1}.000Z`,
                updatedAt: `2026-09-27T10:00:0${index / 2 + 1}.000Z`,
              }
            : message,
        ),
      };
      const contentDigest = conversationContentDigest(snapshot);
      const validated = yield* decodeValidatedImport({
        ...fixture.input,
        snapshot: { ...snapshot, contentDigest },
        package: { ...fixture.input.package, contentDigest },
      });
      const minted = yield* mintConversationImportIds(validated);
      const { historyOrderVersion: _version, ...ids } = minted;
      const decoded = yield* decodeImportIds(ids);
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "scient-old-order-journal-",
      });
      const journal = {
        version: 1 as const,
        importId: validated.importId,
        attemptId: "old-attempt",
        binding: { packageSha256: validated.package.packageSha256, destination: destination() },
        package: { exportId: validated.package.exportId, contentDigest },
        ids: decoded,
        attachments: [],
        messageCount: snapshot.messages.length,
        attachmentCount: 0,
        importedAt: "2026-09-28T12:00:00.000Z",
      };
      yield* writeConversationImportJournal(directory, journal);
      const { lease } = testLease({
        fixture: { input: validated, resources: fixture.resources },
        attemptDirectory: directory,
      });
      const importer = yield* ConversationImporter;
      const request = { destination: destination(), principal: principal() };
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const marker of [null, 2]) {
        yield* fs.writeFileString(
          path.join(directory, CONVERSATION_IMPORT_JOURNAL_FILE),
          yield* encodeUnknownJournalJson({
            ...journal,
            ids: { ...ids, historyOrderVersion: marker },
          }),
        );
        const refused = yield* Effect.flip(importer.importConversation(lease, request));
        assert.equal(refused.reason, "import-failed");
        assert.isTrue(
          Option.isNone(
            yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(ids.commandId),
          ),
        );
      }
      yield* writeConversationImportJournal(directory, journal);
      const completion = yield* importer.importConversation(lease, request);
      assert.equal(completion.result.threadId, ids.threadId);
      const projection = yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(
        ids.threadId,
      );
      assert.deepEqual(
        projection.messages.map((message) => message.text),
        ["Question 1", "Question 2", "Question 3", "Answer 1", "Answer 2", "Answer 3"],
      );
      const visibleMessages = projection.visibleTurnItems.filter(
        (row) => row.item.type === "user_message" || row.item.type === "assistant_message",
      );
      const visibleSteps = projection.visibleTurnItems.filter(
        (row) => row.item.type === "dynamic_tool",
      );
      assert.equal(visibleMessages.length, 6);
      assert.equal(visibleSteps.length, 3);
      assert.deepEqual(
        visibleSteps.map((row) => row.item.title),
        ["Old late step 1", "Old late step 2", "Old late step 3"],
      );
      const lastMessagePosition = Math.max(...visibleMessages.map((row) => row.position));
      assert.isTrue(visibleSteps.every((row) => row.position > lastMessagePosition));
      assert.equal(
        Option.getOrThrow(yield* readConversationImportJournal(directory)).ids.historyOrderVersion,
        undefined,
      );
      assert.deepEqual(yield* importer.importConversation(lease, request), completion);
      yield* (yield* Maintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(
        yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(ids.threadId),
        projection,
      );
      assert.deepEqual(projection.runs, []);
      assert.deepEqual(projection.runtimeRequests, []);
    }).pipe(Effect.provide(TestLayer)),
  { timeout: 30_000 },
);

it.live(
  "refuses incomplete or duplicate explicit import order before committing history or a receipt",
  () =>
    Effect.gen(function* () {
      yield* createNativeProjects;
      const fixture = importFixture({ turns: 2 });
      const command = buildConversationImportCommand({
        validated: fixture.input,
        ids: yield* mintConversationImportIds(fixture.input),
        destination: destination(),
        importedAt: "2026-09-28T12:00:00.000Z",
      });
      assert(command.historyOrder !== undefined && command.historyOrder.length > 1);
      const commit = yield* Commit.ConversationImportCommit;
      for (const order of [
        command.historyOrder.slice(1),
        command.historyOrder.map(() => command.historyOrder![0]!),
      ]) {
        const failure = yield* Effect.flip(commit.dispatch({ ...command, historyOrder: order }));
        assert.equal(failure._tag, "ConversationImportCommitError");
        assert.isTrue(
          Option.isNone(
            yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(command.commandId),
          ),
        );
        assert.equal(
          (yield* (yield* SqlClient.SqlClient)<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
          0,
        );
      }
      yield* commit.dispatch(command);
      assert.isTrue(
        Option.isSome(
          yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(command.commandId),
        ),
      );
    }).pipe(Effect.provide(TestLayer)),
  { timeout: 30_000 },
);
