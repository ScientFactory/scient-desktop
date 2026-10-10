// @effect-diagnostics nodeBuiltinImport:off -- the test reads produced packages from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ChatAttachment,
  SCIC_MEDIA_TYPE,
  ThreadId,
  type ConversationImportId,
  type ScientConversationExportRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as yauzl from "yauzl";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as ConversationExportFiles from "../conversationExport/ConversationExportFiles.ts";
import * as ConversationExportService from "../conversationExport/ConversationExportService.ts";
import {
  nativeExportStorage,
  seedNativeExportThread,
} from "../conversationExport/conversationExport.testkit.ts";
import * as ConversationSnapshotService from "../conversationExport/ConversationSnapshotService.ts";
import { PandocWordConverter } from "../pandoc/PandocWordConverter.ts";
import { readScicPackage } from "./ScicReader.ts";
import { prepareScicPackage, sha256Digest } from "./ScicWriter.ts";
import { ScicManifest, scicAttachmentPathDigest } from "./scicFormat.ts";
import {
  PNG as FIXTURE_PNG,
  attachment as snapshotAttachment,
  capturedSnapshot,
  generatedNames,
  zipBytesPromise,
} from "./scic.test-fixtures.ts";

// Lets a test stand in for a package over the format's limits, which takes
// hundreds of megabytes to reach for real.
const scicWriter = vi.hoisted(() => ({ tooLarge: false }));
vi.mock("./ScicWriter.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ScicWriter.ts")>();
  return {
    ...actual,
    prepareScicPackage: ((input: Parameters<typeof actual.prepareScicPackage>[0]) =>
      scicWriter.tooLarge
        ? { _tag: "too-large", entry: "conversation.json" }
        : actual.prepareScicPackage(input)) as typeof actual.prepareScicPackage,
  };
});

const THREAD = ThreadId.make("thread-1");
const decodeManifestJson = Schema.decodeEffect(Schema.fromJsonString(ScicManifest));
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
  Layer.provideMerge(nativeExportStorage),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scient-scic-export-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** One settled turn: a prompt with an image, a tool call carrying a secret, reasoning, and an answer. */
const seedThread = Effect.fn("seedThread")(function* (
  attachments: ReadonlyArray<ChatAttachment> = [image],
  bytes: Uint8Array = PNG,
) {
  const config = yield* ServerConfig.ServerConfig;
  yield* seedNativeExportThread({
    threadId: THREAD,
    title: "Transfer study",
    pairs: 1,
    firstUserText: `See ${config.stateDir}/logs/server.log`,
    activitiesPerTurn: 1,
    reasoning: true,
    attachmentsForPrompt: () => attachments,
  });
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const attachment of attachments) {
    const imagePath = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
    yield* fileSystem.makeDirectory(path.dirname(imagePath), { recursive: true });
    yield* fileSystem.writeFile(imagePath, bytes);
  }
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

/** Validates prepared package files with the reader, as another Scient would. */
const readPrepared = (files: Parameters<typeof zipBytesPromise>[0]) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.promise(() => zipBytesPromise(files));
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-scic-names-"));
    const packagePath = NodePath.join(root, "package.scic");
    NodeFS.writeFileSync(packagePath, bytes);
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
    return read;
  });

const preparePackage = (
  snapshot: typeof capturedSnapshot,
  redact: (text: string) => string = (text) => text,
) =>
  prepareScicPackage({
    snapshot,
    attachments: new Map(
      snapshot.messages.flatMap((message) =>
        message.attachments.map(
          (entry) =>
            [
              entry.localId,
              { _tag: "bytes" as const, bytes: FIXTURE_PNG, sha256: sha256Digest(FIXTURE_PNG) },
            ] as const,
        ),
      ),
    ),
    exportValue: "7f3c9a2e41b8",
    exportedAt: "2026-09-28T09:12:00.000Z",
    exporter: { name: "Scient", version: "0.7.0" },
    timeZone: "UTC",
    redact,
  });

