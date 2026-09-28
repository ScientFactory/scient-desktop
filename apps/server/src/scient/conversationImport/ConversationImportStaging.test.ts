// @effect-diagnostics nodeBuiltinImport:off -- the tests inspect staging areas and copied files on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  ProjectId,
  ProviderInstanceId,
  SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES,
  ScientConversationImportError,
  ThreadId,
  type ConversationImportDestination,
  type ConversationImportId,
  type EnvironmentSessionPrincipalShape,
  type ScientConversationImportConfirmRequest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  PDF,
  PNG,
  capturedSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  makePackage,
  zipBytesPromise,
} from "../conversationFile/scic.test-fixtures.ts";
import { stagedAttachmentFile } from "../conversationFile/ScicReader.ts";
import { sha256Digest } from "../conversationFile/ScicWriter.ts";
import {
  CONVERSATION_IMPORT_COMPLETION_RETENTION_MS,
  CONVERSATION_IMPORT_MAX_RECORDS,
  CONVERSATION_IMPORT_STAGING_TTL_MS,
  ConversationImporter,
  ConversationImporterError,
  ConversationImportSettleError,
  type ConversationImportCompletion,
  type ConversationImportLease,
  type ConversationImportRequest,
} from "./ConversationImporter.ts";
import * as ConversationImportStaging from "./ConversationImportStaging.ts";

type ImporterService = ConversationImporter["Service"];

interface FakeImporter {
  importConversation: ImporterService["importConversation"];
  settleAttempt: ImporterService["settleAttempt"];
  imports: number;
  settled: Array<Parameters<ImporterService["settleAttempt"]>[0]>;
}

let fake: FakeImporter;

function resetImporter(
  overrides: Partial<Pick<FakeImporter, "importConversation" | "settleAttempt">> = {},
) {
  fake = {
    importConversation: (lease, request) => Effect.succeed(completionFor(lease, request)),
    settleAttempt: () => Effect.succeed({ _tag: "rolled-back" }),
    imports: 0,
    settled: [],
    ...overrides,
  };
}

const FakeImporterLive = Layer.succeed(ConversationImporter, {
  importConversation: (lease, request) =>
    Effect.suspend(() => {
      fake.imports += 1;
      return fake.importConversation(lease, request);
    }),
  settleAttempt: (attempt) =>
    Effect.suspend(() => {
      fake.settled.push(attempt);
      return fake.settleAttempt(attempt);
    }),
});

const TestLayer = Layer.mergeAll(ServerSecretStore.layer, FakeImporterLive).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scient-import-staging-" })),
  Layer.provideMerge(NodeServices.layer),
);

const principal: EnvironmentSessionPrincipalShape = {
  sessionId: AuthSessionId.make("session-1"),
  subject: "owner",
  method: "bearer-access-token",
  scopes: new Set([AuthOrchestrationOperateScope]),
};

const destination: ConversationImportDestination = {
  projectId: ProjectId.make("project-1"),
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};

function completionFor(
  lease: ConversationImportLease,
  request: ConversationImportRequest,
): ConversationImportCompletion {
  return {
    packageSha256: lease.input.package.packageSha256,
    result: {
      importId: lease.importId,
      threadId: ThreadId.make("thread-imported"),
      destination: request.destination,
      messageCount: lease.input.snapshot.messages.length,
      attachmentCount: lease.input.attachments.length,
    },
    completedAt: "1970-01-01T00:00:00.000Z",
  };
}

const stagingRoot = (config: ServerConfig.ServerConfig["Service"]) =>
  NodePath.join(config.stateDir, "scient", "conversation-imports");

const makeStaging = (options: ConversationImportStaging.ConversationImportStagingOptions = {}) =>
  ConversationImportStaging.make({ sweepOnTimer: false, ...options });

type Staging = ConversationImportStaging.ConversationImportStaging["Service"];

const packageBytes = Effect.promise(() => zipBytesPromise(makePackage().files));

const upload = Effect.fnUntraced(function* (staging: Staging, bytes: Uint8Array) {
  const created = yield* staging.createUpload({
    fileName: "Export design.scic",
    sizeBytes: bytes.byteLength,
  });
  const token = created.relativeUrl.slice(
    ConversationImportStaging.CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX.length + 1,
  );
  const claims = yield* staging.validateUploadToken(token);
  assert(claims !== null);
  const stored = yield* staging.receiveUpload(claims, Stream.make(bytes));
  return { importId: created.importId, claims, stored, token };
});

const stagedImport = Effect.fnUntraced(function* (staging: Staging) {
  const bytes = yield* packageBytes;
  const { importId } = yield* upload(staging, bytes);
  const preview = yield* staging.preview(importId);
  return { importId, preview, packageSha256: sha256Digest(bytes) };
});

const uploadMarkdown = Effect.fnUntraced(function* (
  staging: Staging,
  markdown: string,
  markdownMode: "messages" | "document" = "messages",
) {
  const bytes = new TextEncoder().encode(markdown);
  const created = yield* staging.createUpload({
    fileName: "conversation.md",
    sizeBytes: bytes.byteLength,
    markdownMode,
  });
  const token = created.relativeUrl.split("/").at(-1)!;
  const claims = yield* staging.validateUploadToken(token);
  assert(claims !== null);
  assert.deepStrictEqual(yield* staging.receiveUpload(claims, Stream.make(bytes)), { ok: true });
  return { importId: created.importId, packageSha256: sha256Digest(bytes) };
});

const markdownWithDamagedMarker = [
  "---",
  "scient: conversation",
  "scient-format: 1",
  "scient-export: 7f3c9a2e41b8",
  "title: Preview decision",
  "exported: 2026-09-28T09:12:00Z",
  "---",
  "",
  "<!-- scient:message export=7f3c9a2e41b8 n=1 role=user time=2026-09-27T14:05:00Z -->",
  "## You · 27 Sep 2026, 14:05 UTC",
  "",
  "First question",
  "",
  "<!-- scient:message export=7f3c9a2e41b8 n=2 role=robot time=2026-09-27T14:06:00Z -->",
  "## Assistant · 27 Sep 2026, 14:06 UTC",
  "",
  "Damaged answer",
].join("\n");

