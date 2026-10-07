// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type ThreadForkCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ConversationImporter } from "../../scient/conversationImport/ConversationImporter.ts";
import {
  createNativeProjects,
  nativeImportRuntimeTestLayer,
} from "../../scient/conversationImport/conversationImport.native-test-harness.ts";
import {
  importFixture,
  testLease,
  destination,
  principal,
  PROVIDER_ID,
} from "../../scient/conversationImport/conversationImport.test-fixtures.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { EffectOutboxV2 } from "../EffectOutbox.ts";
import { OrchestrationEffectWorkerV2 } from "../EffectWorker.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import {
  ScientForkAttachmentCopier,
  ScientForkAttachmentCopierLive,
  ScientForkAttachmentCopyError,
} from "./ForkAttachmentCopier.ts";

const registry = makeLayer([
  {
    instanceId: PROVIDER_ID,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Fork provisioning cannot execute a provider"),
  },
]);
function runtime(
  options: {
    runtimeOptions?: Parameters<typeof nativeImportRuntimeTestLayer>[1];
    runEffectWorker?: boolean;
    beforeCopy?: (threadId: ThreadId) => Effect.Effect<void, ScientForkAttachmentCopyError>;
  } = {},
) {
  const copier = Layer.effect(
    ScientForkAttachmentCopier,
    Effect.gen(function* () {
      const real = yield* ScientForkAttachmentCopier;
      return {
        ...real,
        copyAll: (input: Parameters<typeof real.copyAll>[0]) =>
          (options.beforeCopy?.(input.threadId) ?? Effect.void).pipe(
            Effect.andThen(real.copyAll(input)),
          ),
      };
    }),
  ).pipe(Layer.provide(ScientForkAttachmentCopierLive));
  return nativeImportRuntimeTestLayer(registry, {
    ...(options.runEffectWorker === undefined ? {} : { runEffectWorker: options.runEffectWorker }),
    forkAttachmentCopierLayer: copier,
    ...options.runtimeOptions,
  }).pipe(Layer.provideMerge(NodeServices.layer));
}
const seed = Effect.gen(function* () {
  yield* createNativeProjects;
  const config = yield* ServerConfig;
  const { lease } = testLease({
    fixture: importFixture({ turns: 2, attachments: true, reasoning: true, workLog: true }),
    attemptDirectory: NodePath.join(config.stateDir, "conversation-imports", "fork-lifecycle"),
  });
  const { result } = yield* (yield* ConversationImporter).importConversation(lease, {
    destination: destination(),
    principal: principal(),
  });
  const source = yield* (yield* ProjectionStoreV2).getThreadProjection(result.threadId);
  const answer = source.messages.find((message) => message.text === "Answer 2");
  assert.ok(answer);
  const command: ThreadForkCommand = {
    type: "thread.fork",
    commandId: CommandId.make("lifecycle-fork"),
    originThreadId: source.thread.id,
    newThreadId: ThreadId.make("lifecycle-target"),
    sourceAssistantMessageId: answer.id,
    workspaceMode: "local",
  };
  return { command, source };
});
const acceptPending = Effect.fn("Lifecycle.acceptPending")(function* (command: ThreadForkCommand) {
  const sink = yield* EventSinkV2;
  const pull = yield* Stream.toPull(
    sink.stream({ threadId: command.newThreadId, eventType: "thread.created", afterSequence: 0 }),
  );
  const waiting = yield* (yield* ConversationForkService)
    .dispatch(command)
    .pipe(Effect.exit, Effect.forkChild);
  yield* pull;
  const pending = yield* (yield* ProjectionStoreV2).getThreadProjection(command.newThreadId);
  assert.equal(pending.thread.conversationFork?.status, "pending");
  return { waiting, pending };
});
const settledJobs = Effect.fn("Lifecycle.settledJobs")(function* (commandId: CommandId) {
  const outbox = yield* EffectOutboxV2;
  const pull = yield* Stream.toPull(
    Stream.merge(yield* outbox.subscribeCompletions, Stream.tick("10 millis")),
  );
  while (true) {
    const rows = yield* outbox.listByCommandId(commandId);
    if (
      rows.every(
        (row) =>
          row.status === "succeeded" || row.status === "failed" || row.status === "cancelled",
      )
    )
      return rows;
    yield* pull;
  }
});
const fault = (threadId: ThreadId) =>
  Effect.fail(
    new ScientForkAttachmentCopyError({
      threadId,
      reason: "target-write-failed",
      detail: "Controlled destination write failure",
    }),
  );

