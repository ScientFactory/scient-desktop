import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const environmentId = EnvironmentId.make("environment-mcp-orchestrator-detail");
const projectId = ProjectId.make("project-mcp-orchestrator-detail");
const parentThreadId = ThreadId.make("thread-mcp-orchestrator-parent");
const childThreadId = ThreadId.make("thread-mcp-orchestrator-child");
const activeRunId = RunId.make("run-mcp-active");
const cancelledRunId = RunId.make("run-mcp-cancelled");
const childRunId = RunId.make("run-mcp-child");
const taskId = NodeId.make("node-mcp-task-1");
const now = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const codexDriver = ProviderDriverKind.make("codex");

const customCodexInstanceId = ProviderInstanceId.make("codex-custom-workspace");
const parentInstanceId = ProviderInstanceId.make("codex");

const makeScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-mcp-orchestrator-detail",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session-mcp-orchestrator-detail",
    providerInstanceId: parentInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

function baseThread(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}) {
  return {
    id: input.threadId,
    projectId,
    title: input.title,
    createdBy: "user" as const,
    creationSource: "mcp" as const,
    modelSelection: {
      instanceId: input.instanceId,
      model: input.model,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: input.instanceId,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(input: {
  readonly id: RunId;
  readonly ordinal: number;
  readonly status: "running" | "waiting" | "cancelled" | "queued" | "completed";
  readonly instanceId?: ProviderInstanceId;
}) {
  return {
    id: input.id,
    ordinal: input.ordinal,
    status: input.status,
    modelSelection: {
      instanceId: input.instanceId ?? parentInstanceId,
      model: "gpt-5.4",
    },
    providerInstanceId: input.instanceId ?? parentInstanceId,
    requestedAt: now,
    startedAt: input.status === "cancelled" || input.status === "queued" ? null : now,
    completedAt: input.status === "cancelled" || input.status === "completed" ? now : null,
  };
}

it("readThread prefers activity-run status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "running" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManagerV2)({
        resolveMcpInvocationPolicy: () =>
          Effect.die("Read-only fixture cannot grant mutation authority."),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("running");
    expect(result.thread.latestRunId).toBe(cancelledRunId);
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread prefers waiting activity status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent waiting",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "waiting" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManagerV2)({
        resolveMcpInvocationPolicy: () =>
          Effect.die("Read-only fixture cannot grant mutation authority."),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("waiting");
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("taskStatus returns task.providerInstanceId rather than the driver kind", async () => {
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        runId: activeRunId,
        parentNodeId: NodeId.make("node-parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: codexDriver,
        providerInstanceId: customCodexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Inspect the custom instance.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: {
      ...baseThread({
        threadId: childThreadId,
        title: "Child",
        instanceId: customCodexInstanceId,
        model: "gpt-5.4",
      }),
      lineage: {
        parentThreadId,
        relationshipToParent: "subagent",
        rootThreadId: parentThreadId,
      },
      createdBy: "agent",
    },
    runs: [
      makeRun({
        id: childRunId,
        ordinal: 1,
        status: "running",
        instanceId: customCodexInstanceId,
      }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [
      {
        type: "subagent_spawn",
        sourceThreadId: parentThreadId,
        targetThreadId: childThreadId,
        targetRunId: childRunId,
      },
    ],
    subagents: [],
    providerThreads: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManagerV2)({
        resolveMcpInvocationPolicy: () =>
          Effect.die("Read-only fixture cannot grant mutation authority."),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === childThreadId) return Effect.succeed(childProjection);
            return Effect.die(`unexpected thread ${threadId}`);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.taskStatus(makeScope(), taskId);
    expect(result.providerInstanceId).toBe(customCodexInstanceId);
    expect(result.providerInstanceId).not.toBe(ProviderInstanceId.make(String(codexDriver)));
    expect(result.status).toBe("running");
    expect(result.taskId).toBe(taskId);
    expect(result.childThreadId).toBe(childThreadId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("cross-project reads require a user attachment and writes retain caller authority", async () => {
  let parentShell: OrchestrationV2ThreadShell | null = null;
  let parentRuns: ReadonlyArray<unknown> = [
    makeRun({ id: RunId.make("run-parent-live"), ordinal: 1, status: "running" }),
  ];
  let parentMessages: OrchestrationV2ThreadProjection["messages"] = [];
  let foreignRecordReads = 0;
  let timelineReads = 0;
  const sentInputs: Array<
    Parameters<ThreadManagementService.ThreadManagementService["Service"]["sendToThread"]>[0]
  > = [];
  const foreignProjectId = ProjectId.make("project-mcp-orchestrator-foreign");
  const foreignThreadId = ThreadId.make("thread-mcp-orchestrator-foreign");
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    get runs() {
      return parentRuns;
    },
    visibleTurnItems: [],
    runtimeRequests: [],
    get messages() {
      return parentMessages;
    },
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const foreignProjection = (threadId: ThreadId) =>
    ({
      thread: {
        ...baseThread({
          threadId,
          title: "Foreign",
          instanceId: parentInstanceId,
          model: "gpt-5.4",
        }),
        projectId: foreignProjectId,
      },
      runs: [],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "inherited",
          sourceThreadId: threadId,
          sourceItemId: "item-1",
          item: {
            id: "item-1",
            type: "assistant_message",
            messageId: "assistant-1",
            status: "completed",
            title: null,
            text: "Foreign thread said hello",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [],
      subagents: [],
      updatedAt: now,
    }) as unknown as OrchestrationV2ThreadProjection;

  const attachedMessage = (
    createdBy: "user" | "agent",
    role: "user" | "assistant",
  ): OrchestrationV2ThreadProjection["messages"][number] => ({
    id: MessageId.make("message-user-attached-foreign-thread"),
    threadId: parentThreadId,
    runId: activeRunId,
    nodeId: null,
    role,
    text: "Inspect this conversation",
    context: {
      version: 1,
      records: [
        {
          version: 1,
          contextId: ComposerContextId.make("context-user-attached-foreign-thread"),
          label: "Foreign conversation",
          kind: "thread",
          environmentId,
          threadId: foreignThreadId,
          title: "Foreign",
        },
      ],
    },
    attachments: [],
    streaming: false,
    createdBy,
    creationSource: createdBy === "user" ? "web" : "mcp",
    createdAt: now,
    updatedAt: now,
  });
  const localProjection = {
    ...foreignProjection(childThreadId),
    thread: { ...foreignProjection(childThreadId).thread, projectId },
  };
  const targetProjection = (threadId: ThreadId) =>
    threadId === childThreadId ? localProjection : foreignProjection(threadId);

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManagerV2)({
        resolveMcpInvocationPolicy: (caller) =>
          Effect.sync(() => {
            expect(caller.threadId).toBe(parentThreadId);
            // The native owner grants an active run, or a background subagent it started.
            return parentRuns.length > 0 ||
              OrchestratorMcpService.isLiveCallerShell(parentShell, caller.providerInstanceId)
              ? Option.some({
                  runtimeMode: "full-access" as const,
                  interactionMode: "default" as const,
                })
              : Option.none();
          }),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === foreignThreadId || threadId === childThreadId)
              return Effect.succeed(targetProjection(threadId));
            return Effect.die(`unexpected thread ${threadId}`);
          },
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === foreignThreadId || threadId === childThreadId
                ? (targetProjection(threadId).thread as unknown as OrchestrationV2ThreadShell)
                : threadId === parentThreadId
                  ? parentShell
                  : null,
            ),
          getTimelinePage: (threadId) =>
            Effect.sync(() => {
              timelineReads += 1;
              return {
                items: targetProjection(threadId).visibleTurnItems,
                totalItems: 1,
                hasMore: false,
              };
            }),
          getProjectThreadRecords: (input) => {
            const expectedProject = input.threadId === childThreadId ? projectId : foreignProjectId;
            if (
              (input.threadId === foreignThreadId || input.threadId === childThreadId) &&
              input.projectId === expectedProject
            ) {
              return Effect.sync(() => {
                if (input.threadId === foreignThreadId) foreignRecordReads += 1;
                return targetProjection(input.threadId);
              });
            }
            return Effect.fail(
              new ThreadManagementService.ThreadManagementThreadNotFoundError({
                projectId: input.projectId,
                threadId: input.threadId,
              }),
            );
          },
          sendToThread: (input) =>
            Effect.sync(() => {
              sentInputs.push(input);
              return {
                run: { id: "run-foreign", status: "queued" },
                delivery: "started",
              } as unknown as ThreadManagementService.ThreadManagementSendResult;
            }),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () =>
            Effect.succeed({
              tasks: [
                {
                  id: "task-foreign",
                  projectId: foreignProjectId,
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                } as never,
              ],
            }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    for (const message of [
      undefined,
      attachedMessage("agent", "user"),
      attachedMessage("user", "assistant"),
    ]) {
      parentMessages = message === undefined ? [] : [message];
      const refused = yield* service
        .readThread(makeScope(), { threadId: foreignThreadId })
        .pipe(Effect.flip);
      expect(refused.code).toBe("thread_not_found");
      expect(foreignRecordReads).toBe(0);
      expect(timelineReads).toBe(0);
    }
    const unattachedSend = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "hi" })
      .pipe(Effect.flip);
    expect(unattachedSend.code).toBe("thread_not_found");
    expect(sentInputs).toEqual([]);

    parentMessages = [attachedMessage("user", "user")];
    const foreign = yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    expect(foreign.thread.threadId).toBe(foreignThreadId);
    expect(foreign.thread.projectId).toBe(foreignProjectId);
    expect(foreign.items.map((item) => item.text)).toEqual(["Foreign thread said hello"]);

    // User attachment grants inspection, never cross-project mutation authority.
    const attachedSend = yield* service
      .sendToThread(makeScope(), {
        threadId: foreignThreadId,
        message: "hi",
      })
      .pipe(Effect.flip);
    expect(attachedSend.code).toBe("thread_not_found");
    expect(sentInputs).toEqual([]);

    const sent = yield* service.sendToThread(makeScope(), {
      threadId: childThreadId,
      message: "hi locally",
    });
    expect(sent.threadId).toBe(childThreadId);
    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]).toMatchObject({
      projectId,
      threadId: childThreadId,
      senderThreadId: parentThreadId,
    });

    const externalScope: McpInvocationContext.McpInvocationScope = {
      ...makeScope(),
      thread: undefined,
      client: {
        sessionId: "external-full-client",
        label: "Approved client",
        access: "full-access",
      },
      requestNamespace: "external-full-client",
    };
    parentMessages = [];
    const externalRead = yield* service.readThread(externalScope, { threadId: foreignThreadId });
    expect(externalRead.thread.projectId).toBe(foreignProjectId);
    expect(externalRead.items.map((item) => item.text)).toEqual(["Foreign thread said hello"]);
    const externalSent = yield* service.sendToThread(externalScope, {
      threadId: foreignThreadId,
      message: "external hi",
    });
    expect(externalSent.threadId).toBe(foreignThreadId);
    expect(sentInputs).toHaveLength(2);
    expect(sentInputs[1]).toMatchObject({ projectId: foreignProjectId, threadId: foreignThreadId });
    expect(sentInputs[1]?.senderThreadId).toBeUndefined();

    // Read-only user-attached history remains available after the captured run ends.
    parentMessages = [attachedMessage("user", "user")];
    parentRuns = [];
    yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    const stale = yield* service
      .sendToThread(makeScope(), { threadId: childThreadId, message: "hi again" })
      .pipe(Effect.flip);
    expect(stale.code).toBe("parent_not_active");
    const staleInterrupt = yield* service
      .interruptThread(makeScope(), { threadId: foreignThreadId })
      .pipe(Effect.flip);
    expect(staleInterrupt.code).toBe("parent_not_active");

    const staleSchedule = yield* service
      .scheduleTask(makeScope(), {
        projectId: foreignProjectId,
        prompt: "check in later",
        schedule: { type: "interval", everyMs: 3_600_000 },
      })
      .pipe(Effect.flip);
    expect(staleSchedule.code).toBe("parent_not_active");
    const staleUpdate = yield* service
      .updateScheduledTask(makeScope(), {
        scheduledTaskId: ScheduledTaskId.make("task-foreign"),
        enabled: false,
      })
      .pipe(Effect.flip);
    expect(staleUpdate.code).toBe("parent_not_active");
    const staleDelete = yield* service
      .deleteScheduledTask(makeScope(), { scheduledTaskId: ScheduledTaskId.make("task-foreign") })
      .pipe(Effect.flip);
    expect(staleDelete.code).toBe("parent_not_active");
    expect(sentInputs).toHaveLength(2);

    const backgroundTasks = [
      {
        taskId: "background-subagent",
        kind: "subagent" as const,
        providerInstanceId: parentInstanceId,
      },
    ];
    parentShell = {
      ...liveThreadShell(parentThreadId, { activeRunId: null }),
      pendingBackgroundTasks: backgroundTasks,
    };
    // Scient keeps sends inside the caller's project, so the local child stands in for upstream's target.
    const backgroundSent = yield* service.sendToThread(makeScope(), {
      threadId: childThreadId,
      message: "background",
    });
    expect(backgroundSent.threadId).toBe(childThreadId);
    expect(sentInputs).toHaveLength(3);
    const delegate = yield* service
      .delegateTask(makeScope(), { task: "requires a run" })
      .pipe(Effect.flip);
    expect(delegate.code).toBe("parent_not_active");
    const create = yield* service
      .createThreads(makeScope(), { threads: [{ prompt: "requires a run" }] })
      .pipe(Effect.flip);
    expect(create.code).toBe("parent_not_active");
    const secret = yield* service
      .requestSecret(makeScope(), { label: "Secret", reason: "requires a run" })
      .pipe(Effect.flip);
    expect(secret.code).toBe("parent_not_active");

    parentShell = { ...parentShell, providerInstanceId: customCodexInstanceId };
    const switchedScope = {
      ...makeScope(),
      thread: { ...makeScope().thread!, providerInstanceId: customCodexInstanceId },
    };
    const switched = yield* service
      .sendToThread(switchedScope, { threadId: childThreadId, message: "wrong owner" })
      .pipe(Effect.flip);
    expect(switched.code).toBe("parent_not_active");
    const mismatched = yield* service
      .sendToThread(makeScope(), { threadId: childThreadId, message: "stale provider" })
      .pipe(Effect.flip);
    expect(mismatched.code).toBe("parent_not_active");

    parentShell = liveThreadShell(parentThreadId);
    const restarted = yield* service.sendToThread(makeScope(), {
      threadId: childThreadId,
      message: "new run",
    });
    expect(restarted.threadId).toBe(childThreadId);

    parentShell = {
      ...parentShell,
      activeRunId: null,
      pendingBackgroundTasks: backgroundTasks,
      archivedAt: now,
    };
    const archived = yield* service
      .sendToThread(makeScope(), { threadId: childThreadId, message: "archived" })
      .pipe(Effect.flip);
    expect(archived.code).toBe("parent_not_active");

    parentShell = { ...parentShell, archivedAt: null, pendingBackgroundTasks: [] };
    const stopped = yield* service
      .sendToThread(makeScope(), { threadId: childThreadId, message: "after stop" })
      .pipe(Effect.flip);
    expect(stopped.code).toBe("parent_not_active");
    expect(sentInputs).toHaveLength(4);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("sendToThread reports why the orchestrator refused the message", async () => {
  const targetThreadId = ThreadId.make("thread-mcp-orchestrator-dead-session");
  const targetProjection = {
    thread: baseThread({
      threadId: targetThreadId,
      title: "Stalled",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderSessionManagerV2)({
          resolveMcpInvocationPolicy: () =>
            Effect.succeed(Option.some({ runtimeMode: "full-access", interactionMode: "default" })),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === targetThreadId
                ? (targetProjection.thread as unknown as OrchestrationV2ThreadShell)
                : liveThreadShell(parentThreadId),
            ),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === targetThreadId
                ? targetProjection
                : ({
                    ...targetProjection,
                    thread: baseThread({
                      threadId: parentThreadId,
                      title: "Parent",
                      instanceId: parentInstanceId,
                      model: "gpt-5.4",
                    }),
                    runs: [
                      makeRun({ id: RunId.make("run-parent-live"), ordinal: 1, status: "running" }),
                    ],
                  } as unknown as OrchestrationV2ThreadProjection),
            ),
          getProjectThreadRecords: () => Effect.succeed(targetProjection),
          sendToThread: (input) =>
            Effect.fail(
              new OrchestratorDispatchError({
                commandId: input.commandId,
                commandType: "message.dispatch",
                cause: "Provider session provider-session-dead is not active.",
              }),
            ),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const failure = yield* service
      .sendToThread(makeScope(), { threadId: targetThreadId, message: "restart", mode: "restart" })
      .pipe(Effect.flip);
    expect(failure.code).toBe("orchestration_error");
    expect(failure.message).toBe(
      `Unable to send to thread ${targetThreadId}: Provider session provider-session-dead is not active.`,
    );
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread exposes the stored sender thread only for thread-sent messages", async () => {
  const shell = liveThreadShell(parentThreadId);
  const messages = [
    { id: "message-from-child", text: "Child reporting in", senderThreadId: childThreadId },
    { id: "message-from-user", text: "Thanks" },
  ];
  const projection = {
    ...idleThreadProjection(shell),
    messages,
    visibleTurnItems: messages.map((message, position) => ({
      position,
      visibility: "local",
      sourceThreadId: parentThreadId,
      sourceItemId: `item-${message.id}`,
      item: {
        id: `item-${message.id}`,
        type: "user_message",
        messageId: message.id,
        runId: activeRunId,
        status: "completed",
        title: null,
        text: message.text,
        updatedAt: now,
      },
    })),
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          getThreadRecords: () => Effect.succeed(projection),
          getProjectThreadRecords: () => Effect.succeed(projection),
          getTimelinePage: () =>
            Effect.succeed({ items: projection.visibleTurnItems, totalItems: 2, hasMore: false }),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          resolveMcpInvocationPolicy: () =>
            Effect.die("Read-only fixture cannot grant mutation authority."),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.items).toMatchObject([
      { messageId: "message-from-child", senderThreadId: childThreadId },
      { messageId: "message-from-user" },
    ]);
    expect(result.items[1]).not.toHaveProperty("senderThreadId");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