const confirmRequest = (
  importId: ConversationImportId,
  packageSha256: string,
  overrides: Partial<ScientConversationImportConfirmRequest> = {},
): ScientConversationImportConfirmRequest => ({
  importId,
  packageSha256,
  destination,
  ...overrides,
});

const encodeImportError = Schema.encodeEffect(ScientConversationImportError);
const decodeImportError = Schema.decodeExit(ScientConversationImportError);

const reasonOf = <A, R>(effect: Effect.Effect<A, { readonly _tag: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) =>
      "reason" in error ? (error as { readonly reason: string }).reason : error._tag,
    ),
  );

describe("ConversationImportStaging", () => {
  it.effect(
    "previews damaged Markdown, requires an explicit clean-message choice, and shares import command",
    () =>
      Effect.gen(function* () {
        let importedText: ReadonlyArray<string> = [];
        resetImporter({
          importConversation: (lease, request) => {
            importedText = lease.input.snapshot.messages.map((message) => message.text);
            return Effect.succeed(completionFor(lease, request));
          },
        });
        const staging = yield* makeStaging();
        const { importId, packageSha256 } = yield* uploadMarkdown(
          staging,
          markdownWithDamagedMarker,
        );
        const preview = yield* staging.preview(importId);
        assert.strictEqual(preview.kind, "markdown");
        assert.strictEqual(preview.counts.messages, 1);
        assert.deepStrictEqual(
          preview.markdownIssues.map((issue) => issue.kind),
          ["unknown-role"],
        );
        assert.strictEqual(fake.imports, 0);
        assert.strictEqual(
          yield* reasonOf(staging.confirm(confirmRequest(importId, packageSha256), principal)),
          "package-rejected",
        );
        assert.strictEqual(fake.imports, 0);
        const result = yield* staging.confirm(
          confirmRequest(importId, packageSha256, { acknowledgeMarkdownIssues: true }),
          principal,
        );
        assert.strictEqual(result.messageCount, 1);
        assert.deepStrictEqual(importedText, ["First question"]);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("re-stages damaged Markdown as one document attachment", () =>
    Effect.gen(function* () {
      resetImporter();
      const staging = yield* makeStaging();
      const { importId, packageSha256 } = yield* uploadMarkdown(
        staging,
        markdownWithDamagedMarker,
        "document",
      );
      const preview = yield* staging.preview(importId);
      assert.strictEqual(preview.kind, "document");
      assert.strictEqual(preview.counts.messages, 1);
      assert.strictEqual(preview.counts.attachments, 1);
      assert.deepStrictEqual(
        preview.markdownIssues.map((issue) => issue.kind),
        ["unknown-role"],
      );
      const result = yield* staging.confirm(confirmRequest(importId, packageSha256), principal);
      assert.strictEqual(result.attachmentCount, 1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect("stages an upload and previews it without touching threads or attachments", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const { importId, preview, packageSha256 } = yield* stagedImport(staging);
      assert.strictEqual(preview.importId, importId);
      assert.strictEqual(preview.kind, "scic");
      assert.strictEqual(preview.fileName, "Export design.scic");
      assert.strictEqual(preview.package.packageSha256, packageSha256);
      assert.strictEqual(preview.conversation.title, "Export design");
      assert.deepStrictEqual(preview.counts, {
        messages: 2,
        attachments: 2,
        reasoning: 0,
        workLogEntries: 0,
        proposedPlans: 0,
        questionAnswers: 0,
      });
      assert.deepStrictEqual((yield* staging.preview(importId)).counts, preview.counts);
      // Preview makes no durable change outside staging and starts nothing.
      assert.strictEqual(fake.imports, 0);
      assert.deepStrictEqual(NodeFS.readdirSync(config.attachmentsDir), []);
      assert.deepStrictEqual(
        NodeFS.readdirSync(stagingRoot(config)).toSorted(),
        [importId, "completions"].toSorted(),
      );
      // The package is gone once validated; its snapshot and attachments (by digest) are staged.
      assert.deepStrictEqual(
        NodeFS.readdirSync(NodePath.join(stagingRoot(config), importId)).toSorted(),
        ["attachments", "attempt", "conversation.json"],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("accepts each upload once, and exactly as declared", () =>
    Effect.gen(function* () {
      resetImporter();
      const staging = yield* makeStaging();
      const bytes = yield* packageBytes;
      const first = yield* upload(staging, bytes);
      assert.deepStrictEqual(first.stored, { ok: true });
      const replay = yield* staging.receiveUpload(first.claims, Stream.make(bytes));
      assert.strictEqual(replay.ok, false);
      assert.strictEqual(yield* staging.validateUploadToken(`${first.token}x`), null);

      const created = yield* staging.createUpload({
        fileName: "a.scic",
        sizeBytes: bytes.byteLength,
      });
      const token = created.relativeUrl.split("/").at(-1)!;
      const claims = (yield* staging.validateUploadToken(token))!;
      const short = yield* staging.receiveUpload(claims, Stream.make(bytes.subarray(1)));
      assert.deepStrictEqual(short.ok ? null : short.status, 400);
      assert.strictEqual(yield* reasonOf(staging.preview(created.importId)), "import-not-found");

      yield* TestClock.adjust("11 minutes");
      assert.strictEqual(yield* staging.validateUploadToken(token), null);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "removes a partial upload and releases its reservation when receiving is interrupted",
    () =>
      Effect.gen(function* () {
        resetImporter();
        const config = yield* ServerConfig.ServerConfig;
        const staging = yield* makeStaging({ quotaBytes: 16, maxLive: 1 });
        const created = yield* staging.createUpload({ fileName: "first.scic", sizeBytes: 16 });
        const claims = yield* staging.validateUploadToken(created.relativeUrl.split("/").at(-1)!);
        assert(claims !== null);
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const body = Stream.make(new Uint8Array(8)).pipe(
          Stream.concat(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(gate);
                return new Uint8Array(8);
              }),
            ),
          ),
        );
        const receiving = yield* Effect.forkChild(staging.receiveUpload(claims, body));
        yield* Deferred.await(started);
        const area = NodePath.join(stagingRoot(config), created.importId);
        assert.isTrue(NodeFS.readdirSync(area).some((name) => name.endsWith(".part")));
        yield* Fiber.interrupt(receiving);
        assert.isFalse(NodeFS.existsSync(area));
        assert.strictEqual(yield* reasonOf(staging.preview(created.importId)), "import-not-found");
        yield* staging.createUpload({ fileName: "second.scic", sizeBytes: 16 });
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("expires a stalled receive and releases its reservation", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging({ quotaBytes: 16, maxLive: 1 });
      const created = yield* staging.createUpload({ fileName: "first.scic", sizeBytes: 16 });
      const claims = yield* staging.validateUploadToken(created.relativeUrl.split("/").at(-1)!);
      assert(claims !== null);
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const body = Stream.make(new Uint8Array(8)).pipe(
        Stream.concat(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(gate);
              return new Uint8Array(8);
            }),
          ),
        ),
      );
      const receiving = yield* Effect.forkChild(staging.receiveUpload(claims, body));
      yield* Deferred.await(started);
      yield* TestClock.adjust("59 seconds");
      assert.strictEqual(receiving.pollUnsafe(), undefined);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(receiving), {
        ok: false,
        status: 408,
        detail: "The upload stopped sending data. Try again.",
      });
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), created.importId)));
      yield* staging.createUpload({ fileName: "second.scic", sizeBytes: 16 });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("ends a steady but too slow receive at a deadline scaled to its size", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const sizeBytes = 64;
      const deadlineMs = ConversationImportStaging.conversationImportUploadDeadlineMs(sizeBytes);
      assert.strictEqual(deadlineMs, 10 * 60_000 + 1_000);
      assert.isAbove(
        ConversationImportStaging.conversationImportUploadDeadlineMs(
          SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES,
        ),
        60 * 60_000,
      );
      const created = yield* staging.createUpload({ fileName: "slow.scic", sizeBytes });
      const claims = yield* staging.validateUploadToken(created.relativeUrl.split("/").at(-1)!);
      assert(claims !== null);
      // One byte every 30 seconds: never idle for a minute, never finished in time.
      const body = Stream.fromEffectRepeat(
        Effect.sleep("30 seconds").pipe(Effect.as(new Uint8Array(1))),
      );
      const receiving = yield* Effect.forkChild(staging.receiveUpload(claims, body));
      yield* TestClock.adjust(deadlineMs - 1);
      assert.strictEqual(receiving.pollUnsafe(), undefined);
      yield* TestClock.adjust(1);
      assert.deepStrictEqual(yield* Fiber.join(receiving), {
        ok: false,
        status: 408,
        detail: "The upload took too long. Try again on a faster connection.",
      });
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), created.importId)));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "holds a cancelled upload's reservation until its receive has stopped, so repeated cancels cannot exceed the quota",
    () =>
      Effect.gen(function* () {
        resetImporter();
        const config = yield* ServerConfig.ServerConfig;
        const staging = yield* makeStaging({ quotaBytes: 16 });
        for (let round = 0; round < 3; round += 1) {
          const created = yield* staging.createUpload({ fileName: "a.scic", sizeBytes: 16 });
          const claims = yield* staging.validateUploadToken(created.relativeUrl.split("/").at(-1)!);
          assert(claims !== null);
          const started = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          // The second read cannot be abandoned midway, as a socket read may not be.
          const body = Stream.make(new Uint8Array(8)).pipe(
            Stream.concat(
              Stream.fromEffect(
                Effect.uninterruptible(
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.as(new Uint8Array(8)),
                  ),
                ),
              ),
            ),
          );
          const receiving = yield* Effect.forkChild(staging.receiveUpload(claims, body));
          yield* Deferred.await(started);
          const area = NodePath.join(stagingRoot(config), created.importId);
          const cancelling = yield* Effect.forkChild(staging.cancel(created.importId));
          yield* Effect.yieldNow;
          // The bytes are still arriving: the cancel waits and the quota stays taken.
          assert.strictEqual(cancelling.pollUnsafe(), undefined);
          assert.strictEqual(
            yield* reasonOf(staging.createUpload({ fileName: "b.scic", sizeBytes: 16 })),
            "staging-full",
          );
          assert.isTrue(NodeFS.readdirSync(area).some((name) => name.endsWith(".part")));
          yield* Deferred.succeed(gate, undefined);
          assert.deepStrictEqual(yield* Fiber.join(cancelling), { _tag: "cancelled" });
          assert.isFalse(NodeFS.existsSync(area));
          assert.deepStrictEqual(yield* Fiber.join(receiving), {
            ok: false,
            status: 409,
            detail: "This import was cancelled.",
          });
          assert.strictEqual(
            yield* reasonOf(staging.preview(created.importId)),
            "import-not-found",
          );
        }
        assert.deepStrictEqual(NodeFS.readdirSync(stagingRoot(config)), ["completions"]);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  if (HostProcessPlatform.defaultValue() !== "win32") {
    it.effect("keeps an area it cannot remove yet, and its reservation, until a sweep can", () =>
      Effect.gen(function* () {
        resetImporter();
        const config = yield* ServerConfig.ServerConfig;
        const staging = yield* makeStaging({ quotaBytes: 16 });
        const created = yield* staging.createUpload({ fileName: "a.scic", sizeBytes: 16 });
        const attempt = NodePath.join(stagingRoot(config), created.importId, "attempt");
        NodeFS.writeFileSync(NodePath.join(attempt, "journal.json"), "{}");
        // Like a file still open on Windows: its folder refuses the removal.
        NodeFS.chmodSync(attempt, 0o500);
        assert.deepStrictEqual(yield* staging.cancel(created.importId), { _tag: "cancelled" });
        assert.isTrue(NodeFS.existsSync(attempt));
        assert.strictEqual(
          yield* reasonOf(staging.createUpload({ fileName: "b.scic", sizeBytes: 16 })),
          "staging-full",
        );
        NodeFS.chmodSync(attempt, 0o700);
        yield* staging.sweep;
        assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), created.importId)));
        yield* staging.createUpload({ fileName: "b.scic", sizeBytes: 16 });
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  }

  it.effect("rejects an invalid package with its reason and removes it", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const { importId } = yield* upload(staging, new TextEncoder().encode("not a zip archive"));
      const error = yield* Effect.flip(staging.preview(importId));
      assert.strictEqual(error._tag, "ScientConversationImportError");
      if (error._tag === "ScientConversationImportError") {
        assert.strictEqual(error.reason, "package-rejected");
        assert.deepStrictEqual(error.rejection, { reason: "corrupt-archive", entry: null });
        assert.strictEqual(error.message, "This file is damaged and cannot be opened.");
      }
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("tells the user in plain words why each kind of file was refused", () =>
    Effect.gen(function* () {
      resetImporter();
      const staging = yield* makeStaging();
      const files = makePackage().files;
      const { importId } = yield* upload(
        staging,
        yield* Effect.promise(() => zipBytesPromise([...files, { path: "   ", bytes: PNG }])),
      );
      const error = yield* Effect.flip(staging.preview(importId));
      assert.strictEqual(error._tag, "ScientConversationImportError");
      if (error._tag === "ScientConversationImportError") {
        assert.deepStrictEqual(error.rejection, { reason: "undeclared-entry", entry: null });
        assert.strictEqual(error.message, "This file contains content Scient did not expect.");
        // The error survives the HTTP encoding and a client's decoding.
        assert.isTrue(Exit.isSuccess(decodeImportError(yield* encodeImportError(error))));
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("enforces the per-import limit, the total quota, and the live-import limit", () =>
    Effect.gen(function* () {
      resetImporter();
      const staging = yield* makeStaging({ quotaBytes: 1_000, maxLive: 2 });
      assert.strictEqual(
        yield* reasonOf(
          staging.createUpload({
            fileName: "big.scic",
            sizeBytes: SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES + 1,
          }),
        ),
        "package-too-large",
      );
      assert.strictEqual(
        yield* reasonOf(staging.createUpload({ fileName: "a.scic", sizeBytes: 1_001 })),
        "staging-full",
      );
      const first = yield* staging.createUpload({ fileName: "a.scic", sizeBytes: 600 });
      assert.strictEqual(
        yield* reasonOf(staging.createUpload({ fileName: "b.scic", sizeBytes: 600 })),
        "staging-full",
      );
      yield* staging.createUpload({ fileName: "b.scic", sizeBytes: 400 });
      assert.strictEqual(
        yield* reasonOf(staging.createUpload({ fileName: "c.scic", sizeBytes: 1 })),
        "staging-full",
      );
      assert.deepStrictEqual(yield* staging.cancel(first.importId), { _tag: "cancelled" });
      yield* staging.createUpload({ fileName: "c.scic", sizeBytes: 600 });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "validates two uploads that fill the quota, one at a time, without counting either's expansion",
    () =>
      Effect.gen(function* () {
        resetImporter();
        const files = makePackage().files;
        const bytes = yield* Effect.promise(() => zipBytesPromise(files));
        const expandedBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
        const snapshotBytes = files.find((file) => file.path === "conversation.json")!.bytes;
        const stagedBytes = snapshotBytes.byteLength + PNG.byteLength + PDF.byteLength;
        const quotaBytes = 2 * Math.max(bytes.byteLength, stagedBytes);
        // Reserving each package's expansion would refuse the first preview.
        assert.isAbove(2 * bytes.byteLength + expandedBytes, quotaBytes);
        const staging = yield* makeStaging({ quotaBytes });
        const first = yield* upload(staging, bytes);
        const second = yield* upload(staging, bytes);
        const previews = yield* Effect.all(
          [staging.preview(first.importId), staging.preview(second.importId)],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(
          previews.map((preview) => preview.importId),
          [first.importId, second.importId],
        );
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps the upload when there is no room yet, and validates it again later", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      // A long, repetitive message: the package is small, the staged snapshot large.
      const [question, answer] = capturedSnapshot.messages;
      const files = makePackage({
        ...capturedSnapshot,
        messages: [question!, { ...answer!, text: "Here is what I found. ".repeat(10_000) }],
      }).files;
      const bytes = yield* Effect.promise(() => zipBytesPromise(files));
      const snapshotBytes = files.find((file) => file.path === "conversation.json")!.bytes;
      const stagedBytes = snapshotBytes.byteLength + PNG.byteLength + PDF.byteLength;
      assert.isBelow(2 * bytes.byteLength, stagedBytes);
      const staging = yield* makeStaging({ quotaBytes: stagedBytes + bytes.byteLength - 1 });
      const { importId } = yield* upload(staging, bytes);
      const holder = yield* staging.createUpload({
        fileName: "holder.scic",
        sizeBytes: bytes.byteLength,
      });
      assert.strictEqual(yield* reasonOf(staging.preview(importId)), "staging-full");
      // The upload is kept as it arrived; nothing validation staged is left.
      const area = NodePath.join(stagingRoot(config), importId);
      assert.deepStrictEqual(NodeFS.readdirSync(area).toSorted(), [
        "attachments",
        "attempt",
        "package.scic",
      ]);
      assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(area, "attachments")), []);
      assert.deepStrictEqual(yield* staging.cancel(holder.importId), { _tag: "cancelled" });
      const preview = yield* staging.preview(importId);
      assert.strictEqual(preview.counts.messages, 2);
      assert.isFalse(NodeFS.existsSync(NodePath.join(area, "package.scic")));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps counting a package it could not remove until a sweep removes it", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      let packageRemovable = false;
      const refusing = FileSystem.make({
        ...fs,
        remove: (path, options) =>
          !packageRemovable && path.endsWith("package.scic")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  cause: new Error("synthetic: the file is still open"),
                }),
              )
            : fs.remove(path, options),
      });
      const bytes = yield* packageBytes;
      const files = makePackage().files;
      const snapshotBytes = files.find((file) => file.path === "conversation.json")!.bytes;
      const stagedBytes = snapshotBytes.byteLength + PNG.byteLength + PDF.byteLength;
      // Room for the staged import and its package, not for another package besides.
      const quotaBytes = stagedBytes + 2 * bytes.byteLength - 1;
      const staging = yield* makeStaging({ quotaBytes }).pipe(
        Effect.provideService(FileSystem.FileSystem, refusing),
      );
      const { importId } = yield* upload(staging, bytes);
      yield* staging.preview(importId);
      const packagePath = NodePath.join(stagingRoot(config), importId, "package.scic");
      assert.isTrue(NodeFS.existsSync(packagePath));
      // The package is still on disk, so it still takes room.
      assert.strictEqual(
        yield* reasonOf(staging.createUpload({ fileName: "b.scic", sizeBytes: bytes.byteLength })),
        "staging-full",
      );
      packageRemovable = true;
      yield* staging.sweep;
      assert.isFalse(NodeFS.existsSync(packagePath));
      yield* staging.createUpload({ fileName: "b.scic", sizeBytes: bytes.byteLength });
      // The import itself stays ready.
      assert.strictEqual((yield* staging.preview(importId)).importId, importId);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  if (HostProcessPlatform.defaultValue() !== "win32" && process.getuid?.() !== 0) {
    it.effect(
      "keeps the upload when the package cannot be opened, and validates it again later",
      () =>
        Effect.gen(function* () {
          resetImporter();
          const config = yield* ServerConfig.ServerConfig;
          const staging = yield* makeStaging();
          const bytes = yield* packageBytes;
          const { importId } = yield* upload(staging, bytes);
          const packagePath = NodePath.join(stagingRoot(config), importId, "package.scic");
          // An operating-system failure (here EACCES) says nothing about the file.
          NodeFS.chmodSync(packagePath, 0o000);
          const error = yield* Effect.flip(staging.preview(importId));
          assert.strictEqual(error._tag, "ConversationImportStagingFailure");
          assert.isTrue(NodeFS.existsSync(packagePath));
          NodeFS.chmodSync(packagePath, 0o600);
          const preview = yield* staging.preview(importId);
          assert.strictEqual(preview.package.packageSha256, sha256Digest(bytes));
        }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  }

  it.effect("keeps the upload after a read error, and validates it again later", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const bytes = yield* packageBytes;
      const { importId } = yield* upload(staging, bytes);
      const attachments = NodePath.join(stagingRoot(config), importId, "attachments");
      // Staging an attachment fails: its folder is a file.
      NodeFS.rmSync(attachments, { recursive: true });
      NodeFS.writeFileSync(attachments, "not a folder");
      const error = yield* Effect.flip(staging.preview(importId));
      assert.strictEqual(error._tag, "ConversationImportStagingFailure");
      assert.isTrue(NodeFS.statSync(attachments).isDirectory());
      const preview = yield* staging.preview(importId);
      assert.strictEqual(preview.package.packageSha256, sha256Digest(bytes));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses, at preview, a conversation with more records than one import writes", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const messages = Array.from({ length: CONVERSATION_IMPORT_MAX_RECORDS + 1 }, (_, index) => ({
        n: index + 1,
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        turnId: index % 2 === 0 ? null : `turn-${index}`,
        createdAt: "2026-09-27T14:05:00.000Z",
        updatedAt: "2026-09-27T14:05:00.000Z",
        text: `Message ${index + 1}`,
        attachments: [],
        references: [],
      }));
      const long = makePackage(
        decodeSnapshot({ ...encodeSnapshot(capturedSnapshot), messages, warnings: [] }),
        new Map(),
      );
      const { importId } = yield* upload(
        staging,
        yield* Effect.promise(() => zipBytesPromise(long.files)),
      );
      const error = yield* Effect.flip(staging.preview(importId));
      assert.strictEqual(error._tag, "ScientConversationImportError");
      if (error._tag === "ScientConversationImportError") {
        assert.strictEqual(error.reason, "package-too-large");
        assert.strictEqual(
          error.message,
          "This conversation is too long to import: it has 5,001 messages and other items, and Scient imports up to 5,000 at once. Export it again without the work log, or only up to an earlier message.",
        );
      }
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses Markdown that is not UTF-8 text in plain words", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const bytes = new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]);
      const created = yield* staging.createUpload({
        fileName: "notes.md",
        sizeBytes: bytes.byteLength,
      });
      const claims = yield* staging.validateUploadToken(created.relativeUrl.split("/").at(-1)!);
      assert(claims !== null);
      assert.deepStrictEqual(yield* staging.receiveUpload(claims, Stream.make(bytes)), {
        ok: true,
      });
      const error = yield* Effect.flip(staging.preview(created.importId));
      assert.strictEqual(error._tag, "ScientConversationImportError");
      if (error._tag === "ScientConversationImportError") {
        assert.strictEqual(error.reason, "package-rejected");
        assert.strictEqual(error.message, "This Markdown file is not plain UTF-8 text.");
      }
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), created.importId)));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps a ready import's snapshot on disk and reads it back to import", () =>
    Effect.gen(function* () {
      let imported: ReadonlyArray<string> = [];
      resetImporter({
        importConversation: (lease, request) => {
          imported = lease.input.snapshot.messages.map((message) => message.text);
          return Effect.succeed(completionFor(lease, request));
        },
      });
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const first = yield* stagedImport(staging);
      const staged = NodePath.join(stagingRoot(config), first.importId, "conversation.json");
      const files = makePackage().files;
      assert.deepStrictEqual(
        new Uint8Array(NodeFS.readFileSync(staged)),
        files.find((file) => file.path === "conversation.json")!.bytes,
      );
      yield* staging.confirm(confirmRequest(first.importId, first.packageSha256), principal);
      assert.strictEqual(imported.length, 2);

      // A staged snapshot that changed after validation is never imported.
      const second = yield* stagedImport(staging);
      const tampered = NodePath.join(stagingRoot(config), second.importId, "conversation.json");
      NodeFS.writeFileSync(
        tampered,
        NodeFS.readFileSync(tampered, "utf8").replace(
          "Here is what I found.",
          "Here is a changed.",
        ),
      );
      assert.strictEqual(
        yield* reasonOf(
          staging.confirm(confirmRequest(second.importId, second.packageSha256), principal),
        ),
        "import-failed",
      );
      assert.strictEqual(fake.imports, 1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("runs validations and imports one at a time", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      resetImporter({
        importConversation: (lease, request) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(completionFor(lease, request)),
          ),
      });
      const staging = yield* makeStaging();
      const importing = yield* stagedImport(staging);
      const waiting = yield* upload(staging, yield* packageBytes);
      const confirming = yield* Effect.forkChild(
        staging.confirm(confirmRequest(importing.importId, importing.packageSha256), principal),
      );
      yield* Deferred.await(started);
      const previewing = yield* Effect.forkChild(staging.preview(waiting.importId));
      yield* Effect.yieldNow;
      yield* Effect.sleep("10 millis").pipe(TestClock.withLive);
      assert.strictEqual(previewing.pollUnsafe(), undefined);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(confirming);
      assert.strictEqual((yield* Fiber.join(previewing)).importId, waiting.importId);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("expires idle imports and uploads that never arrive", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const { importId } = yield* stagedImport(staging);
      const waiting = yield* staging.createUpload({ fileName: "later.scic", sizeBytes: 10 });

      yield* TestClock.adjust("11 minutes");
      yield* staging.sweep;
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), waiting.importId)));
      assert.isTrue(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
      // A preview keeps the import alive.
      yield* staging.preview(importId);
      yield* TestClock.adjust(CONVERSATION_IMPORT_STAGING_TTL_MS - 1);
      yield* staging.sweep;
      assert.isTrue(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
      yield* TestClock.adjust(1);
      yield* staging.sweep;
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
      assert.strictEqual(yield* reasonOf(staging.preview(importId)), "import-not-found");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("removes staged files on cancel", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const { importId } = yield* stagedImport(staging);
      assert.deepStrictEqual(yield* staging.cancel(importId), { _tag: "cancelled" });
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
      assert.strictEqual(yield* reasonOf(staging.preview(importId)), "import-not-found");
      assert.deepStrictEqual(yield* staging.cancel(importId), { _tag: "cancelled" });
      assert.strictEqual(fake.imports, 0);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("clears areas left from an earlier run at startup, settling their attempts", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const root = stagingRoot(config);
      const area = (importId: string, journal: boolean) => {
        NodeFS.mkdirSync(NodePath.join(root, importId, "attempt"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(root, importId, "attachments"), { recursive: true });
        if (journal)
          NodeFS.writeFileSync(NodePath.join(root, importId, "attempt", "journal.json"), "{}");
      };
      const idle = "cimp_00000000-0000-4000-8000-000000000001";
      const committed = "cimp_00000000-0000-4000-8000-000000000002";
      const stuck = "cimp_00000000-0000-4000-8000-000000000003";
      area(idle, false);
      area(committed, true);
      area(stuck, true);
      NodeFS.mkdirSync(NodePath.join(root, "stray"), { recursive: true });

      resetImporter({
        settleAttempt: (attempt) =>
          attempt.importId === committed
            ? Effect.succeed({
                _tag: "committed",
                completion: {
                  packageSha256: `sha256:${"a".repeat(64)}`,
                  result: {
                    importId: committed as ConversationImportId,
                    threadId: ThreadId.make("thread-imported"),
                    destination,
                    messageCount: 2,
                    attachmentCount: 0,
                  },
                  completedAt: "1970-01-01T00:00:00.000Z",
                },
              })
            : Effect.fail(
                new ConversationImportSettleError({ detail: "receipt unreadable", cause: null }),
              ),
      });
      const staging = yield* makeStaging();
      assert.deepStrictEqual(
        fake.settled.map((attempt) => [attempt.importId, attempt.reason]).toSorted(),
        [
          [committed, "startup"],
          [stuck, "startup"],
        ],
      );
      assert.deepStrictEqual(
        NodeFS.readdirSync(root).toSorted(),
        [stuck, "completions"].toSorted(),
      );
      assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(root, "completions")), [
        `${committed}.json`,
      ]);
      // The committed import answers from its durable completion.
      assert.deepStrictEqual(yield* staging.cancel(committed as ConversationImportId), {
        _tag: "already-imported",
        result: {
          importId: committed as ConversationImportId,
          threadId: ThreadId.make("thread-imported"),
          destination,
          messageCount: 2,
          attachmentCount: 0,
        },
      });
      // The unsettled attempt keeps its area until a later sweep settles it.
      fake.settleAttempt = () => Effect.succeed({ _tag: "rolled-back" });
      yield* staging.sweep;
      assert.deepStrictEqual(NodeFS.readdirSync(root), ["completions"]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("imports once and answers repeated confirms from the committed binding", () =>
    Effect.gen(function* () {
      const copies = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-copies-"));
      resetImporter({
        importConversation: (lease, request) =>
          Effect.gen(function* () {
            for (const staged of lease.input.attachments) {
              const destinationPath = NodePath.join(copies, staged.resourceId);
              yield* lease.copyAttachment({ resourceId: staged.resourceId, destinationPath });
              // Retrying a copy of the same bytes is a no-op.
              yield* lease.copyAttachment({ resourceId: staged.resourceId, destinationPath });
            }
            return completionFor(lease, request);
          }).pipe(Effect.orDie),
      });
      const staging = yield* makeStaging();
      const { importId, packageSha256 } = yield* stagedImport(staging);
      const result = yield* staging.confirm(confirmRequest(importId, packageSha256), principal);
      assert.strictEqual(result.threadId, "thread-imported");
      assert.deepStrictEqual(
        new Uint8Array(NodeFS.readFileSync(NodePath.join(copies, "attachment-1"))),
        PNG,
      );
      assert.deepStrictEqual(
        new Uint8Array(NodeFS.readFileSync(NodePath.join(copies, "attachment-2"))),
        PDF,
      );

      assert.deepStrictEqual(
        yield* staging.confirm(confirmRequest(importId, packageSha256), principal),
        result,
      );
      assert.strictEqual(fake.imports, 1);
      assert.strictEqual(
        yield* reasonOf(
          staging.confirm(confirmRequest(importId, `sha256:${"f".repeat(64)}`), principal),
        ),
        "package-changed",
      );
      assert.strictEqual(
        yield* reasonOf(
          staging.confirm(
            confirmRequest(importId, packageSha256, {
              destination: { ...destination, projectId: ProjectId.make("project-2") },
            }),
            principal,
          ),
        ),
        "already-imported",
      );
      assert.deepStrictEqual(yield* staging.cancel(importId), {
        _tag: "already-imported",
        result,
      });
      NodeFS.rmSync(copies, { recursive: true, force: true });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "answers a repeated confirm, preview, and cancel from the commit while its area is being removed and after",
    () =>
      Effect.gen(function* () {
        resetImporter();
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const removing = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let holdArea: string | null = null;
        // The area's removal after the commit waits until the test lets it go.
        const slowRemoval = FileSystem.make({
          ...fs,
          remove: (path, options) =>
            path === holdArea
              ? Deferred.succeed(removing, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(fs.remove(path, options)),
                )
              : fs.remove(path, options),
        });
        const staging = yield* makeStaging().pipe(
          Effect.provideService(FileSystem.FileSystem, slowRemoval),
        );
        const { importId, packageSha256 } = yield* stagedImport(staging);
        holdArea = NodePath.join(stagingRoot(config), importId);
        const request = confirmRequest(importId, packageSha256);
        // The first answer is lost to the client; it confirms again meanwhile.
        const first = yield* Effect.forkChild(staging.confirm(request, principal));
        yield* Deferred.await(removing);
        const retried = yield* staging.confirm(request, principal);
        assert.strictEqual(retried.importId, importId);
        assert.strictEqual(retried.threadId, "thread-imported");
        assert.deepStrictEqual(yield* staging.cancel(importId), {
          _tag: "already-imported",
          result: retried,
        });
        assert.strictEqual(yield* reasonOf(staging.preview(importId)), "already-imported");
        yield* Deferred.succeed(gate, undefined);
        assert.deepStrictEqual(yield* Fiber.join(first), retried);
        assert.isFalse(NodeFS.existsSync(holdArea));
        // After the area is gone, the completion still answers.
        assert.deepStrictEqual(yield* staging.confirm(request, principal), retried);
        assert.deepStrictEqual(yield* staging.cancel(importId), {
          _tag: "already-imported",
          result: retried,
        });
        assert.strictEqual(fake.imports, 1);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("answers from a commit it could not record yet, never as not found", () =>
    Effect.gen(function* () {
      resetImporter();
      const fs = yield* FileSystem.FileSystem;
      let recordable = false;
      // The completion record cannot be written yet: the commit is known only in memory.
      const unrecordable = FileSystem.make({
        ...fs,
        rename: (from, to) =>
          !recordable && to.includes(`${NodePath.sep}completions${NodePath.sep}`)
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "rename",
                  cause: new Error("synthetic: the disk is full"),
                }),
              )
            : fs.rename(from, to),
      });
      const staging = yield* makeStaging().pipe(
        Effect.provideService(FileSystem.FileSystem, unrecordable),
      );
      const { importId, packageSha256 } = yield* stagedImport(staging);
      const request = confirmRequest(importId, packageSha256);
      const result = yield* staging.confirm(request, principal);
      const config = yield* ServerConfig.ServerConfig;
      const record = NodePath.join(stagingRoot(config), "completions", `${importId}.json`);
      assert.isFalse(NodeFS.existsSync(record));
      assert.deepStrictEqual(yield* staging.confirm(request, principal), result);
      assert.strictEqual(yield* reasonOf(staging.preview(importId)), "already-imported");
      recordable = true;
      yield* staging.sweep;
      assert.isTrue(NodeFS.existsSync(record));
      assert.deepStrictEqual(yield* staging.confirm(request, principal), result);
      assert.deepStrictEqual(yield* staging.cancel(importId), { _tag: "already-imported", result });
      assert.strictEqual(fake.imports, 1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("answers from a commit while the sweep's retried record write is pending", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      let mode: "fail" | "hold" | "write" = "fail";
      const writing = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      // The first write of the completion record fails; the sweep's retry waits.
      const flaky = FileSystem.make({
        ...fs,
        rename: (from, to) => {
          if (!to.includes(`${NodePath.sep}completions${NodePath.sep}`)) return fs.rename(from, to);
          if (mode === "fail") {
            return Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "rename",
                cause: new Error("synthetic: the disk is full"),
              }),
            );
          }
          if (mode === "hold") {
            return Deferred.succeed(writing, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(fs.rename(from, to)),
            );
          }
          return fs.rename(from, to);
        },
      });
      const staging = yield* makeStaging().pipe(
        Effect.provideService(FileSystem.FileSystem, flaky),
      );
      const { importId, packageSha256 } = yield* stagedImport(staging);
      const request = confirmRequest(importId, packageSha256);
      const result = yield* staging.confirm(request, principal);
      const record = NodePath.join(stagingRoot(config), "completions", `${importId}.json`);
      assert.isFalse(NodeFS.existsSync(record));
      const answersAsCommitted = Effect.gen(function* () {
        assert.deepStrictEqual(yield* staging.confirm(request, principal), result);
        assert.deepStrictEqual(yield* staging.cancel(importId), {
          _tag: "already-imported",
          result,
        });
        assert.strictEqual(yield* reasonOf(staging.preview(importId)), "already-imported");
      });
      mode = "hold";
      const sweeping = yield* Effect.forkChild(staging.sweep);
      yield* Deferred.await(writing);
      // The sweep has taken the area for removal; the write has not landed.
      yield* answersAsCommitted;
      mode = "write";
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(sweeping);
      assert.isTrue(NodeFS.existsSync(record));
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
      yield* answersAsCommitted;
      assert.strictEqual(fake.imports, 1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("forgets a committed import only when its retention ends", () =>
    Effect.gen(function* () {
      resetImporter();
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const { importId, packageSha256 } = yield* stagedImport(staging);
      const request = confirmRequest(importId, packageSha256);
      const result = yield* staging.confirm(request, principal);
      yield* TestClock.adjust(CONVERSATION_IMPORT_COMPLETION_RETENTION_MS - 1);
      yield* staging.sweep;
      assert.deepStrictEqual(yield* staging.confirm(request, principal), result);
      yield* TestClock.adjust(1);
      yield* staging.sweep;
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(stagingRoot(config), "completions", `${importId}.json`)),
      );
      assert.strictEqual(yield* reasonOf(staging.confirm(request, principal)), "import-not-found");
      assert.deepStrictEqual(yield* staging.cancel(importId), { _tag: "cancelled" });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses to overwrite different bytes at a copy destination", () =>
    Effect.gen(function* () {
      const copies = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-copies-"));
      let copyError: string | null = null;
      resetImporter({
        importConversation: (lease) =>
          Effect.gen(function* () {
            const destinationPath = NodePath.join(copies, "taken");
            NodeFS.writeFileSync(destinationPath, "something else");
            const copied = yield* Effect.result(
              lease.copyAttachment({ resourceId: "attachment-1", destinationPath }),
            );
            copyError = copied._tag === "Failure" ? copied.failure.reason : null;
            return yield* new ConversationImporterError({
              reason: "import-failed",
              detail: "stop",
            });
          }),
      });
      const staging = yield* makeStaging();
      const { importId, packageSha256 } = yield* stagedImport(staging);
      yield* Effect.flip(staging.confirm(confirmRequest(importId, packageSha256), principal));
      assert.strictEqual(copyError, "destination-conflict");
      NodeFS.rmSync(copies, { recursive: true, force: true });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("resumes a failed attempt from its journal, and reports rejections", () =>
    Effect.gen(function* () {
      const directories: string[] = [];
      let calls = 0;
      resetImporter({
        importConversation: (lease, request) =>
          Effect.gen(function* () {
            calls += 1;
            directories.push(lease.attemptDirectory);
            const journal = NodePath.join(lease.attemptDirectory, "journal.json");
            if (calls === 1) {
              NodeFS.writeFileSync(journal, "{}");
              return yield* new ConversationImporterError({
                reason: "import-failed",
                detail: "The database was busy.",
              });
            }
            assert.isTrue(NodeFS.existsSync(journal));
            return completionFor(lease, request);
          }),
      });
      const staging = yield* makeStaging();
      const { importId, packageSha256 } = yield* stagedImport(staging);
      assert.strictEqual(
        yield* reasonOf(staging.confirm(confirmRequest(importId, packageSha256), principal)),
        "import-failed",
      );
      const result = yield* staging.confirm(confirmRequest(importId, packageSha256), principal);
      assert.strictEqual(result.importId, importId);
      assert.strictEqual(directories[0], directories[1]);

      for (const reason of [
        "import-rejected",
        "destination-changed",
        "project-not-found",
      ] as const) {
        resetImporter({
          importConversation: () =>
            Effect.fail(new ConversationImporterError({ reason, detail: reason })),
        });
        const staged = yield* stagedImport(staging);
        assert.strictEqual(
          yield* reasonOf(
            staging.confirm(confirmRequest(staged.importId, staged.packageSha256), principal),
          ),
          reason,
        );
        // The staged import stays, so the user can try again.
        assert.strictEqual((yield* staging.preview(staged.importId)).importId, staged.importId);
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reports honestly when this build has no importer", () =>
    Effect.gen(function* () {
      const staging = yield* makeStaging().pipe(
        Effect.provide(ConversationImporter.layerUnavailable),
      );
      const { importId, packageSha256 } = yield* stagedImport(staging);
      assert.strictEqual(
        yield* reasonOf(staging.confirm(confirmRequest(importId, packageSha256), principal)),
        "importer-unavailable",
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("cancels an import that has not committed, rolling its attempt back", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      resetImporter({
        importConversation: (lease) =>
          Effect.gen(function* () {
            NodeFS.writeFileSync(NodePath.join(lease.attemptDirectory, "journal.json"), "{}");
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
      });
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const { importId, packageSha256 } = yield* stagedImport(staging);
      const confirming = yield* Effect.forkChild(
        reasonOf(staging.confirm(confirmRequest(importId, packageSha256), principal)),
      );
      yield* Deferred.await(started);
      assert.deepStrictEqual(yield* staging.cancel(importId), { _tag: "cancelled" });
      assert.strictEqual(yield* Fiber.join(confirming), "cancelled");
      assert.deepStrictEqual(
        fake.settled.map((attempt) => attempt.reason),
        ["cancelled"],
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  if (HostProcessPlatform.defaultValue() !== "win32") {
    it.effect("waits for an interrupted attachment copy before rollback removes its journal", () =>
      Effect.gen(function* () {
        const copies = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-copy-cancel-"));
        const started = yield* Deferred.make<void>();
        const destinationPath = NodePath.join(copies, "copied.png");
        resetImporter({
          importConversation: (lease) =>
            Effect.gen(function* () {
              NodeFS.writeFileSync(NodePath.join(lease.attemptDirectory, "journal.json"), "{}");
              yield* Deferred.succeed(started, undefined);
              yield* lease.copyAttachment({ resourceId: "attachment-1", destinationPath }).pipe(
                Effect.mapError(
                  () =>
                    new ConversationImporterError({
                      reason: "import-failed",
                      detail: "The copy did not complete.",
                    }),
                ),
              );
              return yield* new ConversationImporterError({
                reason: "import-failed",
                detail: "A cancelled copy must not commit.",
              });
            }),
        });
        const config = yield* ServerConfig.ServerConfig;
        const staging = yield* makeStaging();
        const { importId, packageSha256 } = yield* stagedImport(staging);
        const staged = stagedAttachmentFile(
          NodePath.join(stagingRoot(config), importId, "attachments"),
          sha256Digest(PNG),
        );
        NodeFS.unlinkSync(staged);
        assert.strictEqual(NodeChildProcess.spawnSync("mkfifo", [staged]).status, 0);
        const confirming = yield* Effect.forkChild(
          reasonOf(staging.confirm(confirmRequest(importId, packageSha256), principal)),
        );
        yield* Deferred.await(started);
        const writer = NodeFS.createWriteStream(staged);
        writer.on("error", () => {});
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              writer.once("open", () => resolve());
              writer.once("error", reject);
            }),
        );
        writer.write(PNG.subarray(0, 8));
        assert.deepStrictEqual(yield* staging.cancel(importId), { _tag: "cancelled" });
        assert.strictEqual(yield* Fiber.join(confirming), "cancelled");
        writer.destroy();
        assert.isFalse(NodeFS.existsSync(destinationPath));
        assert.deepStrictEqual(NodeFS.readdirSync(copies), []);
        assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
        NodeFS.rmSync(copies, { recursive: true, force: true });
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  }

  it.effect("lets a commit win over a cancel that arrives after dispatch", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      resetImporter({
        importConversation: (lease, request) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            return completionFor(lease, request);
          }).pipe(Effect.uninterruptible),
      });
      const config = yield* ServerConfig.ServerConfig;
      const staging = yield* makeStaging();
      const { importId, packageSha256 } = yield* stagedImport(staging);
      const confirming = yield* Effect.forkChild(
        staging.confirm(confirmRequest(importId, packageSha256), principal),
      );
      yield* Deferred.await(started);
      const cancelling = yield* Effect.forkChild(staging.cancel(importId));
      yield* Deferred.succeed(gate, undefined);
      const cancelled = yield* Fiber.join(cancelling);
      const result = yield* Fiber.join(confirming);
      assert.deepStrictEqual(cancelled, { _tag: "already-imported", result });
      assert.isTrue(
        NodeFS.existsSync(NodePath.join(stagingRoot(config), "completions", `${importId}.json`)),
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
