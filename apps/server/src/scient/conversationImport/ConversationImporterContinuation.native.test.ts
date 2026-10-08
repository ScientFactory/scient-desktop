// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  ChatAttachmentId,
  CheckpointId,
  CheckpointScopeId,
  CheckpointRef,
  NodeId,
  EventId,
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { reserveAttachment } from "../../orchestration-v2/AttachmentFileUse.ts";
import {
  ThreadFileRelease,
  layer as threadFileReleaseLayer,
} from "../../orchestration-v2/scient-fork/ThreadFileRelease.ts";
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "../../orchestration-v2/threadHistoryPaging.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ConversationForkService } from "../../orchestration-v2/scient-fork/ConversationForkService.ts";
import { layerFromAdapters as makeLayer } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2TurnInput } from "../../orchestration-v2/ProviderAdapter.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../../orchestration-v2/IdAllocator.ts";
import { AcpProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  NativeSessionOperationError,
  type NativeSession,
} from "../../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { layerFromPath as makeSqlitePersistenceLive } from "../../persistence/Sqlite.ts";
import { LegacyV1ThreadImporter } from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

import { ServerConfig } from "../../config.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { layer as resourceCleanupLayer } from "../../orchestration-v2/ResourceCleanupService.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import {
  createAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "../../orchestration-v2/ProjectionMaintenance.ts";
import { historicalMessage } from "../../orchestration-v2/ContextHandoffBudget.ts";
import {
  ConversationImporter,
  conversationContentDigest,
  type ConversationImportLease,
} from "./ConversationImporter.ts";
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
  PROVIDER_ID,
  PROJECT_ID,
  testLease,
  type ImportFixture,
} from "./conversationImport.test-fixtures.ts";
import {
  createNativeProjects as createProjects,
  nativeImportRuntimeTestLayer,
} from "./conversationImport.native-test-harness.ts";
import {
  buildConversationDocument,
  buildConversationSnapshot,
  writeConversationMarkdown,
  parseConversationMarkdown,
} from "@scientfactory/conversation";
import { conversationSnapshotProjection } from "../conversationExport/conversationSnapshotProjection.ts";

const encodeHistoryFixtureJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeQuestionFileReferences = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        mimeType: Schema.String,
        contentReattached: Schema.Literal(false),
      }),
    ),
  ),
);

const attemptDirectory = (name = "attempt") =>
  Effect.map(ServerConfig, (config) =>
    NodePath.join(config.stateDir, "conversation-imports", IMPORT_ID, name),
  );

const readThread = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStoreV2, (store) => store.getThreadProjection(threadId)).pipe(
    Effect.map((projection) => conversationSnapshotProjection(projection, "/tmp/import-project")),
  );

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
 * controlled wall clock after the fixtures' history. Worker polling uses the
 * runtime scheduler; assertions wait for authoritative completion events.
 */
class ImportPeer extends Context.Service<
  ImportPeer,
  {
    readonly prompts: string[];
    readonly sends: ProviderAdapterV2TurnInput[];
    readonly setTime: (time: number) => Effect.Effect<void>;
  }
>()("t3/scient/conversationImport/ConversationImporterContinuation.native.test/ImportPeer") {}

const withImporter = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly modelContextWindow?: (model: string) => number | undefined;
    readonly sourceTraces?: boolean;
    readonly initialTime?: number;
    readonly projectScope?: Scope.Scope;
    readonly runtimeOptions?: Parameters<typeof nativeImportRuntimeTestLayer>[1];
    readonly nativeIdFactory?: () => string;
    readonly beforeOpen?: (threadId: ThreadId) => Effect.Effect<void>;
    readonly beforeFresh?: () => Effect.Effect<void, NativeSessionOperationError>;
    readonly beforeSend?: () => Effect.Effect<void, NativeSessionOperationError>;
    readonly onResume?: (nativeId: string) => Effect.Effect<void, NativeSessionOperationError>;
    readonly onSteer?: (text: string) => Effect.Effect<void, NativeSessionOperationError>;
  } = {},
) =>
  Effect.gen(function* () {
    const prompts: string[] = [];
    const sends: ProviderAdapterV2TurnInput[] = [];
    let time = options.initialTime ?? Date.parse("2026-09-28T09:30:00.000Z");
    const liveClock = yield* Clock.Clock;
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => time,
      currentTimeMillis: Effect.sync(() => time),
      currentTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(time) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: liveClock.monotonicTimeNanos,
      sleep: (duration) => liveClock.sleep(duration),
    };
    const allocator = yield* IdAllocatorV2;
    const cwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "scient-native-import-peer-",
    });
    const capabilities = {
      ...AcpProviderCapabilitiesV2,
      threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: true },
      turns: {
        ...AcpProviderCapabilitiesV2.turns,
        supportsActiveSteering: options.onSteer !== undefined,
      },
      checkpointing: {
        ...AcpProviderCapabilitiesV2.checkpointing,
        providerCanRollbackConversation: true,
        providerRollbackReturnsSnapshot: true,
      },
    };
    const adapters = [PROVIDER_ID, ProviderInstanceId.make("claude")].map((instanceId) => {
      const adapter = makeNativeSessionAdapterV2({
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        capabilities,
        idAllocator: allocator,
        defaultCwd: cwd,
        continuations: { offer: () => Effect.die("Unexpected native continuation wake") },
        open: (input, publish) =>
          (options.beforeOpen?.(input.threadId) ?? Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                let nativeId =
                  options.nativeIdFactory?.() ?? `import-peer:${input.providerSessionId}`;
                return {
                  get nativeId() {
                    return nativeId;
                  },
                  nativeThreadKnown: true,
                  resume: (id) => options.onResume?.(id) ?? Effect.void,
                  ...(options.nativeIdFactory === undefined
                    ? {}
                    : {
                        ensureFresh: () =>
                          Effect.gen(function* () {
                            yield* options.beforeFresh?.() ?? Effect.void;
                            nativeId = options.nativeIdFactory!();
                            yield* publish({ type: "native-thread", id: nativeId });
                          }),
                      }),
                  respond: () => Effect.die("Imported answers cannot be executable requests"),
                  interrupt: publish({ type: "terminal", status: "cancelled" }),
                  ...(options.onSteer === undefined
                    ? {}
                    : {
                        steer: (
                          input: import("../../orchestration-v2/ProviderAdapter.ts").ProviderAdapterV2SteerInput,
                        ) => options.onSteer!(input.message.text),
                      }),
                  send: (turn, nativeTurnId) =>
                    Effect.gen(function* () {
                      prompts.push(turn.message.text);
                      sends.push(turn);
                      if (options.onSteer !== undefined)
                        yield* publish({ type: "accepted", nativeTurnId });
                      yield* options.beforeSend?.() ?? Effect.void;
                      if (options.sourceTraces && turn.message.text === "Trace source") {
                        yield* publish({
                          type: "text",
                          id: "source-thinking",
                          delta: "Visible retained reasoning",
                          reasoning: true,
                        });
                        yield* publish({ type: "text-completed", id: "source-thinking" });
                        yield* publish({
                          type: "tool",
                          id: "source-tool",
                          name: "read_file",
                          input: { path: "data.csv" },
                          output: "Superseded partial result",
                          status: "running",
                        });
                        yield* publish({
                          type: "tool",
                          id: "source-tool",
                          name: "read_file",
                          input: { path: "data.csv" },
                          output: `Retained native result ${"o".repeat(40_000)}`,
                          status: "completed",
                        });
                        yield* publish({
                          type: "text",
                          id: "source-answer",
                          delta: "Source answer",
                        });
                        yield* publish({ type: "text-completed", id: "source-answer" });
                      }
                      if (
                        turn.message.text.trimEnd().endsWith("Continue") ||
                        turn.message.text.trimEnd().endsWith("Temporary follow-up")
                      ) {
                        yield* publish({
                          type: "text",
                          id: "continued-answer",
                          delta: turn.message.text.trimEnd().endsWith("Continue")
                            ? "Continued"
                            : "Temporary answer",
                        });
                        yield* publish({ type: "text-completed", id: "continued-answer" });
                      }
                      yield* publish({ type: "terminal", status: "completed" });
                    }),
                } satisfies NativeSession;
              }),
            ),
          ),
      });
      return {
        ...adapter,
        openSession: (input: Parameters<typeof adapter.openSession>[0]) =>
          adapter.openSession(input).pipe(
            Effect.map((session) => ({
              ...session,
              ...(options.modelContextWindow === undefined
                ? {}
                : {
                    getModelContextWindow: (
                      selection: import("@t3tools/contracts").ModelSelection,
                    ) => options.modelContextWindow!(selection.model),
                  }),
              rollbackThread: (request: Parameters<typeof session.rollbackThread>[0]) =>
                Effect.succeed({
                  providerThread: request.providerThread,
                  providerTurns: [],
                  messages: [],
                  runtimeRequests: [],
                }),
            })),
          ),
      };
    });
    const projectCreation =
      options.projectScope === undefined
        ? createProjects
        : createProjects.pipe(Effect.provideService(Scope.Scope, options.projectScope));
    return yield* projectCreation.pipe(
      Effect.andThen(effect),
      Effect.provideService(ImportPeer, {
        prompts,
        sends,
        setTime: (value) =>
          Effect.sync(() => {
            time = value;
          }),
      }),
      Effect.provide(nativeImportRuntimeTestLayer(makeLayer(adapters), options.runtimeOptions)),
      Effect.provideService(Clock.Clock, clock),
    );
  }).pipe(Effect.provide(Layer.mergeAll(idAllocatorLayer, NodeServices.layer)), Effect.scoped);

const continueImport = Effect.fn("test.nativeImport.continue")(function* (
  threadId: ThreadId,
  messageId: MessageId,
  text: string,
  modelSelection?: import("@t3tools/contracts").ModelSelection,
) {
  const orchestrator = yield* OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`continue:${messageId}`),
    threadId,
    messageId,
    text,
    ...(modelSelection === undefined ? {} : { modelSelection }),
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const first = yield* orchestrator.getThreadProjection(threadId);
  const complete = yield* Stream.concat(
    Stream.succeed(first),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(
    Stream.filter((projection) =>
      ["completed", "failed", "cancelled", "interrupted"].includes(
        projection.runs.at(-1)?.status ?? "",
      ),
    ),
    Stream.runHead,
    Effect.timeout("15 seconds"),
  );
  assert.isTrue(Option.isSome(complete));
  assert.strictEqual(Option.getOrThrow(complete).runs.at(-1)?.status, "completed");
});

const importOnce = (lease: ConversationImportLease, request = importRequest()) =>
  Effect.flatMap(ConversationImporter, (importer) => importer.importConversation(lease, request));

const journalOf = (directory: string) =>
  readConversationImportJournal(directory).pipe(Effect.map(Option.getOrThrow));

const rollbackToBaseline = Effect.fn("test.nativeFork.rollbackToBaseline")(function* (
  threadId: ThreadId,
  suffix: string,
  retainedRunOrdinal = 0,
) {
  const store = yield* ProjectionStoreV2;
  const projection = yield* store.getThreadProjection(threadId);
  const nodeId = projection.runs.at(-1)?.rootNodeId ?? NodeId.make(`${suffix}-baseline-node`);
  const scopeId = CheckpointScopeId.make(`${suffix}-baseline-scope`);
  const checkpointId = CheckpointId.make(`${suffix}-baseline-checkpoint`);
  const now = yield* DateTime.now;
  yield* (yield* EventSinkV2).write({
    events: [
      {
        id: EventId.make(`${suffix}-baseline-scope`),
        threadId: threadId,
        type: "checkpoint-scope.created",
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId: threadId,
          runId: null,
          nodeId,
          parentScopeId: null,
          providerThreadId: projection.thread.activeProviderThreadId,
          kind: "manual",
          ordinalWithinParent: 0,
          advancesAppRunCount: false,
          cwd: "/tmp/import-project",
          createdAt: now,
        },
      },
      {
        id: EventId.make(`${suffix}-baseline-checkpoint`),
        threadId: threadId,
        type: "checkpoint.captured",
        occurredAt: now,
        payload: {
          id: checkpointId,
          threadId: threadId,
          scopeId,
          runId: null,
          nodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: retainedRunOrdinal === 0 ? null : retainedRunOrdinal,
          ref: CheckpointRef.make("refs/scient/import-baseline"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      },
    ],
  });
  const rollbackId = CommandId.make(`rollback-native-${suffix}`);
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({
      threadId: threadId,
      afterSequence: cursor,
    }),
  );
  yield* orchestrator.dispatch({
    type: "checkpoint.rollback",
    commandId: rollbackId,
    threadId: threadId,
    scopeId,
    checkpointId,
    restoreFiles: false,
  });
  const initial = yield* store.getThreadProjection(threadId);
  const rolledBack = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => store.getThreadProjection(threadId)),
    ),
  ).pipe(
    Stream.filter((projection) => projection.thread.rollbackCompletedRequestId === rollbackId),
    Stream.runHead,
    Effect.timeout("15 seconds"),
  );
  assert.isTrue(Option.isSome(rolledBack));
  return Option.getOrThrow(rolledBack);
});

