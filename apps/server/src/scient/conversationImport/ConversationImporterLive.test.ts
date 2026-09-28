// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CheckpointRef,
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import {
  buildConversationDocument,
  buildConversationSnapshot,
  parseConversationMarkdown,
  writeConversationMarkdown,
} from "@scientfactory/conversation";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ScientForkContextDelivery } from "../../orchestration/scient-fork/ForkContextDelivery.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
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
  idsCoverImport,
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
  createProjects,
  importTestLayer,
  type ImportTestControls,
} from "./conversationImport.test-harness.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

const attemptDirectory = (name = "attempt") =>
  Effect.map(ServerConfig, (config) =>
    NodePath.join(config.stateDir, "conversation-imports", IMPORT_ID, name),
  );

const decodeTurnIds = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const readThread = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionSnapshotQuery, (query) =>
    query.getThreadDetailById(threadId, { fullHistory: true }),
  ).pipe(Effect.map(Option.getOrUndefined));

const threadCount = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM projection_threads`,
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

/** Every test runs against a fresh engine, database, and state directory. */
const withImporter = <A, E, R>(effect: Effect.Effect<A, E, R>, controls?: ImportTestControls) =>
  createProjects.pipe(Effect.andThen(effect), Effect.provide(importTestLayer(controls)));

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

function allMessageIds(thread: OrchestrationThread) {
  return thread.messages.map((message) => message.id);
}

describe("ConversationImporter", () => {
  it.effect("preserves omissions from an already-imported source", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture();
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...fixture.input.snapshot,
            provenance: {
              _tag: "import",
              source: "scic",
              exportId: "previous-export",
              sourceThreadId: "previous-thread",
              packageDigest: `sha256:${"a".repeat(64)}`,
              sourceFormat: "scient.conversation-file",
              sourceFormatVersion: 1,
              importedAt: "2026-09-27T10:00:00.000Z",
              omissions: [{ _tag: "range-truncated", throughMessageN: 2 }],
            },
          },
        };
        const ids = yield* mintConversationImportIds(input);
        const command = buildConversationImportCommand({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        assert.deepInclude(command.origin.omissions, {
          _tag: "range-truncated",
          throughMessageN: 2,
        });
      }),
    ),
  );

  it.effect("gives null-turn imported reasoning a retained inherited turn", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ reasoning: true });
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...fixture.input.snapshot,
            reasoning: fixture.input.snapshot.reasoning.map((item, index) =>
              index === 0 ? { ...item, turnId: null } : item,
            ),
          },
        };
        const ids = yield* mintConversationImportIds(input);
        const command = buildConversationImportCommand({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        const reasoning = command.messages.find((item) => item.role === "reasoning");
        assert.isNotNull(reasoning?.turnId ?? null);
        assert.include(command.inheritedTurnIds, reasoning!.turnId!);
      }),
    ),
  );

  it.effect("maps prototype-shaped external record ids as own ids", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ workLog: true });
        const snapshot = fixture.input.snapshot;
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...snapshot,
            proposedPlans: snapshot.proposedPlans.map((plan, index) =>
              index === 0 ? { ...plan, id: "__proto__" } : plan,
            ),
            workLog: snapshot.workLog.map((entry, index) =>
              index === 0 ? { ...entry, id: "constructor" } : entry,
            ),
          },
        };
        const ids = yield* mintConversationImportIds(input);
        assert.isTrue(Object.hasOwn(ids.proposedPlans, "__proto__"));
        assert.isTrue(Object.hasOwn(ids.workLog, "constructor"));
        assert.isTrue(idsCoverImport(ids, input));
        assert.isFalse(idsCoverImport({ ...ids, proposedPlans: {} }, input));
      }),
    ),
  );

  it.effect("imports a package as a new independent thread with fresh ids", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({
          turns: 3,
          reasoning: true,
          workLog: true,
          attachments: true,
        });
        const { lease, copied } = yield* leaseFor(fixture);
        const completion = yield* importOnce(lease);

        assert.strictEqual(completion.result.messageCount, 6);
        assert.strictEqual(completion.result.attachmentCount, 2);
        assert.strictEqual(completion.result.destination.projectId, PROJECT_ID);
        assert.strictEqual(completion.packageSha256, fixture.input.package.packageSha256);

        const thread = (yield* readThread(completion.result.threadId))!;
        assert.strictEqual(thread.projectId, PROJECT_ID);
        assert.strictEqual(thread.title, "Imported design discussion");
        assert.strictEqual(thread.modelSelection.instanceId, PROVIDER_ID);
        // 3 requests, 3 answers, 3 reasoning items; no id is an external one.
        assert.strictEqual(thread.messages.length, 9);
        const sourceIds = new Set([
          ...fixture.input.snapshot.messages.map((message) => message.id),
          ...fixture.input.snapshot.reasoning.map((reasoning) => reasoning.id),
        ]);
        for (const message of thread.messages) {
          assert.isFalse(sourceIds.has(message.id));
          assert.isNotNull(message.turnId);
          assert.isFalse(message.turnId!.startsWith("src-"));
        }
        assert.notStrictEqual(thread.id, ThreadId.make("thread-on-another-machine"));

        // Each request shares a turn with the answer it started.
        const first = thread.messages.filter((message) => message.role !== "reasoning");
        assert.strictEqual(first[0]!.turnId, first[1]!.turnId);
        assert.notStrictEqual(first[1]!.turnId, first[3]!.turnId);

        // Inline references became readable text; attachments are the published copies.
        const request = first[0]!;
        assert.notInclude(request.text, "scient-ref:");
        assert.include(request.text, "figure.png");
        assert.include(request.text, "`src/app.ts`");
        assert.deepStrictEqual(
          request.attachments?.map((attachment) => [attachment.type, attachment.name]),
          [
            ["image", "figure.png"],
            ["file", "notes.txt"],
          ],
        );
        const config = yield* ServerConfig;
        for (const attachment of request.attachments ?? []) {
          assert.isTrue(attachment.id.startsWith(thread.id.toLowerCase().slice(0, 8)));
          const path = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          })!;
          assert.isTrue(NodeFS.existsSync(path));
          assert.include(copied, path);
        }
        assert.deepStrictEqual(
          NodeFS.readFileSync(
            resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment: request.attachments![0]!,
            })!,
            "utf8",
          ),
          "figure-bytes",
        );

        // History only: the work log and the answer, nothing pending or executable.
        assert.deepStrictEqual(thread.activities.map((activity) => activity.kind).toSorted(), [
          "tool.completed",
          "tool.completed",
          "tool.completed",
          "user-input.answer-submitted",
        ]);
        assert.strictEqual(thread.proposedPlans.length, 1);
        const shell = yield* Effect.flatMap(ProjectionSnapshotQuery, (query) =>
          query.getThreadShellById(thread.id),
        );
        assert.isTrue(Option.isSome(shell));
        assert.isFalse(Option.getOrThrow(shell).hasPendingApprovals);
        assert.isFalse(Option.getOrThrow(shell).hasPendingUserInput);
        assert.strictEqual(Option.getOrThrow(shell).conversationImport?.exportId, "7f3c9a2e41b8");

        // External identity lives only in the import marker.
        assert.deepStrictEqual(thread.conversationImport, {
          source: "scic",
          exportId: "7f3c9a2e41b8",
          sourceThreadId: "thread-on-another-machine",
          packageDigest: fixture.input.package.packageSha256,
          sourceFormat: "scient.conversation-file",
          sourceFormatVersion: 1,
          importedAt: thread.conversationImport!.importedAt,
          omissions: [{ _tag: "attachments-unavailable", count: 1 }],
        });
        assert.strictEqual(thread.latestTurn?.state, "completed");

        const sql = yield* SqlClient.SqlClient;
        const [transfer] = yield* sql<{
          readonly type: string;
          readonly source_thread_id: string | null;
          readonly status: string;
          readonly inherited_turn_ids_json: string;
        }>`
          SELECT type, source_thread_id, status, inherited_turn_ids_json
          FROM scient_context_transfers WHERE thread_id = ${thread.id}
        `;
        assert.strictEqual(transfer?.type, "import");
        assert.isNull(transfer?.source_thread_id);
        assert.strictEqual(transfer?.status, "pending");
        assert.deepStrictEqual(
          new Set(decodeTurnIds(transfer!.inherited_turn_ids_json)),
          new Set<string | null>(thread.messages.map((message) => message.turnId)),
        );
        const turns = yield* sql<{
          readonly pending_message_id: string | null;
          readonly assistant_message_id: string | null;
          readonly state: string;
        }>`
          SELECT pending_message_id, assistant_message_id, state
          FROM projection_turns WHERE thread_id = ${thread.id} ORDER BY requested_at
        `;
        assert.strictEqual(turns.length, 3);
        assert.deepStrictEqual(
          turns.map((turn) => [turn.pending_message_id, turn.assistant_message_id, turn.state]),
          [0, 1, 2].map((index) => [first[2 * index]!.id, first[2 * index + 1]!.id, "completed"]),
        );
        assert.isEmpty(
          yield* sql`SELECT thread_id FROM scient_thread_lineage WHERE thread_id = ${thread.id}`,
        );

        // The journal names the exact paths this attempt owns.
        const journal = yield* journalOf(lease.attemptDirectory);
        assert.strictEqual(journal.ids.threadId, thread.id);
        assert.deepStrictEqual(
          journal.attachments.map((attachment) => attachment.path).toSorted(),
          [...copied].toSorted(),
        );
      }),
    ),
  );

  it.effect("keeps async answers folded through import, continuation, and re-export", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 1 });
        const source = fixture.input.snapshot;
        const sourceRequestId = "source-request";
        const answerText = "Blue";
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...source,
            messages: [
              source.messages[0]!,
              {
                ...source.messages[0]!,
                n: 2,
                id: MessageId.make(`async-answer:${sourceRequestId}`),
                text: answerText,
                createdAt: "2026-09-27T10:00:14.000Z",
                updatedAt: "2026-09-27T10:00:14.000Z",
              },
              { ...source.messages[1]!, n: 3 },
            ],
            questionAnswers: [
              {
                id: sourceRequestId,
                turnId: source.messages[1]!.turnId,
                createdAt: "2026-09-27T10:00:14.000Z",
                items: [{ question: "Which color?", answer: answerText, attachments: [] }],
              },
            ],
          },
        };
        const ids = yield* mintConversationImportIds(input);
        const localRequestId = ids.questionAnswers[sourceRequestId]!.requestId;
        assert.notStrictEqual(localRequestId, sourceRequestId);
        assert.strictEqual(
          ids.messages[`async-answer:${sourceRequestId}`],
          `async-answer:${localRequestId}`,
        );
        const command = buildConversationImportCommand({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        assert.strictEqual(command.messages[1]!.messageId, `async-answer:${localRequestId}`);

        const { lease } = yield* leaseFor({ ...fixture, input });
        const { result } = yield* importOnce(lease);
        const engine = yield* OrchestrationEngineService;
        const inherited = (yield* readThread(result.threadId))!;
        const importedRequestId = (
          inherited.activities.find((activity) => activity.kind === "user-input.answer-submitted")
            ?.payload as { readonly requestId: string }
        ).requestId;
        assert.notStrictEqual(importedRequestId, sourceRequestId);
        assert.include(
          inherited.messages.map((message) => message.id),
          `async-answer:${importedRequestId}`,
        );
        const continuationId = MessageId.make("async-answer-continuation-user");
        const assistantId = MessageId.make("async-answer-continuation-assistant");
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("start-async-answer-continuation"),
          threadId: result.threadId,
          message: { messageId: continuationId, role: "user", text: "Continue", attachments: [] },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: "2026-09-28T11:00:00.000Z",
        });
        const continuing = (yield* readThread(result.threadId))!;
        const current = continuing.messages.find((message) => message.id === continuationId)!;
        const delivery = yield* ScientForkContextDelivery;
        const prepared = yield* delivery.prepareTurn({
          thread: continuing,
          message: current,
          userText: current.text,
          attachments: [],
          nativeThreadKey: null,
          sessionRunning: false,
        });
        assert.strictEqual(prepared.kind, "deliver");
        if (prepared.kind === "deliver") assert.include(prepared.contextPreamble, answerText);

        const continuedTurnId = TurnId.make("async-answer-continued-turn");
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("session-async-answer-continuation"),
          threadId: result.threadId,
          session: {
            threadId: result.threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: PROVIDER_ID,
            runtimeMode: "approval-required",
            activeTurnId: continuedTurnId,
            lastError: null,
            updatedAt: "2026-09-28T11:00:01.000Z",
          },
          createdAt: "2026-09-28T11:00:01.000Z",
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("answer-async-answer-continuation"),
          threadId: result.threadId,
          messageId: assistantId,
          text: "Continued",
          turnId: continuedTurnId,
          createdAt: "2026-09-28T11:00:01.000Z",
        });
        yield* engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("complete-async-answer-continuation"),
          threadId: result.threadId,
          turnId: continuedTurnId,
          completedAt: "2026-09-28T11:00:02.000Z",
          checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${result.threadId}/turn/1`),
          status: "ready",
          files: [],
          assistantMessageId: assistantId,
          checkpointTurnCount: 1,
          createdAt: "2026-09-28T11:00:02.000Z",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("finish-async-answer-continuation"),
          threadId: result.threadId,
          session: {
            threadId: result.threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: PROVIDER_ID,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-09-28T11:00:02.000Z",
          },
          createdAt: "2026-09-28T11:00:02.000Z",
        });
        const snapshot = buildConversationSnapshot({
          thread: (yield* readThread(result.threadId))!,
          snapshotSequence: 1,
          threadSequence: 1,
          capturedAt: "2026-09-28T11:01:00.000Z",
          selection: { workLog: false, reasoning: false, throughMessageId: null },
          isAttachmentAvailable: () => false,
        });
        assert.deepStrictEqual(
          snapshot.questionAnswers.map((answer) => answer.id),
          [importedRequestId],
        );
        const document = buildConversationDocument({
          snapshot: { ...snapshot, contentDigest: `sha256:${"a".repeat(64)}` },
          exportValue: "7f3c9a2e41b8",
          timeZone: "UTC",
          resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
        });
        const markdown = writeConversationMarkdown({
          bundle: document.bundle,
          exportValue: "7f3c9a2e41b8",
          exported: "2026-09-28T11:01:00.000Z",
          packaging: "text",
        });
        const parsed = parseConversationMarkdown(markdown);
        assert.strictEqual(parsed.kind, "conversation");
        if (parsed.kind === "conversation") {
          assert.deepStrictEqual(
            parsed.messages.map((message) => message.body),
            ["Question 1", "Answer 1", "Continue", "Continued"],
          );
        }
        assert.strictEqual(markdown.split("**A:** Blue").length - 1, 1);
      }),
    ),
  );

  it.effect(
    "delivers retained history to continuation and re-delivers after a provider switch",
    () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ turns: 3, reasoning: true, workLog: true });
          const { lease } = yield* leaseFor(fixture);
          const { result } = yield* importOnce(lease);
          const engine = yield* OrchestrationEngineService;
          const delivery = yield* ScientForkContextDelivery;
          const sql = yield* SqlClient.SqlClient;
          const messageId = MessageId.make("import-continuation-user");
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("start-import-continuation"),
            threadId: result.threadId,
            message: { messageId, role: "user", text: "Continue the design", attachments: [] },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: "2026-09-28T11:00:00.000Z",
          });
          const thread = (yield* readThread(result.threadId))!;
          const current = thread.messages.find((message) => message.id === messageId)!;
          assert.isNull(thread.session);
          assert.isEmpty(
            yield* sql`SELECT thread_id FROM provider_session_runtime WHERE thread_id = ${thread.id}`,
          );

          const prepare = (nativeThreadKey: string | null, providerInstanceId: string) =>
            delivery.prepareTurn({
              thread,
              message: current,
              userText: current.text,
              attachments: [],
              nativeThreadKey,
              sessionRunning: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make(providerInstanceId),
                model: providerInstanceId === "codex" ? "gpt-5-codex" : "claude-sonnet",
              },
            });
          const initial = yield* prepare("codex@codex:local-session", "codex");
          assert.strictEqual(initial.kind, "deliver");
          if (initial.kind !== "deliver") return;
          for (const text of ["Question 1", "Answer 1", "Question 3", "Answer 3"]) {
            assert.include(initial.contextPreamble, text);
          }
          assert.notInclude(initial.contextPreamble, "Continue the design");
          assert.notInclude(initial.contextPreamble, "thread-on-another-machine");
          assert.strictEqual(initial.omittedItemCount, 0);
          yield* delivery.beginDelivery({
            threadId: thread.id,
            handoffId: initial.handoffId,
            messageId,
            nativeThreadKey: "codex@codex:local-session",
            includedItemCount: initial.includedItemCount,
            omittedItemCount: initial.omittedItemCount,
            budgetTokens: initial.budgetTokens,
            contextPreamble: initial.contextPreamble,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("session-import-continuation"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "running",
              providerName: "codex",
              providerInstanceId: PROVIDER_ID,
              runtimeMode: "approval-required",
              activeTurnId: TurnId.make("local-provider-turn"),
              lastError: null,
              updatedAt: "2026-09-28T11:00:01.000Z",
            },
            createdAt: "2026-09-28T11:00:01.000Z",
          });
          yield* delivery.settleDelivery({
            threadId: thread.id,
            handoffId: initial.handoffId,
            outcome: { type: "accepted", nativeThreadKey: "codex@codex:local-session" },
          });
          assert.strictEqual((yield* prepare("codex@codex:local-session", "codex")).kind, "none");

          const switched = yield* prepare("claude@claude:fresh-session", "claude");
          assert.strictEqual(switched.kind, "deliver");
          if (switched.kind !== "deliver") return;
          assert.isTrue(switched.requireFreshSession);
          assert.include(switched.contextPreamble, "Question 1");
          assert.include(switched.contextPreamble, "Answer 3");
          assert.notInclude(switched.contextPreamble, "codex@codex:local-session");
          assert.strictEqual(
            (yield* readThread(thread.id))!.conversationImport?.sourceThreadId,
            "thread-on-another-machine",
          );
        }),
      ),
  );

  it.effect(
    "forks an inherited imported answer after revert without losing history or provenance",
    () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ turns: 3, reasoning: true });
          const sourceOmission = { _tag: "range-truncated" as const, throughMessageN: 2 };
          const input: typeof fixture.input = {
            ...fixture.input,
            snapshot: {
              ...fixture.input.snapshot,
              provenance: {
                _tag: "import",
                source: "scic",
                exportId: "earlier-export",
                sourceThreadId: "earlier-thread",
                packageDigest: `sha256:${"a".repeat(64)}`,
                sourceFormat: "scient.conversation-file",
                sourceFormatVersion: 1,
                importedAt: "2026-09-27T09:00:00.000Z",
                omissions: [sourceOmission],
              },
            },
          };
          const { lease } = yield* leaseFor({ ...fixture, input });
          const { result } = yield* importOnce(lease);
          const engine = yield* OrchestrationEngineService;
          const sql = yield* SqlClient.SqlClient;
          const before = (yield* readThread(result.threadId))!;
          assert.deepInclude(before.conversationImport!.omissions, sourceOmission);
          const inherited = before.messages.map((message) => [message.role, message.text]);
          const inheritedTurnIds = new Set(before.messages.map((message) => message.turnId));
          const userId = MessageId.make("post-import-user");
          const assistantId = MessageId.make("post-import-assistant");
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("start-post-import-turn"),
            threadId: result.threadId,
            message: {
              messageId: userId,
              role: "user",
              text: "Temporary follow-up",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: "2026-09-28T11:00:00.000Z",
          });
          const postTurnId = TurnId.make("post-import-provider-turn");
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("session-post-import-turn"),
            threadId: result.threadId,
            session: {
              threadId: result.threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: PROVIDER_ID,
              runtimeMode: "approval-required",
              activeTurnId: postTurnId,
              lastError: null,
              updatedAt: "2026-09-28T11:00:01.000Z",
            },
            createdAt: "2026-09-28T11:00:01.000Z",
          });
          const [postTurn] = yield* sql<{ readonly turn_id: string }>`
          SELECT turn_id FROM projection_turns
          WHERE thread_id = ${result.threadId} AND pending_message_id = ${userId}
        `;
          assert.strictEqual(postTurn?.turn_id, postTurnId);
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make("complete-post-import-answer"),
            threadId: result.threadId,
            messageId: assistantId,
            text: "Temporary answer",
            turnId: postTurnId,
            createdAt: "2026-09-28T11:00:01.000Z",
          });
          yield* engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make("complete-post-import-turn"),
            threadId: result.threadId,
            turnId: postTurnId,
            completedAt: "2026-09-28T11:00:02.000Z",
            checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${result.threadId}/turn/1`),
            status: "ready",
            files: [],
            assistantMessageId: assistantId,
            checkpointTurnCount: 1,
            createdAt: "2026-09-28T11:00:02.000Z",
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("finish-post-import-turn"),
            threadId: result.threadId,
            session: {
              threadId: result.threadId,
              status: "ready",
              providerName: "codex",
              providerInstanceId: PROVIDER_ID,
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-09-28T11:00:02.000Z",
            },
            createdAt: "2026-09-28T11:00:02.000Z",
          });
          assert.include(
            (yield* readThread(result.threadId))!.messages.map((message) => message.text),
            "Temporary answer",
          );
          yield* engine.dispatch({
            type: "thread.revert.complete",
            commandId: CommandId.make("revert-post-import-turn"),
            threadId: result.threadId,
            turnCount: 0,
            createdAt: "2026-09-28T11:00:03.000Z",
          });
          const reverted = (yield* readThread(result.threadId))!;
          assert.deepStrictEqual(
            reverted.messages.map((message) => [message.role, message.text]),
            inherited,
          );
          assert.deepStrictEqual(
            new Set(reverted.messages.map((message) => message.turnId)),
            inheritedTurnIds,
          );
          assert.deepStrictEqual(reverted.conversationImport, before.conversationImport);
          assert.isEmpty(
            yield* sql`SELECT turn_id FROM projection_turns WHERE thread_id = ${result.threadId} AND turn_id = ${postTurnId}`,
          );

          const sourceAnswer = reverted.messages.find((message) => message.text === "Answer 2")!;
          const forkId = ThreadId.make("fork-of-imported-history");
          yield* engine.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("fork-inherited-imported-answer"),
            originThreadId: result.threadId,
            newThreadId: forkId,
            sourceAssistantMessageId: sourceAnswer.id,
            workspaceMode: "local",
          });
          const fork = (yield* readThread(forkId))!;
          assert.deepStrictEqual(
            fork.messages
              .filter((message) => message.role !== "reasoning")
              .map((message) => message.text),
            ["Question 1", "Answer 1", "Question 2", "Answer 2"],
          );
          assert.isUndefined(fork.conversationImport);
          assert.strictEqual(fork.forkLineage?.originThreadId, result.threadId);
          assert.deepStrictEqual(fork.forkLineage?.sourceImport, {
            source: before.conversationImport!.source,
            exportId: before.conversationImport!.exportId,
            sourceThreadId: before.conversationImport!.sourceThreadId,
            packageDigest: before.conversationImport!.packageDigest,
            sourceFormat: before.conversationImport!.sourceFormat,
            sourceFormatVersion: before.conversationImport!.sourceFormatVersion,
            importedAt: before.conversationImport!.importedAt,
            omissions: before.conversationImport!.omissions,
          });
          const forkShell = yield* Effect.flatMap(ProjectionSnapshotQuery, (query) =>
            query.getThreadShellById(forkId),
          );
          assert.deepStrictEqual(
            Option.getOrThrow(forkShell).forkLineage?.sourceImport,
            fork.forkLineage?.sourceImport,
          );
          const [lineage] = yield* sql<{ readonly inherited_turn_ids_json: string }>`
          SELECT inherited_turn_ids_json FROM scient_thread_lineage WHERE thread_id = ${forkId}
        `;
          assert.strictEqual(decodeTurnIds(lineage!.inherited_turn_ids_json).length, 2);
          const [transfer] = yield* sql<{
            readonly type: string;
            readonly source_thread_id: string | null;
            readonly origin_json: string | null;
          }>`
          SELECT type, source_thread_id, origin_json
          FROM scient_context_transfers WHERE thread_id = ${forkId}
        `;
          assert.strictEqual(transfer?.type, "fork");
          assert.strictEqual(transfer?.source_thread_id, result.threadId);
          assert.isNotNull(transfer?.origin_json);
          const delivery = yield* ScientForkContextDelivery;
          assert.isNull(
            yield* delivery.planNativeFork({ threadId: forkId, providerInstanceId: PROVIDER_ID }),
          );
          const next = {
            id: MessageId.make("fork-continuation"),
            role: "user" as const,
            text: "Continue from answer two",
            turnId: null,
            streaming: false,
            createdAt: "2026-09-28T11:00:04.000Z",
            updatedAt: "2026-09-28T11:00:04.000Z",
          };
          const context = yield* delivery.prepareTurn({
            thread: fork,
            message: next,
            userText: next.text,
            attachments: [],
            nativeThreadKey: null,
            sessionRunning: false,
          });
          assert.strictEqual(context.kind, "deliver");
          if (context.kind !== "deliver") return;
          assert.include(context.contextPreamble, "Question 1");
          assert.include(context.contextPreamble, "Answer 2");
          assert.include(context.contextPreamble, '"knownSourceOmissions"');
          assert.include(context.contextPreamble, '"range-truncated"');
          assert.notInclude(context.contextPreamble, "Answer 3");
          const snapshot = buildConversationSnapshot({
            thread: fork,
            snapshotSequence: 1,
            threadSequence: 1,
            capturedAt: "2026-09-28T11:01:00.000Z",
            selection: { workLog: false, reasoning: false, throughMessageId: null },
            isAttachmentAvailable: () => false,
          });
          assert.deepStrictEqual(snapshot.provenance, {
            _tag: "fork",
            originThreadId: result.threadId,
            sourceImport: fork.forkLineage?.sourceImport,
          });
          const document = buildConversationDocument({
            snapshot: { ...snapshot, contentDigest: `sha256:${"a".repeat(64)}` },
            exportValue: "7f3c9a2e41b8",
            timeZone: "UTC",
            resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
          });
          assert.deepInclude(document.bundle.warnings, {
            code: "source-history-incomplete",
            message:
              "An earlier transfer stopped at message 2; later source messages may be missing.",
          });
          const markdown = writeConversationMarkdown({
            bundle: document.bundle,
            exportValue: "7f3c9a2e41b8",
            exported: "2026-09-28T11:01:00.000Z",
            packaging: "text",
          });
          assert.include(markdown, "earlier transfer stopped at message 2");
          assert.include(markdown, "forked conversation with imported history (unverified)");
          const reimportInput: typeof fixture.input = {
            ...fixture.input,
            snapshot: { ...snapshot, contentDigest: `sha256:${"a".repeat(64)}` },
          };
          const reimportIds = yield* mintConversationImportIds(reimportInput);
          const reimport = buildConversationImportCommand({
            validated: reimportInput,
            ids: reimportIds,
            destination: destination(),
            importedAt: "2026-09-28T11:02:00.000Z",
          });
          assert.deepInclude(reimport.origin.omissions, sourceOmission);

          yield* engine.dispatch({
            type: "thread.fork.complete",
            commandId: CommandId.make("complete-imported-fork-provisioning"),
            threadId: forkId,
            checkpointStatus: "unavailable",
            workspaceStatus: "shared",
            createdAt: "2026-09-28T11:01:30.000Z",
          });
          const secondForkId = ThreadId.make("fork-of-imported-fork");
          const secondSource = fork.messages.find((message) => message.text === "Answer 2")!;
          yield* engine.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("fork-imported-fork"),
            originThreadId: forkId,
            newThreadId: secondForkId,
            sourceAssistantMessageId: secondSource.id,
            workspaceMode: "local",
          });
          const secondFork = (yield* readThread(secondForkId))!;
          assert.deepStrictEqual(
            secondFork.forkLineage?.sourceImport,
            fork.forkLineage?.sourceImport,
          );
          assert.isUndefined(secondFork.conversationImport);
          assert.deepStrictEqual(
            (yield* readThread(result.threadId))!.conversationImport,
            before.conversationImport,
          );
        }),
      ),
  );

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
        const engine = yield* OrchestrationEngineService;
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
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-imported"),
          threadId: completion.result.threadId,
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
          assert.include(error.detail, "deleted");
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
                ? Effect.flatMap(OrchestrationEngineService, (engine) =>
                    engine.dispatch({
                      type: "project.delete",
                      commandId: CommandId.make("delete-destination"),
                      projectId: PROJECT_ID,
                    }),
                  ).pipe(Effect.orDie, Effect.asVoid)
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
          const receipts = yield* OrchestrationCommandReceiptRepository;
          yield* receipts.upsert({
            commandId: journal.ids.commandId,
            aggregateKind: "thread",
            aggregateId: journal.ids.threadId,
            acceptedAt: "2026-09-28T10:00:01.000Z",
            resultSequence: 0,
            status: "rejected",
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
          const receipts = yield* OrchestrationCommandReceiptRepository;
          yield* receipts.upsert({
            commandId: journal.ids.commandId,
            aggregateKind: "thread",
            aggregateId: journal.ids.threadId,
            acceptedAt: "2026-09-28T10:00:01.000Z",
            resultSequence: 0,
            status: "rejected",
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
