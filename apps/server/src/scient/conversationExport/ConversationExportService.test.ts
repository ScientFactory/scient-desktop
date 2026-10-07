// @effect-diagnostics nodeBuiltinImport:off -- The test reads produced ZIP archives with yauzl.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatAttachment,
  ConversationImportId,
  Sha256Digest,
  EnvironmentFilePath,
  MessageId,
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES,
  ScientDocumentPageInput,
  ThreadId,
  EventId,
  ComposerContextId,
  OrchestrationMessageContext,
  TurnId,
  TurnItemId,
  type DocumentBundle,
  type ScientConversationExportRequest,
} from "@t3tools/contracts";
import { importedMessageMarkdown, parseConversationMarkdown } from "@scientfactory/conversation";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as LegacyImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import { conversationSnapshotProjection } from "./conversationSnapshotProjection.ts";
import { readScicPackage } from "../conversationFile/ScicReader.ts";
import * as yauzl from "yauzl";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { issueAssetUrl, resolveAsset } from "../../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../../assets/NativeAppIconResolver.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as ServerConfig from "../../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as ConversationExportFiles from "./ConversationExportFiles.ts";
import * as ConversationExportService from "./ConversationExportService.ts";
import {
  nativeExportStorage,
  seedNativeExportThread,
  updateNativeExportThread,
} from "./conversationExport.testkit.ts";
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
// These tests resolve captured export files, not provider tool-output capabilities.
const capturedFileLookup = Layer.mock(Orchestrator.OrchestratorV2)({
  getTurnItem: () => Effect.die("Captured export attempted provider-item lookup"),
});

const encodeHistoricalAttachments = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(ChatAttachment)),
);
const encodeHistoricalContext = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationMessageContext),
);
const decodeImportId = Schema.decodeEffect(ConversationImportId);
const decodePackageDigest = Schema.decodeEffect(Sha256Digest);

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
            Layer.provideMerge(capturedFileLookup),
            Layer.provideMerge(NodeServices.layer),
          )
        : wordLayer(word),
    ),
    Layer.provideMerge(ConversationSnapshotService.layer),
    Layer.provideMerge(ConversationExportFiles.layer),
    Layer.provideMerge(nativeExportStorage),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(capturedFileLookup),
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
    Layer.provideMerge(nativeExportStorage),
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

