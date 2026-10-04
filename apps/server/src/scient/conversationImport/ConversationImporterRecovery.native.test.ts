// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { EventId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ConversationImportCommit } from "./ConversationImportCommit.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import {
  ConversationImporter,
  ConversationImportStagingError,
  type ConversationImportLease,
} from "./ConversationImporter.ts";
import {
  CONVERSATION_IMPORT_JOURNAL_FILE,
  readConversationImportJournal,
  writeConversationImportJournal,
} from "./ConversationImportJournal.ts";
import {
  buildConversationImportCommand,
  mintConversationImportIds,
  plannedAttachments,
} from "./conversationImportPlan.ts";
import {
  destination,
  IMPORT_ID,
  importFixture,
  OTHER_PROJECT_ID,
  principal,
  PROJECT_ID,
  PROVIDER_ID,
  testLease,
  type ImportFixture,
} from "./conversationImport.test-fixtures.ts";
import {
  createNativeProjects as createProjects,
  nativeImportTestLayer as importTestLayer,
  deleteNativeProject,
  type NativeImportTestControls as ImportTestControls,
} from "./conversationImport.native-test-harness.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

const attemptDirectory = (name = "attempt") =>
  Effect.map(ServerConfig, (config) =>
    NodePath.join(config.stateDir, "conversation-imports", IMPORT_ID, name),
  );

const readThread = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStoreV2, (store) => store.getThreadProjection(threadId)).pipe(
    Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(undefined)),
  );

