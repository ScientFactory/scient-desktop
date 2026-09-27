// @effect-diagnostics nodeBuiltinImport:off -- the test reads produced packages from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatAttachment,
  SCIC_MEDIA_TYPE,
  ThreadId,
  type ConversationImportId,
  type ScientConversationExportRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as yauzl from "yauzl";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ConversationExportFiles from "../conversationExport/ConversationExportFiles.ts";
import * as ConversationExportService from "../conversationExport/ConversationExportService.ts";
import * as ConversationSnapshotService from "../conversationExport/ConversationSnapshotService.ts";
import { PandocWordConverter } from "../pandoc/PandocWordConverter.ts";
import { readScicPackage } from "./ScicReader.ts";
import { sha256Digest } from "./ScicWriter.ts";

const THREAD = ThreadId.make("thread-1");
const encodeAttachments = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ChatAttachment)));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const image: ChatAttachment = {
  type: "image",
  id: "thread-1-11111111-1111-4111-8111-111111111111",
  name: "figure.png",
  mimeType: "image/png",
  sizeBytes: PNG.byteLength,
};

const QueryLive = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(null),
    }),
  ),
);

const TestLayer = ConversationExportService.layer.pipe(
  Layer.provide(
    Layer.succeed(
      PandocWordConverter,
      PandocWordConverter.of({
        availability: Effect.succeed({
          available: false,
          reason: "Not installed",
          installable: true,
        }),
        convert: () => Effect.die("Word conversion is not used by this archive test"),
      }),
    ),
  ),
  Layer.provideMerge(ConversationSnapshotService.layer),
  Layer.provideMerge(ConversationExportFiles.layer),
  Layer.provideMerge(QueryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scient-scic-export-" })),
  Layer.provideMerge(NodeServices.layer),
);

const at = (index: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-09-27T10:00:00.000Z") + index * 1_000));

/** One settled turn: a prompt with an image, a tool call carrying a secret, reasoning, and an answer. */
const seedThread = Effect.fn("seedThread")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
    VALUES ('project-1', 'Project', '/work/project', '[]', ${at(0)}, ${at(0)}, NULL)`;
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
     latest_turn_id, created_at, updated_at, deleted_at)
    VALUES (${THREAD}, 'project-1', 'Transfer study', '{"provider":"codex","model":"gpt-5"}',
     'full-access', 'default', 'turn-1', ${at(0)}, ${at(0)}, NULL)`;
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
    VALUES ('user-1', ${THREAD}, NULL, 'user', ${`See ${config.stateDir}/logs/server.log`},
      ${encodeAttachments([image])}, 0, ${at(1)}, ${at(1)})`;
  yield* sql`INSERT INTO projection_thread_activities
    (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
    VALUES ('activity-1', ${THREAD}, 'turn-1', 'tool', 'tool.completed', 'Ran command',
      ${encodeJson({
        itemType: "command_execution",
        toolCallId: "call-1",
        title: "Ran command",
        data: { item: { command: "echo hi" }, token: "sk-hidden" },
      })}, 1, ${at(2)})`;
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('reasoning-1', ${THREAD}, 'turn-1', 'reasoning', 'Thinking it over', 0, ${at(3)}, ${at(3)})`;
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('assistant-1', ${THREAD}, 'turn-1', 'assistant', 'Done.', 0, ${at(4)}, ${at(4)})`;
  yield* sql`INSERT INTO projection_turns
    (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at,
     completed_at, checkpoint_files_json)
    VALUES (${THREAD}, 'turn-1', NULL, 'assistant-1', 'completed', ${at(1)}, ${at(1)}, ${at(5)}, '[]')`;
  yield* sql`INSERT INTO projection_thread_sessions
    (thread_id, status, provider_name, provider_session_id, provider_thread_id, runtime_mode,
     active_turn_id, last_error, updated_at)
    VALUES (${THREAD}, 'ready', 'codex', 'provider-session-secret', 'provider-thread-secret',
      'full-access', NULL, NULL, ${at(6)})`;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const imagePath = resolveAttachmentPath({
    attachmentsDir: config.attachmentsDir,
    attachment: image,
  })!;
  yield* fileSystem.makeDirectory(path.dirname(imagePath), { recursive: true });
  yield* fileSystem.writeFile(imagePath, PNG);
});

const request = (
  options: Partial<ScientConversationExportRequest["options"]> = {},
): ScientConversationExportRequest => ({
  threadId: THREAD,
  format: "scic",
  delivery: "file",
  options: { includeWorkLog: false, includeReasoning: false, range: { _tag: "whole" }, ...options },
});

/** Every entry's decompressed content, in archive order. */
function readEntries(path: string): Promise<ReadonlyArray<{ name: string; text: string }>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError);
      const entries: Array<{ name: string; text: string }> = [];
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.push({ name: entry.fileName, text: Buffer.concat(chunks).toString("latin1") });
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** Exports, then validates the file on a separate, clean staging root. */
const exportAndRead = (options: Partial<ScientConversationExportRequest["options"]> = {}) =>
  Effect.gen(function* () {
    const service = yield* ConversationExportService.ConversationExportService;
    const produced = yield* service.produce(request(options));
    assert(produced.output._tag === "file");
    const bytes = NodeFS.readFileSync(produced.output.path);
    const entries = yield* Effect.promise(() =>
      readEntries((produced.output as { readonly path: string }).path),
    );
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-scic-import-"));
    const packagePath = NodePath.join(root, "package.scic");
    NodeFS.copyFileSync(produced.output.path, packagePath);
    NodeFS.mkdirSync(NodePath.join(root, "attachments"));
    const read = yield* Effect.exit(
      readScicPackage({
        importId: "cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b" as ConversationImportId,
        packagePath,
        packageSha256: sha256Digest(bytes),
        packageBytes: bytes.byteLength,
        attachmentsDirectory: NodePath.join(root, "attachments"),
      }),
    );
    NodeFS.rmSync(root, { recursive: true, force: true });
    return { produced, entries, read };
  });

describe("exporting a .scic", () => {
  it.effect("writes a package another Scient validates, without private data", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const config = yield* ServerConfig.ServerConfig;
      const { produced, entries, read } = yield* exportAndRead();
      assert.deepStrictEqual(entries.map((entry) => entry.name).slice(0, 4), [
        "mimetype",
        "manifest.json",
        "conversation.json",
        "conversation.md",
      ]);
      assert.strictEqual(entries[0]!.text, SCIC_MEDIA_TYPE);
      assert(produced.output._tag === "file");
      assert.strictEqual(produced.output.fileName, "Transfer study.scic");
      assert.strictEqual(produced.output.mediaType, SCIC_MEDIA_TYPE);
      assert(Exit.isSuccess(read), String(Exit.isFailure(read) ? read.cause : ""));
      const validated = read.value;
      assert.strictEqual(validated.snapshot.contentDigest, produced.contentDigest);
      assert.deepStrictEqual(validated.snapshot.workLog, []);
      assert.deepStrictEqual(validated.snapshot.reasoning, []);
      assert.deepStrictEqual(
        validated.omissions.map((omission) => omission._tag),
        ["work-log-excluded", "reasoning-excluded"],
      );
      assert.strictEqual(validated.attachments.length, 1);

      const text = entries.map((entry) => entry.text).join("\n");
      for (const secret of [
        "sk-hidden",
        "provider-session-secret",
        "provider-thread-secret",
        image.id,
        config.stateDir,
        config.attachmentsDir,
        "Thinking it over",
      ]) {
        assert.notInclude(text, secret);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("carries the work log and reasoning only when selected", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const { read, entries } = yield* exportAndRead({
        includeWorkLog: true,
        includeReasoning: true,
      });
      assert(Exit.isSuccess(read));
      assert.strictEqual(read.value.snapshot.workLog.length, 1);
      assert.strictEqual(read.value.snapshot.reasoning.length, 1);
      assert.deepStrictEqual(read.value.omissions, []);
      // Even when selected, the tool's raw payload never travels.
      assert.notInclude(entries.map((entry) => entry.text).join("\n"), "sk-hidden");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("cannot be copied to the clipboard", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ConversationExportService.ConversationExportService;
      const error = yield* Effect.flip(service.produce({ ...request(), delivery: "clipboard" }));
      assert.strictEqual(
        error._tag === "ScientConversationExportError" ? error.reason : error._tag,
        "delivery-unsupported",
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});
