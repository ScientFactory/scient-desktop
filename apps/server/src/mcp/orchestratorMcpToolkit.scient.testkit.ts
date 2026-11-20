import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  type ModelSelection,
  type NodeId,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  type OrchestrationV2DelegatedCompletionDelivery,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  ProviderThreadId,
  ProviderTurnId,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  ThreadId,
  ThreadMetadataMcpUpdateResult,
  TurnItemId,
  withMessageSenderNote,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/ai";
import type { McpServer } from "effect/ai";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { emptyMcpReplayPrompt } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationService from "../orchestration-v2/ProviderContinuationService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { layer as ProjectHandlersLive } from "./toolkits/project/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";

export const makeCredentialRegistryLayer = (environmentId: EnvironmentId) =>
  McpSessionRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.die("No environment descriptor is requested in this fixture."),
        }),
      ),
    ),
  );

// The scenarios below share one in-process MCP server with the real invocation
// policy, SQLite projections, two scripted adapters and a continuation probe.

export const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
export const projectId = ProjectId.make("project:mcp-orchestrator");
export const codexInstanceId = ProviderInstanceId.make("codex");
export const codexModel = "gpt-5.4";
export const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
export const claudeModel = "claude-opus-4-6";
export const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
export const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
export const delegatedResult = "Delegated API boundary inspected.";
/** Neither adapter completes a turn with this prompt on its own. */
export const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
export const createdThreadPrompt = "Complete the newly created ordinary thread.";
/** Caller threads with this prefix stay running, like the parent. */
export const heldCallerPrefix = "thread:mcp-scheduled-";

export const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;
export const claudeSelection = {
  instanceId: claudeInstanceId,
  model: claudeModel,
} satisfies ModelSelection;

const claudePromptText = (text: string) =>
  emptyMcpReplayPrompt(ProviderDriverKind.make("claudeAgent"), text);

/** What a child's Claude turn receives when the parent's agent sent `text` (upstream b0b2c4f952). */
export const agentClaudePromptText = (text: string, senderThreadId: ThreadId = parentThreadId) =>
  claudePromptText(
    withMessageSenderNote({ createdBy: "agent", creationSource: "mcp", senderThreadId }, text),
  );

export const decodeCreateThreadsResult = Schema.decodeUnknownEffect(
  OrchestratorMcpCreateThreadsResult,
);
export const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
export const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
export const decodeThreadWaitResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);
export const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
export const decodeTaskCancelResult = Schema.decodeUnknownEffect(OrchestratorMcpTaskCancelResult);
export const decodeThreadUpdateResult = Schema.decodeUnknownEffect(ThreadMetadataMcpUpdateResult);
export const decodeThreadListResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
/** Delegation in these scenarios always runs its child locally. */
export const decodeLocalDelegateTaskResult = (input: unknown) =>
  decodeDelegateTaskResult(input).pipe(
    Effect.flatMap((result) =>
      result.childThreadId === null
        ? Effect.die(new Error("expected a local delegated child"))
        : Effect.succeed({ ...result, childThreadId: result.childThreadId }),
    ),
    Effect.orDie,
  );

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.
export const declaredFailure = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const text = result.content[0];
  expect(text?.type).toBe("text");
  return text?.type === "text" ? JSON.parse(text.text) : undefined;
};

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

interface CapturedTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
}

function unsupported(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}

function makeDeterministicAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly shouldComplete: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => boolean;
  readonly terminalGate?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Deferred.Deferred<void> | undefined;
  readonly beforeAdmissionReturns?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void>;
  readonly afterTurnCompleted?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void>;
  readonly response: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => string;
  readonly steerReceived?: (
    steer: ProviderAdapter.ProviderAdapterV2SteerInput,
  ) => Deferred.Deferred<void> | undefined;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    mcpSessionInjection: true,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const sessionScope = yield* Scope.Scope;
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const publish = (providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();
        const turnInputs = new Map<ProviderTurnId, ProviderAdapter.ProviderAdapterV2TurnInput>();
        const terminalFibers = new Map<ProviderTurnId, Fiber.Fiber<void>>();

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              // Own this turn's gate before a running event lets the test
              // replace the thread's gate for its successor.
              const terminalGate = input.terminalGate?.(turnInput);
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  instanceId: input.instanceId,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                  modelSelection: turnInput.modelSelection,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              turnInputs.set(providerTurnId, turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt: eventTime,
                    completedAt: null,
                  },
                },
              ]);
              if (input.beforeAdmissionReturns !== undefined) {
                yield* input.beforeAdmissionReturns(turnInput);
              }
              // Native admission returns before terminal events; held results cannot occupy worker slots.
              const terminalFiber = yield* Effect.gen(function* () {
                if (terminalGate !== undefined) {
                  yield* Deferred.await(terminalGate);
                } else if (!input.shouldComplete(turnInput)) {
                  return;
                }
                const response = input.response(turnInput);
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver: input.driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: turnInput.providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        driver: input.driver,
                        nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                        strength: "strong",
                      },
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "completed",
                      startedAt: eventTime,
                      completedAt: eventTime,
                    },
                  },
                  {
                    type: "turn_item.updated",
                    driver: input.driver,
                    turnItem: {
                      id: TurnItemId.make(
                        `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                      ),
                      threadId: turnInput.threadId,
                      runId: turnInput.runId,
                      nodeId: turnInput.rootNodeId,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: turnInput.runOrdinal * 100 + 1,
                      status: "completed",
                      title: null,
                      startedAt: eventTime,
                      completedAt: eventTime,
                      updatedAt: eventTime,
                      type: "assistant_message",
                      messageId: MessageId.make(
                        `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                      ),
                      text: response,
                      streaming: false,
                    },
                  },
                  {
                    type: "turn.terminal",
                    driver: input.driver,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    runOrdinal: turnInput.runOrdinal,
                    status: "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  },
                ]);
                if (input.afterTurnCompleted !== undefined) {
                  yield* input.afterTurnCompleted(turnInput);
                }
              }).pipe(Effect.forkIn(sessionScope));
              terminalFibers.set(providerTurnId, terminalFiber);
            }),
          steerTurn: (steer) => {
            const received = input.steerReceived?.(steer);
            return received === undefined
              ? Effect.void
              : Deferred.succeed(received, undefined).pipe(Effect.asVoid);
          },
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              const terminalFiber = terminalFibers.get(providerTurnId);
              if (terminalFiber !== undefined) yield* Fiber.interrupt(terminalFiber);
              terminalFibers.delete(providerTurnId);
              const turnInput = turnInputs.get(providerTurnId);
              const completedAt = yield* DateTime.now;
              if (turnInput !== undefined) {
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver: input.driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        driver: input.driver,
                        nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                        strength: "strong",
                      },
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "interrupted",
                      startedAt: completedAt,
                      completedAt,
                    },
                  },
                ]);
              }
              yield* publish([
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unsupported(input.driver, "readThreadSnapshot is unused in this test"),
          rollbackThread: () => unsupported(input.driver, "rollbackThread is unused in this test"),
          forkThread: () => unsupported(input.driver, "forkThread is unused in this test"),
        };
      }),
  };
}

// SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
// Waits span child turns whose work scales with CPU contention: a 5 s deadline failed on
// slow runners. This one only names the stalled milestone before the 120 s test limit.
const MILESTONE_DEADLINE = "60 seconds";
// SCIENT-FORK:END
function waitForProjection(
  orchestrator: Orchestrator.OrchestratorV2Shape,
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
  milestone?: string,
) {
  return waitForDurableProjection(orchestrator, threadId, predicate).pipe(
    // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
    Effect.timeout(MILESTONE_DEADLINE),
    // SCIENT-FORK:END
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const observed = yield* Effect.exit(orchestrator.getThreadProjection(threadId));
        yield* Effect.logError("orchestrator-mcp.test.projection-milestone-failed", {
          milestone: milestone ?? "unlabeled",
          threadId,
          error,
          observed:
            observed._tag === "Failure"
              ? { diagnosticCause: observed.cause }
              : {
                  runs: observed.value.runs.map(({ id, status, delegatedCompletion }) => ({
                    id,
                    status,
                    delegatedCompletion,
                  })),
                  tasks: observed.value.subagents.map(({ id, status, completionDelivery }) => ({
                    id,
                    status,
                    completionDelivery,
                  })),
                },
        });
      }),
    ),
  );
}

