// @effect-diagnostics nodeBuiltinImport:off -- The test reads produced ZIP archives with yauzl.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatAttachment,
  EnvironmentFilePath,
  MessageId,
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES,
  ScientDocumentPageInput,
  ThreadId,
  type DocumentBundle,
  type ScientConversationExportRequest,
} from "@t3tools/contracts";
import { parseConversationMarkdown } from "@scientfactory/conversation";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as yauzl from "yauzl";

import { issueAssetUrl, resolveAsset } from "../../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../../assets/NativeAppIconResolver.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as ServerConfig from "../../config.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ConversationExportFiles from "./ConversationExportFiles.ts";
import * as ConversationExportService from "./ConversationExportService.ts";
import * as ConversationSnapshotService from "./ConversationSnapshotService.ts";
import { prepareConversationPdf } from "../documentExport/ConversationPdfPreparation.ts";
import {
  PandocWordConverter,
  WordConversionError,
  layer as realConverterLayer,
  type WordConversionFailureReason,
} from "../pandoc/PandocWordConverter.ts";
import {
  managedToolLayer,
  pandocBinaryForTests,
  readDocx,
  PNG_BYTES,
} from "../pandoc/pandocTestSupport.ts";

const pandocBinary = pandocBinaryForTests();

const THREAD = ThreadId.make("thread-1");
const encodeAttachments = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ChatAttachment)));

const image: ChatAttachment = {
  type: "image",
  id: "thread-1-11111111-1111-4111-8111-111111111111",
  name: "figure.png",
  mimeType: "image/png",
  sizeBytes: 4,
};
const missing: ChatAttachment = {
  type: "file",
  id: "thread-1-22222222-2222-4222-8222-222222222222",
  name: "gone.pdf",
  mimeType: "application/pdf",
  sizeBytes: 10,
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

/**
 * A stand-in for the Word converter: unavailable (Pandoc not installed), or
 * writing the bundle Markdown it was given as the "Word file", or failing.
 */
type WordMode =
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "converts"; readonly seen: Array<DocumentBundle> }
  | { readonly _tag: "real"; readonly scratchRoot: string }
  | { readonly _tag: "fails"; readonly reason: WordConversionFailureReason };

const wordLayer = (mode: WordMode) =>
  Layer.effect(
    PandocWordConverter,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return PandocWordConverter.of({
        availability: Effect.succeed(
          mode._tag === "unavailable"
            ? {
                available: false,
                reason: "Word export needs Pandoc (40 MB download).",
                installable: true,
              }
            : { available: true, reason: null, installable: false },
        ),
        convert: (input) =>
          Effect.gen(function* () {
            if (mode._tag === "fails") {
              return yield* new WordConversionError({
                reason: mode.reason,
                message: `Word conversion ${mode.reason}.`,
              });
            }
            if (mode._tag === "converts") mode.seen.push(input.bundle);
            yield* fileSystem
              .writeFileString(input.outputPath, input.bundle.markdown)
              .pipe(Effect.orDie);
            return {
              byteLength: input.bundle.markdown.length,
              warnings: [
                ...input.bundle.warnings,
                { code: "converter-reported" as const, message: "Pandoc reported: a note" },
              ],
              summary: {
                embeddedImages: 0,
                placeholders: 0,
                workLogBlocks: 0,
                reasoningBlocks: 0,
                citedReferences: 0,
                rtlDocument: false,
                landscapeTables: 0,
              },
            };
          }),
      });
    }),
  );

const exportLayer = (prefix: string, word: WordMode = { _tag: "unavailable" }) =>
  ConversationExportService.layer.pipe(
    Layer.provideMerge(
      word._tag === "real"
        ? realConverterLayer.pipe(
            Layer.provide(
              managedToolLayer({
                command: { command: pandocBinary!, leadingArgs: [] },
                scratchRoot: word.scratchRoot,
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          )
        : wordLayer(word),
    ),
    Layer.provideMerge(ConversationSnapshotService.layer),
    Layer.provideMerge(ConversationExportFiles.layer),
    Layer.provideMerge(QueryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );
const TestLayer = exportLayer("scient-convexport-");

type FileAccess = { readonly op: "exists" | "stat" | "stream"; readonly path: string };

/** The real file system, recording which paths the export service stats and streams. */
const recordingFileSystem = (accesses: Array<FileAccess>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return FileSystem.FileSystem.of({
        ...fileSystem,
        exists: (path) => {
          accesses.push({ op: "exists", path });
          return fileSystem.exists(path);
        },
        stat: (path) => {
          accesses.push({ op: "stat", path });
          return fileSystem.stat(path);
        },
        stream: (path, options) => {
          accesses.push({ op: "stream", path });
          return fileSystem.stream(path, options);
        },
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));

const recordingLayer = (accesses: Array<FileAccess>) =>
  ConversationExportService.layer.pipe(
    Layer.provideMerge(wordLayer({ _tag: "converts", seen: [] })),
    Layer.provideMerge(ConversationSnapshotService.layer),
    Layer.provideMerge(ConversationExportFiles.layer),
    Layer.provideMerge(QueryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "scient-convexport-reads-" }),
    ),
    Layer.provideMerge(recordingFileSystem(accesses)),
    Layer.provideMerge(NodeServices.layer),
  );

/** Writes `bytes` where the attachment store keeps `attachment`, and returns that path. */
const storeAttachment = (attachment: ChatAttachment, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stored = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
    yield* fileSystem.makeDirectory(path.dirname(stored), { recursive: true });
    yield* fileSystem.writeFile(stored, bytes);
    return stored;
  });

const AssetConfigLive = ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-convexport-asset-",
});
const AssetTestLayer = ConversationExportFiles.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      WorkspacePaths.layer,
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
      NativeAppIconResolver.layer,
      ServerSecretStore.layer,
    ),
  ),
  Layer.provideMerge(AssetConfigLive),
  Layer.provideMerge(NodeServices.layer),
);

