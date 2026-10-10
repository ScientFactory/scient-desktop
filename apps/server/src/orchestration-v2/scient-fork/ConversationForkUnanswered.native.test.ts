import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ConversationImportCommit } from "../../scient/conversationImport/ConversationImportCommit.ts";
import {
  buildConversationImportCommand,
  mintConversationImportIds,
} from "../../scient/conversationImport/conversationImportPlan.ts";
import {
  createNativeProjects,
  nativeImportRuntimeTestLayer,
} from "../../scient/conversationImport/conversationImport.native-test-harness.ts";
import {
  destination,
  importFixture,
  PROVIDER_ID,
} from "../../scient/conversationImport/conversationImport.test-fixtures.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ConversationForkService } from "./ConversationForkService.ts";

const layer = nativeImportRuntimeTestLayer(
  makeLayer([
    {
      instanceId: PROVIDER_ID,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Inherited unanswered history must not execute"),
    },
  ]),
).pipe(Layer.provideMerge(NodeServices.layer));

const withUnansweredHistory = <A, E, R>(
  test: (source: OrchestrationV2ThreadProjection) => Effect.Effect<A, E, R>,
  unanswered: ReadonlyArray<number> = [2],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* createNativeProjects;
      const fixture = importFixture({ turns: 3, reasoning: true, workLog: true });
      const snapshot = {
        ...fixture.input.snapshot,
        messages: fixture.input.snapshot.messages
          .filter((message) => !unanswered.some((turn) => message.id === `src-assistant-${turn}`))
          .map((message, index) => ({ ...message, n: index + 1 })),
      };
      const validated = { ...fixture.input, snapshot };
      const ids = yield* mintConversationImportIds(validated);
      const command = buildConversationImportCommand({
        validated,
        ids,
        destination: destination(),
        importedAt: "2026-09-28T10:00:00.000Z",
      });
      yield* (yield* ConversationImportCommit).dispatch(command);
      return yield* test(yield* (yield* ProjectionStoreV2).getThreadProjection(command.threadId));
    }).pipe(Effect.provide(layer), Effect.timeout("15 seconds")),
  );

const forkAt = Effect.fn("test.forkUnansweredPrefix")(function* (
  source: OrchestrationV2ThreadProjection,
  text: string,
  target: string,
) {
  const answer = source.messages.find((message) => message.text === text);
  assert.ok(answer);
  yield* (yield* ConversationForkService).dispatch({
    type: "thread.fork",
    commandId: CommandId.make(target),
    originThreadId: source.thread.id,
    newThreadId: ThreadId.make(target),
    sourceAssistantMessageId: answer.id,
    workspaceMode: "local",
  });
  return yield* (yield* ProjectionStoreV2).getThreadProjection(ThreadId.make(target));
});

const shownItems = (projection: OrchestrationV2ThreadProjection) =>
  projection.visibleTurnItems.map((row) => row.item);

const assertUnansweredGroup = (projection: OrchestrationV2ThreadProjection) => {
  const shown = shownItems(projection);
  const prompt = shown.find((item) => item.type === "user_message" && item.text === "Question 2");
  assert.ok(prompt?.historyTurnId);
  const group = shown.filter((item) => item.historyTurnId === prompt.historyTurnId);
  assert.deepEqual(
    group.map((item) => item.type),
    ["user_message", "reasoning", "dynamic_tool"],
  );
  assert.equal(group.find((item) => item.type === "reasoning")?.text, "Thinking about 2");
  assert.equal(new Set(group.map((item) => item.id)).size, 3);
  assert.isTrue(
    group.every(
      (item) => item.runId === null && item.nodeId === null && item.nativeItemRef === null,
    ),
  );
  const answered = shown.filter((item) => item.type === "assistant_message");
  assert.isFalse(answered.some((item) => item.historyTurnId === prompt.historyTurnId));
  assert.equal(
    projection.thread.forkLineage?.baselineAssistantMessageId,
    projection.messages.find((message) => message.text === "Answer 3")?.id,
  );
  assert.deepEqual(projection.runs, []);
  assert.deepEqual(projection.runtimeRequests, []);
  assert.deepEqual(projection.providerSessions, []);
};

it.live(
  "carries an unanswered request, reasoning and work log in their own inherited group while earlier forks exclude them",
  () =>
    withUnansweredHistory((source) =>
      Effect.gen(function* () {
        const fork = yield* forkAt(source, "Answer 3", "unanswered-later-fork");
        assert.deepEqual(
          fork.messages.map((message) => message.text),
          ["Question 1", "Answer 1", "Question 2", "Question 3", "Answer 3"],
        );
        assertUnansweredGroup(fork);
        assert.equal(
          new Set(
            shownItems(fork).flatMap((item) => (item.historyTurnId ? [item.historyTurnId] : [])),
          ).size,
          3,
        );
        const earlier = yield* forkAt(source, "Answer 1", "unanswered-earlier-fork");
        assert.deepEqual(
          earlier.messages.map((message) => message.text),
          ["Question 1", "Answer 1"],
        );
        assert.isFalse(
          shownItems(earlier).some(
            (item) => item.type === "reasoning" && item.text === "Thinking about 2",
          ),
        );
        assert.isFalse(
          shownItems(earlier).some(
            (item) =>
              item.historyTurnId ===
              shownItems(fork).find(
                (item) => item.type === "user_message" && item.text === "Question 2",
              )?.historyTurnId,
          ),
        );
        const sourceAfter = yield* (yield* ProjectionStoreV2).getThreadProjection(source.thread.id);
        assert.deepEqual(sourceAfter.messages, source.messages);
        assert.deepEqual(sourceAfter.turnItems, source.turnItems);
      }),
    ),
);