it.live(
  "a pending native fork owns immutable facts but refuses sends and child forks until its durable job completes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { command, source } = yield* seed;
        const { waiting, pending } = yield* acceptPending(command);
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStoreV2;
        const sink = yield* EventSinkV2;
        const receipts = yield* CommandReceiptStoreV2;
        const outbox = yield* EffectOutboxV2;
        const rows = yield* outbox.listByCommandId(command.commandId);
        assert.lengthOf(rows, 1);
        assert.equal(rows[0]?.status, "pending");
        assert.equal(rows[0]?.attemptCount, 0);
        const replay = yield* forks.dispatch(command).pipe(Effect.exit, Effect.forkChild);
        const seq = yield* sink.latestSequence({});
        const sendId = CommandId.make("pending-send");
        assert.equal(
          (yield* Effect.result(
            (yield* OrchestratorV2).dispatch({
              type: "message.dispatch",
              commandId: sendId,
              threadId: command.newThreadId,
              messageId: MessageId.make("disposable-message"),
              text: "Do not add this",
              dispatchMode: { type: "start_immediately" },
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            }),
          ))._tag,
          "Failure",
        );
        const inherited = pending.messages.find((message) => message.role === "assistant");
        assert.ok(inherited);
        assert.equal(
          (yield* Effect.result(
            forks.dispatch({
              ...command,
              commandId: CommandId.make("pending-child"),
              originThreadId: command.newThreadId,
              newThreadId: ThreadId.make("pending-child"),
              sourceAssistantMessageId: inherited.id,
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(yield* sink.latestSequence({}), seq);
        assert.deepEqual(yield* store.getThreadProjection(command.newThreadId), pending);
        assert.lengthOf(yield* outbox.listByCommandId(command.commandId), 1);
        assert.ok(Option.isNone(yield* receipts.getByCommandId(CommandId.make("pending-child"))));
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        const completed = yield* Fiber.join(waiting);
        assert.equal(completed._tag, "Success");
        const replayed = yield* Fiber.join(replay);
        assert.deepEqual(replayed, completed);
        const ready = yield* store.getThreadProjection(command.newThreadId);
        const sql = yield* SqlClient.SqlClient;
        assert.isAbove((yield* sql`SELECT * FROM effect_sql_migrations`).length, 0);
        assert.isAbove((yield* sql`SELECT * FROM scient_schema_migrations`).length, 0);
        assert.deepEqual(
          yield* sql`SELECT thread_id FROM scient_thread_lineage WHERE thread_id = ${command.newThreadId}`,
          [],
        );

        assert.equal(ready.thread.conversationFork?.status, "ready");
        assert.deepEqual(ready.messages, pending.messages);
        assert.deepEqual(ready.turnItems, pending.turnItems);
        const receipt = yield* forks.dispatch(command);
        assert.deepEqual(
          receipt.forkAttachmentIdMap,
          Object.fromEntries(
            ready.thread.conversationFork!.attachmentCopies.map((copy) => [
              copy.source.id,
              copy.target.id,
            ]),
          ),
        );
        const after = yield* store.getThreadProjection(command.originThreadId);
        assert.deepEqual(after.thread, source.thread);
        assert.deepEqual(after.messages, source.messages);
        assert.deepEqual(after.turnItems, source.turnItems);
      }).pipe(Effect.provide(runtime({ runEffectWorker: false })), Effect.timeout("15 seconds")),
    ),
);

it.live(
  "native provisioning retries a transient copy in place and publishes only verified owned files",
  () => {
    let attempts = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const { command, source } = yield* seed;
        const receipt = yield* (yield* ConversationForkService).dispatch(command);
        const target = yield* (yield* ProjectionStoreV2).getThreadProjection(command.newThreadId);
        assert.equal(attempts, 2);
        assert.equal(target.thread.conversationFork?.status, "ready");
        const rows = yield* settledJobs(command.commandId);
        assert.lengthOf(rows, 1);
        assert.equal(rows[0]?.attemptCount, 2);
        assert.equal(rows[0]?.status, "succeeded");
        assert.isNull(rows[0]?.lastError);
        const fs = yield* FileSystem.FileSystem;
        const { attachmentsDir } = yield* ServerConfig;
        for (const copy of target.thread.conversationFork!.attachmentCopies) {
          const owned = resolveAttachmentPath({ attachmentsDir, attachment: copy.target });
          const origin = resolveAttachmentPath({ attachmentsDir, attachment: copy.source });
          assert.ok(owned && origin);
          assert.deepEqual(yield* fs.readFile(owned), yield* fs.readFile(origin));
        }
        assert.equal(
          (yield* (yield* ConversationForkService).dispatch(command)).sequence,
          receipt.sequence,
        );
        const after = yield* (yield* ProjectionStoreV2).getThreadProjection(command.originThreadId);
        assert.deepEqual(after.thread, source.thread);
        assert.deepEqual(after.messages, source.messages);
        assert.deepEqual(after.turnItems, source.turnItems);
      }).pipe(
        Effect.provide(
          runtime({ beforeCopy: (threadId) => (++attempts === 1 ? fault(threadId) : Effect.void) }),
        ),
        Effect.timeout("15 seconds"),
      ),
    );
  },
);