// A durable cursor plus replay/live tail closes the commit/read race without sleeps.
function waitForDurableProjection(
  orchestrator: Orchestrator.OrchestratorV2Shape,
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  return Effect.gen(function* () {
    const cursor = yield* orchestrator.getThreadEventSequence(threadId);
    const pull = yield* Stream.toPull(
      orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
    );
    const initial = yield* orchestrator.getThreadProjection(threadId);
    // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
    // No inner deadline: callers that need one name their milestone (waitForProjection).
    const found = yield* Stream.concat(
      Stream.succeed(initial),
      Stream.fromPull(Effect.succeed(pull)).pipe(
        Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
      ),
    ).pipe(Stream.filter(predicate), Stream.runHead);
    // SCIENT-FORK:END
    return Option.getOrThrow(found);
  }).pipe(Effect.scoped);
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

function scheduledTaskFromUpsert(input: ScheduledTaskUpsertInput): ScheduledTask {
  const timestamp = IsoDateTime.make("2026-07-01T09:00:00.000Z");
  return {
    id: input.id ?? ScheduledTaskId.make(`scheduled-task:${input.commandId ?? "stub"}`),
    title: input.title,
    prompt: input.prompt,
    enabled: input.enabled,
    schedule:
      input.schedule.type === "webhook"
        ? {
            type: "webhook",
            signature:
              input.schedule.signature == null
                ? null
                : {
                    header: input.schedule.signature.header,
                    encoding: input.schedule.signature.encoding,
                    prefix: input.schedule.signature.prefix,
                  },
          }
        : input.schedule,
    projectId: input.projectId,
    threadId: input.threadId ?? null,
    workspaceStrategy: input.workspaceStrategy,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdBy: input.createdBy ?? "user",
    creationSource: input.creationSource ?? "web",
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
}

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
  Layer.provide(
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed("main"),
      resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
    }),
  ),
);

type NativeTerminal = { readonly threadId: ThreadId; readonly messageId: MessageId };

