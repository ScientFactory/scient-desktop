import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  IsoDateTime,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Persistence from "../../persistence/Sqlite.ts";
import * as Store from "../../orchestration-v2/ProjectionStore.ts";
import * as Events from "../../orchestration-v2/EventStore.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { OrchestrationEffectWorkerV2 } from "../../orchestration-v2/EffectWorker.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as Service from "./KeepAwakeService.ts";
import { assembleGroups, classifyWork, type WorkFacts } from "./work.ts";

const now = DateTime.makeUnsafe(1000);
const id = ThreadId.make("keep-awake-root");
const instanceId = ProviderInstanceId.make("test-provider");
const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id,
  projectId: ProjectId.make("project"),
  title: "Thread",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const run: OrchestrationV2Run = {
  id: RunId.make("run"),
  threadId: id,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
};
const baseItem = {
  threadId: id,
  runId: run.id,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running" as const,
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
};
const database = Persistence.layerMemory;
const stores = Layer.merge(Store.layer, Events.layer).pipe(Layer.provideMerge(database));
const layer = Service.layer.pipe(
  Layer.provideMerge(stores),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProviderSessionManagerV2)({ inspectExecution: () => Effect.succeed("connected") }),
      Layer.mock(OrchestrationEffectWorkerV2)({ isExecutingThread: () => Effect.succeed(true) }),
      Layer.succeed(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
      }),
    ),
  ),
);
const seed = (extra: readonly OrchestrationV2DomainEvent[], currentRun = run) =>
  Effect.gen(function* () {
    const events = yield* Events.EventStoreV2;
    const store = yield* Store.ProjectionStoreV2;
    const records = yield* events.append({
      events: [
        {
          id: EventId.make("thread"),
          threadId: id,
          type: "thread.created",
          occurredAt: now,
          payload: thread,
        },
        {
          id: EventId.make("run"),
          threadId: id,
          type: "run.created",
          occurredAt: now,
          payload: currentRun,
        },
        ...extra,
      ],
    });
    yield* Effect.forEach(records, (event) => store.apply(event.event));
  });