it.live(
  "native provisioning exhausts bounded retries and explicit replay recovers the same destination without regressing ready",
  () => {
    let reject = true;
    let attempts = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const { command } = yield* seed;
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStoreV2;
        assert.equal((yield* Effect.result(forks.dispatch(command)))._tag, "Failure");
        const failed = yield* store.getThreadProjection(command.newThreadId);
        assert.equal(attempts, 5);
        assert.equal(failed.thread.conversationFork?.status, "failed");
        assert.include(failed.thread.conversationFork?.error ?? "", "Controlled destination");
        const rows = yield* settledJobs(command.commandId);
        assert.lengthOf(rows, 1);
        assert.equal(rows[0]?.attemptCount, 5);
        assert.equal(rows[0]?.status, "failed");
        reject = false;
        yield* forks.dispatch(command);
        const ready = yield* store.getThreadProjection(command.newThreadId);
        assert.equal(ready.thread.conversationFork?.status, "ready");
        assert.isNull(ready.thread.conversationFork?.error);
        assert.deepEqual(ready.messages, failed.messages);
        assert.deepEqual(ready.turnItems, failed.turnItems);
        assert.deepEqual(
          ready.thread.conversationFork?.attachmentCopies,
          failed.thread.conversationFork?.attachmentCopies,
        );
        const recovered = yield* settledJobs(command.commandId);
        assert.lengthOf(recovered, 2);
        assert.equal(recovered.filter((row) => row.status === "succeeded").length, 1);
        reject = true;
        const before = attempts;
        yield* forks.provision(command.newThreadId, false);
        yield* forks.provision(command.newThreadId, true);
        assert.equal(attempts, before);
        assert.deepEqual(yield* store.getThreadProjection(command.newThreadId), ready);
      }).pipe(
        Effect.provide(
          runtime({
            beforeCopy: (threadId) => {
              attempts++;
              return reject ? fault(threadId) : Effect.void;
            },
          }),
        ),
        Effect.timeout("15 seconds"),
      ),
    );
  },
);

it.live(
  "a disappeared retained file abandons the native fork and later jobs or replay cannot resurrect or change its error",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { command } = yield* seed;
        const { waiting, pending } = yield* acceptPending(command);
        const copy = pending.thread.conversationFork!.attachmentCopies[0];
        assert.ok(copy);
        const fs = yield* FileSystem.FileSystem;
        const { attachmentsDir } = yield* ServerConfig;
        const path = resolveAttachmentPath({ attachmentsDir, attachment: copy.source });
        assert.ok(path);
        const bytes = yield* fs.readFile(path);
        yield* fs.remove(path);
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
        const store = yield* ProjectionStoreV2;
        const forks = yield* ConversationForkService;
        const abandoned = yield* store.getThreadProjection(command.newThreadId);
        assert.equal(abandoned.thread.conversationFork?.status, "abandoned");
        assert.isNotNull(abandoned.thread.deletedAt);
        yield* fs.writeFile(path, bytes);
        yield* forks.provision(command.newThreadId, true);
        yield* forks.provision(command.newThreadId, false);
        assert.equal((yield* Effect.result(forks.dispatch(command)))._tag, "Failure");
        assert.deepEqual(yield* store.getThreadProjection(command.newThreadId), abandoned);
      }).pipe(Effect.provide(runtime({ runEffectWorker: false })), Effect.timeout("15 seconds")),
    ),
);

