import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import {
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
// SCIENT-FORK:START — native-owner invocation policy and clone guard fixtures.
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { isLiveCallerShell } from "./liveCallerShell.ts";
// SCIENT-FORK:END

const EPOCH = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

export const liveThreadShell = (
  id: ThreadId,
  modes: {
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly activeRunId?: RunId | null;
  } = {},
): OrchestrationV2ThreadShell => {
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    id,
    projectId: ProjectId.make("project:mcp-test"),
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: modes.runtimeMode ?? "full-access",
    interactionMode: modes.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    latestRunId: null,
    activeRunId: modes.activeRunId === undefined ? RunId.make("run:mcp-test") : modes.activeRunId,
    status: "running",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

/** Controlled full-access policy input for domain/transport unit fixtures.
 * Issued credential ownership is tested through the real manager integration.
 */
export const fullAccessCapturedPolicyLayer = Layer.mock(
  ProviderSessionManager.ProviderSessionManagerV2,
)({
  resolveMcpInvocationPolicy: () =>
    Effect.succeedSome({
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    }),
});
export const liveThreadsLayer = Layer.merge(
  fullAccessCapturedPolicyLayer,
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
  }),
);

// SCIENT-FORK:START — native-owner invocation policy and clone guard fixtures.
type ResolveMcpInvocationPolicy =
  ProviderSessionManager.ProviderSessionManagerV2["Service"]["resolveMcpInvocationPolicy"];

// Deferred to call time: the thread service is built by sibling layers, so
// the lookup runs in the caller's context rather than at layer build.
const resolvePolicyFromThreadShell = ((caller: Parameters<ResolveMcpInvocationPolicy>[0]) =>
  ThreadManagement.ThreadManagementService.pipe(
    Effect.flatMap((threads) => threads.getThreadShell(caller.threadId)),
    Effect.orDie,
    Effect.map((shell) =>
      shell === null || !isLiveCallerShell(shell, caller.providerInstanceId)
        ? Option.none()
        : Option.some({
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
          }),
    ),
  )) as unknown as ResolveMcpInvocationPolicy;

/**
 * The native owner's policy as the caller's live thread shell states it, for
 * fixtures whose thread service stands in for real provider sessions.
 */
const threadShellPolicyLayer = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
  resolveMcpInvocationPolicy: resolvePolicyFromThreadShell,
});

/** Services Scient's MCP tools require beyond upstream's, with no clone in progress. */
export const scientToolServicesLayer = Layer.merge(
  threadShellPolicyLayer,
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
);
// SCIENT-FORK:END

export const idleThreadProjection = (
  shell: OrchestrationV2ThreadShell,
): OrchestrationV2ThreadProjection => {
  const {
    status: _status,
    activeRunId: _activeRunId,
    latestRunId: _latestRunId,
    pendingRuntimeRequest: _pendingRuntimeRequest,
    latestVisibleMessage: _latestVisibleMessage,
    latestUserMessageAt: _latestUserMessageAt,
    hasActionableProposedPlan: _hasActionableProposedPlan,
    itemCount: _itemCount,
    visibleItemCount: _visibleItemCount,
    lastVisitedAt,
    ...thread
  } = shell;
  return {
    thread: { ...thread, lastVisitedAt: lastVisitedAt ?? null },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: shell.updatedAt,
  };
};
