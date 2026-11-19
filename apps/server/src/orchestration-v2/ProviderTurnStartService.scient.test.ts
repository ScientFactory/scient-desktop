import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { skillReleaseKey } from "@scientfactory/scient-skills";
import {
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type { McpScientSkillScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import { BUILT_IN_SKILL_RELEASES } from "../scient/skills/BuiltInSkillReleases.ts";
import * as ScientSkillSession from "../scient/skills/ScientSkillSession.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const release = BUILT_IN_SKILL_RELEASES[0]!;
const cwd = "/tmp/scient-skill-start";

// The real registry: `publish` replaces the skill scope of the thread's issued credential.
const registryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      Layer.succeed(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43125),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Layer.succeed(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("skill-start-fixture")),
          getDescriptor: Effect.die("No environment descriptor needed"),
        }),
      ),
    ),
  ),
);

/** What happens to the run between skill preparation and the native offer. */
type PreparationChange = "stop-requested" | "run-interrupted" | "attempt-superseded";

/**
 * One codex run with an explicitly selected skill. Its skill planner can change the
 * run mid-preparation, after the scope is prepared and before `shouldStartProviderTurn`.
 */
const makeStartFixture = Effect.fnUntraced(function* () {
  const now = DateTime.makeUnsafe("2026-11-18T12:00:00Z");
  const threadId = ThreadId.make("thread:skill-start");
  const runId = RunId.make("run:skill-start");
  const rootNodeId = NodeId.make("node:skill-start");
  const attemptId = RunAttemptId.make("attempt:skill-start");
  const providerThreadId = ProviderThreadId.make("provider-thread:skill-start");
  const providerSessionId = ProviderSessionId.make("session:skill-start");
  const instanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const checkpointScopeId = CheckpointScopeId.make("scope:skill-start");
  const messageId = MessageId.make("message:skill-start");
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const projection = yield* Ref.make<OrchestrationV2ThreadProjection>({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:skill-start"),
      title: "Skill start",
      providerInstanceId: instanceId,
      modelSelection: run.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      activeProviderThreadId: providerThreadId,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [run],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [providerThread],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        text: `Continue $${release.name}`,
        attachments: [],
        selectedScientSkillNames: [release.name],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd,
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  });
  const plannedChange = yield* Ref.make<PreparationChange | undefined>(undefined);
  const stopRequested = yield* Ref.make(false);
  /** The credential's skill scope at the moment the provider received each turn. */
  const offeredScopes = yield* Ref.make<ReadonlyArray<McpScientSkillScope | undefined>>([]);
  const deliveryExit = yield* Ref.make<Exit.Exit<void, unknown> | undefined>(undefined);

  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const issued = yield* registry.issue({
    threadId,
    providerInstanceId: instanceId,
    capabilities: new Set(["skills:read"]),
  });
  yield* mcpSessions.set(issued.config);
  const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
  const publishedScope = registry.resolve(token).pipe(Effect.map((scope) => scope?.skillScope));

  const applyChange = (change: PreparationChange) =>
    change === "stop-requested"
      ? Ref.set(stopRequested, true)
      : Ref.update(projection, (current) => ({
          ...current,
          runs: current.runs.map((candidate) =>
            candidate.id !== runId
              ? candidate
              : change === "run-interrupted"
                ? { ...candidate, status: "interrupted" as const, completedAt: now }
                : { ...candidate, activeAttemptId: RunAttemptId.make("attempt:skill-start:new") },
          ),
        }));

  const session: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
    instanceId,
    driver,
    providerSessionId,
    mcpSessionInjection: true,
    providerSession: {
      id: providerSessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd,
      model: run.modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    events: Stream.never,
    ensureThread: () => Effect.succeed(providerThread),
    resumeThread: () => Effect.die("unused resumeThread"),
    startTurn: () =>
      publishedScope.pipe(
        Effect.flatMap((scope) => Ref.update(offeredScopes, (scopes) => [...scopes, scope])),
      ),
    steerTurn: () => Effect.die("unused steerTurn"),
    interruptTurn: () => Effect.die("unused interruptTurn"),
    respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
    readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
    rollbackThread: () => Effect.die("unused rollbackThread"),
    forkThread: () => Effect.die("unused forkThread"),
  };

  const readContext = Ref.get(projection).pipe(
    Effect.map((current) => ({ ...current, hasConversation: true })),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(McpProviderSessions.McpProviderSessions, mcpSessions),
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: ({ events, activeAttemptId, expectedStatus }) =>
            Ref.modify(projection, (current) => {
              const target = current.runs.find((candidate) => candidate.id === runId);
              const committed =
                target?.activeAttemptId === activeAttemptId && target.status === expectedStatus;
              return [
                { committed, storedEvents: [] },
                committed
                  ? events.reduce(
                      (next, event) => ProjectionStore.applyToProjection(next, event),
                      current,
                    )
                  : current,
              ] as const;
            }),
          latestSequence: () => Effect.succeed(0),
          stream: () => Stream.never,
          write: ({ events }) =>
            Ref.update(projection, (current) =>
              events.reduce(
                (next, event) => ProjectionStore.applyToProjection(next, event),
                current,
              ),
            ).pipe(Effect.as([])),
        }),
        IdAllocator.layer,
        Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({}),
        Path.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "scient-skill-start-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        ServerSettings.layerTest(),
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees: () => Effect.void }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: cwd } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getConversationFork: () => Effect.succeed(null),
          getThreadRecords: () => Ref.get(projection),
          getTurnStartContext: () => readContext,
          getRuntimeRecoveryProjection: () => readContext,
          getRun: (_threadId, id) =>
            Ref.get(projection).pipe(
              Effect.map((current) => current.runs.find((candidate) => candidate.id === id)),
            ),
          hasUnpairedRunInterruptRequest: () => Ref.get(stopRequested),
          getTurnStartHistory: () => Effect.succeed([]),
          getContextHistoryCandidates: () => Effect.succeed([]),
          getForkHistoryItems: () => Effect.succeed([]),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () => Effect.succeed(session),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          // Native execution offers the turn through the session it receives.
          startRootRun: (runInput) =>
            runInput.session.startTurn(runInput as never).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Ref.set(deliveryExit, exit)),
            ),
          forkBaseline: () => Effect.succeed(Effect.void),
        }),
        Layer.succeed(ProviderUsageAnalytics.ProviderTurnAnalytics, {
          runStarted: () => Effect.void,
          turnCompleted: () => Effect.void,
          runSettled: () => Effect.void,
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: ({ thread }) =>
            Effect.succeed({
              runtimeMode: thread.runtimeMode,
              interactionMode: "default",
              cwd,
            }),
        }),
        Layer.succeed(ScientSkillSession.ScientSkillSessionPlanner, {
          // Preparation resolves the plan before the native offer's recheck.
          resolve: () =>
            Ref.get(plannedChange).pipe(
              Effect.flatMap((change) =>
                change === undefined ? Effect.void : applyChange(change),
              ),
              Effect.as({
                delivery: "mcp" as const,
                catalogStatus: "complete" as const,
                skills: [
                  {
                    releaseKey: skillReleaseKey(release),
                    id: release.id,
                    name: release.name,
                    description: release.description,
                    origin: release.origin,
                    activationScope: "user" as const,
                    invocationPolicy: "explicit" as const,
                  },
                ],
                releases: new Map([[skillReleaseKey(release), release]]),
                diagnostics: [],
              }),
            ),
        }),
      ),
    ),
  );
  return {
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    plannedChange,
    publishedScope,
    offeredScopes: Ref.get(offeredScopes),
    deliveryExit: Ref.get(deliveryExit),
  };
});

const provideFixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.merge(registryLayer, McpProviderSessions.layer)));

it.effect("publishes a started turn's skill scope before the provider receives it", () =>
  Effect.gen(function* () {
    const fixture = yield* makeStartFixture();
    yield* fixture.start;
    assert.isTrue(Exit.isSuccess((yield* fixture.deliveryExit)!));
    assert.deepEqual(
      (yield* fixture.offeredScopes).map((scope) => scope?.skills.map((skill) => skill.name)),
      [[release.name]],
    );
  }).pipe(provideFixture),
);

it.effect.each(["stop-requested", "run-interrupted", "attempt-superseded"] as const)(
  "never publishes a start's skill scope when the native offer is declined: %s",
  (change) =>
    Effect.gen(function* () {
      const fixture = yield* makeStartFixture();
      yield* Ref.set(fixture.plannedChange, change);
      yield* fixture.start;
      const exit = (yield* fixture.deliveryExit)!;
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "declined after input");
      assert.deepEqual(yield* fixture.offeredScopes, []);
      assert.isUndefined(yield* fixture.publishedScope);
    }).pipe(provideFixture),
);