describe("naming .scic attachments", () => {
  it.effect("writes names the reader accepts for any Unicode attachment name", () =>
    Effect.gen(function* () {
      const names = generatedNames(120);
      const [first, second] = capturedSnapshot.messages;
      const snapshot = {
        ...capturedSnapshot,
        messages: [
          {
            ...first!,
            text: "Generated names",
            references: [],
            attachments: names.map((name, index) =>
              snapshotAttachment(
                `thread-1-generated-${index}`,
                "image",
                name,
                "image/png",
                FIXTURE_PNG.byteLength,
              ),
            ),
          },
          second!,
        ],
        warnings: [],
      };
      const prepared = preparePackage(snapshot);
      assert(prepared._tag === "ok", prepared._tag);
      for (const resource of prepared.value.manifest.resources) {
        assert(resource._tag === "included");
        assert.isTrue(resource.path.isWellFormed());
        assert.strictEqual(scicAttachmentPathDigest(resource.path), resource.sha256);
        assert.isAtMost(new TextEncoder().encode(resource.path.split("/")[1]!).byteLength, 255);
      }
      const read = yield* readPrepared(prepared.value.files);
      assert(Exit.isSuccess(read), String(Exit.isFailure(read) ? read.cause : ""));
      assert.strictEqual(read.value.snapshot.messages[0]!.attachments.length, names.length);
    }),
  );

  it.effect("splits a turn that returns after another turn so the package imports", () =>
    Effect.gen(function* () {
      const [user, assistant] = capturedSnapshot.messages;
      const at = (minute: number) => `2026-09-27T14:${String(minute).padStart(2, "0")}:00.000Z`;
      const reply = (n: number, turnId: string, text: string, minute: number) => ({
        ...assistant!,
        n,
        id: `message-${n}` as never,
        turnId: turnId as never,
        text,
        createdAt: at(minute),
        updatedAt: at(minute),
      });
      const snapshot = {
        ...capturedSnapshot,
        selection: { workLog: false, reasoning: true, throughMessageId: null },
        messages: [
          {
            ...user!,
            text: "Start",
            attachments: [],
            references: [],
            createdAt: at(1),
            updatedAt: at(1),
          },
          reply(2, "turn-1", "First", 2),
          reply(3, "turn-2", "Other", 3),
          reply(4, "turn-1", "Back", 4),
        ],
        reasoning: [
          {
            id: "reasoning-1" as never,
            turnId: "turn-1" as never,
            createdAt: at(2),
            updatedAt: at(2),
            text: "Early",
          },
          {
            id: "reasoning-2" as never,
            turnId: "turn-1" as never,
            createdAt: at(5),
            updatedAt: at(5),
            text: "Late",
          },
        ],
        questionAnswers: [
          {
            id: "request-1",
            turnId: "turn-1" as never,
            createdAt: at(4),
            items: [{ question: "Which?", answer: "This", attachments: [] }],
          },
        ],
        warnings: [],
      };
      const prepared = preparePackage(snapshot);
      assert(prepared._tag === "ok", prepared._tag);
      const read = yield* readPrepared(prepared.value.files);
      assert(Exit.isSuccess(read), String(Exit.isFailure(read) ? read.cause : ""));
      const imported = read.value.snapshot;
      assert.deepStrictEqual(
        imported.messages.map((message): string | null => message.turnId),
        [null, "turn-1", "turn-2", "turn-1~2"],
      );
      assert.deepStrictEqual(
        imported.reasoning.map((reasoning): string | null => reasoning.turnId),
        ["turn-1", "turn-1~2"],
      );
      assert.deepStrictEqual(
        imported.questionAnswers.map((answer): string | null => answer.turnId),
        ["turn-1~2"],
      );
    }),
  );

  it("runs the reader's full conversation validation before writing", () => {
    // Reasoning present although it was not selected: the importer refuses it.
    const prepared = preparePackage({
      ...capturedSnapshot,
      reasoning: [
        {
          id: "reasoning-1" as never,
          turnId: "turn-1" as never,
          createdAt: "2026-09-27T14:05:30.000Z",
          updatedAt: "2026-09-27T14:05:30.000Z",
          text: "Unselected",
        },
      ],
    });
    assert.deepStrictEqual(prepared, {
      _tag: "invalid-package",
      detail: "The conversation does not pass import validation.",
    });
  });

  it("refuses to hand out a package its own reader would reject", () => {
    // A redaction that makes an attachment name longer than a manifest name may be.
    const prepared = preparePackage(capturedSnapshot, (text) =>
      text.replaceAll("figure", "f".repeat(300)),
    );
    assert.strictEqual(prepared._tag, "invalid-package");
  });
});

