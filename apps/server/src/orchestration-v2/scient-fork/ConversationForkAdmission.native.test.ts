// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type ThreadForkCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../../config.ts";
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
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ConversationForkService } from "./ConversationForkService.ts";

const layer = nativeImportRuntimeTestLayer(
  makeLayer([
    {
      instanceId: PROVIDER_ID,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("An inert fork must not execute a provider"),
    },
  ]),
).pipe(Layer.provideMerge(NodeServices.layer));

const withSource = <A, E, R>(test: (command: ThreadForkCommand) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* createNativeProjects;
      const config = yield* ServerConfig;
      const fixture = importFixture({ turns: 3, reasoning: true, workLog: true });
      const { lease } = testLease({
        fixture,
        attemptDirectory: NodePath.join(config.stateDir, "conversation-imports", "fork-admission"),
      });
      const { result } = yield* (yield* ConversationImporter).importConversation(lease, {
        destination: destination(),
        principal: principal(),
      });
      const source = yield* (yield* ProjectionStoreV2).getThreadProjection(result.threadId);
      yield* (yield* OrchestratorV2).dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("name-source"),
        threadId: result.threadId,
        title: "Origin conversation",
      });
      const answer = source.messages.find((message) => message.text === "Answer 2");
      assert.ok(answer);
      return yield* test({
        type: "thread.fork",
        commandId: CommandId.make("native-admission-fork"),
        originThreadId: result.threadId,
        newThreadId: ThreadId.make("native-admission-target"),
        sourceAssistantMessageId: answer.id,
        workspaceMode: "local",
      });
    }).pipe(Effect.provide(layer), Effect.timeout("15 seconds")),
  );

it.live(
  "uses persisted history and titles despite caller-supplied boundary and transcript fields",
  () =>
    withSource((command) =>
      Effect.gen(function* () {
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStoreV2;
        const source = yield* store.getThreadProjection(command.originThreadId);
        const callerShaped = {
          ...command,
          conversationForkBoundaries: [],
          retainedPrefix: [],
          turnCount: 0,
          checkpointCount: 99,
          title: "Injected title",
          sourceImport: { exportId: "injected provenance" },
        };
        yield* forks.dispatch(callerShaped);
        const fork = yield* store.getThreadProjection(command.newThreadId);
        assert.equal(fork.thread.title, "Origin conversation (2)");
        assert.deepEqual(
          fork.messages.map((message) => message.text),
          ["Question 1", "Answer 1", "Question 2", "Answer 2"],
        );
        assert.equal(
          fork.thread.forkLineage?.sourceImport?.exportId,
          source.thread.conversationImport?.exportId,
        );
        assert.isNull(fork.thread.conversationFork?.checkpointRef);
        const rejected = {
          ...callerShaped,
          commandId: CommandId.make("injected-missing-boundary"),
          newThreadId: ThreadId.make("injected-missing-boundary"),
          sourceAssistantMessageId: MessageId.make("invented-answer"),
          conversationForkBoundaries: [{ assistantMessageId: "invented-answer" }],
          retainedPrefix: [{ role: "assistant", text: "Invented answer" }],
        };
        const sink = yield* EventSinkV2;
        const sequence = yield* sink.latestSequence({});
        assert.equal((yield* Effect.result(forks.dispatch(rejected)))._tag, "Failure");
        assert.equal(yield* sink.latestSequence({}), sequence);
        assert.ok(
          Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(rejected.commandId)),
        );
        assert.equal(
          (yield* Effect.result(store.getThreadProjection(rejected.newThreadId)))._tag,
          "Failure",
        );
        const sourceAfter = yield* store.getThreadProjection(command.originThreadId);
        assert.deepEqual(sourceAfter.thread, source.thread);
        assert.deepEqual(sourceAfter.messages, source.messages);
        assert.deepEqual(sourceAfter.turnItems, source.turnItems);
      }),
    ),
);