const at = (index: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-09-27T10:00:00.000Z") + index * 1_000));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const seedThread = Effect.fn("seedThread")(function* (input: {
  readonly pairs: number;
  readonly activitiesPerTurn?: number;
  readonly running?: boolean;
  readonly firstUserText?: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  /** Every prompt gets its own stored attachment, and every turn a reasoning message. */
  readonly attachmentPerPrompt?: boolean;
  readonly reasoning?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
    VALUES ('project-1', 'Project', '/work/project', '[]', ${at(0)}, ${at(0)}, NULL)`;
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
     latest_turn_id, created_at, updated_at, deleted_at)
    VALUES (${THREAD}, 'project-1', 'Long / study: results?', '{"provider":"codex","model":"gpt-5"}',
     'full-access', 'default', ${`turn-${input.pairs}`}, ${at(0)}, ${at(0)}, NULL)`;
  let clock = 1;
  let activity = 0;
  for (let pair = 1; pair <= input.pairs; pair += 1) {
    const turnId = `turn-${pair}`;
    const userText =
      pair === 1 && input.firstUserText !== undefined ? input.firstUserText : `Question ${pair}`;
    const own: ReadonlyArray<ChatAttachment> = input.attachmentPerPrompt
      ? [
          {
            type: "file",
            id: `thread-1-00000000-0000-4000-8000-${String(pair).padStart(12, "0")}`,
            name: `data ${pair}.csv`,
            mimeType: "text/csv",
            sizeBytes: 3,
          },
        ]
      : [];
    for (const attachment of own) yield* storeAttachment(attachment, new Uint8Array([97, 44, 98]));
    const listed = [...(pair === 1 ? (input.attachments ?? []) : []), ...own];
    const attachments = listed.length > 0 ? encodeAttachments(listed) : null;
    const userAt = at(clock);
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
      VALUES (${`user-${pair}`}, ${THREAD}, NULL, 'user', ${userText}, ${attachments}, 0, ${userAt}, ${userAt})`;
    clock += 1;
    for (let index = 0; index < (input.activitiesPerTurn ?? 0); index += 1) {
      activity += 1;
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES (${`activity-${activity}`}, ${THREAD}, ${turnId}, 'tool', 'tool.completed', 'Ran command',
          ${encodeJson({
            itemType: "command_execution",
            toolCallId: `call-${activity}`,
            title: "Ran command",
            data: { item: { command: `echo ${activity}` }, token: "sk-hidden" },
          })}, ${activity}, ${at(clock)})`;
      clock += 1;
    }
    if (input.reasoning) {
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`reasoning-${pair}`}, ${THREAD}, ${turnId}, 'reasoning', ${`Thinking ${pair}`},
          0, ${at(clock)}, ${at(clock)})`;
      clock += 1;
    }
    const isRunning = input.running === true && pair === input.pairs;
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${`assistant-${pair}`}, ${THREAD}, ${turnId}, 'assistant', ${`Answer ${pair}`},
        ${isRunning ? 1 : 0}, ${at(clock)}, ${at(clock)})`;
    clock += 1;
    yield* sql`INSERT INTO projection_turns
      (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at,
       completed_at, checkpoint_files_json)
      VALUES (${THREAD}, ${turnId}, NULL, ${`assistant-${pair}`}, ${isRunning ? "running" : "completed"},
        ${userAt}, ${userAt}, ${isRunning ? null : at(clock)}, '[]')`;
  }
  yield* sql`INSERT INTO projection_thread_sessions
    (thread_id, status, provider_name, provider_session_id, provider_thread_id, runtime_mode,
     active_turn_id, last_error, updated_at)
    VALUES (${THREAD}, ${input.running ? "running" : "ready"}, 'codex', 'provider-session-secret',
      'provider-thread-secret', 'full-access', ${input.running ? `turn-${input.pairs}` : null}, NULL, ${at(clock)})`;
});

const request = (
  overrides: Partial<ScientConversationExportRequest> = {},
  options: Partial<ScientConversationExportRequest["options"]> = {},
): ScientConversationExportRequest => ({
  threadId: THREAD,
  format: "markdown",
  delivery: "file",
  ...overrides,
  options: {
    includeWorkLog: false,
    includeReasoning: false,
    range: { _tag: "whole" },
    ...options,
  },
});

function readZip(path: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError);
      const entries = new Map<string, Buffer>();
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
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

