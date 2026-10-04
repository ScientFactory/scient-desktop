import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachment,
  CommandId,
  ComposerContextId,
  ConversationImportId,
  EventId,
  MessageId,
  OrchestrationMessageContext,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  Sha256Digest,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as Exports from "../../scient/conversationExport/ConversationExportService.ts";
import * as ExportFiles from "../../scient/conversationExport/ConversationExportFiles.ts";
import * as Snapshots from "../../scient/conversationExport/ConversationSnapshotService.ts";
import { readScicPackage } from "../../scient/conversationFile/ScicReader.ts";
import { PandocWordConverter } from "../../scient/pandoc/PandocWordConverter.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventStore from "../EventStore.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import {
  HistoricalSystemMessage,
  HISTORICAL_SYSTEM_MESSAGE_TOOL_NAME,
} from "../legacy/HistoricalSystemMessage.ts";
import * as LegacyImporter from "../legacy/LegacyV1ThreadImporter.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import { ConversationForkService } from "./ConversationForkService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture" };
const encodeAttachments = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ChatAttachment)));
const encodeMessageContext = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationMessageContext),
);
const decodeHistoricalSystemMessage = Schema.decodeUnknownEffect(HistoricalSystemMessage);
const decodeImportId = Schema.decodeEffect(ConversationImportId);
const decodeDigest = Schema.decodeEffect(Sha256Digest);
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "fork-system-attachments" },
  Registry.makeLayer([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Inert system history must not execute a provider"),
    },
  ]),
  { configureMcp: false },
);
const testLayer = Exports.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(
      PandocWordConverter,
      PandocWordConverter.of({
        availability: Effect.succeed({
          available: false,
          reason: "Word is outside this package test",
          installable: false,
        }),
        convert: () => Effect.die("SCIC export must not invoke Word"),
      }),
    ),
  ),
  Layer.provideMerge(Snapshots.layer),
  Layer.provideMerge(ExportFiles.layer),
  Layer.provideMerge(LegacyImporter.layer),
  Layer.provideMerge(EventStore.layer),
  Layer.provideMerge(runtime),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.live(
  "owns migrated system attachment bytes and context through fork and portable export after source deletion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("fork-system-attachments");
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const { attachmentsDir } = yield* ServerConfig;
        const source = ThreadId.make("system-attachment-source");
        const target = ThreadId.make("system-attachment-fork");
        const projectId = ProjectId.make("system-attachment-project");
        const now = "2026-01-01T00:00:00.000Z";
        yield* (yield* ProjectStoreV2).apply({
          sequence: 1,
          eventId: EventId.make("system-attachment-project-created"),
          type: "project.created",
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: "System attachment history",
            workspaceRoot: cwd,
            scripts: [],
            defaultModelSelection: modelSelection,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${source}, ${projectId}, 'System attachment history', '{"instanceId":"codex","model":"fixture"}', 'full-access', 'default', ${now}, ${now})`;
        const rawId = createDeterministicAttachmentId(source, "system-file");
        assert.isNotNull(rawId);
        const attachment = {
          type: "file" as const,
          id: `${rawId}-txt`,
          name: "history.txt",
          mimeType: "text/plain",
          sizeBytes: 16,
        };
        const sourcePath = resolveAttachmentPath({ attachmentsDir, attachment });
        assert.isNotNull(sourcePath);
        yield* fs.writeFileString(sourcePath!, "Immutable bytes.");
        const context = {
          version: 1 as const,
          records: [
            {
              version: 1 as const,
              kind: "file" as const,
              contextId: ComposerContextId.make("historical-file"),
              label: attachment.name,
              attachmentId: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          ],
        };
        const attachmentsJson = yield* encodeAttachments([attachment]);
        const contextJson = yield* encodeMessageContext(context);
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, turn_id, attachments_json, context_json, is_streaming, created_at, updated_at)
      VALUES ('system-file-question', ${source}, 'user', 'Original question', 'system-turn', NULL, NULL, 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
        ('system-file-history', ${source}, 'system', 'Preserve this system history.', 'system-turn', ${attachmentsJson}, ${contextJson}, 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
        ('system-file-answer', ${source}, 'assistant', 'Completed answer', 'system-turn', NULL, NULL, 0, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z')`;
        const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(source);
        const forks = yield* ConversationForkService;
        const command = {
          type: "thread.fork" as const,
          commandId: CommandId.make("system-file-fork"),
          originThreadId: source,
          newThreadId: target,
          sourceAssistantMessageId: MessageId.make("system-file-answer"),
          workspaceMode: "local" as const,
        };
        const receipt = yield* forks.dispatch(command);
        yield* (yield* OrchestratorV2).dispatch({
          type: "thread.delete",
          commandId: CommandId.make("system-file-source-delete"),
          threadId: source,
        });
        yield* fs.remove(sourcePath!, { force: true });
        const snapshots = yield* Snapshots.ConversationSnapshotService;
        const captured = yield* snapshots.capture({
          threadId: target,
          selection: { workLog: true, reasoning: true, throughMessageId: null },
        });
        assert.equal(
          captured.attachmentFiles.size,
          1,
          "The fork must own system-only bytes after its source is gone",
        );
        const system = captured.snapshot.messages.find((message) => message.role === "system");
        assert.ok(system);
        assert.notEqual(system.id, "system-file-history");
        assert.equal(system.text, "Preserve this system history.");
        const ownedId = receipt.forkAttachmentIdMap[attachment.id];
        assert.ok(ownedId);
        assert.equal(system.attachments[0]?.localId, ownedId);
        const targetProjection = yield* (yield* ProjectionStoreV2).getThreadProjection(target);
        const systemItem = targetProjection.turnItems.find(
          (item) =>
            item.type === "dynamic_tool" && item.toolName === HISTORICAL_SYSTEM_MESSAGE_TOOL_NAME,
        );
        assert.ok(systemItem?.type === "dynamic_tool");
        const systemRecord = yield* decodeHistoricalSystemMessage(systemItem.input);
        assert.deepEqual(systemRecord.context, {
          ...context,
          records: [{ ...context.records[0]!, attachmentId: ownedId }],
        });
        assert.equal(
          yield* fs.readFileString(captured.attachmentFiles.get(ownedId)!),
          "Immutable bytes.",
        );
        const archive = yield* (yield* Exports.ConversationExportService).produce({
          threadId: target,
          format: "scic",
          delivery: "file",
          options: { includeWorkLog: true, includeReasoning: true, range: { _tag: "whole" } },
        });
        assert.ok(archive.output._tag === "file");
        const bytes = yield* fs.readFile(archive.output.path);
        const sha256 = yield* (yield* Crypto.Crypto).digest("SHA-256", bytes);
        const importDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "fork-system-package-",
        });
        const parsed = yield* readScicPackage({
          importId: yield* decodeImportId("cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b"),
          packagePath: archive.output.path,
          packageBytes: bytes.byteLength,
          packageSha256: yield* decodeDigest(`sha256:${Encoding.encodeHex(sha256)}`),
          attachmentsDirectory: importDirectory,
        });
        assert.equal(parsed.attachments.length, 1);
        assert.equal(
          parsed.snapshot.messages.find((message) => message.role === "system")?.text,
          system.text,
        );
        assert.deepEqual(
          (yield* snapshots.capture({
            threadId: target,
            selection: { workLog: true, reasoning: true, throughMessageId: null },
          })).snapshot.messages,
          captured.snapshot.messages,
        );
      }).pipe(Effect.provide(testLayer), Effect.timeout("15 seconds")),
    ),
);