const seedThread = Effect.fn("seedThread")(function* (input: {
  readonly pairs: number;
  readonly activitiesPerTurn?: number;
  readonly running?: boolean;
  readonly firstUserText?: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly attachmentPerPrompt?: boolean;
  readonly reasoning?: boolean;
}) {
  const promptAttachments = new Map<number, ReadonlyArray<ChatAttachment>>();
  for (let pair = 1; pair <= input.pairs; pair++) {
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
    promptAttachments.set(pair, [...(pair === 1 ? (input.attachments ?? []) : []), ...own]);
  }
  yield* seedNativeExportThread({
    ...input,
    threadId: THREAD,
    title: "Long / study: results?",
    attachmentsForPrompt: (pair) => promptAttachments.get(pair) ?? [],
  });
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
  it.effect("refuses part of a conversation on every export path", () =>
    Effect.gen(function* () {
      const stored = yield* storeAttachment(image, new Uint8Array([137, 80, 78, 71]));
      yield* seedThread({ pairs: 2, attachments: [image] });
      const service = yield* ConversationExportService.ConversationExportService;
      const partial = (
        format: ScientConversationExportRequest["format"],
        overrides: Partial<ScientConversationExportRequest> = {},
        options: Partial<ScientConversationExportRequest["options"]> = {},
      ) =>
        request(
          { format, ...overrides },
          { range: { _tag: "through-message", messageId: MessageId.make("user-2") }, ...options },
        );
      const refusal = <A>(
        effect: Effect.Effect<A, ConversationExportService.ConversationExportServiceError>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error): { readonly reason: string | null; readonly message: string } =>
            error._tag === "ScientConversationExportError"
              ? { reason: error.reason, message: error.message }
              : { reason: error._tag, message: "" },
          ),
        );
      const expected = {
        reason: "range-unavailable",
        message: "Exporting part of a conversation is not available yet.",
      };
      rangeAccesses.length = 0;
      for (const refused of [
        refusal(service.produce(partial("markdown"))),
        refusal(service.produce(partial("markdown", { delivery: "clipboard" }))),
        refusal(
          service.produce(partial("markdown", {}, { markdownPackaging: "with-attachments" })),
        ),
        refusal(service.produce(partial("scic"))),
        refusal(service.produce(partial("docx"))),
        refusal(service.prepareWordDiagrams(partial("docx"))),
        refusal(service.document(partial("pdf"))),
      ]) {
        assert.deepStrictEqual(yield* refused, expected);
      }
      // Refused before anything is captured or read.
      assert.deepStrictEqual(
        rangeAccesses.filter((access) => access.path === stored),
        [],
      );
      assert.strictEqual((yield* service.produce(request())).messageCount, 4);
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
      yield* updateNativeExportThread(THREAD, {
        title: `Logs in ${config.baseDir}`,
        activityPayload: {
          title: "Ran command",
          itemType: "command_execution",
          data: { item: { command: `cat ${config.stateDir}/logs/a_b.log` } },
        },
      });
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
      yield* updateNativeExportThread(THREAD, { title: "研究結果".repeat(23) });
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
        "range-unavailable",
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
    }).pipe(Effect.provide(Layer.merge(AssetTestLayer, capturedFileLookup))),
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

  it.effect.each(
    (
      [
        ["too-large", "too-large"],
        ["timeout", "too-large"],
        ["failed", "conversion-failed"],
        ["unavailable", "format-unavailable"],
      ] as const
    ).map(([failure, expected]) => ({
      caseTitle: `reports a Word conversion that ${failure === "failed" ? "fails" : `is ${failure}`}`,
      failure,
      expected,
    })),
  )("$caseTitle", ({ failure, expected }) =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 1 });
      const service = yield* ConversationExportService.ConversationExportService;
      const error = yield* service.produce(request({ format: "docx" })).pipe(Effect.flip);
      assert(error._tag === "ScientConversationExportError");
      assert.strictEqual(error.reason, expected);
      assert.strictEqual(error.message, `Word conversion ${failure}.`);
    }).pipe(
      Effect.provide(exportLayer("scient-convexport-word-", { _tag: "fails", reason: failure })),
    ),
  );
});

const pdfTestLayer = (exports: ReturnType<typeof exportLayer>) =>
  Layer.mergeAll(
    WorkspacePaths.layer,
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
    NativeAppIconResolver.layer,
    ServerSecretStore.layer,
  ).pipe(Layer.provideMerge(exports));
const PdfTestLayer = pdfTestLayer(TestLayer);

const decodePageInput = Schema.decodeUnknownEffect(Schema.fromJsonString(ScientDocumentPageInput));

const readCapturedPageInput = (inputRelativeUrl: string) =>
  Effect.gen(function* () {
    const asset = yield* resolveAsset(inputRelativeUrl.split("/")[3]!, "document.json").pipe(
      Effect.provide(capturedFileLookup),
    );
    assert(asset !== null && asset.kind === "file");
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* decodePageInput(yield* fileSystem.readFileString(asset.path));
  });

