import {
  EnvironmentId,
  EventId,
  MessageId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import { LegacyV1ThreadImporter } from "../../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { readScientThreadForInvocation } from "./handlers.ts";
import { ScientThreadReadToolError, type ScientThreadReadInput } from "./tools.ts";

const callerId = ThreadId.make("thread-read-caller");
const siblingId = ThreadId.make("thread-read-sibling");
const foreignId = ThreadId.make("thread-read-foreign");
const projectId = ProjectId.make("project-thread-read");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z");
const longOutput = "x".repeat(6000) + "important-result-at-end";
const TestLayer = ProjectionStore.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.merge(
    Layer.mock(LegacyV1ThreadImporter)({
      ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    }),
  ),
);
const invocation = (
  capabilities: AgentInvocationContext.AgentInvocationScope["capabilities"] = new Set([
    "threads:read",
  ]),
) =>
  ({
    environmentId: EnvironmentId.make("environment-thread-read"),
    threadId: callerId,
    providerSessionId: "provider-session-thread-read",
    providerInstanceId: instanceId,
    capabilities,
    issuedAt: 1,
  }) satisfies AgentInvocationContext.AgentInvocationScope;
const read = (
  input: ScientThreadReadInput,
  capabilities?: AgentInvocationContext.AgentInvocationScope["capabilities"],
) =>
  readScientThreadForInvocation(input).pipe(
    Effect.provideService(AgentInvocationContext.AgentInvocationContext, invocation(capabilities)),
  );

