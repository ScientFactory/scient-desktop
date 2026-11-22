import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { fullAccessCapturedPolicyLayer } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:g5-parent");
const childThreadId = ThreadId.make("thread:g5-child");
const projectId = ProjectId.make("project:g5");
const codexInstanceId = ProviderInstanceId.make("codex");
const scientInstanceId = ProviderInstanceId.make("scient");
const taskId = NodeId.make("node:g5-task");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:g5"),
  requestNamespace: "provider-session:g5",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:g5",
    providerInstanceId: codexInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const provider = (
  instanceId: ProviderInstanceId,
  driver: string,
  slugs: ReadonlyArray<string>,
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-15T00:00:00.000Z",
  models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

const parentProjection = (subagents: ReadonlyArray<unknown>) =>
  ({
    thread: {
      id: parentThreadId,
      projectId,
      title: "Parent",
      createdBy: "user",
      creationSource: "web",
      modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    runs: [
      {
        id: RunId.make("run:g5-parent"),
        ordinal: 1,
        status: "running",
        rootNodeId: NodeId.make("node:g5-root"),
        providerInstanceId: codexInstanceId,
        modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      },
    ],
    contextTransfers: [],
    subagents,
  }) as unknown as OrchestrationV2ThreadProjection;

const childProjection = {
  thread: { id: childThreadId, title: "Child" },
  runs: [],
  contextTransfers: [],
  messages: [],
  subagents: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  turnItems: [],
} as unknown as OrchestrationV2ThreadProjection;

/** The service over one in-memory database, which the test can also write. */
const serviceLayer = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly threads: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
}) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(input.providers),
          refreshInstance: () => Effect.succeed(input.providers),
        }),
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            list: () => Effect.succeed(input.providers.map((entry) => entry.instanceId)),
            get: (instanceId) =>
              Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        fullAccessCapturedPolicyLayer,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

describe("OrchestratorMcpService delegate target recovery", () => {
  it.effect.each([
    {
      name: "a bare name runs its one prefixed model",
      slugs: ["openai-codex/gpt-6-luna", "anthropic/claude-opus-5-5"],
      dispatched: "openai-codex/gpt-6-luna",
    },
    {
      name: "a name two accounts share is refused with both",
      slugs: ["openai-codex/gpt-6-luna", "openai-work/gpt-6-luna"],
      refusal: "openai-codex/gpt-6-luna, openai-work/gpt-6-luna. Pass one of them exactly.",
    },
    {
      name: "an unknown name is refused with the closest models",
      slugs: ["openai-codex/gpt-6-luna", "anthropic/claude-opus-5-5"],
      requested: "gpt-6-sol",
      refusal: "Closest: openai-codex/gpt-6-luna",
    },
  ])("$name", ({ slugs, dispatched, refusal, requested }) =>
    Effect.gen(function* () {
      const commands: Array<{ readonly modelSelection?: unknown }> = [];
      const task = {
        id: taskId,
        threadId: parentThreadId,
        origin: "app_owned",
        childThreadId,
        providerInstanceId: scientInstanceId,
        model: dispatched,
        status: "running",
        result: null,
      };
      const layer = serviceLayer({
        providers: [
          provider(codexInstanceId, "codex", ["gpt-5.4"]),
          provider(scientInstanceId, "scient", slugs),
        ],
        threads: {
          hasReceipt: () => Effect.succeed(false),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(commands.length > 0 ? [task] : [])
                : childProjection,
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command as { readonly modelSelection?: unknown });
              return {
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
              } as never;
            }),
        },
      });
      const delegation = OrchestratorMcpService.OrchestratorMcpService.pipe(
        Effect.flatMap((service) =>
          service.delegateTask(scope, {
            task: "Review the change.",
            target: { providerInstanceId: scientInstanceId, model: requested ?? "GPT-6-luna" },
            mode: "async",
            clientRequestId: "g5-delegate",
          }),
        ),
      );
      if (refusal === undefined) {
        yield* delegation.pipe(Effect.provide(layer));
        assert.deepEqual(commands[0]?.modelSelection, {
          instanceId: scientInstanceId,
          model: dispatched,
        });
      } else {
        const error = yield* Effect.flip(delegation).pipe(Effect.provide(layer));
        assert.equal(error.code, "model_unavailable");
        assert.include(error.message, refusal);
        assert.deepEqual(commands, []);
      }
    }),
  );
});

describe("OrchestratorMcpService task ID recovery", () => {
  const otherProject = ProjectId.make("project:other");
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly owner: ProjectId;
    readonly child: ProjectId;
    readonly childDeleted?: true;
    readonly hint: "both" | "owner" | "none";
  }> = [
    { name: "names its owner and child", owner: projectId, child: projectId, hint: "both" },
    {
      name: "hides an owner in another project",
      owner: otherProject,
      child: projectId,
      hint: "none",
    },
    { name: "hides a child moved away", owner: projectId, child: otherProject, hint: "owner" },
    {
      name: "hides a deleted child",
      owner: projectId,
      child: projectId,
      childDeleted: true,
      hint: "owner",
    },
  ];
  it.effect.each(
    (["task_status", "task_cancel"] as const).flatMap((tool) =>
      cases.map((testCase) => ({ tool, ...testCase })),
    ),
  )("a $tool miss $name", ({ tool, owner, child, childDeleted, hint }) =>
    Effect.gen(function* () {
      const ownerThreadId = ThreadId.make("thread:g5-owner");
      const shell = (id: ThreadId, project: ProjectId, title: string, deleted = false) =>
        ({
          id,
          projectId: project,
          title,
          deletedAt: deleted ? "2026-11-15T00:00:00.000Z" : null,
        }) as never;
      const layer = serviceLayer({
        providers: [provider(codexInstanceId, "codex", ["gpt-5.4"])],
        threads: {
          getThreadRecords: () => Effect.succeed(parentProjection([])),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === ownerThreadId
                ? shell(ownerThreadId, owner, "Owner")
                : threadId === childThreadId
                  ? shell(childThreadId, child, "Child", childDeleted === true)
                  : shell(parentThreadId, projectId, "Parent"),
            ),
        },
      });
      const error = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_subagents
          (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
          VALUES (${taskId}, ${ownerThreadId}, 'node:g5-owner-root', 'codex', ${childThreadId}, 'app_owned', 'running', '2026-11-15T00:00:00.000Z', '{}')`;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return tool === "task_status"
          ? yield* Effect.flip(service.taskStatus(scope, taskId))
          : yield* Effect.flip(service.cancelTask(scope, { taskId }));
      }).pipe(Effect.provide(layer));
      assert.equal(error.code, "task_not_found");
      assert.equal(error.message.includes(ownerThreadId), hint !== "none", error.message);
      assert.equal(error.message.includes(childThreadId), hint === "both", error.message);
    }),
  );
});