const makeFixtureState = Effect.gen(function* () {
  const cwd = yield* checkpointWorkspace("orchestrator-mcp-toolkit");
  const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
  const gates = {
    steerReceived: new Map<string, Deferred.Deferred<void>>(),
    threadTerminal: new Map<ThreadId, Deferred.Deferred<void>>(),
    messageTerminal: new Map<MessageId, Deferred.Deferred<void>>(),
    // Holds a delegated child whose thread id is not known until it starts.
    promptTerminal: new Map<string, Deferred.Deferred<void>>(),
    // Completes on a thread's first continuation offer.
    offered: new Map<ThreadId, Deferred.Deferred<void>>(),
  };
  // Fences one delivery's actual adapter entry, not merely its committed run status.
  const admission = {
    entered: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
    messageId: undefined as MessageId | undefined,
  };
  const nativeTerminals: NativeTerminal[] = [];
  const nativeTerminalEvents = yield* Queue.unbounded<NativeTerminal>();
  const recordNativeTerminal = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    Effect.gen(function* () {
      const terminal = { threadId: turn.threadId, messageId: turn.message.messageId };
      nativeTerminals.push(terminal);
      yield* Queue.offer(nativeTerminalEvents, terminal);
    });
  const awaitNativeTerminal = (matches: (terminal: NativeTerminal) => boolean) =>
    Effect.suspend(() =>
      nativeTerminals.some(matches)
        ? Effect.void
        : Stream.fromQueue(nativeTerminalEvents).pipe(
            Stream.filter(matches),
            Stream.take(1),
            Stream.runDrain,
          ),
    );
  // These fixture-owned prompts define mock routing and results; provider
  // guidance remains visible in the captured prepared input.
  const claudePrompts = new Map<string, string>();
  const declareClaudePrompt = (text: string) => {
    claudePrompts.set(claudePromptText(text), text);
  };
  for (const text of [delegatedPrompt, cancellationPrompt, createdThreadPrompt]) {
    declareClaudePrompt(text);
  }
  // Upstream b0b2c4f952: an agent's message reaches the provider after a line naming its sender.
  const withoutSenderNote = (text: string) => text.replace(/^\[Scient: [^\n]*\]\n\n/, "");
  const claudePrompt = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    claudePrompts.get(withoutSenderNote(turn.message.text)) ?? turn.message.text;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
    makeDeterministicAdapter({
      instanceId: codexInstanceId,
      driver: ProviderDriverKind.make("codex"),
      capabilities: {
        ...CodexProviderCapabilitiesV2,
        turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: false },
      },
      afterTurnCompleted: recordNativeTerminal,
      capturedTurns,
      beforeAdmissionReturns: (turn) =>
        turn.message.messageId === admission.messageId
          ? Effect.gen(function* () {
              yield* Deferred.succeed(admission.entered, undefined);
              yield* Deferred.await(admission.release);
            })
          : Effect.void,
      shouldComplete: (turn) =>
        turn.threadId !== parentThreadId &&
        !turn.threadId.startsWith(heldCallerPrefix) &&
        withoutSenderNote(turn.message.text) !== cancellationPrompt,
      terminalGate: (turn) =>
        gates.messageTerminal.get(turn.message.messageId) ??
        gates.threadTerminal.get(turn.threadId) ??
        gates.promptTerminal.get(withoutSenderNote(turn.message.text)),
      response: (turn) => `Codex completed: ${withoutSenderNote(turn.message.text)}`,
    }),
    makeDeterministicAdapter({
      instanceId: claudeInstanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      capabilities: ClaudeProviderCapabilitiesV2,
      afterTurnCompleted: recordNativeTerminal,
      capturedTurns,
      shouldComplete: (turn) => claudePrompt(turn) !== cancellationPrompt,
      terminalGate: (turn) =>
        gates.messageTerminal.get(turn.message.messageId) ??
        gates.threadTerminal.get(turn.threadId),
      response: (turn) =>
        claudePrompt(turn) === delegatedPrompt
          ? delegatedResult
          : `Claude completed: ${claudePrompt(turn)}`,
      // Exact text, sender note included: a steer from the wrong thread must not open the gate.
      steerReceived: (steer) => gates.steerReceived.get(steer.message.text),
    }),
  ]);
  const continuationOffers = yield* Ref.make<
    ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
  >([]);
  const continuationOfferEvents = yield* Queue.unbounded<void>();
  const layerContinuationProbe = Layer.succeed(
    ProviderContinuationRequests.ProviderContinuationRequests,
    {
      offer: (request) =>
        Ref.update(continuationOffers, (existing) =>
          // SCIENT-FORK:START — upstream re-offers an open delegated completion after each
          // checkpoint capture; the continuation service drops the repeat (same message id),
          // so the probe counts each delivery once.
          request.delegatedCompletion !== undefined &&
          existing.some(
            (offered) =>
              offered.threadId === request.threadId &&
              offered.providerThreadId === request.providerThreadId &&
              offered.delegatedCompletion?.messageId === request.delegatedCompletion?.messageId &&
              offered.delegatedCompletion?.generation === request.delegatedCompletion?.generation,
          )
            ? existing
            : // SCIENT-FORK:END
              [...existing, request],
        ).pipe(
          Effect.andThen(Queue.offer(continuationOfferEvents, undefined)),
          Effect.andThen(() => {
            const offered = gates.offered.get(request.threadId);
            return offered === undefined ? Effect.void : Deferred.succeed(offered, undefined);
          }),
        ),
      take: Effect.never,
    },
  );
  const providerCatalog = yield* Ref.make<ReadonlyArray<ServerProvider>>([
    makeProviderSnapshot({
      instanceId: codexInstanceId,
      driver: ProviderDriverKind.make("codex"),
      model: codexModel,
      optionDescriptors: [
        {
          id: "reasoning",
          label: "Reasoning effort",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
    }),
    makeProviderSnapshot({
      instanceId: claudeInstanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      model: claudeModel,
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "high", label: "High" },
            { id: "max", label: "Max" },
          ],
        },
        { id: "fastMode", label: "Fast mode", type: "boolean" },
      ],
    }),
    makeProviderSnapshot({
      instanceId: ProviderInstanceId.make("opencode"),
      driver: ProviderDriverKind.make("opencode"),
      model: "opencode/test",
    }),
  ]);
  const originalCatalog = yield* Ref.get(providerCatalog);
  const scheduledStore = yield* Ref.make<ReadonlyArray<ScheduledTask>>([]);
  const projectWrites = yield* Ref.make(0);
  return {
    cwd,
    capturedTurns,
    gates,
    admission,
    awaitNativeTerminal,
    declareClaudePrompt,
    layerRegistry,
    layerContinuationProbe,
    continuationOffers,
    continuationOfferEvents,
    providerCatalog,
    originalCatalog,
    scheduledStore,
    projectWrites,
  };
});

type FixtureState = Effect.Success<typeof makeFixtureState>;

