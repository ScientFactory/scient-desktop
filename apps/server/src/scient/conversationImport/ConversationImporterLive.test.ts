// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  EventId,
  TurnItemId,
  type ThreadForkCommand,
  type OrchestrationV2DomainEvent,
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildConversationDocument,
  buildConversationSnapshot,
  parseConversationMarkdown,
  writeConversationMarkdown,
} from "@scientfactory/conversation";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import { handoffBudget } from "@t3tools/provider-core/server/handoffBudget";
import { makeScientContextHandoffPolicy } from "../../orchestration-v2/ScientContextHandoffPolicy.ts";
import { deliverContextHandoffs } from "../../orchestration-v2/ContextHandoffDelivery.ts";
import { ConversationForkService } from "../../orchestration-v2/scient-fork/ConversationForkService.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { conversationSnapshotProjection } from "../conversationExport/conversationSnapshotProjection.ts";

import { ConversationImporter, type ConversationImportLease } from "./ConversationImporter.ts";
import { readConversationImportJournal } from "./ConversationImportJournal.ts";
import {
  buildConversationImportCommand,
  mintConversationImportIds,
} from "./conversationImportPlan.ts";
import {
  destination,
  IMPORT_ID,
  importFixture,
  principal,
  testLease,
  type ImportFixture,
} from "./conversationImport.test-fixtures.ts";
import { createProjects, importHistoryTestLayer } from "./conversationImport.test-harness.ts";

const attemptDirectory = (name = "attempt") =>
  Effect.map(ServerConfig, (config) =>
    NodePath.join(config.stateDir, "conversation-imports", IMPORT_ID, name),
  );

const readProjection = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (query) => query.getThreadProjection(threadId));

const readThread = (threadId: ThreadId) =>
  readProjection(threadId).pipe(
    Effect.map((projection) => conversationSnapshotProjection(projection, null)),
  );

/** Admit through the real orchestrator; the fixture never starts the effect worker. */
const continueHistory = Effect.fn("ImportTest.continueHistory")(function* (
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: string,
  at: string,
) {
  yield* TestClock.setTime(Date.parse(at));
  yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "message.dispatch",
    commandId,
    threadId,
    messageId,
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
  });
});

/** Render actual committed handoffs, recording pending/accepted delivery through EventSink. */
const prepareHistory = Effect.fn("ImportTest.prepareHistory")(function* (threadId: ThreadId) {
  const projection = yield* readProjection(threadId);
  const run = projection.runs.at(-1)!;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  )!;
  const sink = yield* EventSink.EventSinkV2;
  const current = projection.messages.find(
    (message) => message.runId === run.id && message.role === "user",
  )!;
  const policy = yield* yield* makeScientContextHandoffPolicy();
  const budget = handoffBudget({
    ...policy,
    providerThread,
    userText: current.text,
    attachments: current.attachments,
    nativeContextEstimate: 0,
  });
  return yield* deliverContextHandoffs({
    handoffs: projection.contextHandoffs,
    providerThread,
    budget,
    alreadyDeliveredItemIds: new Set(),
    resolveHistory: (yield* ProjectionStore.ProjectionStoreV2).resolveContextHistory,
    sourceOmissions:
      projection.thread.conversationImport?.omissions ??
      projection.thread.forkLineage?.sourceImport?.omissions ??
      [],
    importedMaterial: "conversation",
    persist: (handoff) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`${handoff.id}:${yield* sink.latestSequence()}`),
              type: "context-handoff.updated",
              threadId,
              occurredAt: now,
              payload: handoff,
            },
          ],
        });
      }).pipe(Effect.orDie),
  });
});

/** A controlled local provider identity, persisted on the actual owned native thread. */
const bindHistoryIdentity = Effect.fn("ImportTest.bindHistoryIdentity")(function* (
  threadId: ThreadId,
  nativeId: string,
) {
  const projection = yield* readProjection(threadId);
  const run = projection.runs.at(-1)!;
  const thread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  )!;
  const now = yield* DateTime.now;
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make(`${thread.id}:${nativeId}`),
        threadId,
        occurredAt: now,
        type: "provider-thread.updated",
        payload: {
          ...thread,
          nativeThreadRef: { driver: thread.driver, nativeId, strength: "strong" },
          updatedAt: now,
        },
      },
    ],
  });
  return thread.id;
});

