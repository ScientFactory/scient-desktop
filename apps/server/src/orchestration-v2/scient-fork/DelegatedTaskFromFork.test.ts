import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed to admit a delegated task"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "delegated-task-from-fork" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

// What a delegated subagent takes from its parent thread. The Record makes a field added
// by an upstream merge fail typecheck until someone decides it.
const helperFields = {
  createdBy: "set",
  creationSource: "set",
  id: "set",
  projectId: "inherited",
  workspaceAuthorityRevision: "set",
  title: "set",
  providerInstanceId: "set",
  modelSelection: "set",
  runtimeMode: "set",
  interactionMode: "set",
  branch: "inherited",
  worktreePath: "inherited",
  linkedPullRequest: "reset",
  pullRequests: "set",
  branchPullRequest: "inherited",
  activeProviderThreadId: "set",
  historyOrigin: "reset",
  linkOrigin: "inherited",
  delegatedFrom: "reset",
  lineage: "set",
  forkedFrom: "set",
  createdAt: "set",
  updatedAt: "set",
  archivedAt: "reset",
  settledOverride: "reset",
  settledAt: "reset",
  unsettledAt: "reset",
  snoozedUntil: "reset",
  snoozedAt: "reset",
  lastSnoozeWakeAt: "reset",
  limitRecovery: "reset",
  guestShare: "reset",
  pinnedAt: "reset",
  autoSettleDisabledAt: "reset",
  pinOrderKey: "reset",
  activeOrderKey: "reset",
  tags: "inherited",
  lastVisitedAt: "reset",
  opens: "reset",
  titleRegeneration: "reset",
  lastTitleRegeneration: "inherited",
  rollbackRequestId: "reset",
  rollbackCompletedRequestId: "reset",
  rollbackFailure: "reset",
  deletedAt: "reset",
  sectionId: "inherited",
  conversationImport: "reset",
  forkLineage: "reset",
  conversationFork: "reset",
} as const satisfies Record<keyof OrchestrationV2AppThread, "inherited" | "reset" | "set">;

it.effect("starts a delegated task from a forked conversation as a plain helper", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:forked-parent");
    const rollbackId = CommandId.make("rollback:forked-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-forked-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:forked-parent"),
      title: "Forked parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/forked-parent",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const parentState = {
      delegatedFrom: {
        environmentId: EnvironmentId.make("environment:remote"),
        threadId: ThreadId.make("thread:remote-parent"),
        title: "Remote parent",
      },
      unsettledAt: now,
      lastSnoozeWakeAt: now,
      activeOrderKey: "a0",
      rollbackRequestId: rollbackId,
      rollbackCompletedRequestId: rollbackId,
      rollbackFailure: { requestId: rollbackId, message: "Rollback failed" },
      forkLineage: {
        originThreadId: ThreadId.make("thread:fork-origin"),
        baselineAssistantMessageId: null,
      },
      conversationFork: {
        commandId: CommandId.make("fork:forked-parent"),
        sourceThreadId: ThreadId.make("thread:fork-origin"),
        workspaceMode: "local",
        status: "ready",
        cwd: "/repo-worktree",
        checkpointRef: null,
        checkpointOid: null,
        attachmentCopies: [],
        error: null,
      },
    } as const satisfies Partial<OrchestrationV2AppThread>;
    yield* projections.apply({
      id: EventId.make("forked-parent:fork-state"),
      type: "thread.metadata-updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: { ...(yield* projections.getThread(parentThreadId)), ...parentState },
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-forked-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:forked-parent"),
      text: "Ask for a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;

    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-from-fork"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the plan",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });

    const task = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!;
    const child = yield* projections.getThreadProjection(task.childThreadId!);
    assert.equal(child.thread.lineage.relationshipToParent, "subagent");
    assert.lengthOf(child.runs, 1);
    for (const [field, rule] of Object.entries(helperFields)) {
      if (rule !== "inherited") continue;
      const key = field as keyof OrchestrationV2AppThread;
      assert.deepEqual(child.thread[key], parent.thread[key], `${field} is inherited`);
    }
    for (const [field, value] of Object.entries(parentState)) {
      assert.equal(helperFields[field as keyof typeof parentState], "reset");
      assert.notDeepEqual(
        child.thread[field as keyof typeof parentState],
        value,
        `${field} is reset`,
      );
    }
  }).pipe(Effect.provide(layerTest)),
);