const makeLayerTest = (state: FixtureState) => {
  const credentialRegistryLayer = makeCredentialRegistryLayer(
    EnvironmentId.make("environment:mcp-orchestrator"),
  );
  // The toolkit, manager and worker must observe the same current settings.
  const layerSettings = ServerSettings.layerTest({ responseStreamingMode: "turn" }).pipe(
    Layer.orDie,
  );
  const layerOrchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    {
      name: "orchestrator-mcp-toolkit",
      runtimePolicyOverride: {
        cwd: state.cwd,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    },
    state.layerRegistry,
    {
      configureMcp: true,
      mcpSessionRegistryLayer: credentialRegistryLayer,
      layerServerSettings: layerSettings,
    },
  ).pipe(Layer.provide(state.layerContinuationProbe));
  const layerOrchestration = Layer.merge(
    layerOrchestrator,
    ThreadManagementService.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(layerSettings),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
  );
  const layerProviderRegistry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    ...ProviderRegistryMock.makeProviderRegistryMock(state.originalCatalog),
    getProviders: Ref.get(state.providerCatalog),
  });
  const { scheduledStore } = state;
  const layerScheduledTaskStub = Layer.succeed(
    ScheduledTaskService.ScheduledTaskService,
    ScheduledTaskService.ScheduledTaskService.of({
      list: () => Ref.get(scheduledStore).pipe(Effect.map((tasks) => ({ tasks }))),
      subscribeList: () => Stream.empty,
      upsert: (input) =>
        Effect.gen(function* () {
          const task = scheduledTaskFromUpsert(input);
          yield* Ref.update(scheduledStore, (all) => [
            ...all.filter((candidate) => candidate.id !== task.id),
            task,
          ]);
          return { task };
        }),
      setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
      delete: (input) =>
        Ref.update(scheduledStore, (all) =>
          all.filter((candidate) => candidate.id !== input.id),
        ).pipe(Effect.as({ id: input.id })),
      deleteForThread: () => Effect.die("unused in this test"),
      moveThreadTasks: () => Effect.die("unused in this test"),
      runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
      rotateWebhookToken: () => Effect.die("unused in this test"),
      listWebhookDeliveries: () => Effect.die("unused in this test"),
      getWebhookDelivery: () => Effect.die("unused in this test"),
      triggerWebhook: () => Effect.die("unused in this test"),
    }),
  );
  const layerRepositories = Layer.mock(
    SourceControlRepositoryService.SourceControlRepositoryService,
  )({});
  const layerCloneTracker = ProjectCloneTracker.layer.pipe(Layer.provide(layerRepositories));
  const layerGit = GitVcsDriver.layer.pipe(
    Layer.provide(layerOrchestration),
    Layer.provide(NodeServices.layer),
  );
  const projectGuardDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      update: (input) =>
        Ref.update(state.projectWrites, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(new ProjectService.ProjectNotFoundError({ projectId: input.projectId })),
          ),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/tmp/mcp-managed-projects",
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    layerRepositories,
    layerCloneTracker,
  );
  const projectGuardRegistration = McpHttpServer.toolkitRegistration(
    ProjectToolkit,
    ProjectHandlersLive,
  ).pipe(Layer.provide(projectGuardDependencies));
  return Layer.mergeAll(
    layerOrchestratorToolkit,
    McpHttpServer.layerThreadToolkit,
    projectGuardRegistration,
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(layerOrchestration),
    Layer.provideMerge(credentialRegistryLayer),
    Layer.provide(state.layerRegistry),
    Layer.provide(layerProviderRegistry),
    Layer.provideMerge(layerSettings),
    Layer.provide(layerScheduledTaskStub),
    Layer.provide(layerGit),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({ id, defaultModelSelection: null } as never)
              : Option.none(),
          ),
        // Upstream c0b1d32c97: capabilities and delegation scan the caller's own folder.
        workspaceScanDirectory: Effect.succeed,
      }),
    ),
    Layer.provideMerge(
      SecretRequests.layer.pipe(
        Layer.provide(layerMemorySecretStore),
        Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        Layer.provide(layerOrchestration),
      ),
    ),
    Layer.provide(
      DocumentText.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Layer.provideMerge(McpProviderSessions.layer),
  );
};

type ToolkitServices = Layer.Success<ReturnType<typeof makeLayerTest>>;
type DispatchResult = Effect.Success<ReturnType<Orchestrator.OrchestratorV2Shape["dispatch"]>>;
type StartedRun = OrchestrationV2Run & { readonly rootNodeId: NodeId };