/** Controlled journal-history producer: write terminal events, never fabricated query results. */
const finishHistory = Effect.fn("ImportTest.finishHistory")(function* (
  threadId: ThreadId,
  at: string,
  answer?: { readonly id: MessageId; readonly text: string },
) {
  yield* TestClock.setTime(Date.parse(at));
  const projection = yield* readProjection(threadId);
  const run = projection.runs.at(-1)!;
  const root = projection.nodes.find((node) => node.id === run.rootNodeId)!;
  const now = yield* DateTime.now;
  const events: OrchestrationV2DomainEvent[] = [];
  if (answer !== undefined) {
    events.push(
      {
        id: EventId.make(`${answer.id}:message`),
        threadId,
        occurredAt: now,
        type: "message.updated",
        payload: {
          id: answer.id,
          threadId,
          runId: run.id,
          nodeId: root.id,
          role: "assistant",
          createdBy: "agent",
          creationSource: "server",
          text: answer.text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`${answer.id}:item`),
        threadId,
        occurredAt: now,
        type: "turn-item.updated",
        payload: {
          id: TurnItemId.make(`${answer.id}:item`),
          threadId,
          runId: run.id,
          nodeId: root.id,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: run.ordinal * 100 + 1,
          title: null,
          type: "assistant_message",
          messageId: answer.id,
          text: answer.text,
          streaming: false,
          status: "completed",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      },
    );
  }
  events.push(
    {
      id: EventId.make(`${run.id}:finished`),
      threadId,
      occurredAt: now,
      type: "run.updated",
      payload: { ...run, status: "completed", completedAt: now },
    },
    {
      id: EventId.make(`${root.id}:finished`),
      threadId,
      occurredAt: now,
      type: "node.updated",
      payload: { ...root, status: "completed", completedAt: now },
    },
  );
  yield* (yield* EventSink.EventSinkV2).write({ events });
});

/** Observe the native creation receipt before invoking the production provisioner. */
const forkHistory = Effect.fn("ImportTest.forkHistory")(function* (command: ThreadForkCommand) {
  const sink = yield* EventSink.EventSinkV2;
  const pull = yield* Stream.toPull(
    sink.stream({
      threadId: command.newThreadId,
      eventType: "thread.created",
      afterSequence: 0,
    }),
  );
  const forks = yield* ConversationForkService;
  const waiting = yield* forks.dispatch(command).pipe(Effect.forkChild);
  yield* pull;
  yield* forks.provision(command.newThreadId, false);
  yield* Fiber.join(waiting);
});

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

const withNativeImporter = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(Date.parse("2026-09-28T09:30:00.000Z")).pipe(
    Effect.andThen(createProjects),
    Effect.andThen(effect),
    Effect.provide(importHistoryTestLayer()),
  );

const importOnce = (lease: ConversationImportLease, request = importRequest()) =>
  Effect.flatMap(ConversationImporter, (importer) => importer.importConversation(lease, request));

const journalOf = (directory: string) =>
  readConversationImportJournal(directory).pipe(Effect.map(Option.getOrThrow));

describe("ConversationImporter", () => {
  it.effect(
    "keeps history dated after this server's clock as an inherited prefix, with a note",
    () =>
      withNativeImporter(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-09-28T10:00:00.000Z"));
          // The sender's clock ran a day and a little ahead of this server's.
          const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
          const ahead = (iso: string) => isoAt(Date.parse(iso) + 2 * 24 * 60 * 60_000);
          const fixture = importFixture({ turns: 3, reasoning: true, workLog: true });
          const source = fixture.input.snapshot;
          const input: typeof fixture.input = {
            ...fixture.input,
            snapshot: {
              ...source,
              messages: source.messages.map((message) => ({
                ...message,
                createdAt: ahead(message.createdAt),
                updatedAt: ahead(message.updatedAt),
              })),
              reasoning: source.reasoning.map((reasoning) => ({
                ...reasoning,
                createdAt: ahead(reasoning.createdAt),
                updatedAt: ahead(reasoning.updatedAt),
              })),
              workLog: source.workLog.map((entry) => ({
                ...entry,
                createdAt: ahead(entry.createdAt),
              })),
              proposedPlans: source.proposedPlans.map((plan) => ({
                ...plan,
                createdAt: ahead(plan.createdAt),
                updatedAt: ahead(plan.updatedAt),
              })),
            },
          };
          const { lease } = yield* leaseFor({ ...fixture, input });
          const { result } = yield* importOnce(lease);
          const imported = (yield* readThread(result.threadId))!;
          // Moved back together by how far the latest time was ahead: no
          // imported time is later than the import, and spacing is kept.
          const latest = "2026-09-29T10:00:36.000Z";
          const shift = Date.parse(latest) - Date.parse("2026-09-28T10:00:00.000Z");
          assert.strictEqual(imported.conversationImport?.timesShiftedMs, shift);
          assert.deepStrictEqual(
            imported.messages.map((message) => message.createdAt).toSorted(),
            [...input.snapshot.messages, ...input.snapshot.reasoning]
              .map((record) => isoAt(Date.parse(record.createdAt) - shift))
              .toSorted(),
          );
          for (const time of [
            ...imported.messages.flatMap((message) => [message.createdAt, message.updatedAt]),
            ...imported.activities.map((activity) => activity.createdAt),
            ...imported.proposedPlans.flatMap((plan) => [plan.createdAt, plan.updatedAt]),
          ]) {
            assert.isAtMost(Date.parse(time), Date.parse(imported.conversationImport!.importedAt));
          }

          // A message sent after the import shows after all of it, and the
          // agent receives all of it.
          const messageId = MessageId.make("after-skewed-import");
          yield* continueHistory(
            result.threadId,
            messageId,
            CommandId.make("start-after-skewed-import"),
            "Carry on",
            "2026-09-28T10:05:00.000Z",
          );
          const thread = (yield* readThread(result.threadId))!;
          assert.strictEqual(thread.messages.at(-1)?.id, messageId);
          const prepared = yield* prepareHistory(result.threadId);
          assert.isNotEmpty(prepared.context);

          assert.strictEqual(
            (yield* readProjection(result.threadId)).contextHandoffs.at(-1)!.history!.omittedItems,
            0,
          );
          for (const text of ["Question 1", "Answer 3", "Thinking about 3", "ok 3", "Ship it"]) {
            assert.include(prepared.context, text);
          }

          // Exporting again keeps the note; a later import adds its own move.
          const exported = buildConversationSnapshot({
            thread,
            snapshotSequence: 1,
            threadSequence: 1,
            capturedAt: "2026-09-28T10:06:00.000Z",
            selection: { workLog: true, reasoning: true, throughMessageId: null },
            isAttachmentAvailable: () => false,
          });
          assert.strictEqual(
            exported.provenance._tag === "import" ? exported.provenance.timesShiftedMs : null,
            shift,
          );
          const { ids } = yield* journalOf(lease.attemptDirectory);
          const reimport = (importedAt: string) =>
            buildConversationImportCommand({
              validated: {
                ...input,
                snapshot: { ...input.snapshot, provenance: exported.provenance },
              },
              ids,
              destination: destination(),
              importedAt,
            }).origin.timesShiftedMs;
          assert.strictEqual(reimport("2027-01-01T00:00:00.000Z"), shift);
          assert.strictEqual(reimport("2026-09-29T10:00:00.000Z"), shift + 36_000);
        }),
      ),
  );

  it.effect("keeps async answers folded through import, continuation, and re-export", () =>
    withNativeImporter(
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
        const localMessageId = ids.messages[`async-answer:${sourceRequestId}`]!;
        assert.isFalse(localMessageId.startsWith("async-answer:"));
        const command = buildConversationImportCommand({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        assert.strictEqual(command.messages[1]!.messageId, localMessageId);
        // The answer names the message it folds.
        assert.strictEqual(
          (
            command.activities.find((activity) => activity.kind === "user-input.answer-submitted")!
              .payload as { readonly messageId?: string }
          ).messageId,
          localMessageId,
        );

        const { lease } = yield* leaseFor({ ...fixture, input });
        const { result } = yield* importOnce(lease);
        const inherited = (yield* readThread(result.threadId))!;
        const importedAnswer = inherited.activities.find(
          (activity) => activity.kind === "user-input.answer-submitted",
        )!.payload as { readonly requestId: string; readonly messageId: string };
        const importedRequestId = importedAnswer.requestId;
        assert.notStrictEqual(importedRequestId, sourceRequestId);
        assert.include(
          inherited.messages.map((message) => message.id),
          importedAnswer.messageId,
        );
        const continuationId = MessageId.make("async-answer-continuation-user");
        const assistantId = MessageId.make("async-answer-continuation-assistant");
        yield* continueHistory(
          result.threadId,
          continuationId,
          CommandId.make("start-async-answer-continuation"),
          "Continue",
          "2026-09-28T11:00:00.000Z",
        );
        const prepared = yield* prepareHistory(result.threadId);
        assert.isNotEmpty(prepared.context);
        assert.include(prepared.context, answerText);
        yield* finishHistory(result.threadId, "2026-09-28T11:00:02.000Z", {
          id: assistantId,
          text: "Continued",
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
    "keeps a folded answer after an ordinary message at the same time, and keeps it folded",
    () =>
      withNativeImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ turns: 1 });
          const source = fixture.input.snapshot;
          const tied = "2026-09-27T10:00:14.000Z";
          const input: typeof fixture.input = {
            ...fixture.input,
            snapshot: {
              ...source,
              messages: [
                source.messages[0]!,
                { ...source.messages[1]!, createdAt: tied, updatedAt: tied },
                {
                  ...source.messages[0]!,
                  n: 3,
                  id: MessageId.make("async-answer:source-request"),
                  text: "Blue",
                  createdAt: tied,
                  updatedAt: tied,
                },
              ],
              questionAnswers: [
                {
                  id: "source-request",
                  turnId: source.messages[1]!.turnId,
                  createdAt: tied,
                  items: [{ question: "Which color?", answer: "Blue", attachments: [] }],
                },
              ],
            },
          };

          const { lease } = yield* leaseFor({ ...fixture, input });
          const { result } = yield* importOnce(lease);
          const inherited = (yield* readThread(result.threadId))!;
          assert.deepStrictEqual(
            inherited.messages.map((message) => message.text),
            ["Question 1", "Answer 1", "Blue"],
          );
          // The answer names the message it folds; its id sorts like any other.
          const answer = inherited.activities.find(
            (activity) => activity.kind === "user-input.answer-submitted",
          )!;
          const folded = inherited.messages[2]!;
          assert.strictEqual((answer.payload as { messageId?: string }).messageId, folded.id);
          assert.isFalse(folded.id.startsWith("async-answer:"));

          const continuationId = MessageId.make("folded-tie-continuation-user");
          yield* continueHistory(
            result.threadId,
            continuationId,
            CommandId.make("start-folded-tie-continuation"),
            "Go on",
            "2026-09-28T11:00:00.000Z",
          );
          const prepared = yield* prepareHistory(result.threadId);
          assert.isNotEmpty(prepared.context);

          const answerAt = prepared.context.indexOf("Answer 1");
          const blueAt = prepared.context.indexOf("\nBlue");
          assert.isAbove(answerAt, -1);
          assert.isAbove(blueAt, answerAt);

          yield* finishHistory(result.threadId, "2026-09-28T11:00:02.000Z");
          const snapshot = buildConversationSnapshot({
            thread: (yield* readThread(result.threadId))!,
            snapshotSequence: 1,
            threadSequence: 1,
            capturedAt: "2026-09-28T11:01:00.000Z",
            selection: { workLog: false, reasoning: false, throughMessageId: null },
            isAttachmentAvailable: () => false,
          });
          const requestId = (answer.payload as { requestId: string }).requestId;
          // Files keep naming a folded answer's message after its answer.
          assert.deepStrictEqual(
            snapshot.messages.map((message) => [message.text, message.id.startsWith("async-")]),
            [
              ["Question 1", false],
              ["Answer 1", false],
              ["Blue", true],
              ["Go on", false],
            ],
          );
          assert.strictEqual(snapshot.messages[2]!.id, `async-answer:${requestId}`);
          const markdown = writeConversationMarkdown({
            bundle: buildConversationDocument({
              snapshot: { ...snapshot, contentDigest: `sha256:${"a".repeat(64)}` },
              exportValue: "7f3c9a2e41b8",
              timeZone: "UTC",
              resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
            }).bundle,
            exportValue: "7f3c9a2e41b8",
            exported: "2026-09-28T11:01:00.000Z",
            packaging: "text",
          });
          const parsed = parseConversationMarkdown(markdown);
          assert.strictEqual(parsed.kind, "conversation");
          if (parsed.kind === "conversation") {
            assert.deepStrictEqual(
              parsed.messages.map((message) => message.body),
              ["Question 1", "Answer 1", "Go on"],
            );
          }
          assert.strictEqual(markdown.split("**A:** Blue").length - 1, 1);
          assert.isAbove(markdown.indexOf("**A:** Blue"), markdown.indexOf("Answer 1"));
        }),
      ),
  );

  it.effect("keeps the file's own notices on the imported thread, its forks, and re-export", () =>
    withNativeImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 2 });
        const newer = { major: 1, minor: 1 };
        const input: typeof fixture.input = {
          ...fixture.input,
          package: { ...fixture.input.package, formatVersion: newer },
          warnings: [
            {
              _tag: "export-warning",
              warning: {
                code: "resource-unresolved",
                message: "The linked image chart.png was unavailable.",
              },
            },
            {
              _tag: "export-warning",
              warning: {
                code: "resource-unresolved",
                message: "The file /Users/sender/notes/secret.txt was unavailable.",
              },
            },
            {
              // An omission already states this; the banner does not repeat it.
              _tag: "export-warning",
              warning: {
                code: "running-turn-omitted",
                message: "A turn still running at export was left out.",
              },
            },
            { _tag: "newer-minor-version", formatVersion: newer },
          ],
        };
        // Two warnings of one kind become one line with their count.
        const notices = [
          "2 linked files or images were not included.",
          "A newer version of Scient made this file. Anything this version does not recognise was skipped.",
        ];
        const { lease } = yield* leaseFor({ ...fixture, input });
        const { result } = yield* importOnce(lease);
        const imported = (yield* readThread(result.threadId))!;
        assert.deepStrictEqual(imported.conversationImport?.notices, notices);

        const forkId = ThreadId.make("fork-keeps-notices");
        yield* forkHistory({
          type: "thread.fork",
          commandId: CommandId.make("fork-keeps-notices"),
          originThreadId: result.threadId,
          newThreadId: forkId,
          sourceAssistantMessageId: imported.messages.find(
            (message) => message.text === "Answer 2",
          )!.id,
          workspaceMode: "local",
        });
        const fork = (yield* readThread(forkId))!;
        assert.deepStrictEqual(fork.forkLineage?.sourceImport?.notices, notices);

        const snapshot = buildConversationSnapshot({
          thread: imported,
          snapshotSequence: 1,
          threadSequence: 1,
          capturedAt: "2026-09-28T11:01:00.000Z",
          selection: { workLog: false, reasoning: false, throughMessageId: null },
          isAttachmentAvailable: () => false,
        });
        assert.deepStrictEqual(
          snapshot.provenance._tag === "import" ? snapshot.provenance.notices : undefined,
          notices,
        );
        // Imported again, the earlier notices stay, each once.
        const again: typeof fixture.input = {
          ...input,
          snapshot: { ...input.snapshot, provenance: snapshot.provenance },
        };
        const command = buildConversationImportCommand({
          validated: again,
          ids: yield* mintConversationImportIds(again),
          destination: destination(),
          importedAt: "2026-09-28T12:00:00.000Z",
        });
        assert.deepStrictEqual(command.origin.notices, notices);
      }),
    ),
  );

  it.effect("a fork of an imported folded answer names the message it shows", () =>
    withNativeImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 2 });
        const source = fixture.input.snapshot;
        const answeredAt = source.messages[1]!.createdAt;
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...source,
            messages: [
              source.messages[0]!,
              source.messages[1]!,
              {
                ...source.messages[0]!,
                id: MessageId.make("async-answer:source-request"),
                text: "Blue",
                createdAt: answeredAt,
                updatedAt: answeredAt,
              },
              source.messages[2]!,
              source.messages[3]!,
            ].map((message, index) => ({ ...message, n: index + 1 })),
            questionAnswers: [
              {
                id: "source-request",
                turnId: source.messages[1]!.turnId,
                createdAt: answeredAt,
                items: [{ question: "Which color?", answer: "Blue", attachments: [] }],
              },
            ],
          },
        };
        const { lease } = yield* leaseFor({ ...fixture, input });
        const { result } = yield* importOnce(lease);
        const imported = (yield* readThread(result.threadId))!;
        const forkId = ThreadId.make("fork-of-folded-answer");
        yield* forkHistory({
          type: "thread.fork",
          commandId: CommandId.make("fork-folded-answer"),
          originThreadId: result.threadId,
          newThreadId: forkId,
          sourceAssistantMessageId: imported.messages.find(
            (message) => message.text === "Answer 2",
          )!.id,
          workspaceMode: "local",
        });
        const fork = (yield* readThread(forkId))!;
        const answer = fork.activities.find(
          (activity) => activity.kind === "user-input.answer-submitted",
        )!;
        const folded = fork.messages.find((message) => message.text === "Blue")!;
        assert.strictEqual(
          folded.id,
          imported.messages.find((message) => message.text === "Blue")!.id,
        );
        assert.strictEqual(
          (answer.payload as { readonly messageId?: string }).messageId,
          folded.id,
        );
      }),
    ),
  );

  it.effect(
    "keeps the source order of records that share a timestamp through history, continuation, and re-export",
    () =>
      withNativeImporter(
        Effect.gen(function* () {
          // Everything of one kind shares one timestamp, so only the ids order it.
          const fixture = importFixture({ turns: 4, workLog: true, workLogPerTurn: 2 });
          const source = fixture.input.snapshot;
          const tied = "2026-09-27T10:00:10.000Z";
          const input: typeof fixture.input = {
            ...fixture.input,
            snapshot: {
              ...source,
              messages: source.messages.map((message) => ({
                ...message,
                createdAt: tied,
                updatedAt: tied,
              })),
              workLog: source.workLog.map((entry, index) =>
                entry._tag === "tool"
                  ? { ...entry, createdAt: "2026-09-27T10:00:11.000Z", title: `Step ${index + 1}` }
                  : entry,
              ),
              proposedPlans: [1, 2, 3, 4].map((index) => ({
                ...source.proposedPlans[0]!,
                id: `src-plan-${index}`,
                markdown: `${index}. Plan ${index}`,
              })),
            },
          };
          const messageTexts = source.messages.map((message) => message.text);
          const stepTitles = input.snapshot.workLog.map((_, index) => `Step ${index + 1}`);
          const inOrder = (text: string, expected: ReadonlyArray<string>) => {
            const positions = expected.map((value) => text.indexOf(value));
            assert.notInclude(positions, -1);
            assert.deepStrictEqual(
              positions,
              positions.toSorted((left, right) => left - right),
            );
          };

          const { lease } = yield* leaseFor({ ...fixture, input });
          const { result } = yield* importOnce(lease);
          const inherited = (yield* readThread(result.threadId))!;
          assert.deepStrictEqual(
            inherited.messages.map((message) => message.text),
            messageTexts,
          );
          assert.deepStrictEqual(
            inherited.activities.map((activity) => activity.summary),
            stepTitles,
          );
          assert.deepStrictEqual(
            inherited.proposedPlans.map((plan) => plan.planMarkdown),
            ["1. Plan 1", "2. Plan 2", "3. Plan 3", "4. Plan 4"],
          );

          const continuationId = MessageId.make("tied-continuation-user");
          yield* continueHistory(
            result.threadId,
            continuationId,
            CommandId.make("start-tied-continuation"),
            "Go on",
            "2026-09-28T11:00:00.000Z",
          );
          const prepared = yield* prepareHistory(result.threadId);
          assert.isNotEmpty(prepared.context);

          // SCIC v1 side facts stay within their historical turn; each kind's
          // source order and the original timestamps remain independent.
          inOrder(prepared.context, [
            "Question 1",
            "Answer 1",
            "Step 1",
            "Step 2",
            "Question 2",
            "Answer 2",
            "Step 3",
            "Step 4",
            "Question 3",
            "Answer 3",
            "Step 5",
            "Step 6",
            "Question 4",
            "Answer 4",
            "Step 7",
            "Step 8",
          ]);
          inOrder(prepared.context, messageTexts);
          inOrder(prepared.context, stepTitles);
          inOrder(prepared.context, ["Plan 1", "Plan 2", "Plan 3", "Plan 4"]);

          yield* finishHistory(result.threadId, "2026-09-28T11:00:02.000Z");
          const snapshot = buildConversationSnapshot({
            thread: (yield* readThread(result.threadId))!,
            snapshotSequence: 1,
            threadSequence: 1,
            capturedAt: "2026-09-28T11:01:00.000Z",
            selection: { workLog: true, reasoning: false, throughMessageId: null },
            isAttachmentAvailable: () => false,
          });
          assert.deepStrictEqual(
            snapshot.messages.map((message) => message.text),
            [...messageTexts, "Go on"],
          );
          assert.deepStrictEqual(
            snapshot.workLog.map((entry) => (entry._tag === "tool" ? entry.title : null)),
            stepTitles,
          );
          const markdown = writeConversationMarkdown({
            bundle: buildConversationDocument({
              snapshot: { ...snapshot, contentDigest: `sha256:${"a".repeat(64)}` },
              exportValue: "7f3c9a2e41b8",
              timeZone: "UTC",
              resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
            }).bundle,
            exportValue: "7f3c9a2e41b8",
            exported: "2026-09-28T11:01:00.000Z",
            packaging: "text",
          });
          const parsed = parseConversationMarkdown(markdown);
          assert.strictEqual(parsed.kind, "conversation");
          if (parsed.kind === "conversation") {
            assert.deepStrictEqual(
              parsed.messages.map((message) => message.body),
              [...messageTexts, "Go on"],
            );
          }
        }),
      ),
  );

  it.effect(
    "delivers retained history to continuation and re-delivers after a provider switch",
    () =>
      withNativeImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ turns: 3, reasoning: true, workLog: true });
          const { lease } = yield* leaseFor(fixture);
          const { result } = yield* importOnce(lease);
          const messageId = MessageId.make("import-continuation-user");
          yield* continueHistory(
            result.threadId,
            messageId,
            CommandId.make("start-import-continuation"),
            "Continue the design",
            "2026-09-28T11:00:00.000Z",
          );
          const thread = (yield* readThread(result.threadId))!;
          const native = yield* readProjection(thread.id);
          assert.isEmpty(native.providerSessions);
          assert.isNull(native.providerThreads.at(-1)!.nativeThreadRef);
          const firstProviderThreadId = yield* bindHistoryIdentity(
            thread.id,
            "codex@codex:local-session",
          );
          const initial = yield* prepareHistory(thread.id);
          assert.isNotEmpty(initial.context);
          for (const text of ["Question 1", "Answer 1", "Question 3", "Answer 3"]) {
            assert.include(initial.context, text);
          }
          assert.notInclude(initial.context, "Continue the design");
          assert.notInclude(initial.context, "thread-on-another-machine");
          assert.strictEqual(native.contextHandoffs.at(-1)!.history!.omittedItems, 0);
          const pending = (yield* readProjection(thread.id)).contextHandoffs.at(-1)!;
          assert.strictEqual(pending.delivery?.status, "pending");
          assert.deepStrictEqual(pending.delivery?.omittedItemIds, []);
          assert.strictEqual(pending.delivery?.nativeThreadId, "codex@codex:local-session");
          yield* initial.delivered;
          assert.strictEqual((yield* prepareHistory(thread.id)).context, "");
          assert.strictEqual(
            (yield* readProjection(thread.id)).contextHandoffs.at(-1)!.delivery?.status,
            "inline",
          );
          yield* finishHistory(thread.id, "2026-09-28T11:00:02.000Z");
          yield* (yield* Orchestrator.OrchestratorV2).dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("switch-import-provider"),
            threadId: thread.id,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "claude-sonnet",
            },
          });
          yield* continueHistory(
            thread.id,
            MessageId.make("switched-continuation"),
            CommandId.make("start-switched-continuation"),
            "Carry on with Claude",
            "2026-09-28T11:00:03.000Z",
          );
          const secondProviderThreadId = yield* bindHistoryIdentity(
            thread.id,
            "claude@claude:fresh-session",
          );
          assert.notStrictEqual(secondProviderThreadId, firstProviderThreadId);
          const switchedNative = yield* readProjection(thread.id);
          assert.strictEqual(
            switchedNative.providerThreads.find(
              (candidate) => candidate.id === secondProviderThreadId,
            )!.providerInstanceId,
            ProviderInstanceId.make("claude"),
          );
          const switched = yield* prepareHistory(thread.id);
          assert.isNotEmpty(switched.context);
          assert.include(switched.context, "Question 1");
          assert.include(switched.context, "Answer 3");
          assert.notInclude(switched.context, "codex@codex:local-session");
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
      withNativeImporter(
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
          const before = (yield* readThread(result.threadId))!;
          assert.deepInclude(before.conversationImport!.omissions, sourceOmission);
          const inherited = before.messages.map((message) => [message.role, message.text]);
          const inheritedTurnIds = new Set(before.messages.map((message) => message.turnId));
          const userId = MessageId.make("post-import-user");
          const assistantId = MessageId.make("post-import-assistant");
          yield* continueHistory(
            result.threadId,
            userId,
            CommandId.make("start-post-import-turn"),
            "Temporary follow-up",
            "2026-09-28T11:00:00.000Z",
          );
          const started = yield* readProjection(result.threadId);
          const postRun = started.runs.at(-1)!;
          assert.strictEqual(
            started.messages.find((message) => message.id === userId)!.runId,
            postRun.id,
          );
          yield* finishHistory(result.threadId, "2026-09-28T11:00:02.000Z", {
            id: assistantId,
            text: "Temporary answer",
          });
          assert.include(
            (yield* readThread(result.threadId))!.messages.map((message) => message.text),
            "Temporary answer",
          );
          const completed = yield* readProjection(result.threadId);
          const completedRun = completed.runs.find((run) => run.id === postRun.id)!;
          const completedRoot = completed.nodes.find(
            (node) => node.id === completedRun.rootNodeId,
          )!;
          const revertedAt = DateTime.makeUnsafe("2026-09-28T11:00:03.000Z");
          // The old fixture supplied revert-complete directly too; test projection history boundaries,
          // without claiming that an inert provider performed a filesystem/native-thread rollback.
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("revert-post-import-run"),
                threadId: result.threadId,
                occurredAt: revertedAt,
                type: "run.updated",
                payload: { ...completedRun, status: "rolled_back", completedAt: revertedAt },
              },
              {
                id: EventId.make("revert-post-import-root"),
                threadId: result.threadId,
                occurredAt: revertedAt,
                type: "node.updated",
                payload: { ...completedRoot, status: "rolled_back", completedAt: revertedAt },
              },
            ],
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
          const afterRollback = yield* readProjection(result.threadId);
          assert.strictEqual(
            afterRollback.runs.find((run) => run.id === postRun.id)!.status,
            "rolled_back",
          );
          assert.isFalse(
            afterRollback.visibleTurnItems.some(({ item }) => item.runId === postRun.id),
          );

          const sourceAnswer = reverted.messages.find((message) => message.text === "Answer 2")!;
          const forkId = ThreadId.make("fork-of-imported-history");
          yield* forkHistory({
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
          assert.isNull(fork.conversationImport);
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
          const forkNative = yield* readProjection(forkId);
          const forkShell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(
            forkId,
          );
          assert.ok(forkShell);
          assert.deepStrictEqual(
            forkShell.forkLineage?.sourceImport,
            fork.forkLineage?.sourceImport,
          );
          assert.strictEqual(
            new Set(
              forkNative.visibleTurnItems.flatMap(({ item }) =>
                item.historyTurnId === undefined ? [] : [item.historyTurnId],
              ),
            ).size,
            2,
          );
          const transfer = forkNative.contextTransfers.find(
            (transfer) => transfer.targetThreadId === forkId,
          )!;
          assert.strictEqual(transfer.type, "fork");
          assert.strictEqual(transfer.sourceThreadId, result.threadId);
          assert.isNotNull(transfer.portableReason ?? null);
          assert.isNull(forkNative.thread.activeProviderThreadId);
          assert.isEmpty(forkNative.providerThreads);
          assert.isNull(forkNative.thread.forkedFrom);
          assert.isUndefined(transfer.sourcePoint.providerThreadRef);
          const nextId = MessageId.make("fork-continuation");
          yield* continueHistory(
            forkId,
            nextId,
            CommandId.make("start-fork-continuation"),
            "Continue from answer two",
            "2026-09-28T11:00:04.000Z",
          );
          const context = yield* prepareHistory(forkId);
          assert.isNotEmpty(context.context);
          assert.include(context.context, "Question 1");
          assert.include(context.context, "Answer 2");
          assert.include(context.context, "Known source omissions (unverified)");
          assert.include(context.context, '"range-truncated"');
          assert.notInclude(context.context, "Answer 3");
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

          assert.strictEqual(
            (yield* readProjection(forkId)).thread.conversationFork?.status,
            "ready",
          );
          const secondForkId = ThreadId.make("fork-of-imported-fork");
          const secondSource = fork.messages.find((message) => message.text === "Answer 2")!;
          yield* forkHistory({
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
          assert.isNull(secondFork.conversationImport);
          assert.deepStrictEqual(
            (yield* readThread(result.threadId))!.conversationImport,
            before.conversationImport,
          );
        }),
      ),
  );
});