describe("native import continuation and forks", () => {
  it.live("keeps the file's own notices on the imported thread, its forks, and re-export", () =>
    withImporter(
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
        yield* Effect.flatMap(ConversationForkService, (engine) =>
          engine.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("fork-keeps-notices"),
            originThreadId: result.threadId,
            newThreadId: forkId,
            sourceAssistantMessageId: imported.messages.find(
              (message) => message.text === "Answer 2",
            )!.id,
            workspaceMode: "local",
          }),
        );
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

  it.live("a fork of an imported folded answer names the message it shows", () =>
    withImporter(
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
        yield* Effect.flatMap(ConversationForkService, (engine) =>
          engine.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("fork-folded-answer"),
            originThreadId: result.threadId,
            newThreadId: forkId,
            sourceAssistantMessageId: imported.messages.find(
              (message) => message.text === "Answer 2",
            )!.id,
            workspaceMode: "local",
          }),
        );
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

  it.live("keeps history dated after this server's clock as an inherited prefix, with a note", () =>
    withImporter(
      Effect.gen(function* () {
        yield* (yield* ImportPeer).setTime(Date.parse("2026-09-28T10:00:00.000Z"));
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
        yield* continueImport(result.threadId, messageId, "Carry on");
        const thread = yield* readThread(result.threadId);
        assert.strictEqual(thread.messages.at(-1)?.id, messageId);
        const contextPreamble = (yield* ImportPeer).prompts[0]!;
        const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(result.threadId);
        assert.isTrue(
          projection.contextHandoffs.every(
            (handoff) => (handoff.history?.omittedItemIds?.length ?? 0) === 0,
          ),
        );
        for (const text of ["Question 1", "Answer 3", "Thinking about 3", "ok 3", "Ship it"]) {
          assert.include(contextPreamble, text);
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

  it.live("keeps async answers folded through import, continuation, and re-export", () =>
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
        yield* continueImport(result.threadId, continuationId, "Continue");
        assert.include((yield* ImportPeer).prompts[0]!, answerText);
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

  it.live(
    "keeps a folded answer after an ordinary message at the same time, and keeps it folded",
    () =>
      withImporter(
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
          yield* continueImport(result.threadId, continuationId, "Go on");
          const contextPreamble = (yield* ImportPeer).prompts[0]!;
          const answerAt = contextPreamble.indexOf("\nAnswer 1");
          const blueAt = contextPreamble.indexOf("\nBlue");
          assert.isAbove(answerAt, -1);
          assert.isAbove(blueAt, answerAt);

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

  it.live(
    "keeps the source order of records that share a timestamp through history, continuation, and re-export",
    () =>
      withImporter(
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
          yield* continueImport(result.threadId, continuationId, "Go on");
          const contextPreamble = (yield* ImportPeer).prompts[0]!;
          // New SCIC journals keep each source turn's facts together, while
          // retaining source order independently within messages and steps.
          const groupedTexts = source.messages.flatMap((message) => [
            message.text,
            ...(message.turnId === null
              ? []
              : input.snapshot.workLog.flatMap((entry, step) =>
                  entry.turnId === message.turnId ? [stepTitles[step]!] : [],
                )),
          ]);
          assert.lengthOf(groupedTexts, 16);
          inOrder(contextPreamble, groupedTexts);
          inOrder(contextPreamble, messageTexts);
          inOrder(contextPreamble, stepTitles);
          inOrder(contextPreamble, ["Plan 1", "Plan 2", "Plan 3", "Plan 4"]);

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

  it.live("delivers retained history to continuation and re-delivers after a provider switch", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 3, reasoning: true, workLog: true });
        const { lease } = yield* leaseFor(fixture);
        const { result } = yield* importOnce(lease);
        const store = yield* ProjectionStoreV2;
        const before = yield* store.getThreadProjection(result.threadId);
        assert.deepStrictEqual(before.providerSessions, []);
        assert.deepStrictEqual(before.providerThreads, []);
        assert.isNull(before.thread.activeProviderThreadId);
        yield* continueImport(
          result.threadId,
          MessageId.make("import-continuation-user"),
          "Continue the design",
        );
        const peer = yield* ImportPeer;
        const initial = peer.prompts[0]!;
        const initialContext = initial.slice(0, initial.lastIndexOf("User message:"));
        for (const text of ["Question 1", "Answer 1", "Question 3", "Answer 3"])
          assert.include(initialContext, text);
        assert.notInclude(initialContext, "Continue the design");
        assert.notInclude(initialContext, "thread-on-another-machine");
        const first = yield* store.getThreadProjection(result.threadId);
        assert.isTrue(
          first.contextHandoffs.every((handoff) => (handoff.history?.omittedItems ?? 0) === 0),
        );
        const firstProvider = first.providerThreads.find(
          (thread) => thread.id === first.thread.activeProviderThreadId,
        )!;
        assert.isString(firstProvider.nativeThreadRef?.nativeId);
        yield* continueImport(
          result.threadId,
          MessageId.make("same-import-session"),
          "Same session request",
        );
        assert.notInclude(peer.prompts[1]!, "Question 1");
        assert.strictEqual(
          (yield* store.getThread(result.threadId)).activeProviderThreadId,
          firstProvider.id,
        );
        yield* continueImport(
          result.threadId,
          MessageId.make("switched-import-session"),
          "Fresh provider request",
          { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" },
        );
        const switched = yield* store.getThreadProjection(result.threadId);
        const fresh = switched.providerThreads.find(
          (thread) => thread.id === switched.thread.activeProviderThreadId,
        )!;
        assert.notStrictEqual(fresh.id, firstProvider.id);
        assert.notStrictEqual(
          fresh.nativeThreadRef?.nativeId,
          firstProvider.nativeThreadRef?.nativeId,
        );
        assert.include(peer.prompts[2]!, "Question 1");
        assert.include(peer.prompts[2]!, "Answer 3");
        assert.notInclude(peer.prompts[2]!, String(firstProvider.nativeThreadRef!.nativeId));
        assert.strictEqual(
          switched.thread.conversationImport?.sourceThreadId,
          "thread-on-another-machine",
        );
      }),
    ),
  );
  it.live(
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
          const forks = yield* ConversationForkService;
          const store = yield* ProjectionStoreV2;
          const before = (yield* readThread(result.threadId))!;
          assert.deepInclude(before.conversationImport!.omissions, sourceOmission);
          const inherited = before.messages.map((message) => [message.role, message.text]);
          const inheritedTurnIds = new Set(before.messages.map((message) => message.turnId));
          const userId = MessageId.make("post-import-user");
          yield* continueImport(result.threadId, userId, "Temporary follow-up");
          assert.include(
            (yield* readThread(result.threadId)).messages.map((message) => message.text),
            "Temporary answer",
          );
          const projection = yield* store.getThreadProjection(result.threadId);
          const postRun = projection.runs.at(-1)!;
          const rolledBack = yield* rollbackToBaseline(result.threadId, "import");
          assert.strictEqual(
            rolledBack.runs.find((run) => run.id === postRun.id)?.status,
            "rolled_back",
          );
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
          const sourceAnswer = reverted.messages.find((message) => message.text === "Answer 2")!;
          const forkId = ThreadId.make("fork-of-imported-history");
          yield* forks.dispatch({
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
          const forkShell = yield* store.getThreadShell(forkId);
          assert.deepStrictEqual(
            forkShell?.forkLineage?.sourceImport,
            fork.forkLineage?.sourceImport,
          );
          const nativeFork = yield* store.getThreadProjection(forkId);
          assert.deepStrictEqual(nativeFork.runs, []);
          assert.deepStrictEqual(nativeFork.providerThreads, []);
          const retained = new Set(
            nativeFork.visibleTurnItems.flatMap(({ item }) =>
              item.historyTurnId === undefined ? [] : [item.historyTurnId],
            ),
          );
          assert.strictEqual(retained.size, 2);
          const transfer = nativeFork.contextTransfers.find(
            (transfer) => transfer.targetThreadId === forkId,
          )!;
          assert.strictEqual(transfer.type, "fork");
          assert.strictEqual(transfer.sourceThreadId, result.threadId);
          assert.deepStrictEqual(
            nativeFork.thread.forkLineage?.sourceImport,
            fork.forkLineage?.sourceImport,
          );
          assert.isUndefined(transfer.frozenSource);
          yield* continueImport(
            forkId,
            MessageId.make("fork-continuation"),
            "Continue from answer two",
          );
          const contextPreamble = (yield* ImportPeer).prompts.at(-1)!;
          assert.include(contextPreamble, "Question 1");
          assert.include(contextPreamble, "Answer 2");
          assert.include(contextPreamble, "range-truncated");
          assert.notInclude(contextPreamble, "Answer 3");
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

          const secondForkId = ThreadId.make("fork-of-imported-fork");
          const secondSource = fork.messages.find((message) => message.text === "Answer 2")!;
          yield* forks.dispatch({
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

it.live(
  "native fork delivery reads changed Scient presets and the selected destination model capacity",
  () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 28 });
        const expanded = {
          ...fixture,
          input: {
            ...fixture.input,
            snapshot: {
              ...fixture.input.snapshot,
              messages: fixture.input.snapshot.messages.map((message) => ({
                ...message,
                text: `${message.text} ${"x".repeat(8_000)}`,
              })),
            },
          },
        };
        const { lease } = yield* leaseFor(expanded);
        const { result } = yield* importOnce(lease);
        const store = yield* ProjectionStoreV2;
        const source = yield* store.getThreadProjection(result.threadId);
        const answer = source.messages.at(-1);
        assert.ok(answer?.role === "assistant");
        const settings = yield* ServerSettingsService;
        const counts: number[] = [];
        for (const contextHandoffSize of ["compact", "standard", "large", "maximum"] as const) {
          yield* settings.updateSettings({ scientFork: { contextHandoffSize } });
          const target = ThreadId.make(`preset-fork:${contextHandoffSize}`);
          yield* (yield* ConversationForkService).dispatch({
            type: "thread.fork",
            commandId: CommandId.make(target),
            originThreadId: result.threadId,
            newThreadId: target,
            sourceAssistantMessageId: answer.id,
            workspaceMode: "local",
          });
          yield* continueImport(
            target,
            MessageId.make(`preset-input:${contextHandoffSize}`),
            "Continue",
          );
          const projection = yield* store.getThreadProjection(target);
          const handoff = projection.contextHandoffs.at(-1);
          assert.ok(handoff?.history && handoff.delivery);
          counts.push(handoff.delivery.itemIds.length);
          const prompt = (yield* ImportPeer).prompts.at(-1)!;
          assert.include(prompt, "User message:");
          assert.isTrue(prompt.trimEnd().endsWith("Continue"));
          assert.equal(projection.runs.at(-1)?.status, "completed");
          assert.equal(projection.contextTransfers[0]?.status, "consumed");
          if (contextHandoffSize === "compact") assert.isAtMost(Buffer.byteLength(prompt), 49_000);
          if (contextHandoffSize === "standard") assert.isAbove(Buffer.byteLength(prompt), 64_000);
        }
        assert.isAbove(counts[0]!, 0);
        assert.isBelow(counts[0]!, counts[1]!);
        assert.isBelow(counts[1]!, counts[2]!);
        assert.isBelow(counts[2]!, counts[3]!);
        assert.equal(counts[3], source.turnItems.length);
        const small = ThreadId.make("preset-fork:small-model");
        yield* (yield* ConversationForkService).dispatch({
          type: "thread.fork",
          commandId: CommandId.make(small),
          originThreadId: result.threadId,
          newThreadId: small,
          sourceAssistantMessageId: answer.id,
          workspaceMode: "local",
        });
        yield* continueImport(small, MessageId.make("small-model-input"), "Continue", {
          instanceId: PROVIDER_ID,
          model: "small",
        });
        const bounded = yield* store.getThreadProjection(small);
        const smallHandoff = bounded.contextHandoffs.at(-1);
        assert.ok(smallHandoff?.history && smallHandoff.delivery);
        const smallDelivered = new Set(smallHandoff.delivery.itemIds);
        assert.equal(
          smallHandoff.history.messages.filter(
            (message) =>
              smallDelivered.has(message.itemId) &&
              (message.kind === "user_message" || message.kind === "assistant_message"),
          ).length,
          1,
        );
        assert.isBelow(Buffer.byteLength((yield* ImportPeer).prompts.at(-1)!), 13_000);
        assert.deepEqual(
          (yield* store.getThreadProjection(result.threadId)).messages,
          source.messages,
        );
      }),
      { modelContextWindow: (model) => (model === "small" ? 20_000 : 800_000) },
    ),
);

it.live("the environment cap overrides the maximum preset on actual native fork delivery", () =>
  withImporter(
    Effect.gen(function* () {
      const fixture = importFixture({ turns: 12 });
      const expanded = {
        ...fixture,
        input: {
          ...fixture.input,
          snapshot: {
            ...fixture.input.snapshot,
            messages: fixture.input.snapshot.messages.map((message) => ({
              ...message,
              text: `${message.text} ${"y".repeat(4_000)}`,
            })),
          },
        },
      };
      const { lease } = yield* leaseFor(expanded);
      const { result } = yield* importOnce(lease);
      const source = yield* (yield* ProjectionStoreV2).getThreadProjection(result.threadId);
      const answer = source.messages.at(-1);
      assert.ok(answer?.role === "assistant");
      yield* (yield* ServerSettingsService).updateSettings({
        scientFork: { contextHandoffSize: "maximum" },
      });
      const target = ThreadId.make("environment-capped-fork");
      yield* (yield* ConversationForkService).dispatch({
        type: "thread.fork",
        commandId: CommandId.make(target),
        originThreadId: result.threadId,
        newThreadId: target,
        sourceAssistantMessageId: answer.id,
        workspaceMode: "local",
      });
      yield* continueImport(target, MessageId.make("environment-capped-input"), "Continue");
      const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(target);
      const handoff = projection.contextHandoffs.at(-1);
      assert.ok(handoff?.delivery);
      assert.isAbove(handoff.delivery.itemIds.length, 0);
      assert.isBelow(handoff.delivery.itemIds.length, source.messages.length);
      assert.isAtMost(Buffer.byteLength((yield* ImportPeer).prompts.at(-1)!), 16_000);
      assert.equal(projection.runs.at(-1)?.status, "completed");
    }),
    { modelContextWindow: () => 800_000 },
  ).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ T3CODE_CONTEXT_HANDOFF_TOKEN_CAP: "5000" }),
    ),
  ),
);

it.live(
  "native fork continuation carries frozen visible reasoning and the final work log before the current request",
  () =>
    withImporter(
      Effect.gen(function* () {
        const sourceId = ThreadId.make("native-trace-source");
        const orchestrator = yield* OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("native-trace-create"),
          threadId: sourceId,
          projectId: PROJECT_ID,
          title: "Native trace source",
          runtimeMode: "full-access",
          interactionMode: "default",
          modelSelection: { instanceId: PROVIDER_ID, model: "gpt-5.4" },
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* continueImport(sourceId, MessageId.make("native-trace-input"), "Trace source");
        const store = yield* ProjectionStoreV2;
        const source = yield* store.getThreadProjection(sourceId);
        const answer = source.messages.find((message) => message.text === "Source answer");
        const thinking = source.turnItems.find((item) => item.type === "reasoning");
        const work = source.turnItems.find(
          (item) => item.type === "dynamic_tool" && item.toolName === "read_file",
        );
        assert.ok(answer && thinking && work);
        assert.isNull(historicalMessage(thinking));
        assert.isNull(historicalMessage(work));
        const target = ThreadId.make("native-trace-fork");
        yield* (yield* ConversationForkService).dispatch({
          type: "thread.fork",
          commandId: CommandId.make(target),
          originThreadId: sourceId,
          newThreadId: target,
          sourceAssistantMessageId: answer.id,
          workspaceMode: "local",
        });
        const frozen = yield* store.getThreadProjection(target);
        const retainedThinking = frozen.visibleTurnItems
          .map((row) => row.item)
          .find((item) => item.type === "reasoning");
        assert.ok(retainedThinking);
        assert.isUndefined(retainedThinking.historyTurnId);
        assert.equal(retainedThinking.inheritedFrom?.runId, source.runs.at(-1)?.id);
        assert.isNull(retainedThinking.runId);
        assert.isNull(retainedThinking.nativeItemRef);
        assert.deepEqual(frozen.runtimeRequests, []);
        assert.deepEqual(frozen.runs, []);
        yield* continueImport(target, MessageId.make("native-trace-continue"), "Continue");
        const prompt = (yield* ImportPeer).prompts.at(-1)!;
        const reasonAt = prompt.indexOf("Visible retained reasoning");
        const workAt = prompt.indexOf(`Retained native result ${"o".repeat(40_000)}`);
        const answerAt = prompt.indexOf("Source answer");
        const currentAt = prompt.lastIndexOf("User message:");
        assert.isAtLeast(reasonAt, 0);
        assert.isAbove(workAt, reasonAt);
        assert.isAbove(answerAt, workAt);
        assert.isAbove(currentAt, answerAt);
        assert.notInclude(prompt, "Superseded partial result");
        assert.isTrue(prompt.trimEnd().endsWith("Continue"));
        const continued = yield* store.getThreadProjection(target);
        assert.equal(continued.messages.at(-2)?.text, "Continue");
        assert.deepEqual((yield* store.getThreadProjection(sourceId)).turnItems, source.turnItems);
      }),
      { sourceTraces: true },
    ),
);

it.live.each(["document", "conversation"] as const)(
  "native continuation and refork distinguish imported %s material",
  (kind) =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 1 });
        const snapshot =
          kind === "document"
            ? {
                ...fixture.input.snapshot,
                messages: [
                  {
                    ...fixture.input.snapshot.messages[0]!,
                    text: "Shared research notes",
                    turnId: null,
                  },
                ],
                reasoning: [],
                workLog: [],
                proposedPlans: [],
                questionAnswers: [],
              }
            : fixture.input.snapshot;
        const digest = conversationContentDigest(snapshot);
        const input = {
          ...fixture.input,
          snapshot: { ...snapshot, contentDigest: digest },
          package: {
            ...fixture.input.package,
            format:
              kind === "document"
                ? ("scient-markdown-document" as const)
                : ("scient-conversation-markdown" as const),
            sourceThreadId: null,
            contentDigest: digest,
          },
        };
        const { lease } = yield* leaseFor({ ...fixture, input });
        const { result } = yield* importOnce(lease);
        yield* continueImport(result.threadId, MessageId.make("material-first"), "Continue");
        const peer = yield* ImportPeer;
        const check = (prompt: string) => {
          if (kind === "document") {
            assert.include(prompt, "user-provided document");
            assert.include(prompt, "not a transcript of an earlier conversation");
            assert.notInclude(prompt, "may have been edited");
            assert.include(prompt, "Shared research notes");
          } else {
            assert.include(prompt, "imported conversation");
            assert.include(prompt, "may have been edited");
            assert.notInclude(prompt, "user-provided document");
            assert.include(prompt, "Question 1");
          }
        };
        check(peer.prompts.at(-1)!);
        const store = yield* ProjectionStoreV2;
        const source = yield* store.getThreadProjection(result.threadId);
        const answer = source.messages.findLast((message) => message.text === "Continued");
        assert.ok(answer);
        const target = ThreadId.make(`material-fork-${kind}`);
        yield* (yield* ConversationForkService).dispatch({
          type: "thread.fork",
          commandId: CommandId.make(target),
          originThreadId: result.threadId,
          newThreadId: target,
          sourceAssistantMessageId: answer.id,
          workspaceMode: "local",
        });
        assert.equal(
          (yield* store.getThread(target)).forkLineage?.sourceImport?.sourceFormat,
          input.package.format,
        );
        yield* continueImport(target, MessageId.make("material-fork-request"), "Continue");
        check(peer.prompts.at(-1)!);
        assert.deepEqual(
          (yield* store.getThreadProjection(result.threadId)).messages,
          source.messages,
        );
      }),
    ),
);