describe("conversation PDF preparation", () => {
  it.effect(
    "presents canonical citation text in every human export while SCIC retains raw provenance",
    () => {
      const wordBundles: DocumentBundle[] = [];
      return Effect.gen(function* () {
        yield* seedThread({ pairs: 1 });
        const raw =
          "Evidence לפני 😀 \uE200cite\uE202turn3view1\uE201 after. Missing source \uE200cite\uE202turn9view0\uE201.";
        const presentation = {
          format: "codex-private-v1" as const,
          sources: [{ id: "turn3view1", url: "https://example.org/guideline", title: "Guideline" }],
        };
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const before = yield* projections.getThreadProjection(THREAD);
        const occurredAt = DateTime.makeUnsafe("2026-09-28T00:00:00.000Z");
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            ...before.messages
              .filter((entry) => entry.role === "assistant")
              .map((entry) => ({
                id: EventId.make(`human-citation-message:${entry.id}`),
                type: "message.updated" as const,
                threadId: THREAD,
                occurredAt,
                payload: { ...entry, text: raw, citationPresentation: presentation },
              })),
            ...before.turnItems
              .filter((entry) => entry.type === "assistant_message")
              .map((entry) => ({
                id: EventId.make(`human-citation-item:${entry.id}`),
                type: "turn-item.updated" as const,
                threadId: THREAD,
                occurredAt,
                payload: { ...entry, text: raw, citationPresentation: presentation },
              })),
          ],
        });
        const snapshots = yield* ConversationSnapshotService.ConversationSnapshotService;
        const capture = yield* snapshots.capture({
          threadId: THREAD,
          selection: {
            workLog: false,
            reasoning: false,
            throughMessageId: null,
          },
        });
        assert.equal(
          capture.snapshot.messages.find((entry) => entry.role === "assistant")?.text,
          raw,
        );
        assert.deepEqual(
          capture.snapshot.messages.find((entry) => entry.role === "assistant")
            ?.citationPresentation,
          presentation,
        );
        const expectedLink = '[1](<https://example.org/guideline> "Guideline")';
        const assertHuman = (text: string) => {
          assert.include(
            text,
            `Evidence לפני 😀 ${expectedLink} after. Missing source [citation unavailable].`,
          );
          assert.notInclude(text, "\uE200cite\uE202");
        };
        const service = yield* ConversationExportService.ConversationExportService;
        assertHuman((yield* service.document(request({ format: "pdf" }))).bundle.markdown);
        assertHuman((yield* produceText(request())).text);
        assertHuman((yield* produceText(request({ delivery: "clipboard" }))).text);
        assertHuman((yield* produceText(request({ format: "docx" }))).text);
        assert.equal(wordBundles.length, 1);
        assertHuman(wordBundles[0]!.markdown);
        const pdf = yield* prepareConversationPdf(request({ format: "pdf" }));
        assertHuman((yield* readCapturedPageInput(pdf.inputRelativeUrl)).markdown);
        const archive = yield* service.produce(request({ format: "scic" }));
        if (archive.output._tag !== "file") return assert.fail("Expected SCIC file");
        const archivePath = archive.output.path;
        const entries = yield* Effect.promise(() => readZip(archivePath));
        assertHuman(entries.get("conversation.md")!.toString());
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stage = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-citation-reimport-",
        });
        const attachmentsDirectory = path.join(stage, "attachments");
        yield* fileSystem.makeDirectory(attachmentsDirectory);
        const bytes = yield* fileSystem.readFile(archivePath);
        const imported = yield* readScicPackage({
          importId: yield* decodeImportId("cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b"),
          packagePath: archivePath,
          packageBytes: bytes.byteLength,
          packageSha256: yield* decodePackageDigest(
            `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`,
          ),
          attachmentsDirectory,
        });
        assert.equal(
          imported.snapshot.messages.find((entry) => entry.role === "assistant")?.text,
          raw,
        );
        assert.deepEqual(
          imported.snapshot.messages.find((entry) => entry.role === "assistant")
            ?.citationPresentation,
          presentation,
        );
        assert.equal(
          importedMessageMarkdown(
            imported.snapshot.messages.find((entry) => entry.role === "assistant")!,
          ),
          raw,
        );
        const after = yield* snapshots.capture({
          threadId: THREAD,
          selection: {
            workLog: false,
            reasoning: false,
            throughMessageId: null,
          },
        });
        assert.equal(after.snapshot.contentDigest, capture.snapshot.contentDigest);
        assert.deepEqual(after.snapshot.messages, capture.snapshot.messages);
      }).pipe(
        Effect.provide(
          pdfTestLayer(
            exportLayer("scient-citation-human-export-", { _tag: "converts", seen: wordBundles }),
          ),
        ),
      );
    },
  );

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

      const ranged = yield* prepareConversationPdf(
        request(
          { format: "pdf" },
          { range: { _tag: "through-message", messageId: MessageId.make("assistant-2") } },
        ),
      ).pipe(Effect.flip);
      assert(ranged._tag === "ScientConversationExportError");
      assert.strictEqual(ranged.reason, "range-unavailable");
    }).pipe(Effect.provide(PdfTestLayer)),
  );

  it.effect("redacts storage paths from the PDF title, text, and warnings end to end", () =>
    Effect.gen(function* () {
      yield* seedThread({ pairs: 1, activitiesPerTurn: 1 });
      const config = yield* ServerConfig.ServerConfig;
      yield* updateNativeExportThread(THREAD, {
        title: `Report from ${config.stateDir}/attachments`,
      });
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

it.effect(
  "exports migrated system text, context and attachment bytes from the actual hydrated V2 snapshot",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('legacy-export', 'Legacy export', '/work/legacy', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${THREAD}, 'legacy-export', 'Historical system', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z')`;
      const attachment = {
        ...image,
        type: "file" as const,
        name: "history.txt",
        mimeType: "text/plain",
        sizeBytes: 16,
      };
      yield* storeAttachment(attachment, new TextEncoder().encode("Immutable bytes."));
      const attachmentsJson = yield* encodeHistoricalAttachments([attachment, missing]);
      const context = {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            kind: "file" as const,
            contextId: ComposerContextId.make("legacy-system-file"),
            label: "Historical attachment",
            attachmentId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        ],
      };
      const contextJson = yield* encodeHistoricalContext(context);
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, turn_id, attachments_json, is_streaming, created_at, updated_at)
      VALUES ('legacy-user', ${THREAD}, 'user', 'A historical question', 'legacy-turn', NULL, 0, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('legacy-system', ${THREAD}, 'system', 'Exact system history.\n\n  Preserve indentation.', 'legacy-turn', ${attachmentsJson}, 0, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ('legacy-assistant', ${THREAD}, 'assistant', 'Historical answer', 'legacy-turn', NULL, 0, '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z')`;
      yield* sql`UPDATE projection_thread_messages SET context_json = ${contextJson} WHERE message_id = 'legacy-system'`;
      const migration = yield* LegacyImporter.LegacyV1ThreadImporter;
      yield* migration.reconcileShells;
      const capture =
        yield* (yield* ConversationSnapshotService.ConversationSnapshotService).capture({
          threadId: THREAD,
          selection: { workLog: true, reasoning: true, throughMessageId: null },
        });
      const system = capture.snapshot.messages.find((message) => message.role === "system");
      assert.isDefined(system);
      assert.equal(system?.id, "legacy-system");
      assert.equal(system?.turnId, TurnId.make("legacy-turn"));
      assert.equal(system?.text, "Exact system history.\n\n  Preserve indentation.");
      assert.equal(capture.attachmentFiles.size, 1);
      const { text } = yield* produceText(
        request({}, { includeWorkLog: true, includeReasoning: true }),
      );
      // The established human document omits system rows; the portable package
      // retains them for another Scient import without instruction authority.
      assert.notInclude(text, "Exact system history.");
      const parsed = parseConversationMarkdown(text);
      assert.equal(parsed.kind, "conversation");
      if (parsed.kind !== "conversation") return assert.fail("Expected portable conversation");
      assert.deepEqual(
        parsed.messages.map((message) => message.role),
        ["user", "assistant"],
      );
      const service = yield* ConversationExportService.ConversationExportService;
      const archive = yield* service.produce(
        request({ format: "scic" }, { includeWorkLog: true, includeReasoning: true }),
      );
      assert.equal(archive.output._tag, "file");
      if (archive.output._tag !== "file") return assert.fail("Expected SCIC file");
      const archivePath = archive.output.path;
      const entries = yield* Effect.promise(() => readZip(archivePath));
      assert.isTrue([...entries.values()].some((bytes) => bytes.toString() === "Immutable bytes."));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stage = yield* fs.makeTempDirectoryScoped({ prefix: "scient-system-reimport-" });
      const attachmentStage = path.join(stage, "attachments");
      yield* fs.makeDirectory(attachmentStage);
      const packageBytes = yield* fs.readFile(archivePath);
      const importedPackage = yield* readScicPackage({
        importId: yield* decodeImportId("cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b"),
        packagePath: archivePath,
        packageBytes: packageBytes.byteLength,
        packageSha256: yield* decodePackageDigest(
          `sha256:${NodeCrypto.createHash("sha256").update(packageBytes).digest("hex")}`,
        ),
        attachmentsDirectory: attachmentStage,
      });
      assert.equal(
        importedPackage.snapshot.messages.find((message) => message.role === "system")?.text,
        system?.text,
      );
      assert.equal(importedPackage.attachments.length, 1);

      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        THREAD,
      );
      assert.deepEqual(
        conversationSnapshotProjection(projection, "/work/legacy").messages.find(
          (message) => message.role === "system",
        )?.context,
        context,
      );
      assert.isTrue(capture.snapshot.workLog.length === 0);
      assert.isTrue(
        capture.snapshot.warnings.some((warning) => warning._tag === "attachment-unavailable"),
      );
      assert.deepEqual(projection.runtimeRequests, []);
      assert.deepEqual(projection.runs, []);
      assert.deepEqual(projection.providerSessions, []);
      const item = projection.turnItems.find(
        (candidate) =>
          candidate.type === "dynamic_tool" && candidate.toolName === "historical_system_message",
      );
      if (item?.type !== "dynamic_tool") return assert.fail("Expected migrated system item");
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("malformed-system-history"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: item.updatedAt,
            payload: { ...item, input: { messageId: "legacy-system", text: 7 } },
          },
        ],
      });
      const degraded =
        yield* (yield* ConversationSnapshotService.ConversationSnapshotService).capture({
          threadId: THREAD,
          selection: { workLog: true, reasoning: true, throughMessageId: null },
        });
      assert.deepEqual(
        degraded.snapshot.messages.map((message) => message.role),
        ["user", "assistant"],
      );
      assert.equal(degraded.snapshot.workLog.length, 1);
      assert.equal(degraded.attachmentFiles.size, 0);
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("invalid-system-fields"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: item.updatedAt,
            payload: {
              ...item,
              input: {
                messageId: "legacy-system",
                text: "Recoverable text",
                attachments: [{ type: "file", id: "unsafe" }],
                context: { version: -1 },
              },
            },
          },
        ],
      });
      const partial =
        yield* (yield* ConversationSnapshotService.ConversationSnapshotService).capture({
          threadId: THREAD,
          selection: { workLog: true, reasoning: true, throughMessageId: null },
        });
      const partialSystem = partial.snapshot.messages.find((message) => message.role === "system");
      assert.equal(partialSystem?.text, "Recoverable text");
      assert.deepEqual(partialSystem?.attachments, []);
      assert.deepEqual(partialSystem?.references, []);
      assert.equal(partial.attachmentFiles.size, 0);
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("native-system-tool-name"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: item.updatedAt,
            payload: {
              ...item,
              id: TurnItemId.make("native-system-tool"),
              input: {
                messageId: "fake-system",
                text: "Tool output",
                attachments: [],
                context: null,
              },
            },
          },
        ],
      });
      const native =
        yield* (yield* ConversationSnapshotService.ConversationSnapshotService).capture({
          threadId: THREAD,
          selection: { workLog: true, reasoning: true, throughMessageId: null },
        });
      assert.isUndefined(native.snapshot.messages.find((message) => message.id === "fake-system"));
      assert.equal(native.snapshot.workLog.length, 1);
    }).pipe(Effect.provide(TestLayer)),
);
