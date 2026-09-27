// @effect-diagnostics nodeBuiltinImport:off -- the tests inspect staging areas and copied files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  ProjectId,
  ProviderInstanceId,
  SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES,
  ThreadId,
  type ConversationImportDestination,
  type ConversationImportId,
  type EnvironmentSessionPrincipalShape,
  type ScientConversationImportConfirmRequest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { PDF, PNG, makePackage, zipBytesPromise } from "../conversationFile/scic.test-fixtures.ts";
import { sha256Digest } from "../conversationFile/ScicWriter.ts";
import {
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

const reasonOf = <A, R>(effect: Effect.Effect<A, { readonly _tag: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) =>
      "reason" in error ? (error as { readonly reason: string }).reason : error._tag,
    ),
  );

describe("ConversationImportStaging", () => {
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
      // The package is gone once validated; its attachments are staged by digest.
      assert.deepStrictEqual(
        NodeFS.readdirSync(NodePath.join(stagingRoot(config), importId)).toSorted(),
        ["attachments", "attempt"],
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
      }
      assert.isFalse(NodeFS.existsSync(NodePath.join(stagingRoot(config), importId)));
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