it.live(
  "numbers sibling forks and reforks from persisted lineage while explicit titles preserve the same boundary",
  () =>
    withSource((command) =>
      Effect.gen(function* () {
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStoreV2;
        const source = yield* store.getThreadProjection(command.originThreadId);
        const sink = yield* EventSinkV2;
        const sourceSequence = yield* sink.latestSequence({ threadId: command.originThreadId });
        yield* forks.dispatch(command);
        const first = yield* store.getThreadProjection(command.newThreadId);
        assert.equal(first.thread.title, "Origin conversation (2)");
        const answer = first.messages.find((message) => message.text === "Answer 2");
        assert.ok(answer);
        const reforkCommand = {
          ...command,
          commandId: CommandId.make("native-numbered-refork"),
          originThreadId: command.newThreadId,
          newThreadId: ThreadId.make("native-numbered-refork"),
          sourceAssistantMessageId: answer.id,
        };
        yield* forks.dispatch(reforkCommand);
        const refork = yield* store.getThreadProjection(reforkCommand.newThreadId);
        assert.equal(refork.thread.title, "Origin conversation (3)");
        assert.equal(refork.thread.forkLineage?.originThreadId, command.newThreadId);
        assert.deepEqual(
          refork.messages.map((message) => message.text),
          first.messages.map((message) => message.text),
        );
        yield* forks.dispatch({
          ...command,
          commandId: CommandId.make("explicit-fork-one"),
          newThreadId: ThreadId.make("explicit-one"),
          titleOverride: "Deliberate fork title",
        });
        yield* forks.dispatch({
          ...command,
          commandId: CommandId.make("explicit-fork-two"),
          newThreadId: ThreadId.make("explicit-two"),
          titleOverride: "Deliberate fork title",
        });
        const explicit = yield* store.getThreadProjection(ThreadId.make("explicit-two"));
        assert.equal(explicit.thread.title, "Deliberate fork title");
        assert.deepEqual(
          explicit.messages.map((message) => message.text),
          first.messages.map((message) => message.text),
        );
        assert.equal(
          explicit.thread.forkLineage?.baselineAssistantMessageId,
          explicit.messages.findLast((message) => message.role === "assistant")?.id,
        );
        const sourceAfter = yield* store.getThreadProjection(command.originThreadId);
        assert.deepEqual(sourceAfter.thread, source.thread);
        assert.deepEqual(sourceAfter.messages, source.messages);
        assert.deepEqual(sourceAfter.turnItems, source.turnItems);
        assert.equal(
          yield* sink.latestSequence({ threadId: command.originThreadId }),
          sourceSequence,
        );
      }),
    ),
);

it.live(
  "forks an earlier persisted answer and the first user boundary without later history or source execution",
  () =>
    withSource((command) =>
      Effect.gen(function* () {
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStoreV2;
        const source = yield* store.getThreadProjection(command.originThreadId);
        const answer = source.messages.find((message) => message.text === "Answer 1");
        const question = source.messages.find((message) => message.text === "Question 1");
        assert.ok(answer && question);
        const earlierCommand = { ...command, sourceAssistantMessageId: answer.id };
        const receipt = yield* forks.dispatch(earlierCommand);
        const earlier = yield* store.getThreadProjection(command.newThreadId);
        assert.deepEqual(
          earlier.messages.map((message) => message.text),
          ["Question 1", "Answer 1"],
        );
        assert.ok(
          earlier.turnItems.some(
            (item) => item.type === "reasoning" && item.text === "Thinking about 1",
          ),
        );
        assert.isFalse(
          earlier.turnItems.some(
            (item) => item.type === "reasoning" && item.text === "Thinking about 2",
          ),
        );
        assert.equal(earlier.runs.length, 0);
        assert.equal(earlier.runtimeRequests.length, 0);
        assert.equal(earlier.providerSessions.length, 0);
        assert.equal(earlier.thread.conversationFork?.checkpointRef, null);
        assert.equal(earlier.thread.conversationFork?.workspaceMode, "local");
        assert.equal(earlier.thread.conversationFork?.status, "ready");
        assert.equal((yield* forks.dispatch(earlierCommand)).sequence, receipt.sequence);
        const emptyCommand = {
          ...command,
          commandId: CommandId.make("first-user-fork"),
          newThreadId: ThreadId.make("first-user-target"),
          sourceAssistantMessageId: undefined,
          sourceUserMessageId: question.id,
        };
        yield* forks.dispatch(emptyCommand);
        const empty = yield* store.getThreadProjection(emptyCommand.newThreadId);
        assert.deepEqual(empty.messages, []);
        assert.deepEqual(
          empty.turnItems.map((item) => item.type),
          ["fork"],
        );
        const emptyBoundary = empty.turnItems[0];
        assert.ok(emptyBoundary?.type === "fork");
        assert.isUndefined(emptyBoundary.inheritedFrom);
        assert.deepEqual(emptyBoundary.source, {
          type: "message",
          threadId: source.thread.id,
          messageId: emptyCommand.sourceUserMessageId,
          position: "before",
        });
        assert.isNull(emptyBoundary.runId);
        assert.isNull(emptyBoundary.nodeId);
        assert.isNull(empty.thread.forkLineage?.baselineAssistantMessageId);
        assert.isFalse(
          empty.contextTransfers.some((transfer) => transfer.frozenSource !== undefined),
        );
        assert.isFalse(
          earlier.messages.some((message) =>
            source.messages.some((original) => original.id === message.id),
          ),
        );
        const sourceAfter = yield* store.getThreadProjection(command.originThreadId);
        assert.deepEqual(sourceAfter.thread, source.thread);
        assert.deepEqual(sourceAfter.messages, source.messages);
        assert.deepEqual(sourceAfter.turnItems, source.turnItems);
      }),
    ),
);