const threadCount = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`,
).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

const importRequest = (overrides: Parameters<typeof destination>[0] = {}) => ({
  destination: destination(overrides),
  principal: principal(),
});

const leaseFor = (
  fixture: ImportFixture,
  options: {
    readonly name?: string;
    readonly beforeCopy?: Parameters<typeof testLease>[0]["beforeCopy"];
  } = {},
) =>
  Effect.map(attemptDirectory(options.name), (directory) =>
    testLease({
      fixture,
      attemptDirectory: directory,
      ...(options.beforeCopy === undefined ? {} : { beforeCopy: options.beforeCopy }),
    }),
  );

/**
 * Every test runs against a fresh engine, database, and state directory, on a
 * clock set after the fixtures' history (the test clock otherwise starts in
 * 1970, which would date every fixture after the import).
 */
const withImporter = <A, E, R>(effect: Effect.Effect<A, E, R>, controls?: ImportTestControls) =>
  TestClock.setTime(Date.parse("2026-09-28T09:30:00.000Z")).pipe(
    Effect.andThen(createProjects),
    Effect.andThen(effect),
    Effect.provide(importTestLayer(controls)),
  );

const failImport = (lease: ConversationImportLease, request = importRequest()) =>
  Effect.flatMap(ConversationImporter, (importer) =>
    Effect.flip(importer.importConversation(lease, request)),
  );

const importOnce = (lease: ConversationImportLease, request = importRequest()) =>
  Effect.flatMap(ConversationImporter, (importer) => importer.importConversation(lease, request));

const settle = (directory: string, reason: "cancelled" | "expired" | "startup" = "cancelled") =>
  Effect.flatMap(ConversationImporter, (importer) =>
    importer.settleAttempt({ importId: IMPORT_ID as never, attemptDirectory: directory, reason }),
  );

const journalOf = (directory: string) =>
  readConversationImportJournal(directory).pipe(Effect.map(Option.getOrThrow));

function allMessageIds(thread: OrchestrationV2ThreadProjection) {
  return thread.messages.map((message) => message.id);
}

describe("native ConversationImporter recovery", () => {
  it.effect("flushes the journal before publishing anything", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 1, attachments: true });
        const directory = yield* attemptDirectory();
        let journalAtFirstCopy: boolean | null = null;
        const { lease } = testLease({
          fixture,
          attemptDirectory: directory,
          beforeCopy: () =>
            Effect.sync(() => {
              journalAtFirstCopy ??= NodeFS.existsSync(
                NodePath.join(directory, CONVERSATION_IMPORT_JOURNAL_FILE),
              );
            }),
        });
        yield* importOnce(lease);
        assert.isTrue(journalAtFirstCopy);
      }),
    ),
  );

  it.effect(
    "retrying one attempt is idempotent; importing the file again makes a second thread",
    () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ attachments: true });
          const { lease } = yield* leaseFor(fixture);
          const first = yield* importOnce(lease);
          const retried = yield* importOnce(lease);
          assert.deepStrictEqual(retried, first);
          assert.strictEqual(yield* threadCount, 1);

          const { lease: second } = yield* leaseFor(fixture, { name: "second-attempt" });
          const again = yield* importOnce(second);
          assert.notStrictEqual(again.result.threadId, first.result.threadId);
          assert.strictEqual(yield* threadCount, 2);
          const [left, right] = [
            (yield* readThread(first.result.threadId))!,
            (yield* readThread(again.result.threadId))!,
          ];
          const shared = allMessageIds(left).filter((id) => allMessageIds(right).includes(id));
          assert.isEmpty(shared);
        }),
      ),
  );

  it.effect("resumes an attempt that failed during publication with the same ids", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ attachments: true });
        let failures = 1;
        const { lease, copied } = yield* leaseFor(fixture, {
          beforeCopy: (resourceId) =>
            resourceId === "attachment-2" && failures-- > 0
              ? Effect.fail(
                  new ConversationImportStagingError({ reason: "io-failed", detail: "disk full" }),
                )
              : Effect.void,
        });
        const error = yield* failImport(lease);
        assert.strictEqual(error.reason, "import-failed");
        assert.strictEqual(copied.length, 1);
        assert.strictEqual(yield* threadCount, 0);
        const journal = yield* journalOf(lease.attemptDirectory);

        const completion = yield* importOnce(lease);
        assert.strictEqual(completion.result.threadId, journal.ids.threadId);
        assert.strictEqual(copied.length, 2);
        assert.strictEqual(yield* threadCount, 1);
      }),
    ),
  );

  it.effect(
    "an interrupted import leaves only journal-listed files, and cancel rolls them back",
    () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ attachments: true });
          const reached = yield* Deferred.make<void>();
          const { lease, copied } = yield* leaseFor(fixture, {
            beforeCopy: (resourceId) =>
              resourceId === "attachment-2"
                ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
          });
          const fiber = yield* Effect.forkChild(importOnce(lease));
          yield* Deferred.await(reached);
          yield* Fiber.interrupt(fiber);
          assert.strictEqual(copied.length, 1);
          const journal = yield* journalOf(lease.attemptDirectory);
          assert.include(
            journal.attachments.map((attachment) => attachment.path),
            copied[0],
          );

          const settled = yield* settle(lease.attemptDirectory);
          assert.deepStrictEqual(settled, { _tag: "rolled-back" });
          assert.isFalse(NodeFS.existsSync(copied[0]!));
          assert.isEmpty(NodeFS.readdirSync(lease.attemptDirectory));
          assert.strictEqual(yield* threadCount, 0);
        }),
      ),
  );

  it.effect("finds a commit made before a crash instead of repeating it", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ attachments: true });
        const { lease } = yield* leaseFor(fixture);
        // The first dispatch never reaches the engine.
        const error = yield* failImport(lease);
        assert.strictEqual(error.reason, "import-failed");
        const journal = yield* journalOf(lease.attemptDirectory);

        // The same command commits, as if the process stopped before reporting it.
        const engine = yield* ConversationImportCommit;
        yield* engine.dispatch(
          buildConversationImportCommand({
            validated: fixture.input,
            ids: journal.ids,
            destination: journal.binding.destination,
            importedAt: journal.importedAt,
          }),
        );

        const settled = yield* settle(lease.attemptDirectory, "startup");
        assert.strictEqual(settled._tag, "committed");
        assert.strictEqual(
          settled._tag === "committed" ? settled.completion.result.threadId : null,
          journal.ids.threadId,
        );
        for (const attachment of journal.attachments) {
          assert.isTrue(NodeFS.existsSync(attachment.path));
        }
        const completion = yield* importOnce(lease);
        assert.strictEqual(completion.result.threadId, journal.ids.threadId);
        assert.strictEqual(yield* threadCount, 1);
      }),
      {
        dispatch: (() => {
          let calls = 0;
          return (command, engine) =>
            calls++ === 0
              ? Effect.die(new Error("The server stopped before the dispatch."))
              : engine.dispatch(command);
        })(),
      },
    ),
  );

  it.effect("reports a commit whose acknowledgement failed", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ attachments: true });
        const { lease } = yield* leaseFor(fixture);
        const completion = yield* importOnce(lease);
        assert.strictEqual(yield* threadCount, 1);
        assert.isDefined(yield* readThread(completion.result.threadId));
      }),
      {
        dispatch: (command, engine) =>
          engine.dispatch(command).pipe(Effect.andThen(Effect.die(new Error("reply lost")))),
      },
    ),
  );

  it.effect("never removes committed attachments, even after the thread was deleted", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ attachments: true });
        const { lease } = yield* leaseFor(fixture);
        const completion = yield* importOnce(lease);
        const journal = yield* journalOf(lease.attemptDirectory);
        const projection = yield* (yield* ProjectionStoreV2).getThread(completion.result.threadId);
        yield* (yield* EventSinkV2).write({
          events: [
            {
              id: EventId.make("native-delete-imported"),
              type: "thread.deleted",
              threadId: completion.result.threadId,
              occurredAt: yield* DateTime.now,
              payload: { ...projection, deletedAt: yield* DateTime.now },
            },
          ],
        });
        const present = journal.attachments.map((attachment) => NodeFS.existsSync(attachment.path));
        const settled = yield* settle(lease.attemptDirectory, "expired");
        assert.strictEqual(settled._tag, "committed");
        // Settling a committed attempt removes nothing (staging then removes its area).
        assert.deepStrictEqual(
          journal.attachments.map((attachment) => NodeFS.existsSync(attachment.path)),
          present,
        );
        assert.isTrue(
          NodeFS.existsSync(
            NodePath.join(lease.attemptDirectory, CONVERSATION_IMPORT_JOURNAL_FILE),
          ),
        );
      }),
    ),
  );

  it.effect(
    "a rejected command removes exactly its files; confirming again starts a new attempt",
    () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ attachments: true });
          const { lease, copied } = yield* leaseFor(fixture);
          const config = yield* ServerConfig;
          NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
          const bystander = NodePath.join(config.attachmentsDir, "other-thread-file.png");
          NodeFS.writeFileSync(bystander, "unrelated");

          const error = yield* failImport(lease);
          assert.strictEqual(error.reason, "import-rejected");
          assert.include(error.detail, "no longer exists");
          assert.strictEqual(copied.length, 2);
          for (const path of copied) assert.isFalse(NodeFS.existsSync(path));
          assert.isTrue(NodeFS.existsSync(bystander));
          assert.isEmpty(NodeFS.readdirSync(lease.attemptDirectory));
          assert.strictEqual(yield* threadCount, 0);

          const completion = yield* importOnce(
            lease,
            importRequest({ projectId: OTHER_PROJECT_ID }),
          );
          assert.strictEqual(completion.result.destination.projectId, OTHER_PROJECT_ID);
          assert.strictEqual(yield* threadCount, 1);
        }),
        {
          // The destination disappears between the authority check and the commit.
          beforeDispatch: (() => {
            let calls = 0;
            return (command) =>
              command.type === "thread.conversation.import" && calls++ === 0
                ? deleteNativeProject
                : Effect.void;
          })(),
        },
      ),
  );

  describe("settling by receipt", () => {
    /** A journaled attempt whose files are published, as a crash would leave it. */
    const journaledAttempt = (fixture: ImportFixture) =>
      Effect.gen(function* () {
        const directory = yield* attemptDirectory();
        NodeFS.mkdirSync(directory, { recursive: true });
        const config = yield* ServerConfig;
        const ids = yield* mintConversationImportIds(fixture.input);
        const attachments = plannedAttachments(fixture.input, ids).map(
          ({ resourceId, attachment }) => ({
            resourceId,
            attachmentId: attachment.id,
            path: resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
          }),
        );
        NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
        for (const attachment of attachments) NodeFS.writeFileSync(attachment.path, "bytes");
        const journal = {
          version: 1 as const,
          importId: fixture.input.importId,
          attemptId: "attempt-1",
          binding: {
            packageSha256: fixture.input.package.packageSha256,
            destination: destination(),
          },
          package: {
            exportId: fixture.input.package.exportId,
            contentDigest: fixture.input.package.contentDigest,
          },
          ids,
          attachments,
          messageCount: fixture.input.snapshot.messages.length,
          attachmentCount: attachments.length,
          importedAt: "2026-09-28T10:00:00.000Z",
        };
        yield* writeConversationImportJournal(directory, journal);
        return { directory, journal };
      });

    it.effect("rejected receipt: removes the attempt's files and reports the refusal", () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ attachments: true });
          const { directory, journal } = yield* journaledAttempt(fixture);
          yield* (yield* EventSinkV2).commitRejectedCommand({
            commandId: journal.ids.commandId,
            commandType: "thread.conversation.import",
            threadId: journal.ids.threadId,
            rejectedAt: DateTime.makeUnsafe("2026-09-28T10:00:01.000Z"),
            error: "Project was deleted.",
          });
          const settled = yield* settle(directory);
          assert.deepStrictEqual(settled, { _tag: "rejected", detail: "Project was deleted." });
          for (const attachment of journal.attachments) {
            assert.isFalse(NodeFS.existsSync(attachment.path));
          }
          assert.isEmpty(NodeFS.readdirSync(directory));
        }),
      ),
    );

    it.effect("rejected receipt found on confirm: the old attempt ends and a new one commits", () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ attachments: true });
          const { directory, journal } = yield* journaledAttempt(fixture);
          yield* (yield* EventSinkV2).commitRejectedCommand({
            commandId: journal.ids.commandId,
            commandType: "thread.conversation.import",
            threadId: journal.ids.threadId,
            rejectedAt: DateTime.makeUnsafe("2026-09-28T10:00:01.000Z"),
            error: "Refused.",
          });
          const { lease } = testLease({ fixture, attemptDirectory: directory });
          const completion = yield* importOnce(lease);
          assert.notStrictEqual(completion.result.threadId, journal.ids.threadId);
          for (const attachment of journal.attachments) {
            assert.isFalse(NodeFS.existsSync(attachment.path));
          }
        }),
      ),
    );

    it.effect("absent receipt: rolls back exactly the journal-listed files inside the store", () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ attachments: true });
          const { directory, journal } = yield* journaledAttempt(fixture);
          const outside = NodePath.join(directory, "..", "outside.png");
          NodeFS.writeFileSync(outside, "keep");
          yield* writeConversationImportJournal(directory, {
            ...journal,
            attachments: [
              ...journal.attachments,
              { resourceId: "attachment-9", attachmentId: "x", path: outside },
            ],
          });
          const settled = yield* settle(directory, "expired");
          assert.deepStrictEqual(settled, { _tag: "rolled-back" });
          for (const attachment of journal.attachments) {
            assert.isFalse(NodeFS.existsSync(attachment.path));
          }
          assert.isTrue(NodeFS.existsSync(outside));
          assert.isEmpty(NodeFS.readdirSync(directory));
        }),
      ),
    );

    it.effect("an interrupted journal write settles as nothing published", () =>
      withImporter(
        Effect.gen(function* () {
          const directory = yield* attemptDirectory();
          NodeFS.mkdirSync(NodePath.join(directory, "journal.json.tmp"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(directory, "journal.json.tmp", "contents.tmp"), "{");
          const settled = yield* settle(directory, "startup");
          assert.deepStrictEqual(settled, { _tag: "rolled-back" });
          assert.isEmpty(NodeFS.readdirSync(directory));
        }),
      ),
    );
  });

  it.effect("cleanup never runs while the attempt's commit is in flight", () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    return withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ attachments: true });
        const { lease } = yield* leaseFor(fixture);
        const importing = yield* Effect.forkChild(importOnce(lease));
        yield* Deferred.await(entered);
        const settling = yield* Effect.forkChild(settle(lease.attemptDirectory));
        yield* Effect.yieldNow;
        assert.isUndefined(settling.pollUnsafe());
        yield* Deferred.succeed(release, undefined);
        const completion = yield* Fiber.join(importing);
        const settled = yield* Fiber.join(settling);
        assert.strictEqual(settled._tag, "committed");
        const journal = yield* journalOf(lease.attemptDirectory);
        for (const attachment of journal.attachments) {
          assert.isTrue(NodeFS.existsSync(attachment.path));
        }
        assert.strictEqual(yield* threadCount, 1);
        assert.strictEqual(
          settled._tag === "committed" ? settled.completion.result.threadId : null,
          completion.result.threadId,
        );
      }),
      {
        beforeDispatch: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      },
    );
  });

  it.effect("a kept attempt is never re-targeted to another destination", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ attachments: true });
        const { lease } = yield* leaseFor(fixture);
        assert.strictEqual((yield* failImport(lease)).reason, "import-failed");
        const journal = yield* journalOf(lease.attemptDirectory);

        const error = yield* failImport(lease, importRequest({ projectId: OTHER_PROJECT_ID }));
        assert.strictEqual(error.reason, "destination-changed");
        assert.deepStrictEqual(yield* journalOf(lease.attemptDirectory), journal);

        const completion = yield* importOnce(lease);
        assert.strictEqual(completion.result.threadId, journal.ids.threadId);
        assert.strictEqual(completion.result.destination.projectId, PROJECT_ID);
        // A committed import reports its own destination to any later confirm.
        const repeated = yield* importOnce(lease, importRequest({ projectId: OTHER_PROJECT_ID }));
        assert.strictEqual(repeated.result.destination.projectId, PROJECT_ID);
      }),
      {
        dispatch: (() => {
          let calls = 0;
          return (command, engine) =>
            calls++ === 0 ? Effect.die(new Error("dispatch lost")) : engine.dispatch(command);
        })(),
      },
    ),
  );

  describe("destination authority", () => {
    it.effect("refuses a missing project and journals nothing", () =>
      withImporter(
        Effect.gen(function* () {
          const { lease } = yield* leaseFor(importFixture());
          const error = yield* failImport(
            lease,
            importRequest({ projectId: PROJECT_ID.replace("import", "missing") as never }),
          );
          assert.strictEqual(error.reason, "project-not-found");
          assert.isEmpty(NodeFS.readdirSync(lease.attemptDirectory));
        }),
      ),
    );

    it.effect("refuses a project still being cloned", () =>
      withImporter(
        Effect.gen(function* () {
          const { lease } = yield* leaseFor(importFixture());
          const error = yield* failImport(lease);
          assert.strictEqual(error.reason, "project-not-found");
          assert.include(error.detail, "cloned");
        }),
        { clones: new Map([[PROJECT_ID, "running"]]) },
      ),
    );

    it.effect("refuses a provider that is off or not configured", () =>
      withImporter(
        Effect.gen(function* () {
          const { lease } = yield* leaseFor(importFixture());
          assert.strictEqual((yield* failImport(lease)).reason, "provider-unavailable");
          const other = importRequest({
            modelSelection: { instanceId: "claude" as never, model: "claude-opus" },
          });
          assert.strictEqual((yield* failImport(lease, other)).reason, "provider-unavailable");
          assert.strictEqual(yield* threadCount, 0);
        }),
        { providers: new Map([[PROVIDER_ID, false]]) },
      ),
    );

    it.effect("rechecks the operate scope with the confirm's principal", () =>
      withImporter(
        Effect.gen(function* () {
          const { lease } = yield* leaseFor(importFixture());
          const importer = yield* ConversationImporter;
          const exit = yield* Effect.exit(
            importer.importConversation(lease, {
              destination: destination(),
              principal: principal(["orchestration:read"]),
            }),
          );
          assert.isTrue(Exit.isFailure(exit));
          assert.isEmpty(NodeFS.readdirSync(lease.attemptDirectory));
          assert.strictEqual(yield* threadCount, 0);
        }),
      ),
    );
  });
});