const seedThread = Effect.fn("seedThreadReadFixture")(function* (
  id: ThreadId = callerId,
  options: { projectId?: ProjectId; archived?: boolean; fork?: boolean } = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`create:${id}`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: {
      id,
      projectId: options.projectId ?? projectId,
      title: "Native thread read fixture",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: options.fork ? callerId : null,
        relationshipToParent: options.fork ? "fork" : null,
        rootThreadId: callerId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: options.archived ? now : null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const base = (itemId: string, ordinal: number) => ({
    id: TurnItemId.make(`${id}:${itemId}`),
    threadId: id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  const items: OrchestrationV2TurnItem[] = [
    {
      ...base("user-1", 0),
      type: "user_message",
      messageId: MessageId.make(`${id}:user-1`),
      text: "First question",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    },
    { ...base("reasoning", 1), type: "reasoning", text: "Thinking about it", streaming: false },
    {
      ...base("tool-1", 2),
      type: "dynamic_tool",
      title: "Ran a command",
      toolName: "bash",
      input: { command: "pwd" },
      output: longOutput,
    },
    {
      ...base("assistant-1", 3),
      type: "assistant_message",
      messageId: MessageId.make(`${id}:assistant-1`),
      text: "aaaaaaaaaabbbbbbbbbbccccc",
      streaming: false,
    },
    {
      ...base("command-1", 4),
      type: "command_execution",
      input: "pwd",
      output: "/tmp/native-reader",
    },
    {
      ...base("plan-1", 5),
      type: "proposed_plan",
      planId: PlanId.make(`${id}:plan-1`),
      markdown: "1. Do the thing",
      streaming: false,
    },
    { ...base("system-1", 6), type: "system_notice", message: "Context compacted" },
    {
      ...base("user-2", 7),
      type: "user_message",
      messageId: MessageId.make(`${id}:user-2`),
      text: "Second question",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    },
  ];
  for (const item of items) {
    yield* store.apply({
      id: EventId.make(`${id}:${item.id}`),
      type: "turn-item.updated",
      threadId: id,
      occurredAt: now,
      payload: item,
    });
  }
});
const itemId = (suffix: string) => `${callerId}:${suffix}`;

describe("scient_thread_read native SQLite timeline", () => {
  it.effect("filters conversation rows while retaining full-timeline positions", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const result = yield* read({ threadId: callerId });
      expect(result.items.map(({ position, type }) => [position, type])).toEqual([
        [0, "user_message"],
        [3, "assistant_message"],
        [5, "proposed_plan"],
        [7, "user_message"],
      ]);
      expect(result.thread).toMatchObject({
        threadId: callerId,
        projectId,
        itemCount: 8,
        parentThreadId: null,
      });
      expect(result).toMatchObject({ nextPosition: 7, hasMore: false });
      const activity = yield* read({ threadId: callerId, view: "activity" });
      expect(activity.items.map(({ type }) => type)).toEqual([
        "user_message",
        "reasoning",
        "activity",
        "assistant_message",
        "activity",
        "proposed_plan",
        "system_message",
        "user_message",
      ]);
      expect(activity.items[2]).toMatchObject({
        itemId: itemId("tool-1"),
        title: "Ran a command",
        activityKind: "dynamic_tool",
      });
      expect(activity.items[2]?.text).toContain('{"command":"pwd"}');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("uses exclusive cursors across SQL pages and terminates at the final row", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const first = yield* read({ threadId: callerId, view: "activity", limit: 3 });
      expect(first.items.map(({ position }) => position)).toEqual([0, 1, 2]);
      expect(first).toMatchObject({ nextPosition: 2, hasMore: true });
      const second = yield* read({
        threadId: callerId,
        view: "activity",
        limit: 3,
        afterPosition: 2,
      });
      expect(second.items.map(({ position }) => position)).toEqual([3, 4, 5]);
      const last = yield* read({
        threadId: callerId,
        view: "activity",
        limit: 3,
        afterPosition: 5,
      });
      expect(last.items.map(({ position }) => position)).toEqual([6, 7]);
      expect(last).toMatchObject({ nextPosition: 7, hasMore: false });
      expect(yield* read({ threadId: callerId, afterPosition: 7 })).toMatchObject({
        items: [],
        nextPosition: null,
        hasMore: false,
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("retrieves complete bounded text including tool output beyond 4,000 characters", () =>
    Effect.gen(function* () {
      yield* seedThread();
      const first = yield* read({
        threadId: callerId,
        itemId: itemId("assistant-1"),
        maxCharsPerItem: 10,
      });
      expect(first.items[0]).toMatchObject({
        text: "a".repeat(10),
        textTruncated: true,
        nextTextOffset: 10,
      });
      const second = yield* read({
        threadId: callerId,
        itemId: itemId("assistant-1"),
        textOffset: 10,
        maxCharsPerItem: 10,
      });
      expect(second.items[0]).toMatchObject({
        text: "b".repeat(10),
        textTruncated: true,
        nextTextOffset: 20,
      });
      const end = yield* read({
        threadId: callerId,
        itemId: itemId("assistant-1"),
        textOffset: 20,
        maxCharsPerItem: 10,
      });
      expect(end.items[0]).toMatchObject({
        text: "c".repeat(5),
        textTruncated: false,
        nextTextOffset: null,
      });
      const tool = yield* read({
        threadId: callerId,
        itemId: itemId("tool-1"),
        afterPosition: 7,
        textOffset: 5000,
        maxCharsPerItem: 2000,
      });
      expect(tool.items[0]?.text).toContain("important-result-at-end");
      const reasoning = yield* read({
        threadId: callerId,
        itemId: itemId("reasoning"),
        view: "messages",
        afterPosition: 7,
      });
      expect(reasoning.items[0]?.text).toBe("Thinking about it");
      expect(
        (yield* read({ threadId: callerId, textOffset: 10, maxCharsPerItem: 10 })).items[0]?.text,
      ).toBe("First ques");
      expect(yield* read({ threadId: callerId, itemId: "missing" })).toMatchObject({
        items: [],
        nextPosition: null,
        hasMore: false,
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "reads native archived shells and fork metadata without provider-session authority",
    () =>
      Effect.gen(function* () {
        yield* seedThread(callerId, { archived: true });
        yield* seedThread(siblingId, { archived: true, fork: true });
        expect((yield* read({ threadId: siblingId })).thread).toMatchObject({
          threadId: siblingId,
          archived: true,
          parentThreadId: callerId,
          relationshipToParent: "fork",
        });
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("denies ungranted access before requiring persistence services", () =>
    Effect.gen(function* () {
      expect(
        yield* read({ threadId: callerId }, new Set(["sources:read"])).pipe(Effect.flip),
      ).toBeInstanceOf(ScientThreadReadToolError);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(LegacyV1ThreadImporter)({}),
        ),
      ),
    ),
  );

  it.effect("allows siblings but rejects foreign and distinct scratch projects", () =>
    Effect.gen(function* () {
      yield* seedThread();
      yield* seedThread(siblingId);
      yield* seedThread(foreignId, { projectId: ProjectId.make("other-project") });
      expect((yield* read({ threadId: siblingId })).items).toHaveLength(4);
      expect(yield* read({ threadId: foreignId }).pipe(Effect.flip)).toMatchObject({
        code: "thread_outside_project",
      });
      const scratch = ThreadId.make("scratch-thread");
      yield* seedThread(scratch, { projectId: ProjectId.make(`scratch:${scratch}`) });
      expect(yield* read({ threadId: scratch }).pipe(Effect.flip)).toMatchObject({
        code: "thread_outside_project",
      });
      expect(
        yield* read({ threadId: ThreadId.make("deleted-thread") }).pipe(Effect.flip),
      ).toMatchObject({ code: "thread_not_found" });
    }).pipe(Effect.provide(TestLayer)),
  );
});