it.live(
  "deleting an accepted pending native fork settles its waiter and its job cannot publish it ready",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { command } = yield* seed;
        const { waiting } = yield* acceptPending(command);
        yield* (yield* OrchestratorV2).dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-pending-fork"),
          threadId: command.newThreadId,
        });
        assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
        const store = yield* ProjectionStoreV2;
        const deleted = yield* store.getThreadProjection(command.newThreadId);
        assert.isNotNull(deleted.thread.deletedAt);
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        yield* (yield* ConversationForkService).provision(command.newThreadId, false);
        assert.deepEqual(yield* store.getThreadProjection(command.newThreadId), deleted);
      }).pipe(Effect.provide(runtime({ runEffectWorker: false })), Effect.timeout("15 seconds")),
    ),
);

for (const claimedBeforeRestart of [false, true]) {
  it.live(
    `native startup recovers a frozen fork without its missed wakeup: interrupted-claim=${claimedBeforeRestart}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          const configLayer = Layer.succeed(ServerConfig, config);
          const database = makeSqlitePersistenceLive(config.dbPath).pipe(
            Layer.provide(NodeServices.layer),
          );
          const saved = yield* Effect.scoped(
            Effect.gen(function* () {
              const { command } = yield* seed;
              const { pending } = yield* acceptPending(command);
              const outbox = yield* EffectOutboxV2;
              if (claimedBeforeRestart) {
                const claim = yield* outbox.claimNext({
                  workerId: "interrupted-process",
                  leaseDurationMs: 30000,
                });
                assert.ok(Option.isSome(claim));
                assert.equal(claim.value.request.type, "scient-fork.provision");
                assert.equal(claim.value.attemptCount, 1);
              }
              // The accepted history is frozen even when source content is replaced before setup.
              const source = yield* (yield* ProjectionStoreV2).getThreadProjection(
                command.originThreadId,
              );
              const answer = source.messages.find(
                (message) => message.id === command.sourceAssistantMessageId,
              );
              assert.ok(answer);
              const now = yield* DateTime.now;
              yield* (yield* EventSinkV2).write({
                events: [
                  {
                    id: EventId.make("replace-source-after-fork"),
                    type: "message.updated",
                    threadId: command.originThreadId,
                    occurredAt: now,
                    payload: {
                      ...answer,
                      text: "Source replaced after acceptance",
                      updatedAt: now,
                    },
                  },
                ],
              });
              return { command, pending };
            }).pipe(
              Effect.provide(
                runtime({
                  runEffectWorker: false,
                  runtimeOptions: { serverConfigLayer: configLayer, databaseLayer: database },
                }),
              ),
            ),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const forks = yield* ConversationForkService;
              const receipt = yield* forks.dispatch(saved.command);
              const store = yield* ProjectionStoreV2;
              const ready = yield* store.getThreadProjection(saved.command.newThreadId);
              assert.equal(ready.thread.conversationFork?.status, "ready");
              assert.deepEqual(ready.messages, saved.pending.messages);
              assert.deepEqual(ready.turnItems, saved.pending.turnItems);
              assert.notInclude(
                ready.messages.map((message) => message.text),
                "Source replaced after acceptance",
              );
              const rows = yield* settledJobs(saved.command.commandId);
              assert.lengthOf(rows, 1);
              assert.equal(rows[0]?.attemptCount, claimedBeforeRestart ? 2 : 1);
              assert.equal((yield* forks.dispatch(saved.command)).sequence, receipt.sequence);
              assert.deepEqual(
                receipt.forkAttachmentIdMap,
                Object.fromEntries(
                  ready.thread.conversationFork!.attachmentCopies.map((copy) => [
                    copy.source.id,
                    copy.target.id,
                  ]),
                ),
              );
            }).pipe(
              Effect.provide(
                runtime({
                  runtimeOptions: {
                    serverConfigLayer: configLayer,
                    databaseLayer: database,
                    recoverOnStartup: true,
                  },
                }),
              ),
            ),
          );
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "native-fork-restart-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
          Effect.timeout("20 seconds"),
        ),
      ),
  );
}