it.live(
  "reforks inherited unanswered history once with fresh local ownership and the selected answer baseline",
  () =>
    withUnansweredHistory((source) =>
      Effect.gen(function* () {
        const first = yield* forkAt(source, "Answer 3", "unanswered-first-fork");
        const second = yield* forkAt(first, "Answer 3", "unanswered-refork");
        assertUnansweredGroup(second);
        assert.deepEqual(
          second.messages.map((message) => message.text),
          first.messages.map((message) => message.text),
        );
        // The refork owns fresh copies of its plans and boundary; everything else
        // it shows is the original item, one level deep.
        assert.isTrue(
          second.turnItems.every(
            (item) =>
              item.threadId === second.thread.id &&
              !first.turnItems.some((prior) => prior.id === item.id),
          ),
        );
        const shared = (projection: OrchestrationV2ThreadProjection) =>
          projection.visibleTurnItems.filter(
            (row) => row.visibility === "inherited" && row.sourceThreadId !== projection.thread.id,
          );
        assert.isNotEmpty(shared(second));
        assert.isTrue(shared(second).every((row) => row.sourceThreadId === source.thread.id));
        assert.deepEqual(
          shared(second).map((row) => row.sourceItemId),
          shared(first).map((row) => row.sourceItemId),
        );
        assert.deepEqual(
          second.messages.map((message) => message.id),
          first.messages.map((message) => message.id),
        );
        const earlier = yield* forkAt(first, "Answer 1", "unanswered-earlier-refork");
        assert.deepEqual(
          earlier.messages.map((message) => message.text),
          ["Question 1", "Answer 1"],
        );
        assert.equal(
          earlier.thread.forkLineage?.baselineAssistantMessageId,
          earlier.messages.at(-1)?.id,
        );
        assert.isFalse(
          shownItems(earlier).some(
            (item) => item.type === "reasoning" && item.text === "Thinking about 2",
          ),
        );
      }),
    ),
);

it.live(
  "a user fork after an unanswered turn keeps the last answer baseline and excludes the draft",
  () =>
    withUnansweredHistory((source) =>
      Effect.gen(function* () {
        const question = source.messages.find((message) => message.text === "Question 3");
        assert.ok(question);
        const targetId = ThreadId.make("unanswered-user-fork");
        const command = {
          type: "thread.fork" as const,
          commandId: CommandId.make("unanswered-user-fork"),
          originThreadId: source.thread.id,
          newThreadId: targetId,
          sourceUserMessageId: question.id,
          workspaceMode: "local" as const,
        };
        const forks = yield* ConversationForkService;
        const receipt = yield* forks.dispatch(command);
        const store = yield* ProjectionStoreV2;
        const child = yield* store.getThreadProjection(targetId);
        assert.deepEqual(
          child.messages.map((message) => message.text),
          ["Question 1", "Answer 1", "Question 2"],
        );
        const lastAnswer = child.messages.find((message) => message.text === "Answer 1");
        assert.ok(lastAnswer);
        assert.equal(child.thread.forkLineage?.baselineAssistantMessageId, lastAnswer.id);
        const shown = shownItems(child);
        const unansweredPrompt = shown.find(
          (item) => item.type === "user_message" && item.text === "Question 2",
        );
        assert.ok(unansweredPrompt?.historyTurnId);
        assert.deepEqual(
          shown
            .filter((item) => item.historyTurnId === unansweredPrompt.historyTurnId)
            .map((item) => item.type),
          ["user_message", "reasoning", "dynamic_tool"],
        );
        assert.isFalse(
          shown.some((item) => item.type === "reasoning" && item.text === "Thinking about 3"),
        );
        assert.deepEqual(child.runs, []);
        assert.deepEqual(child.runtimeRequests, []);
        assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);
        assert.deepEqual(
          (yield* store.getThreadProjection(source.thread.id)).turnItems,
          source.turnItems,
        );
      }),
    ),
);

it.live("a user fork with only unanswered inherited requests has no invented answer baseline", () =>
  withUnansweredHistory(
    (source) =>
      Effect.gen(function* () {
        const question = source.messages.find((message) => message.text === "Question 3");
        assert.ok(question);
        const targetId = ThreadId.make("unanswered-empty-baseline");
        yield* (yield* ConversationForkService).dispatch({
          type: "thread.fork",
          commandId: CommandId.make("unanswered-empty-baseline"),
          originThreadId: source.thread.id,
          newThreadId: targetId,
          sourceUserMessageId: question.id,
          workspaceMode: "local",
        });
        const child = yield* (yield* ProjectionStoreV2).getThreadProjection(targetId);
        const shown = shownItems(child);
        assert.deepEqual(
          child.messages.map((message) => message.text),
          ["Question 1", "Question 2"],
        );
        assert.isNull(child.thread.forkLineage?.baselineAssistantMessageId);
        assert.isFalse(shown.some((item) => item.type === "assistant_message"));
        const inheritedItems = shown.filter((item) => item.inheritedFrom !== undefined);
        assert.equal(new Set(inheritedItems.map((item) => item.historyTurnId)).size, 2);
        assert.deepEqual(
          shown.filter((item) => item.inheritedFrom === undefined).map((item) => item.type),
          ["fork"],
        );
        assert.deepEqual(
          shown.map((item) => item.type),
          [
            "user_message",
            "reasoning",
            "dynamic_tool",
            "user_message",
            "reasoning",
            "dynamic_tool",
            "fork",
          ],
        );
        assert.isTrue(
          shown.every(
            (item) => item.runId === null && item.nodeId === null && item.nativeItemRef === null,
          ),
        );
        assert.deepEqual(child.runs, []);
        assert.deepEqual(child.runtimeRequests, []);
        assert.deepEqual(child.providerSessions, []);
      }),
    [1, 2],
  ),
);