it.live.each(["portable import", "legacy SQL"] as const)(
  "turnless %s artifacts reach native continuation, provider switch and refork exactly once",
  (origin) =>
    withImporter(
      Effect.gen(function* () {
        const store = yield* ProjectionStoreV2;
        const unique = "Turnless retained evidence";
        let sourceId: ThreadId;
        if (origin === "portable import") {
          const fixture = importFixture({ turns: 2, workLog: true });
          const snapshot = {
            ...fixture.input.snapshot,
            workLog: fixture.input.snapshot.workLog.map((entry, index) =>
              index !== 0 || entry._tag !== "tool"
                ? entry
                : {
                    ...entry,
                    turnId: null,
                    title: unique,
                    output: {
                      ...entry.output!,
                      text: "Turnless output with omissions",
                      omittedLines: 4,
                      omittedChars: 17,
                    },
                  },
            ),
          };
          const input = {
            ...fixture.input,
            snapshot: { ...snapshot, contentDigest: conversationContentDigest(snapshot) },
          };
          const { lease } = yield* leaseFor({ ...fixture, input });
          sourceId = (yield* importOnce(lease)).result.threadId;
        } else {
          sourceId = ThreadId.make("turnless-legacy-native-source");
          const sql = yield* SqlClient.SqlClient;
          const model = yield* encodeHistoryFixtureJson({
            instanceId: PROVIDER_ID,
            model: "fixture",
          });
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES (${sourceId}, ${PROJECT_ID}, 'Legacy turnless history', ${model}, 'full-access', 'default', '2026-09-28T09:00:00.000Z', '2026-09-28T09:00:00.000Z')`;
          yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, turn_id, is_streaming, created_at, updated_at)
        VALUES ('turnless-legacy-user', ${sourceId}, 'user', 'Question 1', 'legacy-turn', 0, '2026-09-28T09:00:01.000Z', '2026-09-28T09:00:01.000Z'),
          ('turnless-legacy-reason', ${sourceId}, 'reasoning', 'Turnless visible legacy reasoning', NULL, 0, '2026-09-28T09:00:02.000Z', '2026-09-28T09:00:02.000Z'),
          ('turnless-legacy-answer', ${sourceId}, 'assistant', 'Answer 2', 'legacy-turn', 0, '2026-09-28T09:00:04.000Z', '2026-09-28T09:00:04.000Z')`;
          const payload = yield* encodeHistoryFixtureJson({
            output: "Turnless output with omissions",
            omittedLines: 4,
            omittedChars: 17,
          });
          yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
        VALUES ('turnless-legacy-tool', ${sourceId}, NULL, 'tool', 'tool.completed', ${unique}, ${payload}, '2026-09-28T09:00:03.000Z')`;
          const legacy = yield* LegacyV1ThreadImporter;
          yield* legacy.reconcileShells;
          yield* legacy.ensureTranscript(sourceId);
        }
        const source = yield* store.getThreadProjection(sourceId);
        const artifact = source.turnItems.find(
          (item) => item.type === "dynamic_tool" && item.title === unique,
        );
        assert.ok(artifact);
        assert.isUndefined(artifact.historyTurnId);
        const reason = source.turnItems.find((item) => item.type === "reasoning");
        if (origin === "legacy SQL") {
          assert.ok(reason);
          assert.isUndefined(reason.historyTurnId);
        }
        const fork = (projection: typeof source, id: string) =>
          Effect.gen(function* () {
            const target = ThreadId.make(id);
            yield* (yield* ConversationForkService).dispatch({
              type: "thread.fork",
              commandId: CommandId.make(id),
              originThreadId: projection.thread.id,
              newThreadId: target,
              sourceAssistantMessageId: projection.messages.find(
                (message) => message.text === "Answer 2",
              )!.id,
              workspaceMode: "local",
            });
            return yield* store.getThreadProjection(target);
          });
        const child = yield* fork(source, `turnless-${origin}-child`);
        const refork = yield* fork(child, `turnless-${origin}-refork`);
        assert.deepEqual((yield* store.getThreadProjection(sourceId)).turnItems, source.turnItems);
        assert.deepEqual((yield* store.getThreadProjection(sourceId)).messages, source.messages);
        assert.deepEqual(
          refork.turnItems
            .filter((item) => item.inheritedFrom !== undefined)
            .map((item) => item.type),
          child.turnItems
            .filter((item) => item.inheritedFrom !== undefined)
            .map((item) => item.type),
        );
        const copies = refork.turnItems.filter(
          (item) => item.type === "dynamic_tool" || item.type === "reasoning",
        );
        assert.isTrue(
          copies.every(
            (item) =>
              item.runId === null &&
              item.nodeId === null &&
              item.providerThreadId === null &&
              item.providerTurnId === null &&
              item.nativeItemRef === null,
          ),
        );
        assert.deepEqual(refork.runtimeRequests, []);
        assert.deepEqual(refork.runs, []);
        for (const [threadId, messageId, selection] of [
          [sourceId, `turnless-${origin}-initial`, undefined],
          [
            sourceId,
            `turnless-${origin}-switch`,
            { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" },
          ],
          [refork.thread.id, `turnless-${origin}-refork-send`, undefined],
        ] as const) {
          yield* continueImport(threadId, MessageId.make(messageId), "Continue", selection);
          const prompt = (yield* ImportPeer).prompts.at(-1)!;
          assert.equal(prompt.split(`${unique}\n`).length - 1, 1);
          assert.include(prompt, "Turnless output with omissions");
          assert.equal(prompt.split("Turnless output with omissions").length - 1, 1);
          assert.include(prompt, origin === "portable import" ? '"lines":4' : '"omittedLines":4');
          assert.include(prompt, origin === "portable import" ? '"chars":17' : '"omittedChars":17');
          assert.isBelow(prompt.indexOf(unique), prompt.lastIndexOf("User message:"));
          assert.isBelow(prompt.indexOf("Question 1"), prompt.indexOf(unique));
          assert.isBelow(prompt.indexOf(unique), prompt.indexOf("Answer 2"));
          if (origin === "legacy SQL") {
            assert.equal(prompt.split("Turnless visible legacy reasoning").length - 1, 1);
            assert.isBelow(
              prompt.indexOf("Turnless visible legacy reasoning"),
              prompt.indexOf(unique),
            );
          }
          const sent = yield* store.getThreadProjection(threadId);
          const handoff = sent.contextHandoffs.at(-1)!;
          assert.equal(handoff.history?.omittedItems, 0);
          assert.equal(
            handoff.history?.messages.filter((message) => message.text.includes(unique)).length,
            1,
          );
          assert.isTrue(
            handoff.delivery?.itemIds.some((id) =>
              handoff.history?.messages.some(
                (message) => message.itemId === id && message.text.includes(unique),
              ),
            ) ?? false,
          );
        }
      }),
    ),
);

it.live("native rollback of a carrying run restores frozen history from durable projection", () => {
  let generation = 0;
  return withImporter(
    Effect.gen(function* () {
      const fixture = importFixture({ turns: 3, reasoning: true, workLog: true });
      const { lease } = yield* leaseFor(fixture);
      const { result } = yield* importOnce(lease);
      const store = yield* ProjectionStoreV2;
      const source = yield* store.getThreadProjection(result.threadId);
      const answer = source.messages.find((message) => message.text === "Answer 3")!;
      const childId = ThreadId.make("rollback-carried-fork");
      yield* (yield* ConversationForkService).dispatch({
        type: "thread.fork",
        commandId: CommandId.make("rollback-carried-fork"),
        originThreadId: result.threadId,
        newThreadId: childId,
        sourceAssistantMessageId: answer.id,
        workspaceMode: "local",
      });
      const frozen = yield* store.getThreadProjection(childId);
      const frozenSnapshot = yield* readThread(childId);
      yield* continueImport(
        childId,
        MessageId.make("before-carrying-revert"),
        "Temporary follow-up",
      );
      const carried = yield* store.getThreadProjection(childId);
      assert.include((yield* ImportPeer).prompts.at(-1)!, "Question 1");
      assert.isTrue(
        carried.contextHandoffs.some((handoff) => handoff.delivery?.status === "inline"),
      );
      const reverted = yield* rollbackToBaseline(childId, "carrying-fork");
      assert.deepEqual(
        (yield* readThread(childId)).messages.map((message) => message.text),
        frozenSnapshot.messages.map((message) => message.text),
      );
      assert.deepEqual(
        reverted.turnItems.filter((item) => item.inheritedFrom !== undefined),
        frozen.turnItems.filter((item) => item.inheritedFrom !== undefined),
      );
      assert.isTrue(reverted.runs.every((run) => run.status === "rolled_back"));
      // No V1 reactor or non-durable revert notification participates in the native next send.
      yield* continueImport(childId, MessageId.make("after-carrying-revert"), "Continue");
      const restored = (yield* ImportPeer).prompts.at(-1)!;
      assert.include(restored, "Question 1");
      assert.include(restored, "Answer 3");
      assert.include(restored, "Thinking about 2");
      assert.notInclude(restored, "Temporary answer");
      yield* continueImport(childId, MessageId.make("after-carrying-revert-next"), "Continue");
      assert.notInclude((yield* ImportPeer).prompts.at(-1)!, "Question 1");
    }),
    { nativeIdFactory: () => `carrying-native-${generation++}` },
  );
});

it.live("native empty-prefix forks send only the new request without a history handoff", () =>
  withImporter(
    Effect.gen(function* () {
      const { lease } = yield* leaseFor(importFixture({ turns: 2 }));
      const { result } = yield* importOnce(lease);
      const store = yield* ProjectionStoreV2;
      const source = yield* store.getThreadProjection(result.threadId);
      const first = source.messages.find((message) => message.text === "Question 1")!;
      const childId = ThreadId.make("empty-prefix-native-send");
      yield* (yield* ConversationForkService).dispatch({
        type: "thread.fork",
        commandId: CommandId.make("empty-prefix-native-send"),
        originThreadId: result.threadId,
        newThreadId: childId,
        sourceUserMessageId: first.id,
        workspaceMode: "local",
      });
      const empty = yield* store.getThreadProjection(childId);
      assert.deepEqual(empty.messages, []);
      assert.deepEqual(
        empty.turnItems.map((item) => item.type),
        ["fork"],
      );
      yield* continueImport(childId, MessageId.make("empty-prefix-continue"), "Continue");
      const prompt = (yield* ImportPeer).prompts.at(-1)!;
      assert.equal(prompt, "Continue");
      const completed = yield* store.getThreadProjection(childId);
      assert.deepEqual(completed.contextHandoffs, []);
      assert.isTrue(completed.contextTransfers.every((transfer) => transfer.status === "consumed"));
      assert.deepEqual(
        (yield* store.getThreadProjection(result.threadId)).messages,
        source.messages,
      );
    }),
  ),
);

it.live(
  "native retained revert delivers frozen history to an unrelated replacement session",
  () => {
    let generation = 0;
    let failResume = false;
    return withImporter(
      Effect.gen(function* () {
        const { lease } = yield* leaseFor(importFixture({ turns: 2 }));
        const sourceId = (yield* importOnce(lease)).result.threadId;
        const store = yield* ProjectionStoreV2;
        const source = yield* store.getThreadProjection(sourceId);
        const childId = ThreadId.make("retained-revert-replacement");
        yield* (yield* ConversationForkService).dispatch({
          type: "thread.fork",
          commandId: CommandId.make("retained-revert-replacement"),
          originThreadId: sourceId,
          newThreadId: childId,
          sourceAssistantMessageId: source.messages.find((message) => message.text === "Answer 2")!
            .id,
          workspaceMode: "local",
        });
        yield* continueImport(childId, MessageId.make("retained-delivery"), "Continue");
        const carrying = yield* store.getThreadProjection(childId);
        const carrier = carrying.runs.at(-1)!;
        const owner = carrying.providerThreads.find(
          (thread) => thread.id === carrying.thread.activeProviderThreadId,
        )!;
        assert.isTrue(
          carrying.contextHandoffs.some(
            (handoff) =>
              handoff.targetRunId === carrier.id &&
              handoff.delivery?.nativeThreadId === owner.nativeThreadRef?.nativeId &&
              handoff.delivery?.status === "inline",
          ),
        );
        yield* continueImport(childId, MessageId.make("remove-later-turn"), "Temporary follow-up");
        const reverted = yield* rollbackToBaseline(childId, "retained-carrier", carrier.ordinal);
        assert.equal(reverted.runs.find((run) => run.id === carrier.id)?.status, "completed");
        assert.equal(reverted.runs.at(-1)?.status, "rolled_back");
        assert.equal(
          reverted.providerThreads.find((thread) => thread.id === owner.id)?.nativeThreadRef
            ?.nativeId,
          owner.nativeThreadRef?.nativeId,
        );
        const visible = yield* readThread(childId);
        assert.isTrue(visible.messages.some((message) => message.text === "Continued"));
        assert.isFalse(visible.messages.some((message) => message.text === "Temporary answer"));
        yield* (yield* OrchestratorV2).dispatch({
          type: "provider-session.detach",
          commandId: CommandId.make("lose-retained-native-session"),
          threadId: childId,
          providerSessionId: owner.providerSessionId!,
        });
        failResume = true;
        yield* continueImport(childId, MessageId.make("fresh-after-retained-revert"), "Continue");
        const replacement = yield* store.getThreadProjection(childId);
        const fresh = replacement.providerThreads.find(
          (thread) => thread.id === replacement.thread.activeProviderThreadId,
        )!;
        assert.notEqual(fresh.nativeThreadRef?.nativeId, owner.nativeThreadRef?.nativeId);
        const prompt = (yield* ImportPeer).prompts.at(-1)!;
        assert.equal(prompt.split("Question 1").length - 1, 1);
        assert.equal(prompt.split("Answer 2").length - 1, 1);
        assert.notInclude(prompt, "Temporary answer");
        assert.isTrue(
          replacement.contextHandoffs.some(
            (handoff) =>
              handoff.delivery?.nativeThreadId === fresh.nativeThreadRef?.nativeId &&
              handoff.delivery?.status === "inline",
          ),
        );
      }),
      {
        nativeIdFactory: () => `retained-native-${generation++}`,
        onResume: () =>
          failResume
            ? Effect.fail(new NativeSessionOperationError({ detail: "Retained session was lost" }))
            : Effect.void,
      },
    );
  },
);

it.live(
  "native interrupted replacement recovery retains pending history across SQLite reopen",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "native-pending-handoff-restart-",
        });
        const database = makeSqlitePersistenceLive(NodePath.join(directory, "history.sqlite")).pipe(
          Layer.provide(NodeServices.layer),
        );
        const config = yield* ServerConfig;
        const runtimeOptions = {
          layerDatabase: database,
          layerServerConfig: Layer.succeed(ServerConfig, config),
        };
        const replacing = yield* Deferred.make<void>();
        let pauseReplacement = false;
        let failSend = true;
        let generation = 0;
        const resumed: string[] = [];
        const options = {
          runtimeOptions,
          nativeIdFactory: () => `uncertain-native-${generation++}`,
          beforeFresh: () =>
            pauseReplacement
              ? Deferred.succeed(replacing, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
          beforeSend: () => {
            if (!failSend) return Effect.void;
            failSend = false;
            return Effect.fail(
              new NativeSessionOperationError({
                detail: "Transport dropped after receiving inline history",
              }),
            );
          },
          onResume: (nativeId: string) =>
            Effect.sync(() => {
              resumed.push(nativeId);
            }),
        };
        const uncertain = yield* withImporter(
          Effect.gen(function* () {
            const { lease } = yield* leaseFor(importFixture({ turns: 2 }));
            const threadId = (yield* importOnce(lease)).result.threadId;
            assert.equal(
              (yield* Effect.exit(
                continueImport(threadId, MessageId.make("uncertain-original"), "Continue"),
              ))._tag,
              "Failure",
            );
            const store = yield* ProjectionStoreV2;
            const failed = yield* store.getThreadProjection(threadId);
            const pending = failed.contextHandoffs.find(
              (handoff) => handoff.delivery?.status === "pending",
            )!;
            assert.ok(pending);
            assert.equal(failed.runs.at(-1)?.status, "failed");
            pauseReplacement = true;
            yield* (yield* OrchestratorV2).dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("prepare-uncertain-replacement"),
              threadId,
              messageId: MessageId.make("uncertain-replacement-request"),
              text: "Continue",
              dispatchMode: { type: "start_immediately" },
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            });
            yield* Deferred.await(replacing).pipe(Effect.timeout("10 seconds"));
            const interrupted = yield* store.getThreadProjection(threadId);
            assert.isTrue(
              interrupted.contextHandoffs.some(
                (handoff) =>
                  handoff.id === pending.id &&
                  handoff.delivery?.status === "pending" &&
                  handoff.delivery.nativeThreadId === pending.delivery?.nativeThreadId,
              ),
            );
            assert.equal(
              interrupted.providerThreads.find(
                (thread) => thread.id === interrupted.thread.activeProviderThreadId,
              )?.nativeThreadRef?.nativeId,
              pending.delivery?.nativeThreadId,
            );
            assert.deepEqual(resumed, []);
            return { threadId, nativeId: pending.delivery!.nativeThreadId, handoffId: pending.id };
          }),
          options,
        );
        // Closing the runtime interrupts the provider call before replacement ownership commits.
        pauseReplacement = false;
        yield* withImporter(
          Effect.gen(function* () {
            const store = yield* ProjectionStoreV2;
            const before = yield* store.getThreadProjection(uncertain.threadId);
            assert.isTrue(
              before.contextHandoffs.some(
                (handoff) =>
                  handoff.id === uncertain.handoffId && handoff.delivery?.status === "pending",
              ),
            );
            yield* continueImport(
              uncertain.threadId,
              MessageId.make("retry-after-replacement-crash"),
              "Continue",
            );
            const recovered = yield* store.getThreadProjection(uncertain.threadId);
            const fresh = recovered.providerThreads.find(
              (thread) => thread.id === recovered.thread.activeProviderThreadId,
            )!;
            assert.notEqual(fresh.nativeThreadRef?.nativeId, uncertain.nativeId);
            const prompt = (yield* ImportPeer).prompts.at(-1)!;
            assert.equal(prompt.split("Question 1").length - 1, 1);
            assert.equal(prompt.split("Answer 2").length - 1, 1);
            assert.notInclude(resumed, uncertain.nativeId);
            assert.isTrue(
              recovered.contextHandoffs.some(
                (handoff) =>
                  handoff.delivery?.nativeThreadId === fresh.nativeThreadRef?.nativeId &&
                  handoff.delivery?.status === "inline",
              ),
            );
            yield* continueImport(
              uncertain.threadId,
              MessageId.make("after-recovered-delivery"),
              "Continue",
            );
            assert.notInclude((yield* ImportPeer).prompts.at(-1)!, "Question 1");
          }),
          {
            ...options,
            runtimeOptions: { ...runtimeOptions, recoverOnStartup: true },
            initialTime: Date.parse("2026-09-28T09:32:00.000Z"),
          },
        );
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "native-handoff-review-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.timeout("40 seconds"),
      ),
    ),
);

it.live(
  "a fork stays as it was when its source rolls back, and pages, counts, rebuilds and exports its shared history",
  () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({
          turns: 3,
          reasoning: true,
          workLog: true,
          attachments: true,
        });
        const { lease } = yield* leaseFor(fixture);
        const sourceId = (yield* importOnce(lease)).result.threadId;
        const store = yield* ProjectionStoreV2;
        const forks = yield* ConversationForkService;
        yield* continueImport(sourceId, MessageId.make("frozen-live-request"), "Continue");
        const live = yield* store.getThreadProjection(sourceId);
        const answer = live.messages.find((message) => message.text === "Continued")!;
        const forkId = ThreadId.make("frozen-live-fork");
        yield* forks.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("frozen-live-fork"),
          originThreadId: sourceId,
          newThreadId: forkId,
          sourceAssistantMessageId: answer.id,
          workspaceMode: "local",
        });
        const frozen = yield* store.getThreadProjection(forkId);
        const inherited = frozen.visibleTurnItems.filter((row) => row.visibility === "inherited");
        assert.isAbove(inherited.length, 0);
        // Settled history is shared; the fork copies only what it can act on.
        for (const row of inherited)
          if (row.sourceThreadId !== sourceId) {
            assert.equal(row.sourceThreadId, forkId);
            assert.include(["proposed_plan", "todo_list", "handoff"], row.item.type);
          }
        assert.deepEqual(
          frozen.messages.slice(1).map((message) => message.text),
          ["Answer 1", "Question 2", "Answer 2", "Question 3", "Answer 3", "Continue", "Continued"],
        );
        const exported = (yield* readThread(forkId))!;
        assert.deepEqual(
          exported.messages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .map((message) => message.text),
          frozen.messages.map((message) => message.text),
        );

        // Settlement sees the fork's shared conversation as its activity.
        const latestShared = frozen.messages.findLast((message) => message.role === "user")!;
        assert.equal(
          DateTime.formatIso((yield* store.getThreadShell(forkId))!.latestUserMessageAt!),
          DateTime.formatIso(latestShared.updatedAt),
        );
        assert.equal(
          DateTime.formatIso(
            (yield* store.getSettlementCandidates(forkId))[0]!.latestUserMessageAt!,
          ),
          DateTime.formatIso(latestShared.updatedAt),
        );

        // The source takes its live turn back; the fork keeps what it showed.
        yield* rollbackToBaseline(sourceId, "frozen-live");
        assert.notInclude(
          (yield* readThread(sourceId))!.messages.map((message) => message.text),
          "Continued",
        );
        assert.deepEqual(yield* store.getThreadProjection(forkId), frozen);
        assert.deepEqual((yield* readThread(forkId))!, exported);

        // The bounded snapshot clients load keeps the messages its rows show.
        const snapshot = yield* store.getThreadSnapshotWindow(forkId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
        const bounded = buildBoundedThreadProjection({
          projection: snapshot.projection,
          snapshotSequence: snapshot.snapshotSequence,
        }).projection;
        const boundedMessages = new Set(bounded.messages.map((message) => message.id));
        for (const { item } of bounded.visibleTurnItems)
          if (item.type === "user_message" || item.type === "assistant_message")
            assert.isTrue(boundedMessages.has(item.messageId), item.messageId);
        assert.isTrue(boundedMessages.has(frozen.thread.forkLineage!.baselineAssistantMessageId!));
        // Counts, pages and windows read the same shared history.
        assert.equal(yield* store.getMessageCount(forkId), frozen.messages.length);
        assert.equal(
          (yield* store.getThreadShell(forkId))?.itemCount,
          frozen.visibleTurnItems.length,
        );
        const paged: Array<(typeof frozen.visibleTurnItems)[number]> = [];
        let afterPosition: number | undefined;
        while (true) {
          const page = yield* store.getTimelinePage(forkId, {
            limit: 3,
            view: "activity",
            ...(afterPosition === undefined ? {} : { afterPosition }),
          });
          paged.push(...page.items);
          if (!page.hasMore) break;
          afterPosition = page.items.at(-1)!.position;
        }
        assert.deepEqual(paged, frozen.visibleTurnItems);
        // A page anchored in shared history ends at its anchor.
        const anchor = frozen.visibleTurnItems.find(
          (row) => row.sourceThreadId === sourceId && row.item.type === "assistant_message",
        )!;
        const anchored = yield* store.getThreadSnapshotWindow(forkId, {
          rowLimit: 2,
          userTurnLimit: 1,
          anchorItemId: anchor.sourceItemId,
        });
        assert.equal(
          anchored.projection.visibleTurnItems.at(-1)?.sourceItemId,
          anchor.sourceItemId,
        );
        assert.isTrue(
          anchored.projection.visibleTurnItems.every((row) => row.sourceThreadId !== forkId),
        );
        const window = yield* store.getThreadSnapshotWindow(forkId, { rowLimit: 4 });
        assert.deepEqual(
          window.projection.visibleTurnItems.map((row) => row.item),
          frozen.visibleTurnItems
            .slice(-window.projection.visibleTurnItems.length)
            .map((row) => row.item),
        );

        // A projection rebuild replays events; the fork's shared history is unchanged.
        const verification = yield* ProjectionMaintenanceV2.use(
          (maintenance) => maintenance.rebuild,
        ).pipe(Effect.provide(projectionMaintenanceLayer));
        assert.isTrue(verification.valid);
        const rebuilt = yield* store.getThreadProjection(forkId);
        assert.deepEqual(rebuilt.visibleTurnItems, frozen.visibleTurnItems);
        assert.deepEqual(rebuilt.messages, frozen.messages);

        // Rewriting history the fork shows leaves the fork as it was.
        const shownText = (projection: typeof frozen) => ({
          items: projection.visibleTurnItems.map(({ item }) =>
            "text" in item ? [item.type, item.text] : [item.type],
          ),
          messages: projection.messages.map((message) => [message.role, message.text]),
        });
        const shownBefore = shownText(frozen);
        const sharedAnswer = frozen.visibleTurnItems.find(
          (row) => row.sourceThreadId === sourceId && row.item.type === "assistant_message",
        )!;
        const storedAnswer = (yield* store.getThreadProjection(sourceId)).turnItems.find(
          (item) => item.id === sharedAnswer.sourceItemId,
        )!;
        assert.ok(storedAnswer.type === "assistant_message");
        const storedQuestion = (yield* store.getThreadProjection(sourceId)).messages.find(
          (message) => message.text === "Question 2",
        )!;
        const rewriteAt = yield* DateTime.now;
        yield* (yield* EventSinkV2).write({
          events: [
            {
              id: EventId.make("frozen-live-rewrite-item"),
              threadId: sourceId,
              type: "turn-item.updated",
              occurredAt: rewriteAt,
              payload: { ...storedAnswer, text: "Rewritten answer" },
            },
            {
              id: EventId.make("frozen-live-rewrite-message"),
              threadId: sourceId,
              type: "message.updated",
              occurredAt: rewriteAt,
              payload: { ...storedQuestion, text: "Rewritten question" },
            },
          ],
        });
        assert.include(
          (yield* store.getThreadProjection(sourceId)).messages.map((message) => message.text),
          "Rewritten question",
        );
        const afterRewrite = yield* store.getThreadProjection(forkId);
        assert.deepEqual(shownText(afterRewrite), shownBefore);
        // Nothing a loaded client holds changes identity, and the baseline stays.
        assert.deepEqual(
          afterRewrite.visibleTurnItems.map((row) => [row.sourceThreadId, row.sourceItemId]),
          frozen.visibleTurnItems.map((row) => [row.sourceThreadId, row.sourceItemId]),
        );
        assert.equal(
          afterRewrite.thread.forkLineage?.baselineAssistantMessageId,
          frozen.thread.forkLineage?.baselineAssistantMessageId,
        );
        assert.include(
          afterRewrite.messages.map((message) => message.id),
          frozen.thread.forkLineage?.baselineAssistantMessageId,
        );
        // Detail reads go through the fork, which serves the version it shows.
        const shownAnswer = afterRewrite.visibleTurnItems.find(
          (row) => row.sourceItemId === sharedAnswer.sourceItemId,
        )!.item;
        assert.equal(shownAnswer.threadId, forkId);
        const detail = yield* store.getTurnItem({
          threadId: shownAnswer.threadId,
          itemId: sharedAnswer.sourceItemId,
        });
        assert.ok(detail?.type === "assistant_message");
        assert.equal(detail.text, storedAnswer.text);
        // A fork of the fork shows what the fork shows.
        const grandchildId = ThreadId.make("frozen-live-grandchild");
        yield* forks.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("frozen-live-grandchild"),
          originThreadId: forkId,
          newThreadId: grandchildId,
          sourceAssistantMessageId: frozen.thread.forkLineage!.baselineAssistantMessageId!,
          workspaceMode: "local",
        });
        const grandchild = shownText(yield* store.getThreadProjection(grandchildId));
        assert.deepEqual(grandchild.messages, shownBefore.messages);
        assert.deepEqual(grandchild.items.slice(0, -1), shownBefore.items.slice(0, -1));
        yield* ProjectionMaintenanceV2.use((maintenance) => maintenance.rebuild).pipe(
          Effect.provide(projectionMaintenanceLayer),
        );
        assert.deepEqual(shownText(yield* store.getThreadProjection(forkId)), shownBefore);
        assert.deepEqual(
          shownText(yield* store.getThreadProjection(grandchildId)).messages,
          shownBefore.messages,
        );

        // The fork can queue a file its shared history shows.
        const sharedFile = frozen.messages.flatMap((message) => message.attachments)[0]!;
        assert.notEqual(
          parseThreadSegmentFromAttachmentId(sharedFile.id),
          toSafeThreadAttachmentSegment(forkId),
        );
        yield* (yield* OrchestratorV2).dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("frozen-live-busy"),
          threadId: forkId,
          messageId: MessageId.make("frozen-live-busy"),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* (yield* OrchestratorV2).dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("frozen-live-resend"),
          threadId: forkId,
          messageId: MessageId.make("frozen-live-resend"),
          text: "Look at this again",
          attachments: [sharedFile],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queued = yield* store.getThreadProjection(forkId);
        assert.equal(
          queued.runs.find((run) => run.userMessageId === "frozen-live-resend")?.status,
          "queued",
        );
        assert.deepEqual(
          queued.messages.find((message) => message.id === "frozen-live-resend")?.attachments,
          [sharedFile],
        );
      }),
    ).pipe(Effect.timeout("60 seconds")),
);

it.live("file release ignores name case and subagent conversations' copied fork metadata", () =>
  withImporter(
    Effect.gen(function* () {
      const { lease } = yield* leaseFor(importFixture({ turns: 2, attachments: true }));
      const sourceId = (yield* importOnce(lease)).result.threadId;
      const store = yield* ProjectionStoreV2;
      const forks = yield* ConversationForkService;
      const orchestrator = yield* OrchestratorV2;
      const source = yield* store.getThreadProjection(sourceId);
      const forkId = ThreadId.make("release-rules-fork");
      yield* forks.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("release-rules-fork"),
        originThreadId: sourceId,
        newThreadId: forkId,
        sourceAssistantMessageId: source.messages.findLast(
          (message) => message.role === "assistant",
        )!.id,
        workspaceMode: "local",
      });
      const fork = yield* store.getThreadProjection(forkId);
      const file = fork.thread.conversationFork!.attachmentCopies[0]!.source;
      const now = yield* DateTime.now;
      const prompt = fork.messages.find((message) => message.role === "user")!;
      // The fork names the shared file under an uppercase alias.
      yield* (yield* EventSinkV2).write({
        events: [
          {
            id: EventId.make("release-rules-alias"),
            threadId: forkId,
            type: "message.updated",
            occurredAt: now,
            payload: {
              ...prompt,
              id: MessageId.make("release-rules-alias"),
              threadId: forkId,
              attachments: [{ ...file, id: ChatAttachmentId.make(file.id.toUpperCase()) }],
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("release-rules-delete-fork"),
        threadId: forkId,
      });
      // The source still shows the file, in any case.
      assert.isFalse(
        (yield* store.getReleasableFiles(forkId)).some(
          (id) => id.toLowerCase() === file.id.toLowerCase(),
        ),
      );
      // A subagent conversation of a fork carries its fork metadata but shows none of it.
      const otherForkId = ThreadId.make("release-rules-other-fork");
      yield* forks.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("release-rules-other-fork"),
        originThreadId: sourceId,
        newThreadId: otherForkId,
        sourceAssistantMessageId: source.messages.findLast(
          (message) => message.role === "assistant",
        )!.id,
        workspaceMode: "local",
      });
      const otherFork = yield* store.getThreadProjection(otherForkId);
      yield* (yield* EventSinkV2).write({
        events: [
          {
            id: EventId.make("release-rules-subagent"),
            threadId: ThreadId.make("release-rules-subagent"),
            type: "thread.created",
            occurredAt: now,
            payload: {
              ...otherFork.thread,
              id: ThreadId.make("release-rules-subagent"),
              lineage: {
                parentThreadId: otherForkId,
                rootThreadId: otherFork.thread.lineage.rootThreadId,
                relationshipToParent: "subagent",
              },
              forkedFrom: { type: "node", nodeId: NodeId.make("release-rules-node") },
              historyOrigin: undefined,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      for (const threadId of [sourceId, otherForkId])
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`release-rules-delete-${threadId}`),
          threadId,
        });
      assert.include(yield* store.getReleasableFiles(otherForkId), file.id);
    }),
  ),
);

it.live(
  "fork file release keeps files other conversations name and waits for admissions holding them",
  () =>
    withImporter(
      Effect.gen(function* () {
        const { lease } = yield* leaseFor(importFixture({ turns: 2, attachments: true }));
        const sourceId = (yield* importOnce(lease)).result.threadId;
        const store = yield* ProjectionStoreV2;
        const forks = yield* ConversationForkService;
        const orchestrator = yield* OrchestratorV2;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const source = yield* store.getThreadProjection(sourceId);
        const forkId = ThreadId.make("guarded-release-fork");
        yield* forks.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("guarded-release-fork"),
          originThreadId: sourceId,
          newThreadId: forkId,
          sourceAssistantMessageId: source.messages.findLast(
            (message) => message.role === "assistant",
          )!.id,
          workspaceMode: "local",
        });
        const files = (yield* store.getThreadProjection(
          forkId,
        )).thread.conversationFork!.attachmentCopies.map((copy) => copy.source);
        assert.isAtLeast(files.length, 2);
        const [sent, held] = [files[0]!, files[1]!];
        // An unrelated conversation was sent one of the files.
        const otherId = ThreadId.make("guarded-release-other");
        const now = yield* DateTime.now;
        const prompt = source.messages.find((message) => message.role === "user")!;
        yield* (yield* EventSinkV2).write({
          events: [
            {
              id: EventId.make("guarded-release-other-created"),
              threadId: otherId,
              type: "thread.created",
              occurredAt: now,
              payload: {
                ...source.thread,
                id: otherId,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: otherId,
                },
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("guarded-release-other-message"),
              threadId: otherId,
              type: "message.updated",
              occurredAt: now,
              payload: {
                ...prompt,
                id: MessageId.make("guarded-release-other-message"),
                threadId: otherId,
                attachments: [sent],
              },
            },
          ],
        });
        // An admission holds the other file while the lineage is deleted.
        const pin = yield* reserveAttachment(held);
        for (const threadId of [sourceId, forkId])
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`guarded-release-delete-${threadId}`),
            threadId,
          });
        const release = yield* ThreadFileRelease.pipe(Effect.provide(threadFileReleaseLayer));
        const path = (attachment: (typeof files)[number]) =>
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
        const deferred = yield* Effect.flip(release.release(forkId));
        assert.equal(deferred._tag, "ThreadFileReleaseDeferred");
        assert.isTrue(yield* fs.exists(path(held)));
        assert.isTrue(yield* fs.exists(path(sent)));
        yield* pin.release;
        yield* release.release(forkId);
        assert.isFalse(yield* fs.exists(path(held)));
        assert.isTrue(yield* fs.exists(path(sent)));
      }),
    ),
);

it.live(
  "file release keeps a file any live conversation or fork shows, and frees it once none does",
  () =>
    withImporter(
      Effect.gen(function* () {
        const { lease } = yield* leaseFor(importFixture({ turns: 2, attachments: true }));
        const sourceId = (yield* importOnce(lease)).result.threadId;
        const store = yield* ProjectionStoreV2;
        const forks = yield* ConversationForkService;
        const orchestrator = yield* OrchestratorV2;
        const sink = yield* EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const source = yield* store.getThreadProjection(sourceId);
        const forkId = ThreadId.make("reuse-release-fork");
        yield* forks.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("reuse-release-fork"),
          originThreadId: sourceId,
          newThreadId: forkId,
          sourceAssistantMessageId: source.messages.findLast(
            (message) => message.role === "assistant",
          )!.id,
          workspaceMode: "local",
        });
        const fork = yield* store.getThreadProjection(forkId);
        const file = fork.thread.conversationFork!.attachmentCopies[0]!.source;
        const now = yield* DateTime.now;
        const prompt = source.messages.find((message) => message.role === "user")!;
        // An unrelated conversation that was sent `files`.
        const conversation = (threadId: ThreadId, files: ReadonlyArray<typeof file>) =>
          sink.write({
            events: [
              {
                id: EventId.make(`${threadId}-created`),
                threadId,
                type: "thread.created",
                occurredAt: now,
                payload: {
                  ...source.thread,
                  id: threadId,
                  lineage: {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: threadId,
                  },
                  conversationImport: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make(`${threadId}-message`),
                threadId,
                type: "message.updated",
                occurredAt: now,
                payload: {
                  ...prompt,
                  id: MessageId.make(`${threadId}-message`),
                  threadId,
                  attachments: files,
                },
              },
            ],
          });
        const remove = (threadId: ThreadId) =>
          orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`reuse-release-delete-${threadId}`),
            threadId,
          });
        const released = (threadId: ThreadId) =>
          store
            .getReleasableFiles(threadId)
            .pipe(Effect.map((ids) => ids.map((id) => id.toLowerCase())));

        // Deleting a conversation outside any fork lineage that reused the file
        // keeps it for the source and fork, and frees the conversation's own file.
        const otherId = ThreadId.make("reuse-release-other");
        const own = { ...file, id: ChatAttachmentId.make(createAttachmentId(otherId, "png")!) };
        yield* conversation(otherId, [file, own]);
        yield* remove(otherId);
        assert.deepEqual(yield* released(otherId), [own.id.toLowerCase()]);

        // A conversation that reused the file forks; deleting it leaves its fork
        // showing the file through history only.
        const reuserId = ThreadId.make("reuse-release-reuser");
        const reuserForkId = ThreadId.make("reuse-release-reuser-fork");
        yield* conversation(reuserId, [file]);
        yield* sink.write({
          events: [
            {
              id: EventId.make("reuse-release-reuser-fork-created"),
              threadId: reuserForkId,
              type: "thread.created",
              occurredAt: now,
              payload: {
                ...fork.thread,
                id: reuserForkId,
                lineage: {
                  parentThreadId: reuserId,
                  relationshipToParent: "fork",
                  rootThreadId: reuserId,
                },
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        yield* sql`
          INSERT INTO scient_fork_history
            (thread_id, position, source_thread_id, source_item_id, item_type, message_id,
             turn_start, user_turn)
          VALUES (${reuserForkId}, 0, ${reuserId}, 'reuse-release-item', 'user_message',
            ${`${reuserId}-message`}, 1, 1)
        `;
        yield* remove(reuserId);
        assert.notInclude(yield* released(reuserId), file.id.toLowerCase());

        // The original lineage goes: the reuser's live fork still shows the file.
        yield* remove(sourceId);
        yield* remove(forkId);
        assert.notInclude(yield* released(forkId), file.id.toLowerCase());
        assert.notInclude(yield* released(sourceId), file.id.toLowerCase());

        // The last conversation showing it goes: the file is freed, though
        // another lineage minted it.
        yield* remove(reuserForkId);
        assert.include(yield* released(reuserForkId), file.id.toLowerCase());

        // A tool's output can name any file: deleting its conversation frees
        // only pages minted there, never another conversation's page.
        const toolPage = (threadId: ThreadId, page: string) => ({
          id: EventId.make(`${threadId}-tool`),
          threadId,
          type: "turn-item.updated" as const,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${threadId}-tool`),
            type: "dynamic_tool" as const,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed" as const,
            title: "Weather",
            toolName: "weather.get_weather",
            input: {},
            output: {
              t3McpApp: {
                attachmentId: page,
                server: "weather",
                tool: "get_weather",
                resourceUri: "ui://weather/dashboard",
              },
            },
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        });
        const pageOwnerId = ThreadId.make("reuse-release-page-owner");
        const toolId = ThreadId.make("reuse-release-tool");
        const ownersPage = createAttachmentId(pageOwnerId, "html")!;
        const toolsPage = createAttachmentId(toolId, "html")!;
        yield* conversation(pageOwnerId, []);
        yield* conversation(toolId, []);
        yield* sink.write({
          events: [toolPage(pageOwnerId, ownersPage), toolPage(toolId, toolsPage)],
        });
        yield* sink.write({
          events: [
            {
              ...toolPage(toolId, ownersPage),
              id: EventId.make("reuse-release-tool-foreign"),
              payload: {
                ...toolPage(toolId, ownersPage).payload,
                id: TurnItemId.make("reuse-release-tool-foreign"),
                ordinal: 2,
              },
            },
          ],
        });
        yield* remove(toolId);
        assert.deepEqual(yield* released(toolId), [toolsPage.toLowerCase()]);
      }),
    ),
);

