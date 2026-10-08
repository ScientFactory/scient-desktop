import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderSessionManagerV2 } from "../../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThreadHandlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const callerId = ThreadId.make("thread:tool-policy");
const projectId = ProjectId.make("project:mcp-test");
const otherProjectId = ProjectId.make("project:other");
const providerInstanceId = ProviderInstanceId.make("codex");
const task = (targetProjectId: ProjectId): ScheduledTask => ({
  id: ScheduledTaskId.make(`task:${targetProjectId}`),
  title: "Synthetic scheduled task",
  prompt: "Run the synthetic task",
  enabled: true,
  schedule: { type: "interval", everyMs: 60000 },
  projectId: targetProjectId,
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});
const tasks = [task(projectId), task(otherProjectId)];
const matches = [projectId, otherProjectId].map((id) => ({
  projectId: id,
  threadId: ThreadId.make(`result:${id}`),
  source: "assistant" as const,
  snippet: id === projectId ? "Caller project result" : "Other project's private result",
  messageCreatedAt: null,
}));

const makeHarness = Effect.fn("threadToolPolicy.makeHarness")(function* (
  input: {
    readonly policy?: { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode };
    readonly clientAccess?: McpInvocationContext.McpClientCaller["access"];
    readonly loseOwnerDuringList?: boolean;
    readonly threadDefaults?: {
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    };
  } = {},
) {
  const calls = { list: 0, run: [] as ScheduledTaskId[], search: 0, policy: 0 };
  let ownerIsLive = true;
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:tool-policy"),
      requestNamespace: "provider:tool-policy",
      thread:
        input.clientAccess === undefined
          ? { threadId: callerId, providerSessionId: "provider:tool-policy", providerInstanceId }
          : undefined,
      client:
        input.clientAccess === undefined
          ? undefined
          : {
              sessionId: "client:tool-policy",
              label: "Synthetic external client",
              access: input.clientAccess,
            },
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(callerId, input.threadDefaults)),
    }),
    Layer.mock(ProviderSessionManagerV2)({
      resolveMcpInvocationPolicy: () =>
        Effect.sync(() => {
          calls.policy++;
          return ownerIsLive
            ? Option.some(
                input.policy ?? {
                  runtimeMode: "full-access" as const,
                  interactionMode: "default" as const,
                },
              )
            : Option.none();
        }),
    }),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({
      list: () =>
        Effect.sync(() => {
          calls.list++;
          if (input.loseOwnerDuringList) ownerIsLive = false;
          return { tasks };
        }),
      runNow: ({ id }) =>
        Effect.sync(() => {
          calls.run.push(id);
          const scheduled = tasks.find((entry) => entry.id === id)!;
          return { task: { ...scheduled, runCount: 1, lastRunStatus: "running" as const } };
        }),
    }),
    Layer.mock(ThreadSearch.ThreadSearch)({
      search: () =>
        Effect.sync(() => {
          calls.search++;
          return { matches };
        }),
    }),
  );
  const toolkit = yield* ThreadToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  const run = (taskId: ScheduledTaskId) =>
    toolkit.handle("run_scheduled_task_now", { taskId }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((responses) => responses.at(-1)?.result),
      Effect.provide(dependencies),
    );
  const search = (targetProjectId?: ProjectId) =>
    toolkit
      .handle("scient_thread_search", {
        query: "result",
        ...(targetProjectId === undefined ? {} : { projectId: targetProjectId }),
      })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((responses) => responses.at(-1)?.result),
        Effect.provide(dependencies),
      );
  return { calls, run, search };
});

it.effect.each([
  { runtimeMode: "approval-required" as const, interactionMode: "default" as const },
  { runtimeMode: "full-access" as const, interactionMode: "plan" as const },
])(
  "refuses scheduled execution under captured $runtimeMode/$interactionMode despite Full defaults",
  (policy) =>
    Effect.gen(function* () {
      const { calls, run } = yield* makeHarness({ policy });
      expect(yield* run(tasks[0]!.id)).toMatchObject({ code: "capability_denied" });
      expect(calls.list).toBe(0);
      expect(calls.run).toEqual([]);
    }),
);

it.effect(
  "runs a same-project task with captured Full/default despite stricter future defaults",
  () =>
    Effect.gen(function* () {
      const { calls, run } = yield* makeHarness({
        threadDefaults: { runtimeMode: "approval-required", interactionMode: "plan" },
      });
      expect(yield* run(tasks[0]!.id)).toMatchObject({ taskId: tasks[0]!.id, runCount: 1 });
      expect(calls.run).toEqual([tasks[0]!.id]);
    }),
);

it.effect("refuses a known other-project task without invoking the scheduler", () =>
  Effect.gen(function* () {
    const { calls, run } = yield* makeHarness();
    expect(yield* run(tasks[1]!.id)).toMatchObject({ code: "invalid_request" });
    expect(calls.list).toBe(1);
    expect(calls.run).toEqual([]);
  }),
);

it.effect("rechecks live captured ownership after reading scheduled tasks", () =>
  Effect.gen(function* () {
    const { calls, run } = yield* makeHarness({ loseOwnerDuringList: true });
    expect(yield* run(tasks[0]!.id)).toMatchObject({ code: "parent_not_active" });
    expect(calls.list).toBe(1);
    expect(calls.run).toEqual([]);
  }),
);

it.effect("refuses an explicit other-project search without retrieving its snippets", () =>
  Effect.gen(function* () {
    const { calls, search } = yield* makeHarness();
    expect(yield* search(otherProjectId)).toMatchObject({ code: "invalid_request" });
    expect(calls.search).toBe(0);
  }),
);

it.effect("filters omitted and explicit same-project searches to the calling project", () =>
  Effect.gen(function* () {
    const { calls, search } = yield* makeHarness();
    expect(yield* search()).toEqual({ matches: [matches[0]] });
    expect(yield* search(projectId)).toEqual({ matches: [matches[0]] });
    expect(calls.search).toBe(2);
  }),
);

it.effect(
  "keeps global and explicitly targeted searches available to external read-only clients",
  () =>
    Effect.gen(function* () {
      const { calls, search } = yield* makeHarness({ clientAccess: "read-only" });
      expect(yield* search()).toEqual({ matches });
      expect(yield* search(otherProjectId)).toEqual({ matches: [matches[1]] });
      expect(calls.policy).toBe(0);
    }),
);

it.effect("lets an external Full-access client run a task without a calling project", () =>
  Effect.gen(function* () {
    const { calls, run } = yield* makeHarness({ clientAccess: "full-access" });
    expect(yield* run(tasks[1]!.id)).toMatchObject({ taskId: tasks[1]!.id, runCount: 1 });
    expect(calls.run).toEqual([tasks[1]!.id]);
    expect(calls.policy).toBe(0);
  }),
);

it.effect.each(["read-only", "approval-required"] as const)(
  "refuses scheduled execution by an external %s client before reading tasks",
  (clientAccess) =>
    Effect.gen(function* () {
      const { calls, run } = yield* makeHarness({ clientAccess });
      expect(yield* run(tasks[1]!.id)).toMatchObject({ code: "capability_denied" });
      expect(calls.list).toBe(0);
      expect(calls.run).toEqual([]);
    }),
);