const produceText = (input: ScientConversationExportRequest) =>
  Effect.gen(function* () {
    const service = yield* ConversationExportService.ConversationExportService;
    const produced = yield* service.produce(input);
    if (produced.output._tag !== "file") return { produced, text: produced.output.text };
    const fileSystem = yield* FileSystem.FileSystem;
    return { produced, text: yield* fileSystem.readFileString(produced.output.path) };
  });

describe("ConversationExportService", () => {
  if (pandocBinary !== null)
    it.live(
      "exports Mermaid source and unresolved bibliography keys through the real Word path",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const scratchRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "scient-conversation-word-",
          });
          return yield* Effect.gen(function* () {
            yield* seedThread({
              pairs: 1,
              firstUserText: "See [@unavailable2026].\n\n```mermaid\nflowchart LR\n  A --> B\n```",
            });
            const service = yield* ConversationExportService.ConversationExportService;
            const produced = yield* service.produce(request({ format: "docx" }));
            assert(produced.output._tag === "file");
            const docx = yield* readDocx(produced.output.path);
            const xml = docx.text("word/document.xml");
            assert.include(xml, "Mermaid diagram source (image unavailable)");
            assert.include(xml, "A --&gt; B");
            assert.include(xml, "[@unavailable2026]");
            assert.include(
              produced.warnings.map((warning) => warning.message).join("\n"),
              "@unavailable2026",
            );
            assert.include(
              produced.warnings.map((warning) => warning.message).join("\n"),
              "complete Mermaid source",
            );
          }).pipe(
            Effect.provide(
              exportLayer("scient-convexport-real-word-", { _tag: "real", scratchRoot }),
            ),
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  it.effect("exports a 2,100-message thread completely from the server snapshot", () =>
    Effect.gen(function* () {
      yield* seedThread({
        pairs: 1_050,
        activitiesPerTurn: 3,
        reasoning: true,
        attachmentPerPrompt: true,
      });
      const service = yield* ConversationExportService.ConversationExportService;
      const preparation = yield* service.prepare(THREAD);
      assert.strictEqual(preparation.messageCount, 2_100);
      assert.strictEqual(preparation.workLogEntryCount, 3_150);
      assert.strictEqual(preparation.reasoningCount, 1_050);
      assert.strictEqual(preparation.attachmentCount, 1_050);
      assert.deepStrictEqual(preparation.formats, [
        { format: "markdown", available: true, unavailableReason: null },
        { format: "pdf", available: true, unavailableReason: null },
        { format: "scic", available: true, unavailableReason: null },
        {
          format: "docx",
          available: false,
          unavailableReason: "Word export needs Pandoc (40 MB download).",
        },
      ]);

      const { produced, text } = yield* produceText(
        request({}, { includeWorkLog: true, includeReasoning: true }),
      );
      assert.strictEqual(produced.messageCount, 2_100);
      const parsed = parseConversationMarkdown(text);
      assert(parsed.kind === "conversation");
      assert.strictEqual(parsed.messages.length, 2_100);
      assert.deepStrictEqual(parsed.issues, []);
      assert.strictEqual(parsed.messages[2_099]!.body, "Answer 1050");
      assert.strictEqual(
        parsed.messages.filter((message) => message.parts.some((part) => part.kind === "work-log"))
          .length,
        1_050,
      );
      assert.strictEqual(
        parsed.messages.filter((message) => message.parts.some((part) => part.kind === "reasoning"))
          .length,
        1_050,
      );
      assert.strictEqual(
        parsed.messages.filter((message) =>
          message.parts.some((part) => part.kind === "attachments"),
        ).length,
        1_050,
      );
      assert.include(text, "Work log · 3 steps");
      assert.include(text, "- data 1050.csv · text/csv, 3 B");
      assert.include(text, "echo 3150");
      assert.notInclude(text, "sk-hidden");
      assert.notInclude(text, "provider-session-secret");
      assert.notInclude(text, "provider-thread-secret");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("omits the running turn with a warning", () =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 3, running: true });
      const service = yield* ConversationExportService.ConversationExportService;
      assert.isTrue((yield* service.prepare(THREAD)).runningTurnOmitted);
      const { produced, text } = yield* produceText(request());
      assert.strictEqual(produced.messageCount, 4);
      assert.deepStrictEqual(
        produced.warnings.map((warning) => warning.code),
        ["running-turn-omitted"],
      );
      assert.include(text, "The current turn was still running and is not included.");
      assert.notInclude(text, "Question 3");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("is content-identical for the same snapshot except export value and time", () =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 4, activitiesPerTurn: 2 });
      const first = (yield* produceText(request({}, { includeWorkLog: true }))).text;
      const second = (yield* produceText(request({}, { includeWorkLog: true }))).text;
      const normalize = (text: string) =>
        text
          .replace(/export=[a-f0-9]+/gu, "export=V")
          // YAML quotes a hex export id when it would otherwise parse as a number.
          .replace(/scient-export: "?[a-f0-9]+"?/u, "scient-export: V")
          .replace(/exported: \S+/u, "exported: T");
      assert.notStrictEqual(first, second);
      assert.strictEqual(normalize(second), normalize(first));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("packages attachments with relative links and lists unavailable ones", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const imagePath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: image,
      })!;
      yield* fileSystem.makeDirectory(path.dirname(imagePath), { recursive: true });
      yield* fileSystem.writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
      yield* seedThread({ pairs: 1, attachments: [image, missing] });

      const service = yield* ConversationExportService.ConversationExportService;
      const produced = yield* service.produce(
        request({}, { markdownPackaging: "with-attachments" }),
      );
      assert(produced.output._tag === "file");
      assert.strictEqual(produced.output.fileName, "Long study results.zip");
      assert.strictEqual(produced.output.mediaType, "application/zip");
      const entries = yield* Effect.promise(() =>
        readZip((produced.output as { readonly path: string }).path),
      );
      assert.deepStrictEqual(
        [...entries.keys()],
        ["Long study results.md", "attachments/01-figure.png"],
      );
      assert.deepStrictEqual([...entries.get("attachments/01-figure.png")!], [137, 80, 78, 71]);
      const markdown = entries.get("Long study results.md")!.toString("utf8");
      assert.include(markdown, "- ![figure.png](attachments/01-figure.png)");
      assert.include(markdown, "- gone.pdf · unavailable");
      assert.include(
        produced.warnings.map((warning) => warning.code),
        "attachment-unavailable",
      );
      assert.notInclude(markdown, config.attachmentsDir);
    }).pipe(Effect.provide(TestLayer)),
  );

  const fileAccesses: Array<FileAccess> = [];
  it.effect("reads attachment bytes only for formats that embed them", () =>
    Effect.gen(function* () {
      const stored = yield* storeAttachment(image, new Uint8Array([137, 80, 78, 71]));
      yield* seedThread({ pairs: 1, attachments: [image] });
      const service = yield* ConversationExportService.ConversationExportService;
      const accessesDuring = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          fileAccesses.length = 0;
          const result = yield* effect;
          return {
            result,
            ops: fileAccesses
              .filter((access) => access.path === stored && access.op !== "exists")
              .map((access) => access.op),
          };
        });

      const text = yield* accessesDuring(produceText(request()));
      assert.deepStrictEqual(text.ops, []);
      assert.include(text.result.text, "- figure.png · image/png, 4 B");
      const copied = yield* accessesDuring(produceText(request({ delivery: "clipboard" })));
      assert.deepStrictEqual(copied.ops, []);
      assert.include(copied.result.text, "- figure.png · image/png, 4 B");
      const plan = yield* accessesDuring(service.prepareWordDiagrams(request({ format: "docx" })));
      assert.deepStrictEqual(plan.ops, []);

      // A `.zip` checks the file's size and streams it into the archive itself.
      const zipped = yield* accessesDuring(
        service.produce(request({}, { markdownPackaging: "with-attachments" })),
      );
      assert.deepStrictEqual(zipped.ops, ["stat"]);
      assert(zipped.result.output._tag === "file");
      const entries = yield* Effect.promise(() =>
        readZip((zipped.result.output as { readonly path: string }).path),
      );
      assert.deepStrictEqual([...entries.get("attachments/01-figure.png")!], [137, 80, 78, 71]);

      // Word and PDF embed the bytes.
      const word = yield* accessesDuring(service.produce(request({ format: "docx" })));
      assert.deepStrictEqual(word.ops, ["stat", "stream"]);
      const pdf = yield* accessesDuring(service.document(request({ format: "pdf" })));
      assert.deepStrictEqual(pdf.ops, ["stat", "stream"]);
    }).pipe(Effect.provide(recordingLayer(fileAccesses))),
  );

  const rangeAccesses: Array<FileAccess> = [];
  it.effect("ends every format at the chosen message, attachments included", () =>
    Effect.gen(function* () {
      const attachment = (id: string, name: string): ChatAttachment => ({
        type: "image",
        id: `thread-1-${id}`,
        name,
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.byteLength,
      });
      const before = attachment("11111111-1111-4111-8111-aaaaaaaaaaaa", "before.png");
      const answered = attachment("22222222-2222-4222-8222-bbbbbbbbbbbb", "answered-later.png");
      const later = attachment("33333333-3333-4333-8333-cccccccccccc", "later.png");
      const beforePath = yield* storeAttachment(before, PNG_BYTES);
      const excludedPaths = new Set([
        yield* storeAttachment(answered, PNG_BYTES),
        yield* storeAttachment(later, PNG_BYTES),
      ]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
         latest_turn_id, created_at, updated_at, deleted_at)
        VALUES (${THREAD}, NULL, 'Steered', '{"provider":"codex","model":"gpt-5"}',
         'full-access', 'default', 'turn-1', ${at(0)}, ${at(0)}, NULL)`;
      const message = (
        id: string,
        role: string,
        turnId: string | null,
        text: string,
        index: number,
        attachments: ReadonlyArray<ChatAttachment> | null = null,
      ) => sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
        VALUES (${id}, ${THREAD}, ${turnId}, ${role}, ${text},
          ${attachments === null ? null : encodeAttachments(attachments)}, 0, ${at(index)}, ${at(index)})`;
      const activity = (id: string, kind: string, payload: unknown, index: number) =>
        sql`INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
          VALUES (${id}, ${THREAD}, 'turn-1', 'tool', ${kind}, ${kind}, ${encodeJson(payload)},
            ${index}, ${at(index)})`;
      yield* message("user-1", "user", null, "Start", 1, [before]);
      yield* activity("activity-1", "tool.completed", { title: "Before steer" }, 2);
      yield* message("reasoning-1", "reasoning", "turn-1", "Early thought", 3);
      yield* message("assistant-1", "assistant", "turn-1", "Working", 4);
      yield* message("user-2", "user", null, "Change course", 5);
      yield* activity("activity-2", "tool.completed", { title: "After steer" }, 6);
      yield* message("reasoning-2", "reasoning", "turn-1", "Late thought", 7);
      yield* activity(
        "activity-3",
        "user-input.requested",
        { requestId: "request-1", questions: [{ id: "q", question: "Which one?" }] },
        8,
      );
      yield* activity(
        "activity-4",
        "user-input.answer-submitted",
        {
          requestId: "request-1",
          answers: { q: "This" },
          attachmentsByQuestionId: { q: [answered] },
        },
        9,
      );
      yield* message("async-answer:request-1", "user", null, "This", 10, [answered]);
      yield* message("assistant-2", "assistant", "turn-1", "Done", 11);
      yield* message("user-3", "user", null, "Next", 12, [later]);
      yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at,
         completed_at, checkpoint_files_json)
        VALUES (${THREAD}, 'turn-1', NULL, 'assistant-2', 'completed', ${at(1)}, ${at(1)}, ${at(11)}, '[]')`;

      const service = yield* ConversationExportService.ConversationExportService;
      const ranged = (format: ScientConversationExportRequest["format"]) =>
        request(
          { format },
          {
            includeWorkLog: true,
            includeReasoning: true,
            range: { _tag: "through-message", messageId: MessageId.make("user-2") },
            markdownPackaging: "with-attachments",
          },
        );
      const excluded = [
        "After steer",
        "Late thought",
        "Which one?",
        "answered-later",
        "Done",
        "Next",
        "later.png",
      ];
      rangeAccesses.length = 0;

      const markdown = yield* service.produce(ranged("markdown"));
      assert(markdown.output._tag === "file");
      const zipped = yield* Effect.promise(() =>
        readZip((markdown.output as { readonly path: string }).path),
      );
      assert.deepStrictEqual([...zipped.keys()], ["Steered.md", "attachments/01-before.png"]);
      const markdownText = zipped.get("Steered.md")!.toString("utf8");
      for (const text of ["Start", "Before steer", "Early thought", "Working", "Change course"])
        assert.include(markdownText, text);
      for (const text of excluded) assert.notInclude(markdownText, text);

      const scic = yield* service.produce(ranged("scic"));
      assert(scic.output._tag === "file");
      const packaged = yield* Effect.promise(() =>
        readZip((scic.output as { readonly path: string }).path),
      );
      const snapshotJson = packaged.get("conversation.json")!.toString("utf8");
      const manifestJson = packaged.get("manifest.json")!.toString("utf8");
      assert.strictEqual(scic.messageCount, 3);
      assert.include(snapshotJson, "Before steer");
      for (const text of excluded) {
        assert.notInclude(snapshotJson, text);
        assert.notInclude(manifestJson, text);
      }
      assert.deepStrictEqual(
        [...packaged.keys()].filter((name) => name.startsWith("attachments/")).length,
        1,
      );

      const pdf = yield* service.document(ranged("pdf"));
      assert.deepStrictEqual(
        pdf.bundle.assets.map((asset) => asset.fileName),
        ["before.png"],
      );
      for (const text of excluded) assert.notInclude(pdf.bundle.markdown, text);

      assert.isTrue(rangeAccesses.some((access) => access.path === beforePath));
      assert.deepStrictEqual(
        rangeAccesses.filter((access) => excludedPaths.has(access.path)),
        [],
      );
    }).pipe(Effect.provide(recordingLayer(rangeAccesses))),
  );

  it.effect("reports an attachment over the export's budget as too large to include", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stored = yield* storeAttachment(image, new Uint8Array([137, 80, 78, 71]));
      // A sparse file larger than the budget: never read, only measured.
      yield* fileSystem.truncate(stored, SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES + 1);
      yield* seedThread({ pairs: 1, attachments: [image] });
      const service = yield* ConversationExportService.ConversationExportService;
      const produced = yield* service.produce(
        request({}, { markdownPackaging: "with-attachments" }),
      );
      assert.include(
        produced.warnings.map((warning) => warning.message),
        "Attachment “figure.png” is too large to include and is listed by name only.",
      );
      assert(produced.output._tag === "file");
      const entries = yield* Effect.promise(() =>
        readZip((produced.output as { readonly path: string }).path),
      );
      assert.deepStrictEqual([...entries.keys()], ["Long study results.md"]);
      assert.include(
        entries.get("Long study results.md")!.toString("utf8"),
        "- figure.png · unavailable",
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("returns clipboard text and never publishes Scient storage paths", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      // A root whose name Markdown would escape (`_`, `*`).
      assert.include(config.baseDir, "scient_conv*export");
      yield* seedThread({
        pairs: 1,
        activitiesPerTurn: 1,
        firstUserText: `Look in ${config.stateDir}/logs/server_1.log`,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_threads SET title = ${`Logs in ${config.baseDir}`}`;
      yield* sql`UPDATE projection_thread_activities SET payload_json = ${encodeJson({
        title: "Ran command",
        itemType: "command_execution",
        data: { item: { command: `cat ${config.stateDir}/logs/a_b.log` } },
      })}`;
      const { produced, text } = yield* produceText(
        request({ delivery: "clipboard" }, { includeWorkLog: true }),
      );
      assert.strictEqual(produced.output._tag, "text");
      assert.include(text, "Look in «scient-data»/logs/server_1.log");
      assert.include(text, "cat «scient-data»/logs/a_b.log");
      const leaf = config.baseDir.split("/").at(-1)!;
      assert.notInclude(text, leaf);
      assert.notInclude(text, leaf.replaceAll("_", "\\_").replaceAll("*", "\\*"));
    }).pipe(Effect.provide(exportLayer("scient_conv*export-"))),
  );

  it.effect("writes a long non-Latin title as a file name the file system accepts", () =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 1 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_threads SET title = ${"研究結果".repeat(23)}`;
      const service = yield* ConversationExportService.ConversationExportService;
      const produced = yield* service.produce(
        request({}, { markdownPackaging: "with-attachments" }),
      );
      assert(produced.output._tag === "file");
      assert.isAtMost(new TextEncoder().encode(produced.output.fileName).byteLength, 200);
      const fileSystem = yield* FileSystem.FileSystem;
      assert.isTrue(yield* fileSystem.exists(produced.output.path));
      const entries = yield* Effect.promise(() =>
        readZip((produced.output as { readonly path: string }).path),
      );
      const [markdownEntry] = [...entries.keys()];
      assert.isAtMost(new TextEncoder().encode(markdownEntry!).byteLength, 200);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects unavailable formats, bad ranges, missing threads, and packaged copies", () =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 2 });
      const service = yield* ConversationExportService.ConversationExportService;
      const reasonOf = (input: ScientConversationExportRequest) =>
        service.produce(input).pipe(
          Effect.flip,
          Effect.map((error) =>
            error._tag === "ScientConversationExportError" ? error.reason : error._tag,
          ),
        );
      // PDF is printed by the desktop from `document`, never written by `produce`.
      assert.strictEqual(yield* reasonOf(request({ format: "pdf" })), "format-unavailable");
      assert.strictEqual(yield* reasonOf(request({ format: "docx" })), "format-unavailable");
      assert.strictEqual(
        yield* reasonOf(
          request({}, { range: { _tag: "through-message", messageId: MessageId.make("nope") } }),
        ),
        "message-not-found",
      );
      assert.strictEqual(
        yield* reasonOf(request({ threadId: ThreadId.make("missing") })),
        "thread-not-found",
      );
      assert.strictEqual(
        yield* reasonOf(
          request({ delivery: "clipboard" }, { markdownPackaging: "with-attachments" }),
        ),
        "delivery-unsupported",
      );
      const ranged = yield* produceText(
        request(
          {},
          { range: { _tag: "through-message", messageId: MessageId.make("assistant-1") } },
        ),
      );
      assert.strictEqual(ranged.produced.messageCount, 2);
      assert.notInclude(ranged.text, "Question 2");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("ConversationExportFiles", () => {
  it.live("clears exports at startup and removes them after the retention period", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = ConversationExportFiles.exportsDirectory(config, path);
      const stale = path.join(root, "left-by-a-previous-run");
      yield* fileSystem.makeDirectory(stale, { recursive: true });
      yield* fileSystem.writeFileString(path.join(stale, "old.md"), "old");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const files = yield* ConversationExportFiles.make({ retention: Duration.zero });
          assert.isFalse(yield* fileSystem.exists(stale));
          const written = yield* files.write({
            exportId: "export-1",
            fileName: "Chat.md",
            content: { _tag: "text", text: "# Chat\n" },
          });
          assert.strictEqual(written.byteLength, 7);
          assert.isTrue(yield* fileSystem.exists(written.path));
          yield* files.sweep;
          assert.isFalse(yield* fileSystem.exists(written.path));
        }),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "scient-convexport-files-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("streams archive files and refuses one that changed since the export checked it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-zip-source-" });
      const source = path.join(directory, "data.bin");
      const bytes = new TextEncoder().encode("attachment bytes");
      yield* fileSystem.writeFile(source, bytes);
      const digest =
        `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}` as const;
      const files = yield* ConversationExportFiles.make();
      const written = yield* files.write({
        exportId: "export-streamed",
        fileName: "Chat.zip",
        content: {
          _tag: "zip",
          modifiedAt: "2026-09-28T09:12:00.000Z",
          entries: [
            { path: "Chat.md", bytes: new TextEncoder().encode("# Chat\n") },
            {
              path: "attachments/01-data.bin",
              file: { path: source, byteLength: bytes.byteLength, sha256: digest },
            },
          ],
        },
      });
      const entries = yield* Effect.promise(() => readZip(written.path));
      assert.strictEqual(
        entries.get("attachments/01-data.bin")!.toString("utf8"),
        "attachment bytes",
      );

      for (const file of [
        { path: source, byteLength: bytes.byteLength + 1, sha256: null },
        { path: source, byteLength: bytes.byteLength, sha256: `sha256:${"0".repeat(64)}` as const },
        { path: path.join(directory, "missing.bin"), byteLength: 1, sha256: null },
      ]) {
        const exit = yield* Effect.exit(
          files.write({
            exportId: "export-changed",
            fileName: "Changed.zip",
            content: {
              _tag: "zip",
              modifiedAt: "2026-09-28T09:12:00.000Z",
              entries: [{ path: "attachments/01-data.bin", file }],
            },
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.isFalse(
          yield* fileSystem.exists(
            path.join(path.dirname(path.dirname(written.path)), "export-changed", "Changed.zip"),
          ),
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "scient-convexport-files-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("keeps exports younger than the retention period", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const files = yield* ConversationExportFiles.make();
            const written = yield* files.write({
              exportId: "export-2",
              fileName: "Chat.md",
              content: { _tag: "text", text: "x" },
            });
            yield* files.sweep;
            assert.isTrue(yield* fileSystem.exists(written.path));
          }),
        ),
      );
      assert.isTrue(Exit.isSuccess(exit));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "scient-convexport-files-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("conversation export delivery", () => {
  it.live("serves a produced file through a signed asset", () =>
    Effect.gen(function* () {
      const files = yield* ConversationExportFiles.ConversationExportFiles;
      const written = yield* files.write({
        exportId: "export-3",
        fileName: "Conversation notes.md",
        content: { _tag: "text", text: "# Notes\n" },
      });
      const asset = yield* issueAssetUrl({
        resource: {
          _tag: "environment-file",
          path: EnvironmentFilePath.make(written.path),
          access: "exact",
        },
        expiresInMs: Duration.toMillis(ConversationExportFiles.CONVERSATION_EXPORT_RETENTION),
      });
      const [, , , token, name] = asset.relativeUrl.split("/");
      assert.strictEqual(decodeURIComponent(name!), "Conversation notes.md");
      const resolved = yield* resolveAsset(token!, name!);
      assert(resolved?.kind === "file");
      const fileSystem = yield* FileSystem.FileSystem;
      assert.strictEqual(
        yield* fileSystem.realPath(resolved.path),
        yield* fileSystem.realPath(written.path),
      );
    }).pipe(Effect.provide(AssetTestLayer)),
  );

  const wordConversions: Array<DocumentBundle> = [];
  const diagramConversions: Array<DocumentBundle> = [];
  it.effect("captures a PNG for server-selected, redacted conversation Mermaid source", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* seedThread({
        pairs: 1,
        firstUserText: `\`\`\`mermaid\nflowchart LR\n A["${config.stateDir}/logs/x"] --> B\n\`\`\``,
      });
      const service = yield* ConversationExportService.ConversationExportService;
      const wordRequest = request({ format: "docx" });
      const plan = yield* service.prepareWordDiagrams(wordRequest);
      assert.lengthOf(plan.diagrams, 1);
      assert.notInclude(plan.diagrams[0]!.source, config.stateDir);
      const produced = yield* service.produce({
        ...wordRequest,
        diagramCapture: {
          sourceDigest: plan.sourceDigest,
          diagrams: [
            {
              id: plan.diagrams[0]!.id,
              result: { _tag: "png", base64: Buffer.from(PNG_BYTES).toString("base64") },
            },
          ],
        },
      });
      assert.strictEqual(produced.format, "docx");
      const bundle = diagramConversions.at(-1)!;
      assert.strictEqual(
        bundle.assets.find((asset) => asset.role === "rendered-diagram")?.id,
        plan.diagrams[0]!.id,
      );
    }).pipe(
      Effect.provide(
        exportLayer("scient-convexport-word-diagram-", {
          _tag: "converts",
          seen: diagramConversions,
        }),
      ),
    ),
  );
  it.effect("converts the conversation bundle to Word when Pandoc is installed", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* seedThread({ pairs: 2, firstUserText: `See ${config.stateDir}/logs/x.log` });
      const service = yield* ConversationExportService.ConversationExportService;
      const preparation = yield* service.prepare(THREAD);
      assert.deepStrictEqual(
        preparation.formats.find((entry) => entry.format === "docx"),
        {
          format: "docx",
          available: true,
          unavailableReason: null,
        },
      );
      const produced = yield* service.produce(
        request({ format: "docx" }, { includeWorkLog: true }),
      );
      assert(produced.output._tag === "file");
      assert.strictEqual(produced.output.fileName, "Long study results.docx");
      assert.strictEqual(
        produced.output.mediaType,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      const fileSystem = yield* FileSystem.FileSystem;
      assert.isTrue(yield* fileSystem.exists(produced.output.path));
      // The converter receives the bundle, with Scient's storage paths redacted.
      const bundle = wordConversions.at(-1)!;
      assert.strictEqual(bundle.profile, "chat");
      assert.include(bundle.markdown, "«scient-data»/logs/x.log");
      assert.notInclude(bundle.markdown, config.stateDir);
      assert.include(
        produced.warnings.map((warning) => warning.code),
        "converter-reported",
      );
    }).pipe(
      Effect.provide(
        exportLayer("scient-convexport-word-", { _tag: "converts", seen: wordConversions }),
      ),
    ),
  );

  it.effect("refuses to copy a Word file", () =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 1 });
      const service = yield* ConversationExportService.ConversationExportService;
      const error = yield* service
        .produce(request({ format: "docx", delivery: "clipboard" }))
        .pipe(Effect.flip);
      assert(error._tag === "ScientConversationExportError");
      assert.strictEqual(error.reason, "delivery-unsupported");
    }).pipe(Effect.provide(exportLayer("scient-convexport-word-", { _tag: "converts", seen: [] }))),
  );

  for (const [failure, expected] of [
    ["too-large", "too-large"],
    ["timeout", "too-large"],
    ["failed", "conversion-failed"],
    ["unavailable", "format-unavailable"],
  ] as const) {
    it.effect(
      `reports a Word conversion that ${failure === "failed" ? "fails" : `is ${failure}`}`,
      () =>
        Effect.gen(function* () {
          yield* seedThread({ pairs: 1 });
          const service = yield* ConversationExportService.ConversationExportService;
          const error = yield* service.produce(request({ format: "docx" })).pipe(Effect.flip);
          assert(error._tag === "ScientConversationExportError");
          assert.strictEqual(error.reason, expected);
          assert.strictEqual(error.message, `Word conversion ${failure}.`);
        }).pipe(
          Effect.provide(
            exportLayer("scient-convexport-word-", { _tag: "fails", reason: failure }),
          ),
        ),
    );
  }
});

const PdfTestLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer,
  ServerSecretStore.layer,
).pipe(Layer.provideMerge(TestLayer));

const decodePageInput = Schema.decodeUnknownEffect(Schema.fromJsonString(ScientDocumentPageInput));

const readCapturedPageInput = (inputRelativeUrl: string) =>
  Effect.gen(function* () {
    const asset = yield* resolveAsset(inputRelativeUrl.split("/")[3]!, "document.json");
    assert(asset !== null && asset.kind === "file");
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* decodePageInput(yield* fileSystem.readFileString(asset.path));
  });

describe("conversation PDF preparation", () => {
  it.effect("captures a 2,100-message conversation with the dialog's options for PDF", () =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 1_050, activitiesPerTurn: 1 });
      const prepared = yield* prepareConversationPdf(
        request({ format: "pdf" }, { includeWorkLog: true }),
      );
      assert.strictEqual(prepared.expected.documentKind, "conversation");
      assert.match(prepared.expected.sourceDigest, /^sha256:[0-9a-f]{64}$/u);
      const page = yield* readCapturedPageInput(prepared.inputRelativeUrl);
      assert.strictEqual(page.profile, "chat");
      assert.include(page.markdown, "Answer 1050");
      assert.include(page.markdown, "<details>");
      assert.include(page.markdown, "echo 1050");
      assert.notInclude(page.markdown, "sk-hidden");
      assert.notInclude(page.markdown, "provider-session-secret");

      const withoutWorkLog = yield* readCapturedPageInput(
        (yield* prepareConversationPdf(request({ format: "pdf" }))).inputRelativeUrl,
      );
      assert.notInclude(withoutWorkLog.markdown, "echo 1050");

      const ranged = yield* readCapturedPageInput(
        (yield* prepareConversationPdf(
          request(
            { format: "pdf" },
            { range: { _tag: "through-message", messageId: MessageId.make("assistant-2") } },
          ),
        )).inputRelativeUrl,
      );
      assert.include(ranged.markdown, "Answer 2");
      assert.notInclude(ranged.markdown, "Question 3");
    }).pipe(Effect.provide(PdfTestLayer)),
  );

  it.effect("redacts storage paths from the PDF title, text, and warnings end to end", () =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 1, activitiesPerTurn: 1 });
      const config = yield* ServerConfig.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const secretTitle = `Report from ${config.stateDir}/attachments`;
      yield* sql`UPDATE projection_threads SET title = ${secretTitle} WHERE thread_id = ${THREAD}`;
      const prepared = yield* prepareConversationPdf(
        request({ format: "pdf" }, { includeWorkLog: true }),
      );
      const page = yield* readCapturedPageInput(prepared.inputRelativeUrl);
      for (const text of [
        prepared.title,
        page.title,
        page.markdown,
        ...page.warnings.map((warning) => warning.message),
      ]) {
        assert.notInclude(text, config.stateDir);
        assert.notInclude(text, config.baseDir);
      }
      assert.include(page.title, "«scient-data»");
      // The page title is the document title and the running header of every page.
      assert.strictEqual(prepared.title, page.title);
      assert.include(
        page.warnings.map((warning) => warning.code),
        "sensitive-content-included",
      );
    }).pipe(Effect.provide(PdfTestLayer)),
  );

  it.effect("refuses non-PDF requests and missing threads", () =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 1 });
      const notPdf = yield* prepareConversationPdf(request()).pipe(Effect.flip);
      assert.strictEqual(notPdf._tag, "ScientDocumentPdfExportError");
      const missingThread = yield* prepareConversationPdf(
        request({ format: "pdf", threadId: ThreadId.make("missing") }),
      ).pipe(Effect.flip);
      assert.strictEqual(
        missingThread._tag === "ScientConversationExportError" ? missingThread.reason : null,
        "thread-not-found",
      );
    }).pipe(Effect.provide(PdfTestLayer)),
  );
});