it.live("opening a recent fork window never reads its older copies", () =>
  withImporter(
    Effect.gen(function* () {
      const { lease } = yield* leaseFor(importFixture({ turns: 3 }));
      const sourceId = (yield* importOnce(lease)).result.threadId;
      const store = yield* ProjectionStoreV2;
      for (const index of [4, 5, 6])
        yield* continueImport(sourceId, MessageId.make(`later-${index}`), "Continue");
      const source = yield* store.getThreadProjection(sourceId);
      const forkId = ThreadId.make("recent-window-fork");
      yield* (yield* ConversationForkService).dispatch({
        type: "thread.fork",
        commandId: CommandId.make("recent-window-fork"),
        originThreadId: sourceId,
        newThreadId: forkId,
        sourceAssistantMessageId: source.messages.findLast(
          (message) => message.role === "assistant",
        )!.id,
        workspaceMode: "local",
      });
      const plan = (yield* store.getThreadProjection(forkId)).turnItems.find(
        (item) => item.type === "proposed_plan",
      )!;
      const tripwire = Effect.fn("test.tripwire")(function* (
        anchorItemId?: TurnItemId,
        rowsOnly = false,
      ) {
        // The fork's own copy of the old plan cannot be decoded.
        yield* (yield* SqlClient.SqlClient)`
          UPDATE orchestration_v2_projection_turn_items SET payload_json = '{invalid-copy-tripwire'
          WHERE turn_item_id = ${plan.id}`;
        const window = yield* store.getThreadSnapshotWindow(
          forkId,
          rowsOnly
            ? { rowLimit: 2 }
            : {
                rowLimit: 10,
                userTurnLimit: 1,
                ...(anchorItemId === undefined ? {} : { anchorItemId }),
              },
        );
        assert.isFalse(
          window.projection.visibleTurnItems.some((row) => row.sourceItemId === plan.id),
        );
        return window;
      });
      const stored = yield* (yield* SqlClient.SqlClient)<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = ${plan.id}`;
      assert.equal((yield* tripwire()).projection.visibleTurnItems.at(-1)?.item.type, "fork");
      // A row-only window too (the older compatibility endpoint).
      assert.equal(
        (yield* tripwire(undefined, true)).projection.visibleTurnItems.at(-1)?.item.type,
        "fork",
      );
      yield* (yield* SqlClient.SqlClient)`
        UPDATE orchestration_v2_projection_turn_items SET payload_json = ${stored[0]!.payload_json}
        WHERE turn_item_id = ${plan.id}`;
      // Nor after a turn of the fork's own is rolled back.
      yield* continueImport(forkId, MessageId.make("recent-window-local"), "Temporary follow-up");
      yield* rollbackToBaseline(forkId, "recent-window");
      yield* tripwire();
      yield* (yield* SqlClient.SqlClient)`
        UPDATE orchestration_v2_projection_turn_items SET payload_json = ${stored[0]!.payload_json}
        WHERE turn_item_id = ${plan.id}`;
      // Nor a page anchored on a turn of the fork's own.
      yield* continueImport(forkId, MessageId.make("recent-window-anchor"), "Continue");
      const anchorItem = (yield* store.getThreadProjection(forkId)).turnItems.findLast(
        (item) => item.type === "user_message",
      )!;
      const anchored = yield* tripwire(anchorItem.id);
      assert.equal(anchored.projection.visibleTurnItems.at(-1)?.sourceItemId, anchorItem.id);
    }),
  ),
);

it.live(
  "native fork history and question files survive deletion, rollback, replay and refork",
  () => {
    const shown = (projection: {
      readonly visibleTurnItems: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>;
    }) => projection.visibleTurnItems.map((row) => row.item);
    return withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({
          turns: 3,
          reasoning: true,
          workLog: true,
          attachments: true,
        });
        const snapshot = {
          ...fixture.input.snapshot,
          messages: fixture.input.snapshot.messages
            .filter((message) => message.id !== "src-assistant-2")
            .map((message, index) => ({ ...message, n: index + 1 })),
        };
        const prepared = {
          ...fixture,
          input: {
            ...fixture.input,
            snapshot,
            package: {
              ...fixture.input.package,
              contentDigest: conversationContentDigest(snapshot),
            },
          },
        };
        const { lease } = yield* leaseFor(prepared);
        const sourceId = (yield* importOnce(lease)).result.threadId;
        const store = yield* ProjectionStoreV2;
        const forks = yield* ConversationForkService;
        const orchestrator = yield* OrchestratorV2;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const source = yield* store.getThreadProjection(sourceId);
        const childId = ThreadId.make("durable-history-fork");
        const command: import("@t3tools/contracts").ThreadForkCommand = {
          type: "thread.fork",
          commandId: CommandId.make("durable-history-fork"),
          originThreadId: sourceId,
          newThreadId: childId,
          sourceAssistantMessageId: source.messages.find((message) => message.text === "Answer 3")!
            .id,
          workspaceMode: "local",
        };
        const peer = yield* ImportPeer;
        yield* Effect.sleep("1 second").pipe(
          Effect.andThen(peer.setTime(Date.parse("2026-09-28T09:31:00.000Z"))),
          Effect.forkScoped,
        );
        const receipt = yield* forks.dispatch(command);
        const frozen = yield* store.getThreadProjection(childId);
        const baseline = (yield* readThread(childId))!;
        const inherited = frozen.visibleTurnItems
          .filter((row) => row.visibility === "inherited")
          .map((row) => row.item);
        assert.isAbove(inherited.length, 0);
        const files = frozen.thread.conversationFork!.attachmentCopies;
        assert.isAbove(files.length, 0);
        const bytes = new Map<string, Uint8Array>();
        for (const copy of files) {
          // The fork shares the source's files.
          assert.deepEqual(copy.target, copy.source);
          const path = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: copy.target,
          })!;
          bytes.set(copy.target.id, yield* fs.readFile(path));
        }
        const question = inherited.find((item) => item.type === "user_input_request");
        assert.ok(question?.type === "user_input_request" && question.questionAnswer);
        const questionFiles = Object.values(question.questionAnswer.attachmentsByQuestionId).flat();
        assert.isAbove(questionFiles.length, 0);
        assert.isTrue(questionFiles.every((file) => bytes.has(file.id)));
        assert.deepEqual(frozen.providerSessions, []);
        assert.deepEqual(frozen.runtimeRequests, []);
        const unanswered = inherited.find(
          (item) => item.type === "user_message" && item.text === "Question 2",
        )!;
        assert.ok(unanswered.historyTurnId);
        assert.deepEqual(
          inherited
            .filter((item) => item.historyTurnId === unanswered.historyTurnId)
            .map((item) => item.type),
          ["user_message", "reasoning", "dynamic_tool"],
        );
        assert.equal(inherited.filter((item) => item.type === "reasoning").length, 3);
        assert.equal(inherited.filter((item) => item.type === "dynamic_tool").length, 3);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename-durable-source"),
          threadId: sourceId,
          title: "Renamed source",
        });
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename-durable-child"),
          threadId: childId,
          title: "Independent child",
        });
        const selection = { instanceId: ProviderInstanceId.make("claude"), model: "chosen-model" };
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("durable-child-model"),
          threadId: childId,
          modelSelection: selection,
        });
        const renamed = yield* store.getThreadProjection(childId);
        assert.equal(renamed.thread.forkLineage?.originThreadId, sourceId);
        assert.deepEqual(renamed.messages, frozen.messages);
        assert.deepEqual(renamed.thread.modelSelection, selection);
        assert.deepEqual(renamed.providerSessions, []);
        const afterRename = yield* store.getThreadProjection(sourceId);
        assert.equal(afterRename.thread.title, "Renamed source");
        assert.deepEqual(afterRename.messages, source.messages);
        assert.deepEqual(afterRename.turnItems, source.turnItems);
        // The selected prefix now contains genuine execution owned by the child.
        yield* continueImport(childId, MessageId.make("durable-local-request"), "Continue");
        const withLocal = yield* store.getThreadProjection(childId);
        const localAnswer = withLocal.messages.find((message) => message.text === "Continued")!;
        assert.ok(localAnswer.runId);
        const localReforkId = ThreadId.make("durable-local-refork");
        yield* forks.dispatch({
          ...command,
          commandId: CommandId.make("durable-local-refork"),
          originThreadId: childId,
          newThreadId: localReforkId,
          sourceAssistantMessageId: localAnswer.id,
        });
        const localRefork = yield* store.getThreadProjection(localReforkId);
        assert.deepEqual(
          localRefork.messages.map((message) => message.text),
          withLocal.messages.map((message) => message.text),
        );
        assert.equal(
          localRefork.messages.filter((message) => message.text === "Question 2").length,
          1,
        );
        assert.equal(
          localRefork.messages.filter((message) => message.text === "Continue").length,
          1,
        );
        assert.equal(
          localRefork.messages.filter((message) => message.text === "Continued").length,
          1,
        );
        assert.deepEqual(localRefork.thread.modelSelection, selection);
        assert.equal(localRefork.thread.forkLineage?.originThreadId, childId);
        assert.deepEqual(localRefork.runs, []);
        assert.isTrue(
          shown(localRefork).every(
            (item) =>
              item.runId === null &&
              item.nativeItemRef === null &&
              (item.nodeId === null ||
                localRefork.nodes.some(
                  (node) =>
                    node.id === item.nodeId &&
                    node.runId === null &&
                    node.status === "completed" &&
                    !node.countsForRun &&
                    node.providerThreadId === null &&
                    node.providerTurnId === null &&
                    node.nativeItemRef === null,
                )),
          ),
        );
        yield* continueImport(
          childId,
          MessageId.make("durable-stale-request"),
          "Temporary follow-up",
        );
        const staleAnswer = (yield* store.getThreadProjection(childId)).messages.find(
          (message) => message.text === "Temporary answer",
        )!;
        yield* rollbackToBaseline(childId, "durable-history");
        const reverted = yield* store.getThreadProjection(childId);
        assert.deepEqual((yield* readThread(childId))!.messages, baseline.messages);
        assert.deepEqual(
          reverted.visibleTurnItems
            .filter((row) => row.visibility === "inherited")
            .map((row) => row.item),
          inherited,
        );
        assert.equal(
          reverted.thread.forkLineage?.baselineAssistantMessageId,
          frozen.thread.forkLineage?.baselineAssistantMessageId,
        );
        const failedCommand = {
          ...command,
          commandId: CommandId.make("durable-stale-fork"),
          originThreadId: childId,
          newThreadId: ThreadId.make("durable-stale-fork"),
          sourceAssistantMessageId: staleAnswer.id,
        };
        const beforeSequence = yield* orchestrator.getThreadEventSequence(childId);
        assert.equal((yield* Effect.exit(forks.dispatch(failedCommand)))._tag, "Failure");
        assert.equal(yield* orchestrator.getThreadEventSequence(childId), beforeSequence);
        assert.isNull(yield* store.getThreadShell(failedCommand.newThreadId));
        assert.isTrue(
          Option.isNone(
            yield* (yield* CommandReceiptStoreV2).getByCommandId(failedCommand.commandId),
          ),
        );
        const outbox = yield* EffectOutboxV2;
        const completion = yield* Stream.toPull(
          Stream.merge(yield* outbox.subscribeCompletions, Stream.tick("10 millis")),
        );
        const deleteThread = Effect.fn("test.deleteThread")(function* (threadId: ThreadId) {
          const commandId = CommandId.make(`durable-delete-${threadId}`);
          yield* orchestrator.dispatch({ type: "thread.delete", commandId, threadId });
          while (true) {
            const jobs = yield* outbox.listByCommandId(commandId);
            if (jobs.every((job) => ["succeeded", "failed", "cancelled"].includes(job.status))) {
              assert.isTrue(jobs.every((job) => job.status === "succeeded"));
              return;
            }
            yield* completion;
          }
        });
        yield* deleteThread(sourceId);
        assert.isNotNull((yield* store.getThreadProjection(sourceId)).thread.deletedAt);
        // The deleted source's files stay while a fork still shows its history.
        for (const copy of files) {
          const path = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: copy.target,
          })!;
          assert.deepEqual(yield* fs.readFile(path), bytes.get(copy.target.id));
        }
        assert.deepEqual(
          (yield* store.getThreadProjection(childId)).visibleTurnItems,
          reverted.visibleTurnItems,
        );
        const replayed = yield* forks.dispatch(command);
        assert.deepEqual(replayed, receipt);
        const verification = yield* ProjectionMaintenanceV2.use(
          (maintenance) => maintenance.rebuild,
        ).pipe(Effect.provide(projectionMaintenanceLayer));
        assert.isTrue(verification.valid);
        const rebuilt = yield* store.getThreadProjection(childId);
        assert.deepEqual(rebuilt.turnItems, reverted.turnItems);
        assert.deepEqual(rebuilt.visibleTurnItems, reverted.visibleTurnItems);
        assert.deepEqual((yield* readThread(childId))!.messages, baseline.messages);
        assert.deepEqual(rebuilt.thread.conversationFork?.attachmentCopies, files);
        const reforkId = ThreadId.make("durable-baseline-refork");
        yield* forks.dispatch({
          ...command,
          commandId: CommandId.make("durable-baseline-refork"),
          originThreadId: childId,
          newThreadId: reforkId,
          sourceAssistantMessageId: frozen.thread.forkLineage!.baselineAssistantMessageId!,
        });
        const refork = yield* store.getThreadProjection(reforkId);
        assert.deepEqual(
          (yield* readThread(reforkId))!.messages.map((message) => message.text),
          baseline.messages.map((message) => message.text),
        );
        assert.notInclude(
          refork.messages.map((message) => message.text),
          "Temporary answer",
        );
        assert.notInclude(
          refork.messages.map((message) => message.text),
          "Continued",
        );
        assert.equal(shown(refork).filter((item) => item.type === "reasoning").length, 3);
        assert.equal(shown(refork).filter((item) => item.type === "dynamic_tool").length, 3);
        const reforkQuestion = shown(refork).find((item) => item.type === "user_input_request");
        assert.ok(reforkQuestion?.type === "user_input_request" && reforkQuestion.questionAnswer);
        assert.equal(
          Object.values(reforkQuestion.questionAnswer.attachmentsByQuestionId).flat().length,
          questionFiles.length,
        );
        const reforkQuestionFiles = Object.values(
          reforkQuestion.questionAnswer.attachmentsByQuestionId,
        ).flat();
        const questionCopies = questionFiles.map((file) => {
          const matches = refork.thread.conversationFork!.attachmentCopies.filter(
            (copy) => copy.source.id === file.id,
          );
          assert.lengthOf(matches, 1);
          assert.deepEqual(matches[0]!.source, file);
          return matches[0]!;
        });
        assert.deepEqual(
          reforkQuestionFiles,
          questionCopies.map((copy) => copy.target),
        );
        for (const [index, file] of reforkQuestionFiles.entries()) {
          assert.equal(file.id, questionFiles[index]!.id);
          assert.deepEqual(
            yield* fs.readFile(
              resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment: file,
              })!,
            ),
            bytes.get(questionCopies[index]!.source.id),
          );
        }
        for (const copy of refork.thread.conversationFork!.attachmentCopies) {
          assert.isTrue(bytes.has(copy.source.id));
          assert.deepEqual(copy.target, copy.source);
          assert.deepEqual(
            yield* fs.readFile(
              resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment: copy.target,
              })!,
            ),
            bytes.get(copy.source.id),
          );
        }
        yield* continueImport(reforkId, MessageId.make("durable-refork-continue"), "Continue");
        const prompt = (yield* ImportPeer).prompts.at(-1)!;
        assert.equal(prompt.split("Question 2").length - 1, 1);
        assert.include(prompt, "Thinking about 2");
        assert.include(prompt, "Which figure?");
        assert.notInclude(prompt, "Temporary answer");
        const sent = (yield* ImportPeer).sends.at(-1)!;
        assert.equal(sent.threadId, reforkId);
        assert.equal(sent.message.text, prompt);
        assert.deepEqual(sent.message.attachments, []);
        const references = reforkQuestionFiles.map((file) => ({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          contentReattached: false as const,
        }));
        const encodedReferences = yield* encodeQuestionFileReferences(references);
        const suppliedAnswer = `Question: Which figure?\nAnswer: This one\nAttachment references (bytes not replayed): ${encodedReferences}`;
        assert.equal(sent.message.text.split(suppliedAnswer).length - 1, 1);
        const delivered = (yield* store.getThreadProjection(reforkId)).contextHandoffs.at(
          -1,
        )!.delivery!;
        assert.include(delivered.itemIds, reforkQuestion.id);
        assert.notInclude(delivered.omittedItemIds ?? [], reforkQuestion.id);
        // Deleting the last conversation that shows them releases the files.
        const paths = files.map((copy) =>
          resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: copy.source,
          })!,
        );
        yield* deleteThread(childId);
        yield* deleteThread(localReforkId);
        for (const path of paths) assert.isTrue(yield* fs.exists(path));
        yield* deleteThread(reforkId);
        for (const path of paths) assert.isFalse(yield* fs.exists(path));
      }),
      {
        runtimeOptions: {
          resourceCleanupLayer: resourceCleanupLayer.pipe(
            Layer.provide(Layer.mock(TerminalManager)({ close: () => Effect.void })),
          ),
        },
      },
    ).pipe(Effect.timeout("90 seconds"));
  },
);

it.live("native steering reaches an accepted carrying turn before its long send returns", () =>
  Effect.gen(function* () {
    const sending = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const steered = yield* Deferred.make<string>();
    let held = true;
    return yield* withImporter(
      Effect.gen(function* () {
        const { lease } = yield* leaseFor(importFixture({ turns: 2 }));
        const threadId = (yield* importOnce(lease)).result.threadId;
        const orchestrator = yield* OrchestratorV2;
        const store = yield* ProjectionStoreV2;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("long-carrying-send"),
          threadId,
          messageId: MessageId.make("long-carrying-send"),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* Deferred.await(sending).pipe(Effect.timeout("10 seconds"));
        const cursor = yield* orchestrator.getThreadEventSequence(threadId);
        const pull = yield* Stream.toPull(
          orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
        );
        const accepted = yield* Stream.concat(
          Stream.succeed(undefined),
          Stream.fromPull(Effect.succeed(pull)),
        ).pipe(
          Stream.mapEffect(() => store.getThreadProjection(threadId)),
          Stream.filter((projection) =>
            projection.providerTurns.some((turn) => turn.acceptedAt !== undefined),
          ),
          Stream.runHead,
          Effect.timeout("5 seconds"),
          Effect.catchTags({
            TimeoutError: () => Effect.die("Native acceptance never reached SQL"),
          }),
        );
        const before = Option.getOrThrow(accepted);
        const run = before.runs.at(-1)!;
        assert.equal(run.status, "running");
        assert.equal(before.contextHandoffs.at(-1)?.delivery?.status, "pending");
        assert.equal((yield* ImportPeer).prompts.length, 1);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer-held-carry"),
          threadId,
          messageId: MessageId.make("steer-held-carry"),
          text: "Use the retained evidence",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: run.id },
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(
          yield* Deferred.await(steered).pipe(
            Effect.timeout("5 seconds"),
            Effect.catchTags({
              TimeoutError: () => Effect.die("Steering remained blocked by the long send"),
            }),
          ),
          "Use the retained evidence",
        );
        assert.isFalse(yield* Deferred.isDone(release));
        const during = yield* store.getThreadProjection(threadId);
        assert.equal(during.runs.length, before.runs.length);
        assert.equal(during.contextHandoffs.length, before.contextHandoffs.length);
        assert.equal(during.contextHandoffs.at(-1)?.delivery?.status, "pending");
        assert.equal((yield* ImportPeer).prompts.length, 1);
        const completeCursor = yield* orchestrator.getThreadEventSequence(threadId);
        const completed = yield* orchestrator
          .streamStoredEventsFrom({ threadId, afterSequence: completeCursor })
          .pipe(
            Stream.mapEffect(() => store.getThreadProjection(threadId)),
            Stream.filter(
              (projection) =>
                projection.runs.find((candidate) => candidate.id === run.id)?.status ===
                  "completed" && projection.contextHandoffs.at(-1)?.delivery?.status === "inline",
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
        held = false;
        yield* Deferred.succeed(release, undefined);
        assert.isTrue(
          Option.isSome(yield* Fiber.join(completed).pipe(Effect.timeout("10 seconds"))),
        );
        assert.equal(
          (yield* store.getThreadProjection(threadId)).contextHandoffs.at(-1)?.delivery?.status,
          "inline",
        );
        yield* continueImport(threadId, MessageId.make("after-long-carry"), "Continue");
        assert.notInclude((yield* ImportPeer).prompts.at(-1)!, "Question 1");
      }),
      {
        beforeSend: () =>
          held
            ? Deferred.succeed(sending, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        onSteer: (text) => Deferred.succeed(steered, text).pipe(Effect.asVoid),
      },
    );
  }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
);

it.live(
  "native fork capacity persists across SQLite reopen and isolates selection and configuration",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "native-model-window-restart-",
        });
        const database = makeSqlitePersistenceLive(
          NodePath.join(directory, "capacity.sqlite"),
        ).pipe(Layer.provide(NodeServices.layer));
        const config = yield* ServerConfig;
        const runtimeOptions = {
          layerDatabase: database,
          layerServerConfig: Layer.succeed(ServerConfig, config),
        };
        const projectScope = yield* Scope.Scope;
        const selected = { instanceId: PROVIDER_ID, model: "reported-capacity-model" };
        const original = yield* withImporter(
          Effect.gen(function* () {
            const fixture = importFixture({ turns: 20 });
            const snapshot = {
              ...fixture.input.snapshot,
              messages: fixture.input.snapshot.messages.map((message) => ({
                ...message,
                text: `${message.text} ${"x".repeat(4_000)}`,
              })),
            };
            const expanded = {
              ...fixture,
              input: {
                ...fixture.input,
                snapshot,
                package: {
                  ...fixture.input.package,
                  contentDigest: conversationContentDigest(snapshot),
                },
              },
            };
            const { lease } = yield* leaseFor(expanded);
            const sourceId = (yield* importOnce(lease)).result.threadId;
            const store = yield* ProjectionStoreV2;
            const source = yield* store.getThreadProjection(sourceId);
            yield* (yield* ServerSettingsService).updateSettings({
              scientFork: { contextHandoffSize: "maximum" },
            });
            const threadId = ThreadId.make("reported-capacity-fork");
            yield* (yield* ConversationForkService).dispatch({
              type: "thread.fork",
              commandId: CommandId.make(threadId),
              originThreadId: sourceId,
              newThreadId: threadId,
              sourceAssistantMessageId: source.messages.at(-1)!.id,
              workspaceMode: "local",
            });
            yield* continueImport(
              threadId,
              MessageId.make("reported-window-send"),
              "Continue",
              selected,
            );
            const delivered = (yield* store.getThreadProjection(threadId)).contextHandoffs.at(
              -1,
            )!.delivery!;
            assert.isAbove(delivered.omittedItemIds!.length, 0);
            assert.isBelow(delivered.itemIds.length, source.turnItems.length);
            const rows = yield* (yield* SqlClient.SqlClient)<{
              readonly max_tokens: number;
            }>`SELECT max_tokens FROM scient_model_context_windows WHERE provider_instance_id = ${PROVIDER_ID}`;
            assert.isTrue(rows.some((row) => row.max_tokens === 20_000));
            return {
              fixture: expanded,
              sourceId,
              answerId: source.messages.at(-1)!.id,
              messages: source.messages,
              items: source.turnItems,
              included: delivered.itemIds.length,
            };
          }),
          { runtimeOptions, projectScope, modelContextWindow: () => 20_000 },
        );
        const opened = yield* Deferred.make<void>();
        const releaseOpen = yield* Deferred.make<void>();
        const lateTarget = ThreadId.make("capacity-reopen:late-preset");
        yield* withImporter(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.updateSettings({ scientFork: { contextHandoffSize: "maximum" } });
            const store = yield* ProjectionStoreV2;
            const deliver = (
              suffix: string,
              selection: import("@t3tools/contracts").ModelSelection,
            ) =>
              Effect.gen(function* () {
                const threadId = ThreadId.make(`capacity-reopen:${suffix}`);
                yield* (yield* ConversationForkService).dispatch({
                  type: "thread.fork",
                  commandId: CommandId.make(threadId),
                  originThreadId: original.sourceId,
                  newThreadId: threadId,
                  sourceAssistantMessageId: original.answerId,
                  workspaceMode: "local",
                });
                yield* continueImport(
                  threadId,
                  MessageId.make(`capacity-reopen:${suffix}`),
                  "Continue",
                  selection,
                );
                return (yield* store.getThreadProjection(threadId)).contextHandoffs.at(-1)!
                  .delivery!;
              });
            const cached = yield* deliver("same-selection", selected);
            assert.isAbove(cached.omittedItemIds!.length, 0);
            assert.isBelow(cached.itemIds.length, original.items.length);
            assert.isAtMost(Math.abs(cached.itemIds.length - original.included), 1);
            yield* settings.updateSettings({ scientFork: { contextHandoffSize: "compact" } });
            const late = yield* deliver("late-preset", selected).pipe(Effect.forkScoped);
            yield* Deferred.await(opened).pipe(Effect.timeout("10 seconds"));
            const prepared = (yield* store.getThreadProjection(lateTarget)).contextHandoffs.at(-1)!;
            assert.equal(prepared.budgetPolicy, "scient");
            assert.deepEqual(prepared.history!.omittedItemIds, []);
            assert.deepEqual(
              prepared.history!.messages.map((message) => message.text),
              original.items
                .flatMap((item) => historicalMessage(item) ?? [])
                .map((message) => message.text),
            );
            assert.isAbove(
              prepared.history!.messages.reduce((bytes, message) => bytes + message.text.length, 0),
              48_000,
            );
            assert.equal((yield* settings.getSettings).scientFork.contextHandoffSize, "compact");
            yield* settings.updateSettings({ scientFork: { contextHandoffSize: "large" } });
            yield* Deferred.succeed(releaseOpen, undefined);
            const lateDelivery = yield* Fiber.join(late);
            assert.isAbove(lateDelivery.omittedItemIds!.length, 0);
            assert.isBelow(lateDelivery.itemIds.length, original.items.length);
            assert.isAtMost(Math.abs(lateDelivery.itemIds.length - original.included), 1);
            assert.isTrue((yield* ImportPeer).prompts.at(-1)!.endsWith("Continue"));
            yield* settings.updateSettings({ scientFork: { contextHandoffSize: "maximum" } });
            const otherModel = yield* deliver("other-model", {
              ...selected,
              model: "unknown-other-model",
            });
            assert.equal(otherModel.itemIds.length, original.items.length);
            assert.deepEqual(otherModel.omittedItemIds, []);
            const otherInstance = yield* deliver("other-instance", {
              ...selected,
              instanceId: ProviderInstanceId.make("claude"),
            });
            assert.equal(otherInstance.itemIds.length, original.items.length);
            assert.deepEqual(otherInstance.omittedItemIds, []);
            const current = yield* settings.getSettings;
            yield* settings.updateSettings({
              providers: {
                codex: { ...current.providers.codex, homePath: "/synthetic/different-runtime" },
              },
            });
            const otherConfiguration = yield* deliver("other-configuration", selected);
            assert.equal(otherConfiguration.itemIds.length, original.items.length);
            assert.deepEqual(otherConfiguration.omittedItemIds, []);
            const source = yield* store.getThreadProjection(original.sourceId);
            assert.deepEqual(source.messages, original.messages);
            assert.deepEqual(source.turnItems, original.items);
          }),
          {
            runtimeOptions,
            modelContextWindow: () => undefined,
            beforeOpen: (threadId) =>
              threadId === lateTarget
                ? Deferred.succeed(opened, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseOpen)),
                  )
                : Effect.void,
          },
        );
        yield* Effect.gen(function* () {
          const freshConfig = yield* ServerConfig;
          assert.notEqual(freshConfig.stateDir, config.stateDir);
          const freshDatabase = makeSqlitePersistenceLive(
            NodePath.join(freshConfig.stateDir, "capacity.sqlite"),
          ).pipe(Layer.provide(NodeServices.layer));
          yield* withImporter(
            Effect.gen(function* () {
              const { lease } = yield* leaseFor(original.fixture);
              const sourceId = (yield* importOnce(lease)).result.threadId;
              const store = yield* ProjectionStoreV2;
              const source = yield* store.getThreadProjection(sourceId);
              yield* (yield* ServerSettingsService).updateSettings({
                scientFork: { contextHandoffSize: "maximum" },
              });
              const target = ThreadId.make("capacity-other-profile:fork");
              yield* (yield* ConversationForkService).dispatch({
                type: "thread.fork",
                commandId: CommandId.make(target),
                originThreadId: sourceId,
                newThreadId: target,
                sourceAssistantMessageId: source.messages.at(-1)!.id,
                workspaceMode: "local",
              });
              yield* continueImport(
                target,
                MessageId.make("capacity-other-profile:send"),
                "Continue",
                selected,
              );
              const delivery = (yield* store.getThreadProjection(target)).contextHandoffs.at(
                -1,
              )!.delivery!;
              assert.equal(delivery.itemIds.length, source.turnItems.length);
              assert.deepEqual(delivery.omittedItemIds, []);
              const rows =
                yield* (yield* SqlClient.SqlClient)`SELECT * FROM scient_model_context_windows`;
              assert.deepEqual(rows, []);
              const unchanged = yield* store.getThreadProjection(sourceId);
              assert.deepEqual(unchanged.messages, source.messages);
              assert.deepEqual(unchanged.turnItems, source.turnItems);
            }),
            {
              modelContextWindow: () => undefined,
              runtimeOptions: {
                layerDatabase: freshDatabase,
                layerServerConfig: Layer.succeed(ServerConfig, freshConfig),
              },
            },
          );
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "native-capacity-other-profile-",
            }).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "native-capacity-proof-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.timeout("90 seconds"),
      ),
    ),
);