type McpServerShape = McpServer.McpServer["Service"];

const makeHandle = (
  state: FixtureState,
  serverService: Effect.Effect<McpServerShape, never, McpServer.McpServer>,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const server = yield* serverService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const credentialRegistry = yield* McpSessionRegistry.McpSessionRegistry;
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const { continuationOffers, continuationOfferEvents } = state;

    const waitFor = (
      threadId: ThreadId,
      predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
      milestone?: string,
    ) => waitForProjection(orchestrator, threadId, predicate, milestone);
    const waitForDurable = (
      threadId: ThreadId,
      predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
    ) => waitForDurableProjection(orchestrator, threadId, predicate);
    const projection = (threadId: ThreadId) => orchestrator.getThreadProjection(threadId);

    const waitForContinuationOffers = (count: number, milestone?: string) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(continuationOffers);
        if (current.length >= count) return current;
        return Option.getOrThrow(
          yield* Stream.fromQueue(continuationOfferEvents).pipe(
            Stream.mapEffect(() => Ref.get(continuationOffers)),
            Stream.filter((offers) => offers.length >= count),
            Stream.runHead,
            // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
            Effect.timeout(MILESTONE_DEADLINE),
            // SCIENT-FORK:END
          ),
        );
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError("orchestrator-mcp.test.continuation-milestone-failed", {
            milestone: milestone ?? "unlabeled",
            error,
          }),
        ),
      );
    const awaitOffer = (
      matches: (
        offers: ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>,
      ) => boolean,
    ) =>
      Effect.gen(function* () {
        if (matches(yield* Ref.get(continuationOffers))) return;
        yield* Stream.fromQueue(continuationOfferEvents).pipe(
          Stream.mapEffect(() => Ref.get(continuationOffers)),
          Stream.filter(matches),
          Stream.take(1),
          Stream.runDrain,
        );
      });
    const expectOffersToStay = (count: number) =>
      Effect.gen(function* () {
        yield* worker.drain();
        expect(yield* Ref.get(continuationOffers)).toHaveLength(count);
      });
    // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
    // Cancellation stops runs before disposing delivery, allowing a stopped run to offer meanwhile.
    // Consumers discard withdrawn offers; assert only that no live delivery remains offered.
    const expectNoLiveOffers = (threadId: ThreadId) =>
      Effect.gen(function* () {
        yield* worker.drain();
        const liveDeliveries = new Set(
          (yield* projection(threadId)).runs.flatMap((run) =>
            run.delegatedCompletion?.delivery == null
              ? []
              : [run.delegatedCompletion.delivery.messageId],
          ),
        );
        expect(
          (yield* Ref.get(continuationOffers)).filter(
            (offer) =>
              offer.delegatedCompletion === undefined ||
              liveDeliveries.has(offer.delegatedCompletion.messageId),
          ),
        ).toEqual([]);
        yield* Ref.set(continuationOffers, []);
      });
    // SCIENT-FORK:END
    const clearOffers = Ref.set(continuationOffers, []);

    /** Replays offers through the real continuation consumer until it asks for more. */
    const consumeOffers = (
      offers: ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>,
    ) =>
      Effect.gen(function* () {
        const pendingOffers = yield* Queue.unbounded<
          ProviderContinuationRequests.ProviderContinuationRequest | undefined
        >();
        yield* Queue.offerAll(pendingOffers, [...offers, undefined]);
        const offersConsumed = yield* Deferred.make<void>();
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* Deferred.await(offersConsumed).pipe(
          Effect.provide(
            ProviderContinuationService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  IdAllocator.layer,
                  Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
                  Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
                    offer: (request) => Queue.offer(pendingOffers, request).pipe(Effect.asVoid),
                    take: Queue.take(pendingOffers).pipe(
                      Effect.filterOrElse(
                        (request) => request !== undefined,
                        () =>
                          Deferred.succeed(offersConsumed, undefined).pipe(
                            Effect.andThen(Effect.never),
                          ),
                      ),
                    ),
                  }),
                ),
              ),
            ),
          ),
        );
      });

    /** Creates a thread and starts its first turn; `hold` keeps that turn running. */
    const startThread = (input: {
      readonly threadId: ThreadId;
      readonly title?: string;
      readonly text?: string;
      readonly runtimeMode?: "full-access" | "approval-required";
      readonly interactionMode?: "default" | "plan";
      readonly projectId?: ProjectId;
      readonly hold?: boolean;
    }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        if (input.hold === true) state.gates.threadTerminal.set(input.threadId, gate);
        const created = yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${input.threadId}:create`),
          threadId: input.threadId,
          projectId: input.projectId ?? projectId,
          title: input.title ?? "MCP scenario thread",
          modelSelection: codexSelection,
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          branch: null,
          worktreePath: state.cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${input.threadId}:start`),
          threadId: input.threadId,
          messageId: MessageId.make(`message:${input.threadId}:start`),
          text: input.text ?? parentPrompt,
          attachments: [],
          modelSelection: codexSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const started = yield* waitFor(
          input.threadId,
          (candidate) =>
            candidate.runs.some((run) => run.status === "running") &&
            candidate.providerTurns.some((turn) => turn.status === "running"),
          `${input.threadId}-running`,
        );
        const run = started.runs.find((candidate) => candidate.status === "running");
        if (run === undefined || run.rootNodeId === null) {
          return yield* Effect.die(new Error(`Run of ${input.threadId} did not start.`));
        }
        return {
          run: run as StartedRun,
          createdSequence: created.sequence,
          release: Deferred.succeed(gate, undefined).pipe(Effect.asVoid),
        };
      });
    const startParent = startThread({ threadId: parentThreadId, title: "MCP parent" }).pipe(
      Effect.map(({ run }) => run),
    );

    const callerScopeFor = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const config = yield* sessions.read(threadId);
        if (config === undefined)
          return yield* Effect.die(new Error("Expected the live manager-issued credential."));
        const scope = yield* credentialRegistry.resolve(
          config.authorizationHeader.replace(/^Bearer /, ""),
        );
        if (scope === undefined)
          return yield* Effect.die(new Error("Expected the actual credential to resolve."));
        return scope;
      });
    const invokeAs = (
      callScope: McpInvocationContext.McpInvocationScope,
      name: string,
      args: Record<string, unknown>,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, callScope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    /** Calls a tool with the parent's live credential. */
    const invoke = (name: string, args: Record<string, unknown>) =>
      callerScopeFor(parentThreadId).pipe(Effect.flatMap((scope) => invokeAs(scope, name, args)));
    const delegateAs = (threadId: ThreadId, args: Record<string, unknown>) =>
      callerScopeFor(threadId).pipe(
        Effect.flatMap((scope) => invokeAs(scope, "delegate_task", args)),
        Effect.flatMap((result) => decodeLocalDelegateTaskResult(result.structuredContent)),
      );
    const taskStatus = (taskId: string, threadId: ThreadId = parentThreadId) =>
      callerScopeFor(threadId).pipe(
        Effect.flatMap((scope) => invokeAs(scope, "task_status", { taskId })),
      );

    const taskFromDispatch = (result: DispatchResult) => {
      const taskEvent = result.storedEvents.find(
        (stored) =>
          stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
      );
      if (taskEvent?.event.type !== "subagent.updated") {
        throw new Error("Delegated task projection missing.");
      }
      return taskEvent.event.payload;
    };
    /** Requests an app-owned task as the server's delegation command does. */
    const requestTask = (input: {
      readonly parentThreadId?: ThreadId;
      readonly parentRun: StartedRun;
      readonly label: string;
      readonly task: string;
      readonly modelSelection?: ModelSelection;
      readonly legacyWake?: boolean;
    }) => {
      if (input.modelSelection?.instanceId === claudeInstanceId)
        state.declareClaudePrompt(input.task);
      return orchestrator
        .dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`command:${input.label}:delegate`),
          parentThreadId: input.parentThreadId ?? parentThreadId,
          parentRunId: input.parentRun.id,
          parentNodeId: input.parentRun.rootNodeId,
          task: input.task,
          modelSelection: input.modelSelection ?? codexSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          ...(input.legacyWake === true ? {} : { completionWake: "always" as const }),
        })
        .pipe(Effect.map(taskFromDispatch));
    };
    const deliveryOf = (candidate: OrchestrationV2ThreadProjection, parentRunId: string) =>
      candidate.runs.find((run) => run.id === parentRunId)?.delegatedCompletion?.delivery ?? null;
    /** Waits until the parent run reserves a delivery that `accepts`. */
    const reservedDelivery = (
      threadId: ThreadId,
      parentRunId: string,
      accepts: (
        delivery: OrchestrationV2DelegatedCompletionDelivery,
        projection: OrchestrationV2ThreadProjection,
      ) => boolean,
      milestone?: string,
    ) =>
      waitFor(
        threadId,
        (candidate) => {
          const delivery = deliveryOf(candidate, parentRunId);
          return delivery !== null && accepts(delivery, candidate);
        },
        milestone,
      ).pipe(Effect.map((candidate) => deliveryOf(candidate, parentRunId)!));
    /** Sends a reserved delivery as the continuation consumer would. */
    const dispatchDelivery = (input: {
      readonly threadId: ThreadId;
      readonly parentRunId: OrchestrationV2Run["id"];
      readonly delivery: OrchestrationV2DelegatedCompletionDelivery;
      readonly label: string;
      readonly modelSelection?: ModelSelection;
    }) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "server",
        commandId: CommandId.make(`command:${input.label}:dispatch-delivery`),
        threadId: input.threadId,
        messageId: input.delivery.messageId,
        text: "Delegated task reached a terminal state.",
        attachments: [],
        modelSelection: input.modelSelection ?? codexSelection,
        dispatchMode: { type: "queue_after_active" },
        delegatedCompletion: {
          parentRunId: input.parentRunId,
          generation: input.delivery.generation,
          taskIds: input.delivery.taskIds,
        },
      });
    const runForMessage = (
      threadId: ThreadId,
      messageId: MessageId,
      status: OrchestrationV2Run["status"],
      milestone?: string,
    ) =>
      waitFor(
        threadId,
        (candidate) =>
          candidate.runs.some((run) => run.userMessageId === messageId && run.status === status),
        milestone,
      ).pipe(
        Effect.map((candidate) => candidate.runs.find((run) => run.userMessageId === messageId)!),
      );
    /** One completed Claude task whose wake is queued behind the parent's active run. */
    const queueCompletionWake = (parentRun: StartedRun, label: string, taskText: string) =>
      Effect.gen(function* () {
        const task = yield* requestTask({
          parentRun,
          label,
          task: taskText,
          modelSelection: claudeSelection,
        });
        const delivery = yield* reservedDelivery(
          parentThreadId,
          parentRun.id,
          (reserved, candidate) =>
            reserved.taskIds.includes(task.id) &&
            candidate.subagents.find((row) => row.id === task.id)?.status === "completed",
          `${label}-reserved`,
        );
        yield* dispatchDelivery({
          threadId: parentThreadId,
          parentRunId: parentRun.id,
          delivery,
          label,
        });
        const queuedRun = yield* runForMessage(
          parentThreadId,
          delivery.messageId,
          "queued",
          `${label}-queued`,
        );
        return { task, delivery, queuedRun };
      });
    const taskRow = (threadId: ThreadId, taskId: string) =>
      projection(threadId).pipe(
        Effect.map((candidate) => candidate.subagents.find((task) => task.id === taskId)),
      );

    return {
      ...state,
      orchestrator,
      server,
      worker,
      waitFor,
      waitForDurable,
      projection,
      waitForContinuationOffers,
      awaitOffer,
      expectOffersToStay,
      expectNoLiveOffers,
      clearOffers,
      consumeOffers,
      startThread,
      startParent,
      callerScopeFor,
      invokeAs,
      invoke,
      delegateAs,
      taskStatus,
      taskFromDispatch,
      requestTask,
      reservedDelivery,
      dispatchDelivery,
      runForMessage,
      queueCompletionWake,
      taskRow,
    };
  });

export type ToolkitFixture = Effect.Success<ReturnType<typeof makeHandle>>;
export type ToolkitTask = ReturnType<ToolkitFixture["taskFromDispatch"]>;

/**
 * Binds the in-process MCP server, which only test files may name, and returns
 * a runner that gives each scenario fresh projections, adapters and credentials.
 */
export const makeWithToolkit =
  (serverService: Effect.Effect<McpServerShape, never, McpServer.McpServer>) =>
  <A, E>(body: (fixture: ToolkitFixture) => Effect.Effect<A, E, ToolkitServices>) =>
    Effect.gen(function* () {
      const state = yield* makeFixtureState;
      return yield* makeHandle(state, serverService).pipe(
        Effect.flatMap(body),
        Effect.provide(makeLayerTest(state)),
      );
    });