it.effect(
  "observes background work beyond the bounded history window without returning transcript content",
  () =>
    Effect.gen(function* () {
      const tool: OrchestrationV2TurnItem = {
        ...baseItem,
        id: TurnItemId.make("background"),
        type: "dynamic_tool",
        toolName: "background",
        input: {},
      };
      const history: OrchestrationV2DomainEvent[] = Array.from({ length: 110 }, (_, index) => ({
        id: EventId.make(`history-${index}`),
        threadId: id,
        occurredAt: now,
        type: "turn-item.updated",
        payload: {
          ...baseItem,
          id: TurnItemId.make(`item-${index}`),
          ordinal: index + 2,
          type: "assistant_message",
          messageId: MessageId.make(`message-${index}`),
          text: "Transcript content",
          streaming: false,
          status: "completed",
          completedAt: now,
        },
      }));
      yield* seed([
        {
          id: EventId.make("tool"),
          threadId: id,
          occurredAt: now,
          type: "turn-item.updated",
          payload: tool,
        },
        ...history,
      ]);
      const batch = yield* (yield* Service.KeepAwakeService).observe({
        threadIds: [id],
        includeLocalWork: true,
      });
      assert.isTrue(batch.groups[0]!.members[0]!.runnable);
      assert.isTrue(batch.groups[0]!.members[0]!.unfinished);
      assert.isFalse("turnItems" in batch.groups[0]!.members[0]!);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "uses the canonical pending secret input and pauses instead of treating its connected run as runnable",
  () =>
    Effect.gen(function* () {
      const secret: OrchestrationV2TurnItem = {
        ...baseItem,
        id: TurnItemId.make("secret"),
        type: "secret_request",
        status: "waiting",
        label: "API key",
        reason: "Needed",
        secretStatus: "pending",
      };
      yield* seed(
        [
          {
            id: EventId.make("secret-event"),
            threadId: id,
            occurredAt: now,
            type: "turn-item.updated",
            payload: secret,
          },
        ],
        { ...run, status: "running", completedAt: null },
      );
      const batch = yield* (yield* Service.KeepAwakeService).observe({
        threadIds: [id],
        includeLocalWork: false,
      });
      assert.isTrue(batch.groups[0]!.members[0]!.blockingInput);
      assert.isFalse(batch.groups[0]!.members[0]!.runnable);
      assert.isTrue(batch.groups[0]!.members[0]!.unfinished);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "protects checkpoint finalization after cancellation and invalidates cached completion when saving settles",
  () =>
    Effect.gen(function* () {
      yield* seed([], { ...run, status: "cancelled" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count, available_at, created_at, updated_at)
    VALUES ('capture', 'command', ${id}, 'checkpoint.capture', '{}', 'running', 1, '2026-01-01', '2026-01-01', '2026-01-01')`;
      const service = yield* Service.KeepAwakeService;
      const pending = yield* service.observe({ threadIds: [id], includeLocalWork: false });
      assert.isTrue(pending.groups[0]!.members[0]!.finalizing);
      assert.isTrue(pending.groups[0]!.members[0]!.runnable);
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE effect_id = 'capture'`;
      const completed = yield* service.observe({ threadIds: [id], includeLocalWork: false });
      assert.isFalse(completed.groups[0]!.members[0]!.unfinished);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "resolves finished and archived children and pauses native children for a parent-held approval",
  () =>
    Effect.gen(function* () {
      yield* seed([]);
      const shell = (yield* (yield* Store.ProjectionStoreV2).getThreadShell(id))!;
      const parent: WorkFacts = {
        blockingInput: false,
        shell: {
          ...shell,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("approval"),
            kind: "user_input",
            createdAt: now,
          },
        },
        active: true,
        queued: false,
        runnableQueue: false,
        nativeRunning: false,
        finalizing: false,
        progress: "1",
      };
      const childId = ThreadId.make("child");
      const child: WorkFacts = {
        ...parent,
        active: false,
        nativeRunning: true,
        shell: {
          ...shell,
          id: childId,
          creationSource: "provider",
          pendingRuntimeRequest: null,
          lineage: { parentThreadId: id, rootThreadId: id, relationshipToParent: "subagent" },
        },
      };
      const group = assembleGroups(
        [{ ...parent, blockedChildren: [childId] }, child],
        new Set([id]),
        false,
      )[0]!;
      assert.isFalse(group.members[1]!.runnable);
      assert.isTrue(group.members[1]!.blockingInput);
      const sibling = {
        ...child,
        shell: { ...child.shell, id: ThreadId.make("independent-child") },
      };
      const parallel = assembleGroups(
        [{ ...parent, blockedChildren: [childId] }, child, sibling],
        new Set([id]),
        false,
      )[0]!;
      assert.isTrue(
        parallel.members.find((member) => member.threadId === sibling.shell.id)!.runnable,
      );
      const finished: WorkFacts = {
        ...child,
        nativeRunning: false,
        shell: { ...child.shell, archivedAt: now },
      };
      const endedParent: WorkFacts = {
        ...parent,
        active: false,
        shell: {
          ...shell,
          pendingBackgroundTasks: [
            { taskId: "old-child", kind: "subagent", childThreadId: childId },
          ],
        },
      };
      assert.isFalse(
        assembleGroups([endedParent, finished], new Set([id]), false)[0]!.members.some(
          (member) => member.unfinished,
        ),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "allows sleep through passive watches and future recovery even when messages remain queued",
  () =>
    Effect.gen(function* () {
      yield* seed([]);
      const shell = (yield* (yield* Store.ProjectionStoreV2).getThreadShell(id))!;
      const facts: WorkFacts = {
        shell,
        active: false,
        blockingInput: false,
        queued: true,
        runnableQueue: true,
        nativeRunning: false,
        finalizing: false,
        progress: "1",
      };
      const limited = {
        ...facts,
        shell: {
          ...shell,
          limitRecovery: {
            runId: run.id,
            resetAt: IsoDateTime.make("2099-01-01T00:00:00.000Z"),
            autoResume: true,
          },
        },
      };
      assert.isFalse(classifyWork(limited, false).runnable);
      assert.isTrue(classifyWork(limited, false).unfinished);
      assert.isTrue(classifyWork({ ...limited, active: true }, false).runnable);
      const watch = {
        ...facts,
        queued: false,
        runnableQueue: false,
        shell: {
          ...shell,
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" as const }],
        },
      };
      assert.isFalse(classifyWork(watch, false).runnable);
      assert.isTrue(classifyWork(watch, false).unfinished);
    }).pipe(Effect.provide(layer)),
);

it.effect("does not advance past a held queue head and resumes when that head is released", () =>
  Effect.gen(function* () {
    yield* seed([], {
      ...run,
      status: "queued",
      startedAt: null,
      completedAt: null,
      queueHeld: true,
      queuePosition: 1,
    });
    const events = yield* Events.EventStoreV2;
    const store = yield* Store.ProjectionStoreV2;
    const nextRun = {
      ...run,
      id: RunId.make("queued-second"),
      ordinal: 2,
      status: "queued" as const,
      startedAt: null,
      completedAt: null,
      queueHeld: false,
      queuePosition: 2,
    };
    const appended = yield* events.append({
      events: [
        {
          id: EventId.make("queue-second"),
          threadId: id,
          type: "run.created",
          occurredAt: now,
          payload: nextRun,
        },
      ],
    });
    yield* Effect.forEach(appended, (entry) => store.apply(entry.event));
    const service = yield* Service.KeepAwakeService;
    assert.isFalse(
      (yield* service.observe({ threadIds: [id], includeLocalWork: false })).groups[0]!.members[0]!
        .runnable,
    );
    const resumed = yield* events.append({
      events: [
        {
          id: EventId.make("queue-resumed"),
          threadId: id,
          type: "run.updated",
          occurredAt: now,
          payload: {
            ...run,
            status: "queued",
            queueHeld: false,
            queuePosition: 1,
            startedAt: null,
            completedAt: null,
          },
        },
      ],
    });
    yield* Effect.forEach(resumed, (entry) => store.apply(entry.event));
    assert.isTrue(
      (yield* service.observe({ threadIds: [id], includeLocalWork: false })).groups[0]!.members[0]!
        .runnable,
    );
  }).pipe(Effect.provide(layer)),
);