it.live(
  "rejects foreign, missing, non-assistant and non-Git worktree boundaries before any destination or receipt exists",
  () =>
    withSource((command) =>
      Effect.gen(function* () {
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStoreV2;
        const receipts = yield* CommandReceiptStoreV2;
        const sink = yield* EventSinkV2;
        const source = yield* store.getThreadProjection(command.originThreadId);
        const firstQuestion = source.messages.find((message) => message.role === "user");
        assert.ok(firstQuestion);
        // Give a different origin a genuine, destination-owned assistant ID.
        yield* forks.dispatch({
          ...command,
          commandId: CommandId.make("foreign-assistant-fixture"),
          newThreadId: ThreadId.make("foreign-assistant-source"),
        });
        const foreign = yield* store.getThreadProjection(ThreadId.make("foreign-assistant-source"));
        const foreignAnswer = foreign.messages.find((message) => message.role === "assistant");
        assert.ok(foreignAnswer);
        const variants = [
          { sourceAssistantMessageId: MessageId.make("missing-message") },
          { sourceAssistantMessageId: firstQuestion.id },
          { sourceAssistantMessageId: foreignAnswer.id },
          { originThreadId: ThreadId.make("missing-origin") },
          { workspaceMode: "new-worktree" as const },
        ];
        for (const [index, change] of variants.entries()) {
          const rejected = {
            ...command,
            ...change,
            commandId: CommandId.make(`rejected-fork:${index}`),
            newThreadId: ThreadId.make(`rejected-target:${index}`),
          };
          const sequence = yield* sink.latestSequence({});
          assert.equal((yield* Effect.result(forks.dispatch(rejected)))._tag, "Failure");
          assert.equal(yield* sink.latestSequence({}), sequence);
          assert.ok(Option.isNone(yield* receipts.getByCommandId(rejected.commandId)));
          assert.equal(
            (yield* Effect.result(store.getThreadProjection(rejected.newThreadId)))._tag,
            "Failure",
          );
        }
        const sourceAfter = yield* store.getThreadProjection(command.originThreadId);
        assert.deepEqual(sourceAfter.thread, source.thread);
        assert.deepEqual(sourceAfter.messages, source.messages);
        assert.deepEqual(sourceAfter.turnItems, source.turnItems);
      }),
    ),
);

it.live(
  "rejects an existing SQL destination without changing either thread or recording the new operation",
  () =>
    withSource((command) =>
      Effect.gen(function* () {
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStoreV2;
        const receipts = yield* CommandReceiptStoreV2;
        const sink = yield* EventSinkV2;
        yield* forks.dispatch(command);
        const source = yield* store.getThreadProjection(command.originThreadId);
        const target = yield* store.getThreadProjection(command.newThreadId);
        const sequence = yield* sink.latestSequence({});
        const competing = { ...command, commandId: CommandId.make("competing-destination-fork") };
        assert.equal((yield* Effect.result(forks.dispatch(competing)))._tag, "Failure");
        assert.ok(Option.isNone(yield* receipts.getByCommandId(competing.commandId)));
        assert.equal(yield* sink.latestSequence({}), sequence);
        assert.deepEqual(yield* store.getThreadProjection(command.newThreadId), target);
        assert.deepEqual(yield* store.getThreadProjection(command.originThreadId), source);
      }),
    ),
);