describe("exporting a .scic", () => {
  it.effect("round-trips identical file bytes with distinct declared media types", () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode("shared file bytes\n");
      const files: ReadonlyArray<ChatAttachment> = [
        {
          type: "file",
          id: "thread-1-33333333-3333-4333-8333-333333333333",
          name: "shared.txt",
          mimeType: "text/plain",
          sizeBytes: bytes.byteLength,
        },
        {
          type: "file",
          id: "thread-1-44444444-4444-4444-8444-444444444444",
          name: "shared.txt",
          mimeType: "application/octet-stream",
          sizeBytes: bytes.byteLength,
        },
      ];
      yield* seedThread(files, bytes);
      const { entries, read } = yield* exportAndRead();
      assert(Exit.isSuccess(read), String(Exit.isFailure(read) ? read.cause : ""));

      const manifest = yield* decodeManifestJson(
        entries.find((entry) => entry.name === "manifest.json")!.text,
      );
      const resources = manifest.resources.filter((resource) => resource._tag === "included");
      assert.strictEqual(resources.length, 2);
      assert.strictEqual(resources[0]!.name, "shared.txt");
      assert.strictEqual(resources[1]!.name, "shared.txt");
      assert.notStrictEqual(resources[0]!.path, resources[1]!.path);
      const expectedPrefix = `attachments/${sha256Digest(bytes).slice("sha256:".length)}-`;
      for (const resource of resources) {
        assert(resource.path.startsWith(expectedPrefix));
        assert.include(resource.path, "shared.txt");
        assert(
          manifest.entries.some(
            (entry) => entry.path === resource.path && entry.mediaType === resource.mediaType,
          ),
        );
        assert.include(
          entries.find((entry) => entry.name === "conversation.md")!.text,
          resource.path,
        );
      }
      assert.deepStrictEqual(
        entries.filter((entry) => entry.name.startsWith("attachments/")).map((entry) => entry.name),
        resources.map((resource) => resource.path).toSorted(),
      );
      assert.deepStrictEqual(
        read.value.snapshot.messages[0]?.attachments.map((attachment) => attachment.mimeType),
        ["text/plain", "application/octet-stream"],
      );
      assert.strictEqual(read.value.attachments.length, 2);
      assert(
        read.value.attachments.every((attachment) => attachment.sha256 === sha256Digest(bytes)),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("round-trips case-colliding attachment names with identical bytes", () =>
    Effect.gen(function* () {
      const otherImage: ChatAttachment = {
        ...image,
        id: "thread-1-22222222-2222-4222-8222-222222222222",
        name: "Figure.png",
      };
      yield* seedThread([otherImage, image]);
      const { entries, read } = yield* exportAndRead();
      assert(Exit.isSuccess(read), String(Exit.isFailure(read) ? read.cause : ""));

      const expectedPath = `attachments/${sha256Digest(PNG).slice("sha256:".length)}-figure.png`;
      assert.deepStrictEqual(
        entries.filter((entry) => entry.name.startsWith("attachments/")).map((entry) => entry.name),
        [expectedPath],
      );
      const manifest = yield* decodeManifestJson(
        entries.find((entry) => entry.name === "manifest.json")!.text,
      );
      assert.deepStrictEqual(
        manifest.resources.map((resource) => [
          resource.name,
          resource._tag === "included" ? resource.path : null,
        ]),
        [
          ["Figure.png", expectedPath],
          ["figure.png", expectedPath],
        ],
      );
      assert.deepStrictEqual(
        read.value.snapshot.messages[0]?.attachments.map((attachment) => attachment.name),
        ["Figure.png", "figure.png"],
      );
      assert.strictEqual(read.value.attachments.length, 2);
      assert(read.value.attachments.every((attachment) => attachment.sha256 === sha256Digest(PNG)));
      assert.include(entries.find((entry) => entry.name === "conversation.md")!.text, expectedPath);
    }).pipe(Effect.provide(TestLayer)),
  );

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

  it.effect("suggests what the dialog offers when the file would be too large", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const service = yield* ConversationExportService.ConversationExportService;
      scicWriter.tooLarge = true;
      const error = yield* service
        .produce(request())
        .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => (scicWriter.tooLarge = false))));
      assert(error._tag === "ScientConversationExportError");
      assert.strictEqual(error.reason, "too-large");
      assert.strictEqual(
        error.message,
        "This conversation is too large for a Scient conversation file. Leave out the work log and reasoning, or export it as Markdown.",
      );
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
