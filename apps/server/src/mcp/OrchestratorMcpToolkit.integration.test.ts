import { type ScheduledTaskUpsertInput } from "@t3tools/contracts";
import { IsoDateTime } from "@t3tools/contracts";
import { OrchestratorMcpThreadWaitResult } from "@t3tools/contracts";
import { OrchestratorMcpTaskCancelResult } from "@t3tools/contracts";
import { ThreadMetadataMcpUpdateResult } from "@t3tools/contracts";
import { OrchestratorMcpThreadListResult } from "@t3tools/contracts";
import { OrchestratorMcpCreateThreadsResult } from "@t3tools/contracts";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as DateTime from "effect/DateTime";
import { type OrchestrationV2ProviderSession } from "@t3tools/contracts";
import { ProviderTurnId } from "@t3tools/contracts";
import { ProviderThreadId } from "@t3tools/contracts";
import { type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { TurnItemId } from "@t3tools/contracts";
import { type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "../orchestration-v2/ProviderContinuationService.ts";
import { type ScheduledTask } from "@t3tools/contracts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { EventId } from "@t3tools/contracts";
import { OrchestratorMcpThreadReadResult } from "@t3tools/contracts";
import { ScheduledTaskId } from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import { RuntimeRequestId } from "@t3tools/contracts";
import { type OrchestrationV2DelegatedCompletionDelivery } from "@t3tools/contracts";
import { type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { type OrchestrationV2RuntimeRequest } from "@t3tools/contracts";
import { NodeId } from "@t3tools/contracts";
import { RunId } from "@t3tools/contracts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as NetAddress from "effect/net/NetAddress";
import { HttpServer } from "effect/http";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DocumentText from "../provider/DocumentText.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  isProviderNativeSubagentThread,
  MessageId,
  type ModelSelection,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { threadShellFromProjection } from "@t3tools/shared/orchestrationV2ThreadShell";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import {
  emptyMcpReplayPrompt,
  withIssuedCodexMcpReplayExpectations,
} from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  layerProviderReplay,
} from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { layer as ProjectHandlersLive } from "./toolkits/project/handlers.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { delegatedTaskRun, hasPendingChildRuns } from "./OrchestratorMcpService.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const text = result.content[0];
  expect(text?.type).toBe("text");
  return text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";

const makeCredentialRegistryLayer = (environmentId: EnvironmentId) =>
  McpSessionRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
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

const decodeCreateThreadsResult = Schema.decodeUnknownEffect(OrchestratorMcpCreateThreadsResult);
const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(function* (
  followupResult: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(
    decodeURIComponent(delegatedTaskStatusTranscriptFile.pathname),
  );
  return yield* decodeProviderReplayNdjson(text.replaceAll(queuedFollowupResult, followupResult));
}, Effect.provide(NodeServices.layer));

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
          observed: JSON.stringify(
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
          ),
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

const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("ScheduledTaskService.upsert is unused in this test"),
    setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
    delete: () => Effect.die("ScheduledTaskService.delete is unused in this test"),
    deleteForThread: () => Effect.die("unused in this test"),
    runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
    rotateWebhookToken: () => Effect.die("unused in this test"),
    listWebhookDeliveries: () => Effect.die("unused in this test"),
    getWebhookDelivery: () => Effect.die("unused in this test"),
    triggerWebhook: () => Effect.die("unused in this test"),
  }),
);

const createdThreadPrompt = "Complete the newly created ordinary thread.";

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

const claudeModel = "claude-opus-4-6";

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

const claudeSelection = {
  instanceId: claudeInstanceId,
  model: claudeModel,
} satisfies ModelSelection;

const decodeThreadWaitResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);

const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);

const decodeTaskCancelResult = Schema.decodeUnknownEffect(OrchestratorMcpTaskCancelResult);

const decodeThreadUpdateResult = Schema.decodeUnknownEffect(ThreadMetadataMcpUpdateResult);

const decodeThreadListResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);

const approvalCompletionPrompt = "Finish the delegated work once its approval is decided.";

describe("orchestrator MCP toolkit", () => {
  it.live(
    "delegates cross-provider tasks, polls and cancels children, and creates ordinary threads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("orchestrator-mcp-toolkit");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const steerReceivedGates = new Map<string, Deferred.Deferred<void>>();
          const parentTerminalGates = new Map<ThreadId, Deferred.Deferred<void>>();
          const messageTerminalGates = new Map<MessageId, Deferred.Deferred<void>>();
          const fanoutFirstAdapterEntered = yield* Deferred.make<void>();
          const fanoutFirstStartedGate = yield* Deferred.make<void>();
          let firstFanoutMessageId: MessageId | undefined;
          type NativeTerminal = { readonly threadId: ThreadId; readonly messageId: MessageId };
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
            claudePrompts.set(
              emptyMcpReplayPrompt(ProviderDriverKind.make("claudeAgent"), text),
              text,
            );
          };
          for (const text of [delegatedPrompt, cancellationPrompt, createdThreadPrompt]) {
            declareClaudePrompt(text);
          }
          const claudePrompt = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            claudePrompts.get(turn.message.text) ?? turn.message.text;
          // Holds a delegated child whose thread id is not known until it starts.
          const promptTerminalGates = new Map<string, Deferred.Deferred<void>>();
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
              // Fence this delivery's actual adapter entry, not merely its committed run status.
              beforeAdmissionReturns: (turn) =>
                turn.message.messageId === firstFanoutMessageId
                  ? Effect.gen(function* () {
                      yield* Deferred.succeed(fanoutFirstAdapterEntered, undefined);
                      yield* Deferred.await(fanoutFirstStartedGate);
                    })
                  : Effect.void,
              shouldComplete: (turn) =>
                turn.threadId !== parentThreadId &&
                !turn.threadId.startsWith("thread:mcp-scheduled-") &&
                turn.message.text !== cancellationPrompt,
              terminalGate: (turn) =>
                messageTerminalGates.get(turn.message.messageId) ??
                parentTerminalGates.get(turn.threadId) ??
                promptTerminalGates.get(turn.message.text),
              response: (turn) => `Codex completed: ${turn.message.text}`,
            }),
            makeDeterministicAdapter({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              capabilities: ClaudeProviderCapabilitiesV2,
              afterTurnCompleted: recordNativeTerminal,
              capturedTurns,
              shouldComplete: (turn) => claudePrompt(turn) !== cancellationPrompt,
              terminalGate: (turn) =>
                messageTerminalGates.get(turn.message.messageId) ??
                parentTerminalGates.get(turn.threadId),
              response: (turn) =>
                claudePrompt(turn) === delegatedPrompt
                  ? delegatedResult
                  : `Claude completed: ${claudePrompt(turn)}`,
              steerReceived: (steer) => steerReceivedGates.get(steer.message.text),
            }),
          ]);
          const approvalParentId = ThreadId.make("thread:mcp-approval-parent");
          const approvalOffered = yield* Deferred.make<void>();
          const continuationOffers = yield* Ref.make<
            ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
          >([]);
          const continuationOfferEvents = yield* Queue.unbounded<void>();
          const layerContinuationProbe = Layer.succeed(
            ProviderContinuationRequests.ProviderContinuationRequests,
            {
              offer: (request) =>
                Ref.update(continuationOffers, (existing) => [...existing, request]).pipe(
                  Effect.andThen(Queue.offer(continuationOfferEvents, undefined)),
                  Effect.andThen(
                    request.threadId === approvalParentId
                      ? Deferred.succeed(approvalOffered, undefined)
                      : Effect.void,
                  ),
                ),
              take: Effect.never,
            },
          );
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
          const expectOffersToStay = (count: number) =>
            Effect.gen(function* () {
              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              yield* worker.drain();
              expect(yield* Ref.get(continuationOffers)).toHaveLength(count);
            });
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
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            layerRegistry,
            {
              configureMcp: true,
              mcpSessionRegistryLayer: credentialRegistryLayer,
              layerServerSettings: layerSettings,
            },
          ).pipe(Layer.provide(layerContinuationProbe));
          const layerOrchestration = Layer.merge(
            layerOrchestrator,
            ThreadManagementService.layer.pipe(
              Layer.provide(layerOrchestrator),
              Layer.provide(layerSettings),
              Layer.provide(
                CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              ),
            ),
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
          const layerProviderRegistry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
            ...ProviderRegistryMock.makeProviderRegistryMock(originalCatalog),
            getProviders: Ref.get(providerCatalog),
          });
          const scheduledStore = yield* Ref.make<ReadonlyArray<ScheduledTask>>([]);
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
              setEnabled: () =>
                Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
              delete: (input) =>
                Ref.update(scheduledStore, (all) =>
                  all.filter((candidate) => candidate.id !== input.id),
                ).pipe(Effect.as({ id: input.id })),
              deleteForThread: () => Effect.die("unused in this test"),
              runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
              rotateWebhookToken: () => Effect.die("unused in this test"),
              listWebhookDeliveries: () => Effect.die("unused in this test"),
              getWebhookDelivery: () => Effect.die("unused in this test"),
              triggerWebhook: () => Effect.die("unused in this test"),
            }),
          );
          const projectWrites = yield* Ref.make(0);
          const layerRepositories = Layer.mock(
            SourceControlRepositoryService.SourceControlRepositoryService,
          )({});
          const layerCloneTracker = ProjectCloneTracker.layer.pipe(
            Layer.provide(layerRepositories),
          );
          const layerGit = GitVcsDriver.layer.pipe(
            Layer.provide(layerOrchestration),
            Layer.provide(NodeServices.layer),
          );
          const projectGuardDependencies = Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              update: (input) =>
                Ref.update(projectWrites, (count) => count + 1).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProjectService.ProjectNotFoundError({ projectId: input.projectId }),
                    ),
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
          const layerTest = Layer.mergeAll(
            layerOrchestratorToolkit,
            McpHttpServer.layerThreadToolkit,
            projectGuardRegistration,
          ).pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provideMerge(layerOrchestration),
            Layer.provideMerge(credentialRegistryLayer),
            Layer.provide(layerRegistry),
            Layer.provide(layerProviderRegistry),
            Layer.provideMerge(layerSettings),
            Layer.provide(layerScheduledTaskStub),
            Layer.provide(layerGit),
            Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
            Layer.provide(
              Layer.mock(ProjectService.ProjectService)({
                getById: (id) =>
                  Effect.succeed(
                    id === projectId
                      ? Option.some({ id, defaultModelSelection: null } as never)
                      : Option.none(),
                  ),
              }),
            ),
            Layer.provideMerge(
              SecretRequests.layer.pipe(
                Layer.provide(layerMemorySecretStore),
                Layer.provide(layerOrchestration),
              ),
            ),
            Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
            Layer.provideMerge(McpProviderSessions.layer),
          );

          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
            // Cancellation stops runs before disposing delivery, allowing a stopped run to offer meanwhile.
            // Consumers discard withdrawn offers; assert only that no live delivery remains offered.
            const expectNoLiveOffers = (threadId: ThreadId) =>
              Effect.gen(function* () {
                yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
                const liveDeliveries = new Set(
                  (yield* orchestrator.getThreadProjection(threadId)).runs.flatMap((run) =>
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
            const server = yield* McpServer.McpServer;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "MCP parent",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("message:mcp-parent:start"),
              text: parentPrompt,
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            const parent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some((run) =>
                  ["starting", "running", "waiting"].includes(run.status),
                ) && projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const parentRun = parent.runs[0];
            expect(parentRun?.status).toBe("running");

            const credentialRegistry = yield* McpSessionRegistry.McpSessionRegistry;
            const callerScopeFor = (threadId: ThreadId) =>
              Effect.gen(function* () {
                const sessions = yield* McpProviderSessions.McpProviderSessions;
                const config = yield* sessions.read(threadId);
                if (config === undefined)
                  return yield* Effect.die(
                    new Error("Expected the live manager-issued credential."),
                  );
                const scope = yield* credentialRegistry.resolve(
                  config.authorizationHeader.replace(/^Bearer /, ""),
                );
                if (scope === undefined)
                  return yield* Effect.die(new Error("Expected the actual credential to resolve."));
                return scope;
              });
            const invocation = yield* callerScopeFor(parentThreadId);
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
            const invoke = (name: string, args: Record<string, unknown>) =>
              callerScopeFor(parentThreadId).pipe(
                Effect.flatMap((scope) => invokeAs(scope, name, args)),
              );

            const deferredSettle = yield* invoke("scient_thread_organize", { action: "settle" });
            expect(deferredSettle.isError).toBe(false);
            expect(deferredSettle.structuredContent).toEqual({ settlesWhenTurnEnds: true });
            const afterDeferredSettle = yield* orchestrator.getThreadProjection(parentThreadId);
            expect(afterDeferredSettle.thread.settledOverride).not.toBe("settled");
            expect(afterDeferredSettle.runs.find((run) => run.id === parentRun?.id)?.status).toBe(
              "running",
            );

            const pinned = yield* invoke("scient_thread_organize", { action: "pin" });
            expect(pinned.isError).toBe(false);
            expect(pinned.structuredContent).toHaveProperty("sequence");
            expect((yield* orchestrator.getThreadShell(parentThreadId))?.pinnedAt).not.toBeNull();
            yield* invoke("scient_thread_organize", { action: "unpin" });
            expect((yield* orchestrator.getThreadShell(parentThreadId))?.pinnedAt).toBeNull();

            if (parentRun === undefined || parentRun.rootNodeId === null) {
              return yield* Effect.die(new Error("Parent run missing."));
            }
            for (const action of ["edit", "cancel"]) {
              const refusedQueueMutation = yield* invoke("scient_queue", {
                action,
                queuedRunId: parentRun.id,
                ...(action === "edit" ? { text: "Keep the active turn." } : {}),
              });
              expect(refusedQueueMutation.isError).toBe(true);
              expect(refusedQueueMutation.structuredContent).toBeUndefined();
              expect(declaredFailure(refusedQueueMutation)).toEqual({
                _tag: "OrchestratorMcpFailure",
                code: "orchestration_error",
                message: `Run ${parentRun.id} is not queued.`,
              });
            }

            let parentRootNodeId = parentRun.rootNodeId;
            const queueAutomaticCompletion = (suffix: string, taskText: string) =>
              Effect.gen(function* () {
                declareClaudePrompt(taskText);
                const delegated = yield* orchestrator.dispatch({
                  type: "delegated_task.request",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId: CommandId.make(`command:mcp-parent:${suffix}:delegate`),
                  parentThreadId,
                  parentRunId: parentRun.id,
                  parentNodeId: parentRootNodeId,
                  task: taskText,
                  modelSelection: claudeSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  completionWake: "always",
                });
                const taskEvent = delegated.storedEvents.find(
                  (stored) =>
                    stored.event.type === "subagent.updated" &&
                    stored.event.payload.origin === "app_owned",
                );
                if (taskEvent?.event.type !== "subagent.updated") {
                  return yield* Effect.die(
                    new Error(`Automatic completion task ${suffix} was not created.`),
                  );
                }
                const task = taskEvent.event.payload;
                const reserved = yield* waitForProjection(
                  orchestrator,
                  parentThreadId,
                  (projection) => {
                    const delivery = projection.runs.find((run) => run.id === parentRun.id)
                      ?.delegatedCompletion?.delivery;
                    return (
                      projection.subagents.find((candidate) => candidate.id === task.id)?.status ===
                        "completed" &&
                      delivery !== undefined &&
                      delivery !== null &&
                      delivery.taskIds.includes(task.id)
                    );
                  },
                );
                const delivery = reserved.runs.find((run) => run.id === parentRun.id)
                  ?.delegatedCompletion?.delivery;
                if (delivery === undefined || delivery === null) {
                  return yield* Effect.die(
                    new Error(`Automatic completion delivery ${suffix} was not reserved.`),
                  );
                }
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  createdBy: "agent",
                  creationSource: "server",
                  commandId: CommandId.make(`command:mcp-parent:${suffix}:dispatch`),
                  threadId: parentThreadId,
                  messageId: delivery.messageId,
                  text: "Delegated task reached a terminal state.",
                  attachments: [],
                  modelSelection: codexSelection,
                  dispatchMode: { type: "queue_after_active" },
                  delegatedCompletion: {
                    parentRunId: parentRun.id,
                    generation: delivery.generation,
                    taskIds: delivery.taskIds,
                  },
                });
                const queued = yield* waitForProjection(
                  orchestrator,
                  parentThreadId,
                  (projection) =>
                    projection.runs.some(
                      (run) => run.userMessageId === delivery.messageId && run.status === "queued",
                    ),
                );
                const queuedRun = queued.runs.find(
                  (run) => run.userMessageId === delivery.messageId,
                );
                if (queuedRun === undefined) {
                  return yield* Effect.die(
                    new Error(`Automatic completion delivery ${suffix} was not queued.`),
                  );
                }
                return { task, delivery, queuedRun };
              });

            const coalescedTask = (suffix: string) =>
              orchestrator.dispatch({
                type: "delegated_task.request",
                createdBy: "agent",
                creationSource: "mcp",
                commandId: CommandId.make(`command:mcp-parent:coalesced-${suffix}`),
                parentThreadId,
                parentRunId: parentRun.id,
                parentNodeId: parentRootNodeId,
                task: `Complete coalesced task ${suffix}.`,
                modelSelection: claudeSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                completionWake: "always",
              });
            const firstCoalesced = yield* coalescedTask("one");
            const secondCoalesced = yield* coalescedTask("two");
            const coalescedTaskIds = yield* Effect.forEach(
              [firstCoalesced, secondCoalesced],
              (result) =>
                Effect.gen(function* () {
                  const taskEvent = result.storedEvents.find(
                    (stored) =>
                      stored.event.type === "subagent.updated" &&
                      stored.event.payload.origin === "app_owned",
                  );
                  if (taskEvent?.event.type !== "subagent.updated") {
                    throw new Error("Coalesced delegated task projection missing.");
                  }
                  const childThreadId = taskEvent.event.payload.childThreadId;
                  if (childThreadId === null) throw new Error("Coalesced child thread missing.");
                  yield* awaitNativeTerminal((terminal) => terminal.threadId === childThreadId);
                  return taskEvent.event.payload.id;
                }),
            );
            const coalescedProjection = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                coalescedTaskIds.every(
                  (taskId) =>
                    projection.subagents.find((task) => task.id === taskId)?.status === "completed",
                ) &&
                projection.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion !==
                  undefined,
            );
            const coalescedCohort = coalescedProjection.runs.find(
              (run) => run.id === parentRun.id,
            )?.delegatedCompletion;
            expect(coalescedCohort?.delivery?.taskIds).toEqual(
              expect.arrayContaining(coalescedTaskIds),
            );
            expect(coalescedCohort?.delivery?.taskIds).toHaveLength(2);
            const coalescedOffers = yield* waitForContinuationOffers(1);
            expect(coalescedOffers).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  delegatedCompletion: expect.objectContaining({
                    parentRunId: parentRun.id,
                    messageId: coalescedCohort?.delivery?.messageId,
                  }),
                }),
              ]),
            );
            if (coalescedCohort?.delivery === undefined || coalescedCohort.delivery === null) {
              return yield* Effect.die(new Error("Coalesced delivery reservation missing."));
            }
            const coalescedDelivery = coalescedCohort.delivery;
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-parent:dispatch-coalesced-delivery"),
              threadId: parentThreadId,
              messageId: coalescedDelivery.messageId,
              text: "Delegated tasks reached terminal states.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: parentRun.id,
                generation: coalescedDelivery.generation,
                taskIds: coalescedDelivery.taskIds,
              },
            });
            const queuedCoalesced = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === coalescedDelivery.messageId && run.status === "queued",
                ),
            );
            const queuedCoalescedRun = queuedCoalesced.runs.find(
              (run) => run.userMessageId === coalescedDelivery.messageId,
            );
            expect(queuedCoalescedRun?.status).toBe("queued");
            if (queuedCoalescedRun === undefined) {
              return yield* Effect.die(new Error("Queued coalesced delivery missing."));
            }

            const completionEditError = yield* orchestrator
              .dispatch({
                type: "queued-run.edit",
                commandId: CommandId.make("command:mcp-parent:edit-coalesced-delivery"),
                threadId: parentThreadId,
                runId: queuedCoalescedRun.id,
                text: "Rewrite the automatic delivery.",
              })
              .pipe(Effect.flip);
            expect(completionEditError._tag).toBe("OrchestratorCommandRejectedError");
            const completionReorderError = yield* orchestrator
              .dispatch({
                type: "queued-run.reorder",
                commandId: CommandId.make("command:mcp-parent:reorder-coalesced-delivery"),
                threadId: parentThreadId,
                runId: queuedCoalescedRun.id,
                beforeRunId: null,
              })
              .pipe(Effect.flip);
            expect(completionReorderError._tag).toBe("OrchestratorDispatchError");
            const completionSteerError = yield* orchestrator
              .dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make("command:mcp-parent:steer-coalesced-delivery"),
                threadId: parentThreadId,
                queuedRunId: queuedCoalescedRun.id,
                targetRunId: parentRun.id,
              })
              .pipe(Effect.flip);
            expect(completionSteerError._tag).toBe("OrchestratorDispatchError");

            for (const taskId of coalescedTaskIds) {
              const statusCall = yield* invoke("task_status", { taskId });
              expect(statusCall.isError).toBe(false);
            }
            const acknowledgedCoalesced = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === queuedCoalescedRun.id)?.status ===
                  "cancelled" &&
                coalescedTaskIds.every(
                  (taskId) =>
                    projection.subagents.find((task) => task.id === taskId)?.completionDelivery
                      ?.state === "acknowledged",
                ),
            );
            expect(
              acknowledgedCoalesced.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                ?.delivery,
            ).toBeNull();
            yield* Ref.set(continuationOffers, []);

            const directReadPrompt = "Complete before a parent reads this child result directly.";
            const directRead = yield* queueAutomaticCompletion(
              "direct-child-read",
              directReadPrompt,
            );
            if (directRead.task.childThreadId === null) {
              return yield* Effect.die(new Error("Direct-read child thread missing."));
            }
            const directChildThreadId = directRead.task.childThreadId;
            const directChildWaitCall = yield* invoke("scient_thread_wait", {
              threadId: directChildThreadId,
              timeoutMs: 10_000,
            });
            const directChildWait = yield* decodeThreadWaitResult(
              directChildWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(directChildWait).toMatchObject({
              threadId: directChildThreadId,
              status: "completed",
              timedOut: false,
            });
            expect(
              (yield* Ref.get(capturedTurns)).filter(
                (turn) => turn.threadId === directChildThreadId,
              ),
            ).toEqual([
              {
                instanceId: claudeInstanceId,
                threadId: directChildThreadId,
                modelSelection: claudeSelection,
                text: emptyMcpReplayPrompt(
                  ProviderDriverKind.make("claudeAgent"),
                  directReadPrompt,
                ),
              },
            ]);
            const pendingAfterWait = yield* orchestrator.getThreadProjection(parentThreadId);
            expect(
              pendingAfterWait.subagents.find((task) => task.id === directRead.task.id)
                ?.completionDelivery?.state,
            ).toBe("claimed");
            expect(
              pendingAfterWait.runs.find((run) => run.id === directRead.queuedRun.id)?.status,
            ).toBe("queued");

            const childPromptReadCall = yield* invoke("scient_thread_inspect", {
              threadId: directChildThreadId,
              limit: 1,
            });
            const childPromptRead = yield* decodeThreadReadResult(
              childPromptReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(childPromptRead.items.map((item) => item.type)).toEqual(["user_message"]);
            if (childPromptRead.nextPosition === null) {
              return yield* Effect.die(new Error("Direct-read child prompt position missing."));
            }
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === directRead.task.id,
              )?.completionDelivery?.state,
            ).toBe("claimed");

            const truncatedResultReadCall = yield* invoke("scient_thread_inspect", {
              threadId: directChildThreadId,
              afterPosition: childPromptRead.nextPosition,
              limit: 1,
              maxCharsPerItem: 1,
            });
            const truncatedResultRead = yield* decodeThreadReadResult(
              truncatedResultReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(truncatedResultRead.items).toMatchObject([
              { type: "assistant_message", textTruncated: true },
            ]);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === directRead.task.id,
              )?.completionDelivery?.state,
            ).toBe("claimed");

            const firstChunk = truncatedResultRead.items[0]!;
            expect(firstChunk.nextTextOffset).toBe(1);
            const remainderCall = yield* invoke("scient_thread_inspect", {
              threadId: directChildThreadId,
              itemId: firstChunk.itemId,
              textOffset: firstChunk.nextTextOffset,
              maxCharsPerItem: 50_000,
            });
            const remainder = yield* decodeThreadReadResult(remainderCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(remainder.items[0]?.nextTextOffset).toBeNull();
            expect(firstChunk.text + (remainder.items[0]?.text ?? "")).toBe(
              "Claude completed: Complete before a parent reads this child result directly.",
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === directRead.task.id,
              )?.completionDelivery?.state,
            ).toBe("claimed");

            const terminalResultReadCall = yield* invoke("scient_thread_inspect", {
              threadId: directChildThreadId,
              afterPosition: childPromptRead.nextPosition,
              limit: 1,
            });
            const terminalResultRead = yield* decodeThreadReadResult(
              terminalResultReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(terminalResultRead.items).toMatchObject([
              {
                type: "assistant_message",
                text: "Claude completed: Complete before a parent reads this child result directly.",
                textTruncated: false,
              },
            ]);
            const longText = "界🧪\n".repeat(20_000) + "FINAL_CONSTRAINT";
            const childProjection = yield* orchestrator.getThreadProjection(directChildThreadId);
            const sourceItem = childProjection.turnItems.find(
              (item) => item.type === "user_message",
            )!;
            const oversizedItem = {
              ...sourceItem,
              id: TurnItemId.make("item:oversized-retrieval"),
              type: "assistant_message" as const,
              text: longText,
              streaming: false,
              ordinal: 999,
            };
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("event:oversized-retrieval"),
                  type: "turn-item.updated",
                  threadId: directChildThreadId,
                  occurredAt: yield* DateTime.now,
                  payload: oversizedItem,
                },
              ],
            });
            let recovered = "";
            let textOffset: number | null = 0;
            while (textOffset !== null) {
              const pageCall = yield* invoke("scient_thread_inspect", {
                threadId: directChildThreadId,
                itemId: oversizedItem.id,
                textOffset,
                maxCharsPerItem: 50_000,
              });
              const page: OrchestratorMcpThreadReadResult = yield* decodeThreadReadResult(
                pageCall.structuredContent,
              ).pipe(Effect.orDie);
              expect(page.items).toHaveLength(1);
              recovered += page.items[0]!.text;
              textOffset = page.items[0]!.nextTextOffset ?? null;
            }
            expect(recovered).toBe(longText);

            const acknowledgedByDirectRead = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === directRead.queuedRun.id)?.status ===
                  "cancelled" &&
                projection.subagents.find((task) => task.id === directRead.task.id)
                  ?.completionDelivery?.state === "acknowledged",
            );
            expect(
              acknowledgedByDirectRead.subagents.find((task) => task.id === directRead.task.id)
                ?.completionDelivery,
            ).toMatchObject({ state: "acknowledged", observedByRunId: parentRun.id });
            yield* Ref.set(continuationOffers, []);

            const queueRace = yield* queueAutomaticCompletion(
              "queue-race",
              "Complete before a user queues follow-up work.",
            );
            const queuedUserMessageId = MessageId.make("message:mcp-parent:queue-race:user");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:queue-race:user"),
              threadId: parentThreadId,
              messageId: queuedUserMessageId,
              text: "🙂".repeat(16001),
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
            });
            const queueRaceQueued = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some((run) => run.id === queueRace.queuedRun.id) &&
                projection.runs.some(
                  (run) => run.userMessageId === queuedUserMessageId && run.status === "queued",
                ),
            );
            const queuedUserRun = queueRaceQueued.runs.find(
              (run) => run.userMessageId === queuedUserMessageId,
            );
            if (queuedUserRun === undefined) {
              return yield* Effect.die(new Error("Queued user follow-up missing."));
            }
            const queueFirstPage = yield* invoke("scient_queue", { action: "list", limit: 1 });
            expect(queueFirstPage.structuredContent).toMatchObject({
              items: [{ queuedRunId: queueRace.queuedRun.id }],
              nextCursor: 1,
            });
            const queueSecondPage = yield* invoke("scient_queue", {
              action: "list",
              cursor: 1,
              limit: 1,
            });
            expect(queueSecondPage.structuredContent).toEqual({
              items: [{ queuedRunId: queuedUserRun.id, text: "🙂".repeat(1000), truncated: true }],
              nextCursor: null,
            });
            const queueRead = yield* invoke("scient_queue", {
              action: "read",
              queuedRunId: queuedUserRun.id,
            });
            expect(queueRead.structuredContent).toEqual({
              queuedRunId: queuedUserRun.id,
              text: "🙂".repeat(16000),
              truncated: true,
            });
            const missingQueueRead = yield* invoke("scient_queue", {
              action: "read",
              queuedRunId: parentRun.id,
            });
            expect(missingQueueRead.isError).toBe(true);
            expect(missingQueueRead.structuredContent).toBeUndefined();
            expect(declaredFailure(missingQueueRead)).toMatchObject({ code: "invalid_request" });
            const queueRaceStatus = yield* invoke("task_status", { taskId: queueRace.task.id });
            expect(queueRaceStatus.isError).toBe(false);
            yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === queueRace.queuedRun.id)?.status ===
                  "cancelled" &&
                projection.runs.find((run) => run.id === queuedUserRun.id)?.status === "queued" &&
                projection.subagents.find((task) => task.id === queueRace.task.id)
                  ?.completionDelivery?.state === "acknowledged",
            );
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("command:mcp-parent:queue-race:cleanup"),
              threadId: parentThreadId,
              runId: queuedUserRun.id,
            });

            const steerRace = yield* queueAutomaticCompletion(
              "steer-race",
              "Complete before a user steers the parent.",
            );
            const steerMessageId = MessageId.make("message:mcp-parent:steer-race:user");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:steer-race:user"),
              threadId: parentThreadId,
              messageId: steerMessageId,
              text: "Steer the active parent after receiving the result.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "steer_active", targetRunId: parentRun.id },
            });
            const steerRaceStatus = yield* invoke("task_status", { taskId: steerRace.task.id });
            expect(steerRaceStatus.isError).toBe(false);
            const acknowledgedSteerRace = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.messages.some((message) => message.id === steerMessageId) &&
                projection.runs.find((run) => run.id === parentRun.id)?.status === "running" &&
                projection.runs.find((run) => run.id === steerRace.queuedRun.id)?.status ===
                  "cancelled" &&
                projection.subagents.find((task) => task.id === steerRace.task.id)
                  ?.completionDelivery?.state === "acknowledged",
            );
            expect(
              acknowledgedSteerRace.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                ?.delivery,
            ).toBeNull();

            const restartRace = yield* queueAutomaticCompletion(
              "restart-race",
              "Complete before a user restarts the parent.",
            );
            const attemptBeforeRestart = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).runs.find((run) => run.id === parentRun.id)?.activeAttemptId;
            const restartMessageId = MessageId.make("message:mcp-parent:restart-race:user");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:restart-race:user"),
              threadId: parentThreadId,
              messageId: restartMessageId,
              text: "Restart the active parent after receiving the result.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "restart_active", targetRunId: parentRun.id },
            });
            const restartedParent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) => {
                const run = projection.runs.find((candidate) => candidate.id === parentRun.id);
                return (
                  run?.status === "running" &&
                  run.activeAttemptId !== attemptBeforeRestart &&
                  run.rootNodeId !== null
                );
              },
            );
            const currentParentRun = restartedParent.runs.find((run) => run.id === parentRun.id);
            if (currentParentRun?.rootNodeId === null || currentParentRun === undefined) {
              return yield* Effect.die(new Error("Restarted parent run missing."));
            }
            parentRootNodeId = currentParentRun.rootNodeId;
            expect(currentParentRun.delegatedCompletion?.disposition).toBe("open");
            const restartRaceStatus = yield* invoke("task_status", {
              taskId: restartRace.task.id,
            });
            expect(restartRaceStatus.isError).toBe(false);
            yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.messages.some((message) => message.id === restartMessageId) &&
                projection.runs.find((run) => run.id === restartRace.queuedRun.id)?.status ===
                  "cancelled" &&
                projection.subagents.find((task) => task.id === restartRace.task.id)
                  ?.completionDelivery?.state === "acknowledged" &&
                projection.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                  ?.disposition === "open",
            );
            yield* Ref.set(continuationOffers, []);

            const capabilitiesTool = server.tools.find(
              ({ tool }) => tool.name === "orchestrator_capabilities",
            );
            expect(capabilitiesTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(capabilitiesTool?.tool.annotations?.idempotentHint).toBe(true);
            const delegateTool = server.tools.find(({ tool }) => tool.name === "delegate_task");
            expect(delegateTool?.tool.annotations?.destructiveHint).toBe(true);
            expect(delegateTool?.tool.annotations?.openWorldHint).toBe(true);
            const taskStatusTool = server.tools.find(({ tool }) => tool.name === "task_status");
            expect(taskStatusTool?.tool.annotations?.readOnlyHint).toBe(false);
            expect(taskStatusTool?.tool.annotations?.idempotentHint).toBe(true);
            const createThreadsTool = server.tools.find(
              ({ tool }) => tool.name === "create_threads",
            );
            expect(createThreadsTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadListTool = server.tools.find(
              ({ tool }) => tool.name === "scient_thread_list",
            );
            expect(threadListTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(threadListTool?.tool.annotations?.idempotentHint).toBe(true);
            const threadReadTool = server.tools.find(
              ({ tool }) => tool.name === "scient_thread_inspect",
            );
            expect(threadReadTool?.tool.annotations?.readOnlyHint).toBe(false);
            const deniedThreadInspection = yield* invokeAs(
              { ...invocation, capabilities: new Set(["threads:read"]) },
              "scient_thread_inspect",
              { threadId: parentThreadId },
            );
            expect(declaredFailure(deniedThreadInspection)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "capability_denied",
            });
            const unknownPagingParamError = yield* invoke("scient_thread_inspect", {
              threadId: parentThreadId,
              cursor: 90,
            }).pipe(Effect.flip);
            expect(unknownPagingParamError.message).toContain("Expected no excess property");
            const threadUpdateTool = server.tools.find(
              ({ tool }) => tool.name === "scient_thread_update",
            );
            expect(threadUpdateTool?.tool.annotations?.destructiveHint).toBe(true);
            expect(threadUpdateTool?.tool.annotations?.idempotentHint).toBe(false);
            expect(threadUpdateTool?.tool.inputSchema).toMatchObject({
              type: "object",
              properties: {
                action: expect.any(Object),
                title: expect.any(Object),
              },
            });
            const deniedThreadUpdate = yield* invokeAs(
              { ...invocation, capabilities: new Set() },
              "scient_thread_update",
              { action: "rename", title: "Denied title" },
            );
            expect(declaredFailure(deniedThreadUpdate)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "capability_denied",
            });
            const threadSendTool = server.tools.find(
              ({ tool }) => tool.name === "scient_thread_send",
            );
            expect(threadSendTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadWaitTool = server.tools.find(
              ({ tool }) => tool.name === "scient_thread_wait",
            );
            expect(threadWaitTool?.tool.annotations?.readOnlyHint).toBe(true);
            const threadInterruptTool = server.tools.find(
              ({ tool }) => tool.name === "scient_thread_interrupt",
            );
            expect(threadInterruptTool?.tool.annotations?.destructiveHint).toBe(true);

            const capabilities = yield* invoke("orchestrator_capabilities", {});
            expect(capabilities.isError).toBe(false);
            expect(capabilities.structuredContent).toMatchObject({
              inheritedProviderInstanceId: codexInstanceId,
              inheritedModel: codexModel,
              features: {
                appOwnedSubagents: true,
                asyncPolling: true,
                cancellation: true,
                batchThreadCreation: true,
                threadManagement: true,
                incrementalThreadRead: true,
              },
              providers: expect.arrayContaining([
                expect.objectContaining({
                  providerInstanceId: claudeInstanceId,
                  canRunCrossProviderChildTask: true,
                }),
                expect.objectContaining({
                  providerInstanceId: "opencode",
                  canRunChildTask: false,
                }),
                expect.objectContaining({
                  providerInstanceId: codexInstanceId,
                  models: [
                    expect.objectContaining({
                      id: codexModel,
                      options: [{ id: "reasoning", values: ["low", "medium", "high"] }],
                    }),
                  ],
                }),
              ]),
            });

            const scheduleTool = server.tools.find(({ tool }) => tool.name === "schedule_task");
            expect(scheduleTool?.tool.annotations?.destructiveHint).toBe(true);
            const scheduleCall = yield* invoke("schedule_task", {
              prompt: "wake up in this thread and say hello",
              schedule: { type: "interval", everyMs: 60_000 },
              clientRequestId: "schedule-hello-1",
            });
            expect(scheduleCall.isError).toBe(false);
            expect(scheduleCall.structuredContent).toMatchObject({
              boundThreadId: parentThreadId,
              projectId,
              enabled: true,
              schedule: { type: "interval", everyMs: 60_000 },
              title: "wake up in this thread and say hello",
            });
            const scheduledTaskId = (scheduleCall.structuredContent as { scheduledTaskId: string })
              .scheduledTaskId;
            const storedAfterCreate = yield* Ref.get(scheduledStore);
            expect(storedAfterCreate).toHaveLength(1);
            expect(storedAfterCreate[0]).toMatchObject({
              threadId: parentThreadId,
              projectId,
              createdBy: "agent",
              creationSource: "mcp",
              modelSelection: codexSelection,
            });

            const scheduledListCall = yield* invoke("list_scheduled_tasks", {});
            expect(scheduledListCall.isError).toBe(false);
            expect(scheduledListCall.structuredContent).toMatchObject({
              tasks: [{ scheduledTaskId, boundThreadId: parentThreadId }],
            });

            const fullCallerProject = yield* invoke("scient_project_update", {
              projectId,
              title: "Authorized project mutation",
            });
            expect(fullCallerProject.isError).toBe(true);
            expect(fullCallerProject.structuredContent).toBeUndefined();
            expect(declaredFailure(fullCallerProject)).toMatchObject({ code: "invalid_request" });
            expect(yield* Ref.get(projectWrites)).toBe(1);

            // Ceilings are checked at the real MCP entry using V2 thread modes,
            // before any scheduled-task write, including rebind and unbind.
            for (const [suffix, runtimeMode, interactionMode, expectedCode] of [
              ["supervised", "approval-required", "default", "runtime_mode_escalation_denied"],
              ["plan", "full-access", "plan", "interaction_mode_escalation_denied"],
            ] as const) {
              const callerThreadId = ThreadId.make(`thread:mcp-scheduled-${suffix}`);
              yield* orchestrator.dispatch({
                type: "thread.create",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`command:mcp-scheduled-${suffix}:create`),
                threadId: callerThreadId,
                projectId,
                title: "Scheduled task caller",
                modelSelection: codexSelection,
                runtimeMode,
                interactionMode,
                branch: null,
                worktreePath: cwd,
              });
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`command:mcp-scheduled-${suffix}:start`),
                threadId: callerThreadId,
                messageId: MessageId.make(`message:mcp-scheduled-${suffix}:start`),
                text: "Keep the captured caller policy active.",
                attachments: [],
                modelSelection: codexSelection,
                dispatchMode: { type: "start_immediately" },
              });
              yield* waitForProjection(orchestrator, callerThreadId, (projection) =>
                projection.providerTurns.some((turn) => turn.status === "running"),
              );
              const callerScope = yield* callerScopeFor(callerThreadId);
              for (const binding of [undefined, false, true]) {
                const before = yield* Ref.get(scheduledStore);
                const denied = yield* invokeAs(callerScope, "schedule_task", {
                  scheduledTaskId,
                  prompt: "replacement instructions",
                  ...(binding === undefined ? {} : { bindToCurrentThread: binding }),
                });
                // Native declared failures retain their tagged payload in MCP error text.
                expect(denied.isError).toBe(true);
                expect(declaredFailure(denied)).toMatchObject({ code: expectedCode });
                expect(yield* Ref.get(scheduledStore)).toEqual(before);
              }
              for (const bindToCurrentThread of [true, false]) {
                const created = yield* invokeAs(callerScope, "schedule_task", {
                  prompt: "work within the caller ceiling",
                  schedule: { type: "interval", everyMs: 60_000 },
                  bindToCurrentThread,
                  clientRequestId: `ceiling-${suffix}-${bindToCurrentThread}`,
                });
                expect(created.isError).toBe(false);
                const inherited = (yield* Ref.get(scheduledStore)).find(
                  (task) => task.id !== scheduledTaskId,
                );
                expect(inherited).toMatchObject({ runtimeMode, interactionMode });
                expect(inherited?.threadId).toBe(bindToCurrentThread ? callerThreadId : null);
                if (inherited !== undefined) {
                  yield* invokeAs(callerScope, "delete_scheduled_task", {
                    scheduledTaskId: inherited.id,
                  });
                }
              }
              // Future defaults cannot grant this still-running caller more authority.
              yield* orchestrator.dispatch({
                type: "thread.runtime-mode.set",
                commandId: CommandId.make(`command:mcp-scheduled-${suffix}:future-access`),
                threadId: callerThreadId,
                runtimeMode: "full-access",
              });
              yield* orchestrator.dispatch({
                type: "thread.interaction-mode.set",
                commandId: CommandId.make(`command:mcp-scheduled-${suffix}:future-interaction`),
                threadId: callerThreadId,
                interactionMode: "default",
              });
              const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
              expect(yield* manager.resolveMcpInvocationPolicy(callerScope.thread)).toEqual(
                Option.some({ runtimeMode, interactionMode }),
              );
              // The same manager-issued credential still owns the restricted native policy.
              // A bearer webhook must remain hidden after mutable defaults broaden.
              const webhookTask = {
                ...(yield* Ref.get(scheduledStore))[0]!,
                id: ScheduledTaskId.make(`scheduled-task:captured-webhook-${suffix}`),
                threadId: null,
                schedule: { type: "webhook" as const, signature: null },
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
                webhook: {
                  path: "/hooks/captured-policy",
                  url: "https://scient.test/hooks/captured-policy",
                  hasSecret: false,
                },
              };
              yield* Ref.update(scheduledStore, (tasks) => [...tasks, webhookTask]);
              const webhookList = yield* invokeAs(callerScope, "list_scheduled_tasks", {
                projectId,
              });
              expect(webhookList.isError).toBe(false);
              const webhookSummary = (
                webhookList.structuredContent as {
                  tasks: readonly { scheduledTaskId: string; webhookUrl?: string }[];
                }
              ).tasks.find((task) => task.scheduledTaskId === webhookTask.id);
              expect(webhookSummary).toBeDefined();
              expect(webhookSummary?.webhookUrl).toBeUndefined();
              yield* Ref.update(scheduledStore, (tasks) =>
                tasks.filter((task) => task.id !== webhookTask.id),
              );
              for (const binding of [undefined, false, true]) {
                const before = yield* Ref.get(scheduledStore);
                const denied = yield* invokeAs(callerScope, "schedule_task", {
                  scheduledTaskId,
                  prompt: "Cannot inherit future thread defaults.",
                  ...(binding === undefined ? {} : { bindToCurrentThread: binding }),
                });
                expect(declaredFailure(denied)).toMatchObject({ code: expectedCode });
                expect(yield* Ref.get(scheduledStore)).toEqual(before);
              }
              const beforeProjectWrites = yield* Ref.get(projectWrites);
              const deniedProject = yield* invokeAs(callerScope, "scient_project_update", {
                projectId,
                title: "Cannot upgrade the running caller's project authority.",
              });
              expect(declaredFailure(deniedProject)).toMatchObject({ code: "capability_denied" });
              expect(yield* Ref.get(projectWrites)).toBe(beforeProjectWrites);

              const safeFuture = yield* invokeAs(callerScope, "schedule_task", {
                prompt: "Unbound work inherits the running caller's captured ceiling.",
                schedule: { type: "interval", everyMs: 60_000 },
                bindToCurrentThread: false,
                clientRequestId: `captured-future-${suffix}`,
              });
              expect(safeFuture.structuredContent).toHaveProperty("scheduledTaskId");
              const futureTask = (yield* Ref.get(scheduledStore)).find(
                (task) => task.id !== scheduledTaskId,
              );
              expect(futureTask).toMatchObject({ runtimeMode, interactionMode, threadId: null });
              if (futureTask !== undefined) {
                const beforeRebind = yield* Ref.get(scheduledStore);
                const deniedRebind = yield* invokeAs(callerScope, "schedule_task", {
                  scheduledTaskId: futureTask.id,
                  bindToCurrentThread: true,
                  prompt: "Cannot rebind captured restricted work to broader future defaults.",
                });
                expect(declaredFailure(deniedRebind)).toMatchObject({ code: expectedCode });
                expect(yield* Ref.get(scheduledStore)).toEqual(beforeRebind);
                yield* invokeAs(callerScope, "delete_scheduled_task", {
                  scheduledTaskId: futureTask.id,
                });
              }
              const boundFuture = yield* invokeAs(callerScope, "schedule_task", {
                prompt: "Cannot bind weaker caller work into a stronger current default.",
                schedule: { type: "interval", everyMs: 60_000 },
              });
              expect(declaredFailure(boundFuture)).toMatchObject({ code: expectedCode });
              for (const foreignScope of [
                {
                  ...callerScope,
                  thread: { ...callerScope.thread, providerSessionId: "foreign-credential" },
                },
                {
                  ...callerScope,
                  thread: { ...callerScope.thread, providerInstanceId: claudeInstanceId },
                },
                { ...callerScope, thread: { ...callerScope.thread, threadId: parentThreadId } },
              ]) {
                expect(
                  Option.isNone(yield* manager.resolveMcpInvocationPolicy(foreignScope.thread)),
                ).toBe(true);
                const denied = yield* invokeAs(foreignScope, "schedule_task", {
                  scheduledTaskId,
                  prompt: "foreign",
                });
                expect(declaredFailure(denied)).toMatchObject({ code: "parent_not_active" });
              }
              // A task's copied modes can be weaker than its bound thread.
              // Bound execution uses the thread, so checking the copy alone fails.
              const originalTasks = yield* Ref.get(scheduledStore);
              yield* Ref.set(
                scheduledStore,
                originalTasks.map((task) => ({
                  ...task,
                  runtimeMode,
                  interactionMode,
                })),
              );
              const boundDenied = yield* invokeAs(callerScope, "schedule_task", {
                scheduledTaskId,
                prompt: "replacement for a stronger bound thread",
                bindToCurrentThread: false,
              });
              expect(boundDenied.isError).toBe(true);
              expect(declaredFailure(boundDenied)).toMatchObject({ code: expectedCode });
              expect((yield* Ref.get(scheduledStore))[0]?.prompt).toBe(originalTasks[0]?.prompt);
              yield* Ref.set(scheduledStore, originalTasks);
            }

            // A caller within the ceiling can edit and unbind normally.
            const unbound = yield* invoke("schedule_task", {
              scheduledTaskId,
              prompt: "updated safe scheduled instructions",
              bindToCurrentThread: false,
            });
            expect(unbound.isError).toBe(false);
            expect((yield* Ref.get(scheduledStore))[0]).toMatchObject({
              prompt: "updated safe scheduled instructions",
              threadId: null,
              runtimeMode: "full-access",
              interactionMode: "default",
            });

            const scheduledUpdateCall = yield* invoke("schedule_task", {
              scheduledTaskId,
              enabled: false,
            });
            expect(scheduledUpdateCall.isError).toBe(false);
            expect(scheduledUpdateCall.structuredContent).toMatchObject({
              scheduledTaskId,
              enabled: false,
            });

            const scheduledDeleteCall = yield* invoke("delete_scheduled_task", { scheduledTaskId });
            expect(scheduledDeleteCall.isError).toBe(false);
            expect(scheduledDeleteCall.structuredContent).toMatchObject({
              scheduledTaskId,
              deleted: true,
            });
            expect(yield* Ref.get(scheduledStore)).toHaveLength(0);

            // OpenCode 1.15 has emitted this exact nested-object-as-JSON-string
            // shape. Decode it at the MCP boundary rather than failing a task
            // the model otherwise specified correctly.
            const serializedScheduleCall = yield* invoke("schedule_task", {
              prompt: "check for new pull requests",
              schedule: '{"type":"interval","everyMs":3600000}',
              clientRequestId: "schedule-opencode-compat-1",
            });
            expect(serializedScheduleCall.isError).toBe(false);
            expect(serializedScheduleCall.structuredContent).toMatchObject({
              schedule: { type: "interval", everyMs: 3_600_000 },
              boundThreadId: parentThreadId,
            });
            const serializedScheduledTaskId = (
              serializedScheduleCall.structuredContent as { scheduledTaskId: string }
            ).scheduledTaskId;
            yield* invoke("delete_scheduled_task", {
              scheduledTaskId: serializedScheduledTaskId,
            });
            expect(yield* Ref.get(scheduledStore)).toHaveLength(0);

            const secretRequests = yield* SecretRequests.SecretRequests;
            const secretFiber = yield* invoke("request_secret", {
              label: "GitHub webhook secret",
              reason: "Signs release webhooks. Enter the same value in GitHub's webhook settings.",
              placeholder: "Paste the webhook secret",
              clientRequestId: "release-webhook-secret",
            }).pipe(Effect.forkChild);
            const asked = yield* waitForDurableProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.turnItems.some(
                  (item) => item.type === "secret_request" && item.secretStatus === "pending",
                ),
            );
            const card = asked.turnItems.find((item) => item.type === "secret_request");
            if (card?.type !== "secret_request") {
              return yield* Effect.die(new Error("Secret request card missing."));
            }
            expect(card).toMatchObject({
              label: "GitHub webhook secret",
              placeholder: "Paste the webhook secret",
            });
            yield* orchestrator.dispatch({
              type: "secret_request.record",
              commandId: CommandId.make("command:test:secret-request-replay"),
              threadId: parentThreadId,
              runId: card.runId!,
              nodeId: card.nodeId!,
              turnItemId: card.id,
              label: "Something else",
              reason: "A different reason.",
              secretStatus: "pending",
            });
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).turnItems.find(
                (item) => item.id === card.id,
              ),
            ).toMatchObject({ label: "GitHub webhook secret", runId: card.runId });
            expect(
              (yield* orchestrator.getThreadShell(parentThreadId))?.pendingRuntimeRequest,
            ).toMatchObject({ kind: "user_input" });
            expect(
              threadShellFromProjection(asked, threadPullRequestsOf).pendingRuntimeRequest,
            ).toMatchObject({
              kind: "user_input",
            });
            yield* secretRequests.answer({
              threadId: parentThreadId,
              turnItemId: card.id,
              answer: { type: "save", secret: "github-webhook-secret" },
            });
            const secretCall = yield* Fiber.join(secretFiber);
            expect(secretCall.isError).toBe(false);
            const secretResult = secretCall.structuredContent as {
              status: string;
              secretRef?: string;
            };
            expect(secretResult.status).toBe("saved");
            expect(
              (yield* orchestrator.getThreadShell(parentThreadId))?.pendingRuntimeRequest ?? null,
            ).toBeNull();
            expect(secretResult.secretRef).toMatch(/^secret-ref:[0-9a-f]{32}$/);
            const received = [
              ...secretCall.content.map((part) => ("text" in part ? part.text : "")),
              ...Object.values(secretResult),
            ];
            expect(received.some((value) => value.includes("github-webhook-secret"))).toBe(false);

            const retried = yield* invoke("request_secret", {
              label: "GitHub webhook secret",
              reason: "Signs release webhooks. Enter the same value in GitHub's webhook settings.",
              clientRequestId: "release-webhook-secret",
            });
            expect(retried.structuredContent).toEqual(secretResult);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).turnItems.filter(
                (item) => item.type === "secret_request",
              ),
            ).toHaveLength(1);

            expect(
              yield* secretRequests.consume({
                ref: secretResult.secretRef as never,
                projectId,
              }),
            ).toBe("github-webhook-secret");
            const reused = yield* secretRequests
              .consume({ ref: secretResult.secretRef as never, projectId })
              .pipe(Effect.flip);
            expect(reused.message).toContain("already used");

            const delegatedOptions = [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ];
            const delegatedCall = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              target: {
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
                options: { effort: "max", fastMode: true },
              },
              mode: "wait",
              timeoutMs: 10_000,
              clientRequestId: "delegate-claude-1",
            });
            expect(delegatedCall.isError).toBe(false);
            const delegated = yield* decodeDelegateTaskResult(delegatedCall.structuredContent).pipe(
              Effect.orDie,
            );
            const delegatedSource = yield* orchestrator.getThreadProjection(
              delegated.childThreadId,
            );
            expect(delegatedSource.messages[0]).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(
              delegatedSource.turnItems.find((item) => item.type === "user_message"),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(delegated.status).toBe("completed");
            expect(delegated.summary).toBe(delegatedResult);
            expect(delegated.providerInstanceId).toBe(claudeInstanceId);
            expect(delegated.options).toEqual(delegatedOptions);

            const completedParent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.subagents.some(
                  (task) =>
                    task.id === delegated.taskId &&
                    task.status === "completed" &&
                    task.result === delegatedResult,
                ) &&
                projection.contextTransfers.some(
                  (transfer) =>
                    transfer.type === "subagent_result" &&
                    transfer.sourceThreadId === delegated.childThreadId,
                ),
            );
            const completedTask = completedParent.subagents.find(
              (task) => task.id === delegated.taskId,
            );
            expect(completedTask).toMatchObject({
              origin: "app_owned",
              createdBy: "agent",
              childThreadId: delegated.childThreadId,
              status: "completed",
              result: delegatedResult,
            });
            const child = yield* orchestrator.getThreadProjection(delegated.childThreadId);
            expect(child.thread.lineage).toEqual({
              parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: parentThreadId,
            });
            expect(child.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(child.thread.modelSelection).toEqual({
              ...claudeSelection,
              options: delegatedOptions,
            });
            expect(
              child.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual([delegatedPrompt]);
            expect(
              child.contextTransfers.some(
                (transfer) =>
                  transfer.type === "subagent_spawn" && transfer.sourceThreadId === parentThreadId,
              ),
            ).toBe(true);
            const capturedAfterDelegate = yield* Ref.get(capturedTurns);
            expect(
              capturedAfterDelegate.filter((turn) => turn.threadId === delegated.childThreadId),
            ).toEqual([
              {
                instanceId: claudeInstanceId,
                threadId: delegated.childThreadId,
                text: emptyMcpReplayPrompt(ProviderDriverKind.make("claudeAgent"), delegatedPrompt),
                modelSelection: { ...claudeSelection, options: delegatedOptions },
              },
            ]);
            expect(
              capturedAfterDelegate.some(
                (turn) =>
                  turn.threadId === delegated.childThreadId && turn.text.includes(parentPrompt),
              ),
            ).toBe(false);

            const delegatedStatusCall = yield* invoke("task_status", {
              taskId: delegated.taskId,
            });
            const delegatedStatus = yield* decodeDelegateTaskResult(
              delegatedStatusCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(delegatedStatus).toMatchObject({
              childRunId: delegated.childRunId,
              status: "completed",
              hasPendingChildRuns: false,
              latestTerminalRunId: delegated.childRunId,
              latestTerminalStatus: "completed",
              latestTerminalSummary: null,
              latestTerminalResultContextTransferId: null,
            });
            expect(delegatedStatus.resultContextTransferId).not.toBeNull();

            yield* expectOffersToStay(0);

            const childFollowupCall = yield* invoke("scient_thread_send", {
              threadId: delegated.childThreadId,
              message: "Confirm the delegated API boundary remains inspected.",
              clientRequestId: "delegated-child-followup-1",
            });
            const childFollowup = yield* decodeThreadSendResult(
              childFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            const childFollowupWaitCall = yield* invoke("scient_thread_wait", {
              threadId: delegated.childThreadId,
              runId: childFollowup.runId,
              timeoutMs: 10_000,
            });
            const childFollowupWait = yield* decodeThreadWaitResult(
              childFollowupWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(childFollowupWait).toMatchObject({
              runId: childFollowup.runId,
              status: "completed",
              timedOut: false,
            });
            const delegatedStatusAfterFollowupCall = yield* invoke("task_status", {
              taskId: delegated.taskId,
            });
            const delegatedStatusAfterFollowup = yield* decodeDelegateTaskResult(
              delegatedStatusAfterFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(delegatedStatusAfterFollowup).toMatchObject({
              childRunId: delegated.childRunId,
              status: "completed",
              summary: delegatedResult,
              hasPendingChildRuns: false,
              latestTerminalRunId: childFollowup.runId,
              latestTerminalStatus: "completed",
            });
            expect(delegatedStatusAfterFollowup.latestTerminalSummary).not.toBeNull();

            const activeChildFollowupCall = yield* invoke("scient_thread_send", {
              threadId: delegated.childThreadId,
              message: cancellationPrompt,
              clientRequestId: "delegated-child-active-followup-1",
            });
            const activeChildFollowup = yield* decodeThreadSendResult(
              activeChildFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            const activeChildStarted = yield* waitForDurableProjection(
              orchestrator,
              delegated.childThreadId,
              (projection) => {
                const run = projection.runs.find((run) => run.id === activeChildFollowup.runId);
                return (
                  run?.status === "running" &&
                  run.activeAttemptId !== null &&
                  projection.providerTurns.some(
                    (turn) =>
                      turn.runAttemptId === run.activeAttemptId &&
                      turn.status === "running" &&
                      turn.nativeTurnRef !== null,
                  )
                );
              },
            );
            const activeChildAttemptId = activeChildStarted.runs.find(
              (run) => run.id === activeChildFollowup.runId,
            )?.activeAttemptId;
            const activeChildNativeTurn = activeChildStarted.providerTurns.find(
              (turn) => turn.runAttemptId === activeChildAttemptId && turn.status === "running",
            );
            expect(activeChildNativeTurn).toBeDefined();
            if (activeChildNativeTurn === undefined)
              return yield* Effect.die("Missing child native start");
            const delegatedStatusDuringFollowupCall = yield* invoke("task_status", {
              taskId: delegated.taskId,
            });
            const delegatedStatusDuringFollowup = yield* decodeDelegateTaskResult(
              delegatedStatusDuringFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(delegatedStatusDuringFollowup).toMatchObject({
              childRunId: delegated.childRunId,
              status: "completed",
              summary: delegatedResult,
              hasPendingChildRuns: true,
              latestTerminalRunId: childFollowup.runId,
              latestTerminalStatus: "completed",
            });
            const activeChildProjection = yield* orchestrator.getThreadProjection(
              delegated.childThreadId,
            );
            const legacyChildProjection = {
              ...activeChildProjection,
              contextTransfers: activeChildProjection.contextTransfers.filter(
                (transfer) => transfer.type !== "subagent_spawn",
              ),
            };
            const legacyDelegatedRun = delegatedTaskRun(legacyChildProjection, completedTask!);
            expect(legacyDelegatedRun?.id).toBe(delegated.childRunId);
            expect(hasPendingChildRuns(legacyChildProjection, legacyDelegatedRun)).toBe(true);
            expect(
              hasPendingChildRuns(
                {
                  ...legacyChildProjection,
                  runs: legacyChildProjection.runs.map((run) =>
                    run.id === activeChildFollowup.runId ? { ...run, status: "queued" } : run,
                  ),
                },
                legacyDelegatedRun,
              ),
            ).toBe(true);
            expect(
              hasPendingChildRuns(
                {
                  ...legacyChildProjection,
                  runs: legacyChildProjection.runs.map((run) =>
                    run.id === activeChildFollowup.runId
                      ? { ...run, status: "queued", queueHeld: true }
                      : run,
                  ),
                },
                legacyDelegatedRun,
              ),
            ).toBe(false);
            const heldFollowupCall = yield* invoke("scient_thread_send", {
              threadId: delegated.childThreadId,
              message: "This queued follow-up must remain stopped until resumed.",
              mode: "queue",
              clientRequestId: "delegated-child-held-followup",
            });
            const heldFollowup = yield* decodeThreadSendResult(
              heldFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(heldFollowup.taskId).toBeDefined();
            const completedTaskCancelCall = yield* invoke("task_cancel", {
              taskId: delegated.taskId,
              reason: "Stop the child's later work too.",
              clientRequestId: "cancel-completed-delegated-task-1",
            });
            const completedTaskCancel = yield* decodeTaskCancelResult(
              completedTaskCancelCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(completedTaskCancel).toEqual({
              taskId: delegated.taskId,
              status: "completed",
            });
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === delegated.taskId,
              ),
            ).toMatchObject({
              result: delegatedResult,
              completionDelivery: { state: "disposed" },
            });
            // The completed task's published result remains, while Stop retires later native work.
            const cancelledChild = yield* waitForDurableProjection(
              orchestrator,
              delegated.childThreadId,
              (projection) =>
                projection.runs.some(
                  (run) => run.id === activeChildFollowup.runId && run.status === "interrupted",
                ) &&
                projection.providerTurns.some(
                  (turn) =>
                    turn.id === activeChildNativeTurn.id &&
                    turn.runAttemptId === activeChildAttemptId &&
                    turn.status === "interrupted" &&
                    turn.completedAt !== null,
                ),
            );
            const interruptedNativeTurn = cancelledChild.providerTurns.find(
              (turn) => turn.id === activeChildNativeTurn.id,
            );
            expect(interruptedNativeTurn).toMatchObject({
              providerThreadId: activeChildNativeTurn.providerThreadId,
              nativeTurnRef: activeChildNativeTurn.nativeTurnRef,
              runAttemptId: activeChildAttemptId,
              status: "interrupted",
            });
            const activeChildCleanupCall = yield* invoke("scient_thread_interrupt", {
              threadId: delegated.childThreadId,
              runId: activeChildFollowup.runId,
              reason: "Verify interrupting the exact already-stopped follow-up is idempotent.",
              clientRequestId: "interrupt-delegated-child-followup-1",
            });
            const activeChildCleanup = yield* decodeThreadInterruptResult(
              activeChildCleanupCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(activeChildCleanup).toMatchObject({
              runId: activeChildFollowup.runId,
              status: "interrupted",
            });
            expect(
              (yield* orchestrator.getThreadProjection(delegated.childThreadId)).providerTurns.find(
                (turn) => turn.id === activeChildNativeTurn.id,
              ),
            ).toEqual(interruptedNativeTurn);
            const delegatedStatusAfterCancelCall = yield* invoke("task_status", {
              taskId: delegated.taskId,
            });
            const delegatedStatusAfterCancel = yield* decodeDelegateTaskResult(
              delegatedStatusAfterCancelCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(delegatedStatusAfterCancel).toMatchObject({
              childRunId: delegated.childRunId,
              status: "completed",
              summary: delegatedResult,
              hasPendingChildRuns: false,
              latestTerminalRunId: activeChildFollowup.runId,
              latestTerminalStatus: "interrupted",
            });

            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) => task.id === heldFollowup.taskId && task.status === "idle",
              ),
            );
            expect(
              (yield* orchestrator.getThreadProjection(delegated.childThreadId)).runs.find(
                (run) => run.id === heldFollowup.runId,
              ),
            ).toMatchObject({ status: "queued", queueHeld: true, startedAt: null });
            const cancelHeldCall = yield* invoke("task_cancel", {
              taskId: heldFollowup.taskId,
              clientRequestId: "cancel-held-delegated-followup",
            });
            expect(
              (yield* decodeTaskCancelResult(cancelHeldCall.structuredContent).pipe(Effect.orDie))
                .status,
            ).toBe("cancel_requested");
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) => task.id === heldFollowup.taskId && task.status === "cancelled",
              ),
            );
            expect(
              (yield* orchestrator.getThreadProjection(delegated.childThreadId)).runs.find(
                (run) => run.id === heldFollowup.runId,
              ),
            ).toMatchObject({ status: "cancelled", startedAt: null });

            expect(childFollowup.taskId).toBeDefined();
            expect(activeChildFollowup.taskId).toBeDefined();
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* worker.drain();
            const beforeAcknowledgement = yield* orchestrator.getThreadProjection(parentThreadId);
            const pendingDelivery = beforeAcknowledgement.runs.find(
              (run) => run.id === parentRun.id,
            )?.delegatedCompletion?.delivery;
            if (pendingDelivery == null) {
              return yield* Effect.die(
                "Follow-up completion delivery missing before acknowledgement.",
              );
            }
            expect(pendingDelivery.taskIds).toEqual(
              expect.arrayContaining([childFollowup.taskId, activeChildFollowup.taskId]),
            );
            const hasPendingDeliveryOffer = (
              offers: ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>,
            ) =>
              offers.some(
                (offer) =>
                  offer.threadId === parentThreadId &&
                  offer.delegatedCompletion?.messageId === pendingDelivery.messageId,
              );
            if (!hasPendingDeliveryOffer(yield* Ref.get(continuationOffers))) {
              yield* Stream.fromQueue(continuationOfferEvents).pipe(
                Stream.mapEffect(() => Ref.get(continuationOffers)),
                Stream.filter(hasPendingDeliveryOffer),
                Stream.take(1),
                Stream.runDrain,
              );
            }
            yield* invoke("task_status", { taskId: childFollowup.taskId });
            yield* invoke("task_status", { taskId: activeChildFollowup.taskId });
            const acknowledgedParent = yield* orchestrator.getThreadProjection(parentThreadId);
            for (const taskId of [childFollowup.taskId, activeChildFollowup.taskId]) {
              expect(
                acknowledgedParent.subagents.find((task) => task.id === taskId)?.completionDelivery
                  ?.state,
              ).toBe("acknowledged");
            }
            const stoppedChild = yield* orchestrator.getThreadProjection(delegated.childThreadId);
            // Stop may re-offer an existing wake. Its consumer must discard every stale hint,
            // not rely on how often cleanup or completion happened to publish it.
            const staleOffers = yield* Ref.get(continuationOffers);
            expect(staleOffers).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  threadId: parentThreadId,
                  delegatedCompletion: expect.objectContaining({
                    parentRunId: parentRun.id,
                    messageId: pendingDelivery?.messageId,
                  }),
                }),
              ]),
            );
            const pendingOffers = yield* Queue.unbounded<
              ProviderContinuationRequests.ProviderContinuationRequest | undefined
            >();
            yield* Queue.offerAll(pendingOffers, [...staleOffers, undefined]);
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
            expect(yield* orchestrator.getThreadProjection(parentThreadId)).toEqual(
              acknowledgedParent,
            );
            expect(yield* orchestrator.getThreadProjection(delegated.childThreadId)).toEqual(
              stoppedChild,
            );
            yield* Ref.set(continuationOffers, []);

            // A resumed task owes its descendants and their result wake, not
            // merely the terminal status of its first turn.
            const nestedFollowupGate = yield* Deferred.make<void>();
            const descendantWakeGate = yield* Deferred.make<void>();
            parentTerminalGates.set(delegated.childThreadId, nestedFollowupGate);
            const nestedFollowupCall = yield* invoke("scient_thread_send", {
              threadId: delegated.childThreadId,
              message: cancellationPrompt,
              clientRequestId: "delegated-child-nested-followup",
            });
            const nestedFollowup = yield* decodeThreadSendResult(
              nestedFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            if (nestedFollowup.taskId === undefined) {
              return yield* Effect.die("Nested follow-up task missing.");
            }
            yield* waitForProjection(
              orchestrator,
              delegated.childThreadId,
              (projection) =>
                projection.runs.some(
                  (run) => run.id === nestedFollowup.runId && run.status === "running",
                ) && projection.providerTurns.some((turn) => turn.status === "running"),
              "nested-followup-running",
            );
            const descendantCall = yield* invokeAs(
              yield* callerScopeFor(delegated.childThreadId),
              "delegate_task",
              {
                task: cancellationPrompt,
                target: { providerInstanceId: codexInstanceId, model: codexModel },
                mode: "async",
                clientRequestId: "nested-followup-descendant",
              },
            );
            const descendant = yield* decodeDelegateTaskResult(
              descendantCall.structuredContent,
            ).pipe(Effect.orDie);
            yield* waitForProjection(
              orchestrator,
              descendant.childThreadId,
              (projection) =>
                projection.runs.some(
                  (run) => run.id === descendant.childRunId && run.status === "running",
                ) && projection.providerTurns.some((turn) => turn.status === "running"),
              "nested-descendant-running",
            );
            yield* Deferred.succeed(nestedFollowupGate, undefined);
            parentTerminalGates.delete(delegated.childThreadId);
            yield* waitForProjection(
              orchestrator,
              delegated.childThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === nestedFollowup.runId)?.status ===
                "completed",
              "nested-followup-completed",
            );
            const awaitingDescendant = yield* invoke("task_status", {
              taskId: nestedFollowup.taskId,
            });
            expect(awaitingDescendant.structuredContent).toMatchObject({
              status: "running",
              workState: "waiting_for_children",
              summary: null,
              resultContextTransferId: null,
            });
            yield* expectOffersToStay(0);
            if (descendant.childRunId === null) {
              return yield* Effect.die("Descendant run missing.");
            }
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-nested-followup:finish-descendant"),
              threadId: descendant.childThreadId,
              runId: descendant.childRunId,
              reason: "Finish the nested descendant.",
            });
            const descendantFinished = yield* waitForProjection(
              orchestrator,
              delegated.childThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === descendant.taskId)?.status ===
                  "interrupted" &&
                projection.runs.find((run) => run.id === nestedFollowup.runId)?.delegatedCompletion
                  ?.delivery != null,
              "nested-descendant-result-reserved",
            );
            const descendantDelivery = descendantFinished.runs.find(
              (run) => run.id === nestedFollowup.runId,
            )?.delegatedCompletion?.delivery;
            if (descendantDelivery == null) {
              return yield* Effect.die("Descendant result delivery missing.");
            }
            yield* waitForContinuationOffers(1, "nested-descendant-delivery-offered");
            yield* expectOffersToStay(1);
            expect((yield* Ref.get(continuationOffers))[0]?.threadId).toBe(delegated.childThreadId);
            // Handoff context can precede wake text; the reserved message owns this gate.
            messageTerminalGates.set(descendantDelivery.messageId, descendantWakeGate);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-nested-followup:dispatch-descendant-wake"),
              threadId: delegated.childThreadId,
              messageId: descendantDelivery.messageId,
              text: "Delegated task reached a terminal state.",
              attachments: [],
              modelSelection: claudeSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: nestedFollowup.runId,
                generation: descendantDelivery.generation,
                taskIds: descendantDelivery.taskIds,
              },
            });
            const descendantWakeStarted = yield* waitForProjection(
              orchestrator,
              delegated.childThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === descendantDelivery.messageId && run.status === "running",
                ),
              "nested-result-wake-running",
            );
            const descendantWake = descendantWakeStarted.runs.find(
              (run) => run.userMessageId === descendantDelivery.messageId,
            );
            expect(descendantWake?.delegatedTaskId).toBe(nestedFollowup.taskId);
            const awaitingWake = yield* invoke("task_status", {
              taskId: nestedFollowup.taskId,
            });
            expect(awaitingWake.structuredContent).toMatchObject({
              status: "running",
              workState: "working",
              summary: null,
              resultContextTransferId: null,
            });
            yield* expectOffersToStay(1);
            yield* Deferred.succeed(descendantWakeGate, undefined);
            messageTerminalGates.delete(descendantDelivery.messageId);
            const nestedFinished = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === nestedFollowup.taskId)?.status ===
                  "completed" &&
                projection.contextTransfers.some(
                  (transfer) =>
                    transfer.type === "subagent_result" &&
                    transfer.sourcePoint.runId === descendantWake?.id,
                ),
              "nested-followup-result-published",
            );
            expect(
              nestedFinished.subagents.find((task) => task.id === delegated.taskId)?.result,
            ).toBe(delegatedResult);
            yield* waitForContinuationOffers(2, "nested-followup-delivery-offered");
            yield* expectOffersToStay(2);
            const nestedResult = yield* invoke("task_status", {
              taskId: nestedFollowup.taskId,
            });
            expect(nestedResult.structuredContent).toMatchObject({
              childRunId: nestedFollowup.runId,
              status: "completed",
              workState: "result_available",
              latestTerminalRunId: descendantWake?.id,
              latestTerminalStatus: "completed",
            });
            yield* Ref.set(continuationOffers, []);

            // A send into a child run the server started has no task to join.
            // It gets its own task only when it starts a new attempt; a steer
            // into the running attempt leaves no run that could settle one.
            const childSteerText = "Include the parent's latest guidance before finishing.";
            const steerIntoUntaskedChildRun = (
              target: { readonly providerInstanceId: ProviderInstanceId; readonly model: string },
              name: string,
            ) =>
              Effect.gen(function* () {
                const delegateCall = yield* invoke("delegate_task", {
                  task: "Inspect the steering boundary and return the result.",
                  target,
                  mode: "wait",
                  timeoutMs: 10_000,
                  clientRequestId: `${name}-delegate`,
                });
                const child = yield* decodeDelegateTaskResult(delegateCall.structuredContent).pipe(
                  Effect.orDie,
                );
                expect(child.status).toBe("completed");
                const messageId = MessageId.make(`message:mcp-child:${name}`);
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  createdBy: "agent",
                  creationSource: "server",
                  commandId: CommandId.make(`command:mcp-child:${name}`),
                  threadId: child.childThreadId,
                  messageId,
                  text: cancellationPrompt,
                  attachments: [],
                  modelSelection: { instanceId: target.providerInstanceId, model: target.model },
                  dispatchMode: { type: "start_immediately" },
                });
                const running = yield* waitForProjection(
                  orchestrator,
                  child.childThreadId,
                  (projection) => {
                    const run = projection.runs.find((row) => row.userMessageId === messageId);
                    return (
                      run?.status === "running" &&
                      projection.providerTurns.some(
                        (turn) => turn.nodeId === run.rootNodeId && turn.status === "running",
                      )
                    );
                  },
                );
                const run = running.runs.find((row) => row.userMessageId === messageId)!;
                expect(run.delegatedTaskId).toBeUndefined();
                const sendCall = yield* invoke("scient_thread_send", {
                  threadId: child.childThreadId,
                  message: childSteerText,
                  mode: "steer",
                  clientRequestId: `${name}-steer`,
                });
                const sent = yield* decodeThreadSendResult(sendCall.structuredContent).pipe(
                  Effect.orDie,
                );
                expect(sent).toMatchObject({ runId: run.id, delivery: "steered" });
                return { child, sent };
              });
            const waitForChildRun = (
              childThreadId: ThreadId,
              runId: string,
              status: "completed" | "interrupted",
            ) =>
              waitForProjection(orchestrator, childThreadId, (projection) =>
                projection.runs.some((run) => run.id === runId && run.status === status),
              );

            // Claude steers into the running turn, which then ends.
            const steerReceived = yield* Deferred.make<void>();
            // SCIENT-FORK:START match the skill-scope projection (docs/internals/providers.md).
            const childSteerPrompt = emptyMcpReplayPrompt(
              ProviderDriverKind.make("claudeAgent"),
              childSteerText,
            );
            steerReceivedGates.set(childSteerPrompt, steerReceived);
            // SCIENT-FORK:END
            const steeredSend = yield* steerIntoUntaskedChildRun(
              { providerInstanceId: claudeInstanceId, model: claudeModel },
              "steer-untasked-run",
            );
            // A steer that misses the turn is sent again as its own run, so
            // end the turn only once the steer reached it.
            yield* Deferred.await(steerReceived);
            // SCIENT-FORK: remove the same projected prompt registered above.
            steerReceivedGates.delete(childSteerPrompt);
            yield* invoke("scient_thread_interrupt", {
              threadId: steeredSend.child.childThreadId,
              runId: steeredSend.sent.runId,
              clientRequestId: "steer-untasked-run-interrupt",
            });
            yield* waitForChildRun(
              steeredSend.child.childThreadId,
              steeredSend.sent.runId,
              "interrupted",
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
                (task) =>
                  task.origin === "app_owned" &&
                  task.childThreadId === steeredSend.child.childThreadId &&
                  task.status === "running",
              ),
            ).toEqual([]);
            expect(steeredSend.sent.taskId).toBeUndefined();

            // This Codex session has active steering off, so the send restarts the
            // turn as a new attempt that owns the follow-up task and settles it.
            const restarted = yield* steerIntoUntaskedChildRun(
              { providerInstanceId: codexInstanceId, model: codexModel },
              "restart-untasked-run",
            );
            const restartedTaskId = restarted.sent.taskId;
            expect(restartedTaskId).toBeDefined();
            yield* waitForChildRun(
              restarted.child.childThreadId,
              restarted.sent.runId,
              "completed",
            );
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) => task.id === restartedTaskId && task.status === "completed",
              ),
            );
            expect(
              (yield* orchestrator.getThreadProjection(restarted.child.childThreadId)).runs.find(
                (run) => run.id === restarted.sent.runId,
              )?.delegatedTaskId,
            ).toBe(restartedTaskId);
            yield* invoke("task_status", { taskId: steeredSend.child.taskId });
            yield* invoke("task_status", { taskId: restarted.child.taskId });
            yield* invoke("task_status", { taskId: restartedTaskId });
            yield* Ref.set(continuationOffers, []);

            const repeatedDelegatedCall = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              target: {
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
              mode: "async",
              clientRequestId: "delegate-claude-1",
            });
            const repeatedDelegated = yield* decodeDelegateTaskResult(
              repeatedDelegatedCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedDelegated.taskId).toBe(delegated.taskId);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
                (task) => task.id === delegated.taskId,
              ),
            ).toHaveLength(1);

            const rejectedOptionsCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                options: { reasoning: "extreme" },
              },
              mode: "async",
              clientRequestId: "delegate-rejected-options-1",
            });
            expect(declaredFailure(rejectedOptionsCall)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: expect.stringContaining("rejected options"),
            });

            const duplicateOptionsCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                options: [
                  { id: "reasoning", value: "low" },
                  { id: "reasoning", value: "high" },
                ],
              },
              mode: "async",
              clientRequestId: "delegate-duplicate-options-1",
            });
            expect(declaredFailure(duplicateOptionsCall)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: expect.stringContaining("more than once"),
            });

            const cancellableCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                options: { reasoning: "low" },
              },
              mode: "async",
              clientRequestId: "delegate-cancel-1",
            });
            const cancellable = yield* decodeDelegateTaskResult(
              cancellableCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(cancellable.status).toBe("running");
            expect(cancellable.hasPendingChildRuns).toBe(false);
            yield* waitForProjection(orchestrator, cancellable.childThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const statusWhileOriginalRunningCall = yield* invoke("task_status", {
              taskId: cancellable.taskId,
            });
            const statusWhileOriginalRunning = yield* decodeDelegateTaskResult(
              statusWhileOriginalRunningCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(statusWhileOriginalRunning).toMatchObject({
              childRunId: cancellable.childRunId,
              status: "running",
              hasPendingChildRuns: false,
              latestTerminalRunId: null,
              latestTerminalStatus: null,
            });
            const optionedChild = yield* orchestrator.getThreadProjection(
              cancellable.childThreadId,
            );
            expect(optionedChild.thread.modelSelection).toEqual({
              instanceId: codexInstanceId,
              model: codexModel,
              options: [{ id: "reasoning", value: "low" }],
            });
            const cancelCall = yield* invoke("task_cancel", {
              taskId: cancellable.taskId,
              reason: "Parent no longer needs this work.",
              clientRequestId: "cancel-1",
            });
            const cancelResult = yield* decodeTaskCancelResult(cancelCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(cancelResult.status).toBe("cancel_requested");
            yield* waitForProjection(orchestrator, cancellable.childThreadId, (projection) =>
              projection.runs.some((run) => run.status === "interrupted"),
            );
            const cancelledStatusCall = yield* invoke("task_status", {
              taskId: cancellable.taskId,
            });
            const cancelledStatus = yield* decodeDelegateTaskResult(
              cancelledStatusCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(cancelledStatus.status).toBe("interrupted");

            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === cancellable.taskId,
              )?.completionDelivery,
            ).toMatchObject({ state: "disposed" });
            // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
            // Withdrawn offers are tolerated; live ones are not.
            yield* expectNoLiveOffers(parentThreadId);
            // SCIENT-FORK:END

            const createInput = {
              clientRequestId: "create-thread-batch-1",
              threads: [
                {
                  title: "Inherited empty thread",
                },
                {
                  title: "Claude ordinary thread",
                  prompt: createdThreadPrompt,
                  target: {
                    driverKind: "claudeAgent",
                  },
                },
              ],
            };
            const createCall = yield* invoke("create_threads", createInput);
            expect(createCall.isError).toBe(false);
            const created = yield* decodeCreateThreadsResult(createCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(created.threads).toHaveLength(2);
            const emptyThread = created.threads[0]!;
            const promptedThread = created.threads[1]!;
            expect(emptyThread).toMatchObject({
              status: "idle",
              createdBy: "agent",
              creationSource: "mcp",
              providerInstanceId: codexInstanceId,
              model: codexModel,
            });
            expect(promptedThread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
              providerInstanceId: claudeInstanceId,
              model: claudeModel,
            });
            const createdSource = yield* orchestrator.getThreadProjection(promptedThread.threadId);
            expect(createdSource.messages[0]).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(
              createdSource.turnItems.find((item) => item.type === "user_message"),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            const emptyProjection = yield* orchestrator.getThreadProjection(emptyThread.threadId);
            expect(emptyProjection.thread.lineage).toEqual({
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: emptyThread.threadId,
            });
            expect(emptyProjection.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(emptyProjection.thread.forkedFrom).toBeNull();
            expect(emptyProjection.runs).toEqual([]);

            const defaultRenameCall = yield* invoke("scient_thread_update", {
              action: "rename",
              title: "MCP parent metadata",
              clientRequestId: "metadata-default-thread-1",
            });
            const defaultRenamed = yield* decodeThreadUpdateResult(
              defaultRenameCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(defaultRenamed).toMatchObject({
              threadId: parentThreadId,
              action: "rename",
              title: "MCP parent metadata",
            });

            const renameCall = yield* invoke("scient_thread_update", {
              threadId: emptyThread.threadId,
              action: "rename",
              title: "Metadata-managed thread",
              clientRequestId: "metadata-rename-1",
            });
            const renamed = yield* decodeThreadUpdateResult(renameCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(renamed).toMatchObject({
              threadId: emptyThread.threadId,
              action: "rename",
              title: "Metadata-managed thread",
              linkedPullRequest: null,
            });
            const repeatedRenameCall = yield* invoke("scient_thread_update", {
              threadId: emptyThread.threadId,
              action: "rename",
              title: "Metadata-managed thread",
              clientRequestId: "metadata-rename-1",
            });
            const repeatedRename = yield* decodeThreadUpdateResult(
              repeatedRenameCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedRename.commandId).toBe(renamed.commandId);
            expect(repeatedRename.sequence).toBe(renamed.sequence);

            const linkedPullRequest = {
              projectId,
              repository: "pingdotgg/t3code",
              number: 8689,
              url: "https://github.com/pingdotgg/t3code/pull/8689",
            };
            yield* orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("command:mcp-empty:metadata-link"),
              threadId: emptyThread.threadId,
              linkedPullRequest,
            });
            const metadataReadCall = yield* invoke("scient_thread_inspect", {
              threadId: emptyThread.threadId,
            });
            const metadataRead = yield* decodeThreadReadResult(
              metadataReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(metadataRead.thread).toMatchObject({
              title: "Metadata-managed thread",
              linkedPullRequest,
            });
            const metadataListCall = yield* invoke("scient_thread_list", { limit: 100 });
            const metadataList = yield* decodeThreadListResult(
              metadataListCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(
              metadataList.threads.find((thread) => thread.threadId === emptyThread.threadId),
            ).toMatchObject({
              title: "Metadata-managed thread",
              linkedPullRequest,
              settled: false,
              settledAt: null,
            });
            expect(metadataRead.thread).toMatchObject({ settled: false, settledAt: null });

            yield* orchestrator.dispatch({
              type: "thread.settle",
              commandId: CommandId.make("command:mcp-empty:settle"),
              threadId: emptyThread.threadId,
              settledAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
            });
            const settledReadCall = yield* invoke("scient_thread_inspect", {
              threadId: emptyThread.threadId,
            });
            const settledRead = yield* decodeThreadReadResult(
              settledReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(settledRead.thread).toMatchObject({
              settled: true,
              settledAt: "2026-01-01T00:00:00.000Z",
            });
            const settledListCall = yield* invoke("scient_thread_list", {
              settled: true,
              limit: 100,
            });
            const settledList = yield* decodeThreadListResult(
              settledListCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(settledList.threads.map((thread) => thread.threadId)).toEqual([
              emptyThread.threadId,
            ]);
            expect(settledList.threads[0]).toMatchObject({
              settled: true,
              settledAt: "2026-01-01T00:00:00.000Z",
            });
            const activeListCall = yield* invoke("scient_thread_list", {
              settled: false,
              limit: 100,
            });
            const activeList = yield* decodeThreadListResult(activeListCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(
              activeList.threads.some((thread) => thread.threadId === emptyThread.threadId),
            ).toBe(false);
            yield* orchestrator.dispatch({
              type: "thread.unsettle",
              commandId: CommandId.make("command:mcp-empty:unsettle"),
              threadId: emptyThread.threadId,
              reason: "user",
            });

            expect(metadataRead.thread).toMatchObject({ snoozed: false, snoozedUntil: null });
            yield* orchestrator.dispatch({
              type: "thread.snooze",
              commandId: CommandId.make("command:mcp-empty:snooze"),
              threadId: emptyThread.threadId,
              snoozedUntil: "2099-01-01T00:00:00.000Z",
            });
            const snoozedListCall = yield* invoke("scient_thread_list", {
              snoozed: true,
              limit: 100,
            });
            const snoozedList = yield* decodeThreadListResult(
              snoozedListCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(snoozedList.threads.map((thread) => thread.threadId)).toEqual([
              emptyThread.threadId,
            ]);
            expect(snoozedList.threads[0]).toMatchObject({
              snoozed: true,
              snoozedUntil: "2099-01-01T00:00:00.000Z",
            });
            const snoozedReadCall = yield* invoke("scient_thread_inspect", {
              threadId: emptyThread.threadId,
            });
            const snoozedRead = yield* decodeThreadReadResult(
              snoozedReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(snoozedRead.thread).toMatchObject({
              snoozed: true,
              snoozedUntil: "2099-01-01T00:00:00.000Z",
            });
            yield* orchestrator.dispatch({
              type: "thread.unsnooze",
              commandId: CommandId.make("command:mcp-empty:unsnooze"),
              threadId: emptyThread.threadId,
              reason: "user",
            });

            yield* orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("command:mcp-empty:metadata-unlink"),
              threadId: emptyThread.threadId,
              linkedPullRequest: null,
            });

            // Links added through thread.pull-request.link leave linkedPullRequest unchanged.
            yield* orchestrator.dispatch({
              type: "thread.pull-request.link",
              commandId: CommandId.make("command:mcp-empty:link-other-repository"),
              threadId: emptyThread.threadId,
              host: "github.com",
              repository: "octo/other-repo",
              number: 42,
              url: "https://github.com/octo/other-repo/pull/42",
              source: "agent",
            });
            yield* orchestrator.dispatch({
              type: "thread.pull-request.link",
              commandId: CommandId.make("command:mcp-empty:link-dismissed"),
              threadId: emptyThread.threadId,
              host: "github.com",
              repository: "octo/other-repo",
              number: 43,
              url: "https://github.com/octo/other-repo/pull/43",
              source: "stack-dismissed",
            });
            const otherRepositoryLink = {
              host: "github.com",
              repository: "octo/other-repo",
              number: 42,
              url: "https://github.com/octo/other-repo/pull/42",
              source: "agent",
              state: null,
            };
            const otherRepositoryReadCall = yield* invoke("scient_thread_inspect", {
              threadId: emptyThread.threadId,
            });
            const otherRepositoryRead = yield* decodeThreadReadResult(
              otherRepositoryReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(otherRepositoryRead.thread).toMatchObject({
              linkedPullRequest: null,
              pullRequests: [otherRepositoryLink],
            });
            const otherRepositoryListCall = yield* invoke("scient_thread_list", { limit: 100 });
            const otherRepositoryList = yield* decodeThreadListResult(
              otherRepositoryListCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(
              otherRepositoryList.threads.find(
                (thread) => thread.threadId === emptyThread.threadId,
              ),
            ).toMatchObject({ linkedPullRequest: null, pullRequests: [otherRepositoryLink] });
            expect(
              otherRepositoryList.threads.find((thread) => thread.threadId === parentThreadId),
            ).toMatchObject({ pullRequests: [] });

            const regenerateCall = yield* invoke("scient_thread_update", {
              threadId: emptyThread.threadId,
              action: "regenerate_title",
              clientRequestId: "metadata-regenerate-title-1",
            });
            const regenerating = yield* decodeThreadUpdateResult(
              regenerateCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(regenerating).toMatchObject({
              threadId: emptyThread.threadId,
              action: "regenerate_title",
              titleRegeneration: { requestId: regenerating.commandId },
            });
            const promptedProjection = yield* waitForProjection(
              orchestrator,
              promptedThread.threadId,
              (projection) => projection.runs.some((run) => run.status === "completed"),
            );
            expect(promptedProjection.thread.lineage.parentThreadId).toBeNull();
            expect(
              promptedProjection.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual([createdThreadPrompt]);
            const createdThreadItems = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).visibleTurnItems
              .map((row) => row.item)
              .filter((item) => item.type === "thread_created");
            expect(
              createdThreadItems.map((item) => ({
                targetThreadId: item.targetThreadId,
                targetRunId: item.targetRunId,
                title: item.title,
                providerInstanceId: item.targetProviderInstanceId,
                model: item.targetModel,
              })),
            ).toEqual([
              {
                targetThreadId: emptyThread.threadId,
                targetRunId: null,
                title: emptyThread.title,
                providerInstanceId: codexInstanceId,
                model: codexModel,
              },
              {
                targetThreadId: promptedThread.threadId,
                targetRunId: promptedThread.runId,
                title: promptedThread.title,
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
            ]);

            const repeatedCreateCall = yield* invoke("create_threads", createInput);
            const repeatedCreated = yield* decodeCreateThreadsResult(
              repeatedCreateCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedCreated.threads.map((thread) => thread.threadId)).toEqual(
              created.threads.map((thread) => thread.threadId),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).visibleTurnItems.filter(
                (row) => {
                  if (row.item.type !== "thread_created") return false;
                  const targetThreadId = row.item.targetThreadId;
                  return created.threads.some((thread) => thread.threadId === targetThreadId);
                },
              ),
            ).toHaveLength(2);

            // A committed creation or prompt keeps its receipt after the catalog changes.
            // Observe the actual persisted command IDs rather than reproducing MCP ID logic.
            const settings = yield* ServerSettings.ServerSettingsService;
            const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
            const receiptFor = (
              threadId: ThreadId,
              eventType: "thread.created" | "run.created",
              commandType: "thread.create" | "message.dispatch",
            ) =>
              Effect.gen(function* () {
                const stored = Option.getOrThrow(
                  yield* orchestrator
                    .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType })
                    .pipe(Stream.runHead, Effect.timeout("10 seconds")),
                );
                if (stored.commandId === null) {
                  return yield* Effect.die(new Error("Expected a persisted command identity."));
                }
                const receipt = Option.getOrThrow(yield* receipts.getByCommandId(stored.commandId));
                expect(receipt).toMatchObject({ threadId, commandType, status: "accepted" });
                return receipt;
              });
            const emptyCreationReceipt = yield* receiptFor(
              emptyThread.threadId,
              "thread.created",
              "thread.create",
            );
            const promptedCreationReceipt = yield* receiptFor(
              promptedThread.threadId,
              "thread.created",
              "thread.create",
            );
            const promptedDispatchReceipt = yield* receiptFor(
              promptedThread.threadId,
              "run.created",
              "message.dispatch",
            );
            const beforeDisabledEmpty = yield* orchestrator.getThreadProjection(
              emptyThread.threadId,
            );
            const beforeDisabledPrompted = yield* waitForDurableProjection(
              orchestrator,
              promptedThread.threadId,
              (projection) =>
                projection.runs.some(
                  (run) => run.id === promptedThread.runId && run.status === "completed",
                ),
            );
            const emptySequence = yield* orchestrator.getThreadEventSequence(emptyThread.threadId);
            const promptedSequence = yield* orchestrator.getThreadEventSequence(
              promptedThread.threadId,
            );
            const turnsBeforeReplay = (yield* Ref.get(capturedTurns)).filter(
              (turn) =>
                turn.threadId === emptyThread.threadId || turn.threadId === promptedThread.threadId,
            );
            const beforeDisabledSettings = yield* settings.getSettings;
            yield* Effect.gen(function* () {
              yield* settings.updateSettings({
                projectSettingsOverrides: {
                  [projectId]: {
                    ...beforeDisabledSettings.projectSettingsOverrides[projectId],
                    providerInstances: {
                      ...beforeDisabledSettings.projectSettingsOverrides[projectId]
                        ?.providerInstances,
                      [codexInstanceId]: { enabled: false },
                      [claudeInstanceId]: { enabled: false },
                    },
                  },
                },
              });
              yield* Ref.set(
                providerCatalog,
                originalCatalog.map((provider) =>
                  provider.instanceId === codexInstanceId ||
                  provider.instanceId === claudeInstanceId
                    ? { ...provider, enabled: false }
                    : provider,
                ),
              );
              const management = yield* ThreadManagementService.ThreadManagementService;
              expect(
                yield* management.isProviderInstanceEnabledForProject({
                  projectId,
                  instanceId: codexInstanceId,
                }),
              ).toBe(false);
              expect(
                yield* management.isProviderInstanceEnabledForProject({
                  projectId,
                  instanceId: claudeInstanceId,
                }),
              ).toBe(false);

              const disabledReplay = yield* invoke("create_threads", createInput);
              expect(disabledReplay.isError).toBe(false);
              const replayed = yield* decodeCreateThreadsResult(disabledReplay.structuredContent);
              expect(replayed.threads.map((thread) => thread.threadId)).toEqual(
                created.threads.map((thread) => thread.threadId),
              );
              expect(replayed.threads[1]?.runId).toBe(promptedThread.runId);

              // The first entry has an accepted creation but no prompt receipt.
              // Adding its first prompt cannot borrow the creation's admission.
              const partialReplay = yield* invoke("create_threads", {
                ...createInput,
                threads: [
                  { ...createInput.threads[0]!, prompt: "Fresh prompt after provider disable." },
                  createInput.threads[1]!,
                ],
              });
              expect(declaredFailure(partialReplay)).toMatchObject({
                code: "invalid_request",
                message: expect.stringContaining("disabled"),
              });
              const freshCreation = yield* invoke("create_threads", {
                clientRequestId: "create-after-catalog-disable",
                threads: [{ target: { driverKind: "claudeAgent" } }],
              });
              expect(freshCreation.isError).toBe(true);

              for (const accepted of [
                emptyCreationReceipt,
                promptedCreationReceipt,
                promptedDispatchReceipt,
              ]) {
                expect(
                  Option.getOrThrow(yield* receipts.getByCommandId(accepted.commandId)),
                ).toEqual(accepted);
              }
              const afterDisabledEmpty = yield* orchestrator.getThreadProjection(
                emptyThread.threadId,
              );
              const afterDisabledPrompted = yield* orchestrator.getThreadProjection(
                promptedThread.threadId,
              );
              expect(afterDisabledEmpty.messages).toEqual(beforeDisabledEmpty.messages);
              expect(afterDisabledEmpty.runs).toEqual(beforeDisabledEmpty.runs);
              expect(afterDisabledPrompted.messages).toEqual(beforeDisabledPrompted.messages);
              expect(afterDisabledPrompted.runs).toEqual(beforeDisabledPrompted.runs);
              expect(yield* orchestrator.getThreadEventSequence(emptyThread.threadId)).toBe(
                emptySequence,
              );
              expect(yield* orchestrator.getThreadEventSequence(promptedThread.threadId)).toBe(
                promptedSequence,
              );
              expect(
                (yield* Ref.get(capturedTurns)).filter(
                  (turn) =>
                    turn.threadId === emptyThread.threadId ||
                    turn.threadId === promptedThread.threadId,
                ),
              ).toEqual(turnsBeforeReplay);
              expect(
                (yield* orchestrator.getThreadProjection(parentThreadId)).visibleTurnItems.filter(
                  (row) => {
                    if (row.item.type !== "thread_created") return false;
                    const targetThreadId = row.item.targetThreadId;
                    return created.threads.some((thread) => thread.threadId === targetThreadId);
                  },
                ),
              ).toHaveLength(2);
            }).pipe(
              Effect.ensuring(
                Ref.set(providerCatalog, originalCatalog).pipe(
                  Effect.andThen(
                    settings.updateSettings({
                      projectSettingsOverrides: {
                        [projectId]: {
                          ...beforeDisabledSettings.projectSettingsOverrides[projectId],
                          providerInstances:
                            beforeDisabledSettings.projectSettingsOverrides[projectId]
                              ?.providerInstances ?? {},
                        },
                      },
                    }),
                  ),
                  Effect.asVoid,
                  Effect.orDie,
                ),
              ),
            );

            const promptedReadCall = yield* invoke("scient_thread_inspect", {
              threadId: promptedThread.threadId,
              limit: 1,
            });
            const promptedRead = yield* decodeThreadReadResult(
              promptedReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(promptedRead.thread.status).toBe("completed");
            expect(promptedRead.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(promptedRead.items.map((item) => item.type)).toEqual(["user_message"]);
            expect(promptedRead.items[0]).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(promptedRead.hasMore).toBe(true);
            const promptedReadNextCall = yield* invoke("scient_thread_inspect", {
              threadId: promptedThread.threadId,
              afterPosition: promptedRead.nextPosition,
              limit: 1,
            });
            const promptedReadNext = yield* decodeThreadReadResult(
              promptedReadNextCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(promptedReadNext.items.map((item) => item.type)).toEqual(["assistant_message"]);
            expect(promptedReadNext.items[0]?.text).toBe(
              `Claude completed: ${createdThreadPrompt}`,
            );

            const forkedThreadId = ThreadId.make("thread:mcp-orchestrator-inherited-read");
            yield* orchestrator.dispatch({
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-orchestrator-inherited-read"),
              sourceThreadId: promptedThread.threadId,
              targetThreadId: forkedThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Inherited read thread",
            });
            const forkedProjection = yield* orchestrator.getThreadProjection(forkedThreadId);
            expect(forkedProjection.messages.map((message) => message.text)).toEqual(
              promptedProjection.messages.map((message) => message.text),
            );
            expect(forkedProjection.thread.forkedFrom).toBeNull();
            expect(forkedProjection.thread.lineage.parentThreadId).toBe(promptedThread.threadId);
            expect(
              forkedProjection.visibleTurnItems.some(
                (row) =>
                  row.visibility === "inherited" &&
                  row.sourceThreadId === promptedThread.threadId &&
                  row.item.inheritedFrom?.threadId === promptedThread.threadId &&
                  row.item.type === "user_message",
              ),
            ).toBe(true);

            const forkedReadCall = yield* invoke("scient_thread_inspect", {
              threadId: forkedThreadId,
            });
            const forkedRead = yield* decodeThreadReadResult(forkedReadCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(
              forkedRead.items.find((item) => item.text === createdThreadPrompt),
            ).toMatchObject({
              sourceThreadId: promptedThread.threadId,
              createdBy: "agent",
              creationSource: "mcp",
            });
            // Rewriting the original's provenance after the fork leaves the fork's
            // report as the fork shows it.
            const shownPrompt = promptedProjection.messages.find(
              (message) => message.text === createdThreadPrompt,
            )!;
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("event:mcp-orchestrator-inherited-provenance"),
                  type: "message.updated",
                  threadId: promptedThread.threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...shownPrompt, createdBy: "user", creationSource: "web" },
                },
              ],
            });
            const reread = yield* decodeThreadReadResult(
              (yield* invoke("scient_thread_inspect", { threadId: forkedThreadId }))
                .structuredContent,
            ).pipe(Effect.orDie);
            expect(reread.items.find((item) => item.text === createdThreadPrompt)).toMatchObject({
              sourceThreadId: promptedThread.threadId,
              createdBy: "agent",
              creationSource: "mcp",
            });

            const ordinaryLoopPrompt = "Run an ordinary thread loop iteration.";
            const sendCall = yield* invoke("scient_thread_send", {
              threadId: emptyThread.threadId,
              message: ordinaryLoopPrompt,
              clientRequestId: "ordinary-loop-send-1",
            });
            const sent = yield* decodeThreadSendResult(sendCall.structuredContent).pipe(
              Effect.orDie,
            );
            const sentSource = yield* orchestrator.getThreadProjection(emptyThread.threadId);
            expect(
              sentSource.messages.find((message) => message.id === sent.messageId),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(
              sentSource.turnItems.find(
                (item) => item.type === "user_message" && item.messageId === sent.messageId,
              ),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(sent.delivery).toBe("started");
            const waitCall = yield* invoke("scient_thread_wait", {
              threadId: emptyThread.threadId,
              runId: sent.runId,
              timeoutMs: 10_000,
            });
            const waited = yield* decodeThreadWaitResult(waitCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(waited).toMatchObject({
              runId: sent.runId,
              status: "completed",
              timedOut: false,
            });
            const repeatedSendCall = yield* invoke("scient_thread_send", {
              threadId: emptyThread.threadId,
              message: ordinaryLoopPrompt,
              clientRequestId: "ordinary-loop-send-1",
            });
            const repeatedSend = yield* decodeThreadSendResult(
              repeatedSendCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedSend.runId).toBe(sent.runId);
            expect(
              (yield* orchestrator.getThreadProjection(emptyThread.threadId)).runs,
            ).toHaveLength(1);

            const activeThreadCall = yield* invoke("create_threads", {
              threads: [{ prompt: cancellationPrompt, title: "Managed active thread" }],
              clientRequestId: "managed-active-thread-1",
            });
            const activeThread = (yield* decodeCreateThreadsResult(
              activeThreadCall.structuredContent,
            ).pipe(Effect.orDie)).threads[0]!;
            const activeThreadItem = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).visibleTurnItems
              .map((row) => row.item)
              .find(
                (item) =>
                  item.type === "thread_created" && item.targetThreadId === activeThread.threadId,
              );
            expect(activeThreadItem).toMatchObject({
              type: "thread_created",
              title: "Managed active thread",
              targetThreadId: activeThread.threadId,
              targetRunId: activeThread.runId,
              targetProviderInstanceId: codexInstanceId,
              targetModel: codexModel,
            });
            const activeProjection = yield* waitForProjection(
              orchestrator,
              activeThread.threadId,
              (projection) =>
                projection.runs.some((run) => run.status === "running") &&
                projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const activeRun = activeProjection.runs[0]!;
            const activeTimeoutCall = yield* invoke("scient_thread_wait", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
              timeoutMs: 1,
            });
            const activeTimeout = yield* decodeThreadWaitResult(
              activeTimeoutCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(activeTimeout).toMatchObject({
              runId: activeRun.id,
              status: "running",
              timedOut: true,
            });
            const steerCall = yield* invoke("scient_thread_send", {
              threadId: activeThread.threadId,
              message: "Include the latest parent guidance before finishing.",
              mode: "steer",
              clientRequestId: "managed-active-steer-1",
            });
            const steered = yield* decodeThreadSendResult(steerCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(steered).toMatchObject({
              runId: activeRun.id,
              delivery: "steered",
            });
            const steeredSource = yield* orchestrator.getThreadProjection(activeThread.threadId);
            expect(
              steeredSource.messages.find((message) => message.id === steered.messageId),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(
              steeredSource.turnItems.find(
                (item) => item.type === "user_message" && item.messageId === steered.messageId,
              ),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            const interruptCall = yield* invoke("scient_thread_interrupt", {
              threadId: activeThread.threadId,
              reason: "The orchestration loop has enough evidence.",
              clientRequestId: "managed-active-interrupt-1",
            });
            const interrupted = yield* decodeThreadInterruptResult(
              interruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(interrupted).toMatchObject({
              runId: activeRun.id,
              status: "interrupt_requested",
            });
            const interruptedWaitCall = yield* invoke("scient_thread_wait", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
              timeoutMs: 10_000,
            });
            const interruptedWait = yield* decodeThreadWaitResult(
              interruptedWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(interruptedWait.status).toBe("interrupted");
            const repeatedInterruptCall = yield* invoke("scient_thread_interrupt", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
            });
            const repeatedInterrupt = yield* decodeThreadInterruptResult(
              repeatedInterruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedInterrupt.status).toBe("interrupted");

            const foreignThreadId = ThreadId.make("thread:mcp-foreign-project");
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-foreign-project:create"),
              threadId: foreignThreadId,
              projectId: ProjectId.make("project:mcp-foreign"),
              title: "Foreign project thread",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            const foreignOrganizeCall = yield* invoke("scient_thread_organize", {
              threadId: foreignThreadId,
              action: "pin",
            });
            expect(declaredFailure(foreignOrganizeCall)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "thread_not_found",
            });
            expect((yield* orchestrator.getThreadShell(foreignThreadId))?.pinnedAt).toBeNull();

            const foreignReadCall = yield* invoke("scient_thread_inspect", {
              threadId: foreignThreadId,
            });
            expect(declaredFailure(foreignReadCall)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "thread_not_found",
            });
            const foreignUpdateCall = yield* invoke("scient_thread_update", {
              threadId: foreignThreadId,
              action: "rename",
              title: "Should stay foreign",
            });
            expect(declaredFailure(foreignUpdateCall)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "thread_not_found",
            });
            expect((yield* orchestrator.getThreadShell(foreignThreadId))?.title).toBe(
              "Foreign project thread",
            );
            const listCall = yield* invoke("scient_thread_list", {
              includeSubagents: false,
              limit: 100,
            });
            const listed = yield* decodeThreadListResult(listCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(listed.projectId).toBe(projectId);
            expect(listed.threads.map((thread) => thread.threadId)).toEqual(
              expect.arrayContaining([
                parentThreadId,
                emptyThread.threadId,
                promptedThread.threadId,
                activeThread.threadId,
              ]),
            );
            expect(
              listed.threads.find((thread) => thread.threadId === emptyThread.threadId),
            ).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(listed.threads.some((thread) => thread.threadId === foreignThreadId)).toBe(
              false,
            );
            expect(
              listed.threads.some((thread) => thread.relationshipToParent === "subagent"),
            ).toBe(false);

            const upgradedCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
              },
              mode: "wait",
              timeoutMs: 1,
              clientRequestId: "delegate-wait-upgrade-1",
            });
            const upgradedDelegated = yield* decodeDelegateTaskResult(
              upgradedCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(upgradedDelegated.status).toBe("running");
            yield* waitForProjection(orchestrator, upgradedDelegated.childThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === upgradedDelegated.taskId,
              )?.completionWake,
            ).toBe("always");
            const upgradeCancelCall = yield* invoke("task_cancel", {
              taskId: upgradedDelegated.taskId,
              reason: "Terminalize while the parent run is live.",
              clientRequestId: "cancel-wait-upgrade-1",
            });
            expect(upgradeCancelCall.isError).toBe(false);
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) => task.id === upgradedDelegated.taskId && task.status === "interrupted",
              ),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === upgradedDelegated.taskId,
              )?.completionDelivery,
            ).toMatchObject({ state: "disposed" });
            // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
            // Withdrawn offers are tolerated; live ones are not.
            yield* expectNoLiveOffers(parentThreadId);
            // SCIENT-FORK:END

            const questionWait = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              title: "Wait question",
              target: { providerInstanceId: codexInstanceId, model: codexModel },
              mode: "wait",
              timeoutMs: 30_000,
              clientRequestId: "delegate-wait-question-1",
            }).pipe(Effect.forkChild);
            const question = (yield* waitForProjection(orchestrator, parentThreadId, (p) =>
              p.subagents.some(
                (task) => task.title === "Wait question" && task.childThreadId !== null,
              ),
            )).subagents.find((task) => task.title === "Wait question")!;
            const asking = yield* waitForProjection(orchestrator, question.childThreadId!, (p) =>
              p.providerTurns.some((turn) => turn.status === "running"),
            );
            const askedAt = yield* DateTime.now;
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("event:wait-question:live"),
                  type: "runtime-request.updated",
                  threadId: question.childThreadId!,
                  occurredAt: askedAt,
                  payload: {
                    id: RuntimeRequestId.make("request:wait-question"),
                    nodeId: question.id,
                    providerTurnId: null,
                    nativeRequestRef: null,
                    kind: "user_input",
                    status: "pending",
                    responseCapability: {
                      type: "live",
                      providerSessionId: asking.providerSessions[0]!.id,
                    },
                    createdAt: askedAt,
                    resolvedAt: null,
                  },
                },
              ],
            });
            expect((yield* Fiber.join(questionWait)).structuredContent).toMatchObject({
              status: "running",
              hasPendingQuestion: true,
              waitTimedOut: false,
            });
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === question.id,
              )?.completionWake,
            ).toBe("always");
            yield* invoke("task_cancel", {
              taskId: question.id,
              clientRequestId: "cancel-wait-question-1",
            });
            yield* waitForProjection(orchestrator, parentThreadId, (p) =>
              p.subagents.some((task) => task.id === question.id && task.status === "interrupted"),
            );

            // Stop disposes delivery even if a live approval record survives it.
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("event:approval-after-stop"),
                  type: "runtime-request.updated",
                  threadId: question.childThreadId!,
                  occurredAt: askedAt,
                  payload: {
                    id: RuntimeRequestId.make("request:approval-after-stop"),
                    nodeId: asking.nodes.find((node) => node.runId === asking.runs[0]!.id)!.id,
                    providerTurnId: null,
                    nativeRequestRef: null,
                    kind: "command",
                    status: "pending",
                    responseCapability: {
                      type: "live",
                      providerSessionId: asking.providerSessions[0]!.id,
                    },
                    createdAt: askedAt,
                    resolvedAt: null,
                  },
                },
              ],
            });
            expect(
              (yield* invoke("task_status", { taskId: question.id })).structuredContent,
            ).toMatchObject({
              status: "interrupted",
              pendingApproval: null,
            });
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === question.id,
              )?.completionDelivery,
            ).toMatchObject({ state: "disposed" });

            const terminalUpgrade = yield* orchestrator.dispatch({
              type: "delegated_task.wake-policy",
              commandId: CommandId.make("command:mcp-parent:wake-policy-terminal"),
              parentThreadId,
              taskId: delegated.taskId,
              completionWake: "always",
            });
            expect(
              terminalUpgrade.storedEvents.some(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === delegated.taskId &&
                  stored.event.payload.completionWake === "always",
              ),
            ).toBe(true);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === delegated.taskId,
              )?.completionWake,
            ).toBe("always");
            // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
            // Withdrawn offers are tolerated; live ones are not.
            yield* expectNoLiveOffers(parentThreadId);
            // SCIENT-FORK:END

            const legacyDispatch = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-parent:delegate-legacy"),
              parentThreadId,
              parentRunId: parentRun.id,
              parentNodeId: parentRootNodeId,
              task: cancellationPrompt,
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
            });
            const legacyTaskEvent = legacyDispatch.storedEvents.find(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.origin === "app_owned",
            );
            if (legacyTaskEvent?.event.type !== "subagent.updated") {
              return yield* Effect.die(new Error("Legacy delegated task projection missing."));
            }
            const legacyTask = legacyTaskEvent.event.payload;
            expect(legacyTask.completionWake).toBeUndefined();
            if (legacyTask.childThreadId === null) {
              return yield* Effect.die(new Error("Legacy delegated task child thread missing."));
            }
            const legacyChildThreadId = legacyTask.childThreadId;
            yield* waitForProjection(orchestrator, legacyChildThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            yield* expectOffersToStay(0);

            const stopQueuedDispatch = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-parent:stop-queued-delivery"),
              parentThreadId,
              parentRunId: parentRun.id,
              parentNodeId: parentRootNodeId,
              task: "Complete the stop barrier delivery task.",
              modelSelection: claudeSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const stopQueuedTaskEvent = stopQueuedDispatch.storedEvents.find(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.origin === "app_owned",
            );
            if (stopQueuedTaskEvent?.event.type !== "subagent.updated") {
              return yield* Effect.die(
                new Error("Stop barrier delegated task projection missing."),
              );
            }
            const stopQueuedTaskId = stopQueuedTaskEvent.event.payload.id;
            const stopQueuedProjection = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === stopQueuedTaskId)?.status ===
                  "completed" &&
                projection.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                  ?.delivery !== null &&
                projection.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                  ?.delivery !== undefined,
            );
            const stopQueuedDelivery = stopQueuedProjection.runs.find(
              (run) => run.id === parentRun.id,
            )?.delegatedCompletion?.delivery;
            if (stopQueuedDelivery === undefined || stopQueuedDelivery === null) {
              return yield* Effect.die(new Error("Stop barrier delivery reservation missing."));
            }
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-parent:dispatch-stop-queued-delivery"),
              threadId: parentThreadId,
              messageId: stopQueuedDelivery.messageId,
              text: "Delegated task reached a terminal state.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: parentRun.id,
                generation: stopQueuedDelivery.generation,
                taskIds: stopQueuedDelivery.taskIds,
              },
            });
            const queuedStopDelivery = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === stopQueuedDelivery.messageId && run.status === "queued",
                ),
            );
            const queuedStopDeliveryRun = queuedStopDelivery.runs.find(
              (run) => run.userMessageId === stopQueuedDelivery.messageId,
            );
            if (queuedStopDeliveryRun === undefined) {
              return yield* Effect.die(new Error("Queued stop barrier delivery missing."));
            }
            yield* Ref.set(continuationOffers, []);

            const parentStop = yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-parent:interrupt-wake"),
              threadId: parentThreadId,
              runId: parentRun.id,
              reason: "Settle the parent before the legacy child terminalizes.",
            });
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.runs.every(
                (run) =>
                  run.status !== "preparing" &&
                  run.status !== "starting" &&
                  run.status !== "running",
              ),
            );
            const stoppedParent = yield* orchestrator.getThreadProjection(parentThreadId);
            expect(stoppedParent.runs.some((run) => run.id === parentRun.id)).toBe(true);
            expect(
              parentStop.storedEvents.some(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === parentRun.id &&
                  stored.event.payload.delegatedCompletion?.disposition === "stopped",
              ),
            ).toBe(true);
            expect(
              stoppedParent.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion,
            ).toMatchObject({ disposition: "stopped", delivery: null });
            expect(
              stoppedParent.runs.find((run) => run.id === queuedStopDeliveryRun.id)?.status,
            ).toBe("cancelled");
            expect(
              stoppedParent.subagents.find((task) => task.id === legacyTask.id)?.completionDelivery,
            ).toMatchObject({ state: "disposed" });
            const legacyChildRun = (yield* orchestrator.getThreadProjection(
              legacyChildThreadId,
            )).runs.find((run) => run.status === "running");
            if (legacyChildRun === undefined) {
              return yield* Effect.die(
                new Error("Still-running child was missing after parent Stop."),
              );
            }
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-parent:interrupt-legacy-after-parent-stop"),
              threadId: legacyChildThreadId,
              runId: legacyChildRun.id,
              reason: "Terminalize after the parent Stop barrier.",
            });
            yield* waitForProjection(orchestrator, legacyChildThreadId, (projection) =>
              projection.runs.some((run) => run.status === "interrupted"),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === legacyTask.id,
              )?.completionDelivery,
            ).toMatchObject({ state: "disposed" });
            yield* expectOffersToStay(0);

            const settledUpgrade = yield* orchestrator.dispatch({
              type: "delegated_task.wake-policy",
              commandId: CommandId.make("command:mcp-parent:wake-policy-settled"),
              parentThreadId,
              taskId: legacyTask.id,
              completionWake: "always",
            });
            expect(
              settledUpgrade.storedEvents.some(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === legacyTask.id &&
                  stored.event.payload.completionWake === "always",
              ),
            ).toBe(true);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === legacyTask.id,
              )?.completionWake,
            ).toBe("always");
            yield* expectOffersToStay(0);

            const lateParentThreadId = ThreadId.make("thread:mcp-late-completion-parent");
            const lateParentGate = yield* Deferred.make<void>();
            const lateDeliveryGate = yield* Deferred.make<void>();
            parentTerminalGates.set(lateParentThreadId, lateParentGate);
            yield* Ref.set(continuationOffers, []);
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-late-parent:create"),
              threadId: lateParentThreadId,
              projectId,
              title: "Late completion parent",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-late-parent:start"),
              threadId: lateParentThreadId,
              messageId: MessageId.make("message:mcp-late-parent:start"),
              text: "Hold this parent until its completion delivery is queued.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            const lateParentProjection = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some((run) => run.status === "running") &&
                projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const lateParentRun = lateParentProjection.runs.find((run) => run.status === "running");
            if (lateParentRun?.rootNodeId === null || lateParentRun === undefined) {
              return yield* Effect.die(new Error("Late completion parent run missing."));
            }
            const earlyLateDelivery = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-late-parent:early-task"),
              parentThreadId: lateParentThreadId,
              parentRunId: lateParentRun.id,
              parentNodeId: lateParentRun.rootNodeId,
              task: "Complete before the first delivery starts.",
              modelSelection: claudeSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const lateChild = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-late-parent:late-task"),
              parentThreadId: lateParentThreadId,
              parentRunId: lateParentRun.id,
              parentNodeId: lateParentRun.rootNodeId,
              task: cancellationPrompt,
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const taskFromDispatch = (result: typeof earlyLateDelivery) => {
              const taskEvent = result.storedEvents.find(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.origin === "app_owned",
              );
              if (taskEvent?.event.type !== "subagent.updated") {
                throw new Error("Late completion delegated task projection missing.");
              }
              return taskEvent.event.payload;
            };
            const earlyLateTask = taskFromDispatch(earlyLateDelivery);
            const lateTask = taskFromDispatch(lateChild);
            const thirdLateChild = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-late-parent:third-late-task"),
              parentThreadId: lateParentThreadId,
              parentRunId: lateParentRun.id,
              parentNodeId: lateParentRun.rootNodeId,
              task: cancellationPrompt,
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const thirdLateTask = taskFromDispatch(thirdLateChild);
            const fourthLateTask = taskFromDispatch(
              yield* orchestrator.dispatch({
                type: "delegated_task.request",
                createdBy: "agent",
                creationSource: "mcp",
                commandId: CommandId.make("command:mcp-late-parent:fourth-late-task"),
                parentThreadId: lateParentThreadId,
                parentRunId: lateParentRun.id,
                parentNodeId: lateParentRun.rootNodeId,
                task: cancellationPrompt,
                modelSelection: codexSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                completionWake: "always",
              }),
            );
            if (
              lateTask.childThreadId === null ||
              thirdLateTask.childThreadId === null ||
              fourthLateTask.childThreadId === null
            ) {
              return yield* Effect.die(new Error("Late completion child thread missing."));
            }
            const beforeFirstDelivery = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === earlyLateTask.id)?.status ===
                  "completed" &&
                projection.subagents.find((task) => task.id === lateTask.id)?.status ===
                  "running" &&
                projection.runs.find((run) => run.id === lateParentRun.id)?.delegatedCompletion
                  ?.delivery !== null &&
                projection.runs.find((run) => run.id === lateParentRun.id)?.delegatedCompletion
                  ?.delivery !== undefined,
            );
            const firstLateDelivery = beforeFirstDelivery.runs.find(
              (run) => run.id === lateParentRun.id,
            )?.delegatedCompletion?.delivery;
            if (firstLateDelivery === undefined || firstLateDelivery === null) {
              return yield* Effect.die(new Error("First late completion delivery missing."));
            }
            messageTerminalGates.set(firstLateDelivery.messageId, lateDeliveryGate);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-late-parent:dispatch-first-delivery"),
              threadId: lateParentThreadId,
              messageId: firstLateDelivery.messageId,
              text: "Delegated task reached a terminal state.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: lateParentRun.id,
                generation: firstLateDelivery.generation,
                taskIds: firstLateDelivery.taskIds,
              },
            });
            yield* Deferred.succeed(lateParentGate, undefined);
            const activeFirstDelivery = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === firstLateDelivery.messageId && run.status === "running",
                ),
            );
            const activeFirstDeliveryRun = activeFirstDelivery.runs.find(
              (run) => run.userMessageId === firstLateDelivery.messageId,
            );
            if (activeFirstDeliveryRun === undefined) {
              return yield* Effect.die(new Error("First late completion delivery did not start."));
            }
            const lateChildProjection = yield* orchestrator.getThreadProjection(
              lateTask.childThreadId,
            );
            const lateChildRun = lateChildProjection.runs[0];
            if (lateChildRun === undefined) {
              return yield* Effect.die(new Error("Late completion child run missing."));
            }
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-late-parent:interrupt-late-child"),
              threadId: lateTask.childThreadId,
              runId: lateChildRun.id,
              reason: "Terminalize after the first completion delivery started.",
            });
            yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === lateTask.id)?.completionDelivery
                  ?.state === "pending",
            );
            yield* Deferred.succeed(lateDeliveryGate, undefined);
            messageTerminalGates.delete(firstLateDelivery.messageId);
            const successorReserved = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) => {
                const delivery = projection.runs.find((run) => run.id === lateParentRun.id)
                  ?.delegatedCompletion?.delivery;
                return (
                  delivery !== undefined &&
                  delivery !== null &&
                  delivery.generation === firstLateDelivery.generation + 1 &&
                  delivery.taskIds.length === 1 &&
                  delivery.taskIds[0] === lateTask.id
                );
              },
            );
            const successorDelivery = successorReserved.runs.find(
              (run) => run.id === lateParentRun.id,
            )?.delegatedCompletion?.delivery;
            expect(successorDelivery).toMatchObject({
              generation: firstLateDelivery.generation + 1,
              taskIds: [lateTask.id],
            });
            const lateOffers = yield* waitForContinuationOffers(2);
            expect(lateOffers).toHaveLength(2);
            expect(
              successorReserved.runs.filter((run) => {
                const message = successorReserved.messages.find(
                  (candidate) => candidate.id === run.userMessageId,
                );
                return message?.delegatedCompletion?.parentRunId === lateParentRun.id;
              }),
            ).toHaveLength(1);
            if (successorDelivery === undefined || successorDelivery === null) {
              return yield* Effect.die(new Error("Late completion successor delivery missing."));
            }

            const successorGate = yield* Deferred.make<void>();
            messageTerminalGates.set(successorDelivery.messageId, successorGate);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-late-parent:dispatch-successor-delivery"),
              threadId: lateParentThreadId,
              messageId: successorDelivery.messageId,
              text: "Delegated task reached a terminal state.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: lateParentRun.id,
                generation: successorDelivery.generation,
                taskIds: successorDelivery.taskIds,
              },
            });
            const activeSuccessor = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === successorDelivery.messageId && run.status === "running",
                ),
            );
            const activeSuccessorRun = activeSuccessor.runs.find(
              (run) => run.userMessageId === successorDelivery.messageId,
            );
            if (activeSuccessorRun === undefined) {
              return yield* Effect.die(new Error("Late completion successor did not start."));
            }
            expect(activeSuccessor.turnItems).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "notification",
                  runId: activeSuccessorRun.id,
                  source: {
                    kind: "delegated_task",
                    taskIds: successorDelivery.taskIds,
                    childThreadId: lateTask.childThreadId,
                  },
                  outcome: "cancelled",
                  summary: `Delegated task "${cancellationPrompt}" stopped`,
                }),
              ]),
            );
            expect(
              activeSuccessor.turnItems.some(
                (item) =>
                  item.type === "user_message" && item.messageId === successorDelivery.messageId,
              ),
            ).toBe(false);
            for (const [label, childThreadId] of [
              ["third", thirdLateTask.childThreadId],
              ["fourth", fourthLateTask.childThreadId],
            ] as const) {
              const childProjection = yield* waitForProjection(
                orchestrator,
                childThreadId,
                (projection) =>
                  projection.runs.some((run) => run.status === "running") &&
                  projection.providerTurns.some((turn) => turn.status === "running"),
              );
              const childRun = childProjection.runs.find((run) => run.status === "running");
              if (childRun === undefined) {
                return yield* Effect.die(new Error(`${label} late completion child run missing.`));
              }
              yield* orchestrator.dispatch({
                type: "run.interrupt",
                commandId: CommandId.make(`command:mcp-late-parent:interrupt-${label}-late-child`),
                threadId: childThreadId,
                runId: childRun.id,
                reason: "Terminalize while the successor delivery is running.",
              });
            }
            const pendingDuringSuccessor = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                [thirdLateTask.id, fourthLateTask.id].every(
                  (taskId) =>
                    projection.subagents.find((task) => task.id === taskId)?.completionDelivery
                      ?.state === "pending",
                ),
            );
            expect(
              pendingDuringSuccessor.runs.find((run) => run.id === lateParentRun.id)
                ?.delegatedCompletion?.delivery,
            ).toMatchObject({
              generation: successorDelivery.generation,
              taskIds: successorDelivery.taskIds,
            });
            yield* expectOffersToStay(2);
            yield* Deferred.succeed(successorGate, undefined);
            messageTerminalGates.delete(successorDelivery.messageId);
            const batchedReserved = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) => {
                const delivery = projection.runs.find((run) => run.id === lateParentRun.id)
                  ?.delegatedCompletion?.delivery;
                return (
                  delivery !== undefined &&
                  delivery !== null &&
                  delivery.generation === successorDelivery.generation + 1 &&
                  projection.runs.find((run) => run.id === activeSuccessorRun.id)?.status ===
                    "completed"
                );
              },
            );
            const batchedDelivery = batchedReserved.runs.find((run) => run.id === lateParentRun.id)
              ?.delegatedCompletion?.delivery;
            if (batchedDelivery === undefined || batchedDelivery === null) {
              return yield* Effect.die(new Error("Batched late completion delivery missing."));
            }
            expect([...batchedDelivery.taskIds].toSorted()).toEqual(
              [thirdLateTask.id, fourthLateTask.id].toSorted(),
            );
            expect(
              [lateTask.id, thirdLateTask.id, fourthLateTask.id].map(
                (taskId) =>
                  batchedReserved.subagents.find((task) => task.id === taskId)?.completionDelivery
                    ?.state,
              ),
            ).toEqual(["delivered", "claimed", "claimed"]);
            yield* waitForContinuationOffers(3);
            yield* expectOffersToStay(3);
            expect(
              batchedReserved.runs.filter((run) => {
                const message = batchedReserved.messages.find(
                  (candidate) => candidate.id === run.userMessageId,
                );
                return (
                  message?.delegatedCompletion?.parentRunId === lateParentRun.id &&
                  run.status !== "completed"
                );
              }),
            ).toHaveLength(0);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-late-parent:dispatch-batched-delivery"),
              threadId: lateParentThreadId,
              messageId: batchedDelivery.messageId,
              text: "Delegated tasks reached terminal states.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: lateParentRun.id,
                generation: batchedDelivery.generation,
                taskIds: batchedDelivery.taskIds,
              },
            });
            const drainedCohort = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === lateParentRun.id)?.delegatedCompletion
                  ?.delivery === null &&
                projection.runs.some(
                  (run) =>
                    run.userMessageId === batchedDelivery.messageId && run.status === "completed",
                ),
            );
            expect(
              [earlyLateTask.id, lateTask.id, thirdLateTask.id, fourthLateTask.id].map(
                (taskId) =>
                  drainedCohort.subagents.find((task) => task.id === taskId)?.completionDelivery
                    ?.state,
              ),
            ).toEqual(["delivered", "delivered", "delivered", "delivered"]);
            yield* expectOffersToStay(3);

            const removeParentGate = yield* Deferred.make<void>();
            parentTerminalGates.set(lateParentThreadId, removeParentGate);
            const removeParentMessageId = MessageId.make("message:mcp-late-parent:remove-start");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-late-parent:remove-start"),
              threadId: lateParentThreadId,
              messageId: removeParentMessageId,
              text: "Keep the parent active while removing automatic delivery.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            const removeParentProjection = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) => run.userMessageId === removeParentMessageId && run.status === "running",
                ),
            );
            const removeParentRun = removeParentProjection.runs.find(
              (run) => run.userMessageId === removeParentMessageId,
            );
            if (removeParentRun?.rootNodeId === null || removeParentRun === undefined) {
              return yield* Effect.die(new Error("Queue Remove parent run missing."));
            }
            const removeDelegation = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-late-parent:remove-delegate"),
              parentThreadId: lateParentThreadId,
              parentRunId: removeParentRun.id,
              parentNodeId: removeParentRun.rootNodeId,
              task: "Complete before Queue Remove disposes this automatic delivery.",
              modelSelection: claudeSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const removeTaskEvent = removeDelegation.storedEvents.find(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.origin === "app_owned",
            );
            if (removeTaskEvent?.event.type !== "subagent.updated") {
              return yield* Effect.die(
                new Error("Queue Remove delegated task projection missing."),
              );
            }
            const removeTask = removeTaskEvent.event.payload;
            const removeReserved = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === removeTask.id)?.status ===
                  "completed" &&
                projection.runs.find((run) => run.id === removeParentRun.id)?.delegatedCompletion
                  ?.delivery !== null &&
                projection.runs.find((run) => run.id === removeParentRun.id)?.delegatedCompletion
                  ?.delivery !== undefined,
            );
            const removeDelivery = removeReserved.runs.find((run) => run.id === removeParentRun.id)
              ?.delegatedCompletion?.delivery;
            if (removeDelivery === undefined || removeDelivery === null) {
              return yield* Effect.die(new Error("Queue Remove delivery reservation missing."));
            }
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-late-parent:remove-dispatch"),
              threadId: lateParentThreadId,
              messageId: removeDelivery.messageId,
              text: "Delegated task reached a terminal state.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: removeParentRun.id,
                generation: removeDelivery.generation,
                taskIds: removeDelivery.taskIds,
              },
            });
            const removeQueued = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === removeDelivery.messageId && run.status === "queued",
                ),
            );
            const removeQueuedRun = removeQueued.runs.find(
              (run) => run.userMessageId === removeDelivery.messageId,
            );
            if (removeQueuedRun === undefined) {
              return yield* Effect.die(new Error("Queue Remove delivery did not queue."));
            }
            yield* Ref.set(continuationOffers, []);
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("command:mcp-late-parent:remove-queued-delivery"),
              threadId: lateParentThreadId,
              runId: removeQueuedRun.id,
            });
            const removedDelivery = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === removeParentRun.id)?.delegatedCompletion
                  ?.disposition === "disposed" &&
                projection.runs.find((run) => run.id === removeQueuedRun.id)?.status ===
                  "cancelled" &&
                projection.subagents.find((task) => task.id === removeTask.id)?.completionDelivery
                  ?.state === "disposed",
            );
            expect(
              removedDelivery.runs.find((run) => run.id === removeParentRun.id)
                ?.delegatedCompletion,
            ).toMatchObject({ disposition: "disposed", delivery: null });
            expect(
              removedDelivery.subagents.find((task) => task.id === removeTask.id),
            ).toMatchObject({ result: expect.any(String), status: "completed" });
            yield* expectOffersToStay(0);

            const fanoutParentThreadId = ThreadId.make("thread:mcp-fanout-parent");
            const fanoutParentGate = yield* Deferred.make<void>();
            const firstFanoutDeliveryGate = yield* Deferred.make<void>();
            const secondFanoutDeliveryGate = yield* Deferred.make<void>();
            parentTerminalGates.set(fanoutParentThreadId, fanoutParentGate);
            yield* Ref.set(continuationOffers, []);
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-fanout-parent:create"),
              threadId: fanoutParentThreadId,
              projectId,
              title: "Fan-out parent",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-fanout-parent:start"),
              threadId: fanoutParentThreadId,
              messageId: MessageId.make("message:mcp-fanout-parent:start"),
              text: "Fan out twelve review agents.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            const fanoutStarted = yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) =>
                projection.runs.some((run) => run.status === "running") &&
                projection.providerTurns.some((turn) => turn.status === "running"),
              "fanout-parent-running",
            );
            const fanoutRun = fanoutStarted.runs.find((run) => run.status === "running");
            if (fanoutRun === undefined || fanoutRun.rootNodeId === null) {
              return yield* Effect.die(new Error("Fan-out parent run missing."));
            }
            const fanoutRootNodeId = fanoutRun.rootNodeId;
            const fanoutTasks = yield* Effect.forEach(
              Array.from({ length: 12 }, (_, index) => index),
              (index) =>
                orchestrator
                  .dispatch({
                    type: "delegated_task.request",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: CommandId.make(`command:mcp-fanout-parent:task-${index}`),
                    parentThreadId: fanoutParentThreadId,
                    parentRunId: fanoutRun.id,
                    parentNodeId: fanoutRootNodeId,
                    task: cancellationPrompt,
                    modelSelection: codexSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    completionWake: "always",
                  })
                  .pipe(Effect.map(taskFromDispatch)),
            );
            type FanoutTask = (typeof fanoutTasks)[number];
            const finishFanoutChildren = (tasks: ReadonlyArray<FanoutTask>) =>
              Effect.forEach(
                tasks,
                (task) =>
                  Effect.gen(function* () {
                    const childThreadId = task.childThreadId;
                    if (childThreadId === null) {
                      return yield* Effect.die(new Error("Fan-out child thread missing."));
                    }
                    const child = yield* waitForProjection(
                      orchestrator,
                      childThreadId,
                      (projection) =>
                        projection.runs.some((run) => run.status === "running") &&
                        projection.providerTurns.some((turn) => turn.status === "running"),
                      "fanout-child-running",
                    );
                    yield* worker.drain();
                    const childRun = child.runs.find((run) => run.status === "running");
                    if (childRun === undefined) {
                      return yield* Effect.die(new Error("Fan-out child run missing."));
                    }
                    yield* orchestrator.dispatch({
                      type: "run.interrupt",
                      commandId: CommandId.make(`command:mcp-fanout-parent:finish-${task.id}`),
                      threadId: childThreadId,
                      runId: childRun.id,
                      reason: "Finish this fan-out child.",
                    });
                    yield* worker.drain();
                  }),
                { discard: true },
              );
            const fanoutDelivery = (projection: OrchestrationV2ThreadProjection) =>
              projection.runs.find((run) => run.id === fanoutRun.id)?.delegatedCompletion
                ?.delivery ?? null;
            const fanoutDeliveryRuns = (projection: OrchestrationV2ThreadProjection) =>
              projection.runs.filter(
                (run) =>
                  projection.messages.find((message) => message.id === run.userMessageId)
                    ?.delegatedCompletion?.parentRunId === fanoutRun.id,
              );
            const expectAtMostOneOutstandingDelivery = (
              projection: OrchestrationV2ThreadProjection,
            ) =>
              expect(
                fanoutDeliveryRuns(projection).filter(
                  (run) =>
                    run.status !== "completed" &&
                    run.status !== "failed" &&
                    run.status !== "cancelled" &&
                    run.status !== "interrupted",
                ).length,
              ).toBeLessThanOrEqual(1);
            const deliveryStates = (
              projection: OrchestrationV2ThreadProjection,
              tasks: ReadonlyArray<FanoutTask>,
            ) =>
              tasks.map(
                (task) =>
                  projection.subagents.find((candidate) => candidate.id === task.id)
                    ?.completionDelivery?.state,
              );
            const sortedIds = (ids: ReadonlyArray<string>) => [...ids].toSorted();
            const idsOf = (tasks: ReadonlyArray<FanoutTask>) =>
              sortedIds(tasks.map((task) => task.id));
            const dispatchFanoutDelivery = (
              label: string,
              delivery: OrchestrationV2DelegatedCompletionDelivery,
            ) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "agent",
                creationSource: "server",
                commandId: CommandId.make(`command:mcp-fanout-parent:dispatch-${label}`),
                threadId: fanoutParentThreadId,
                messageId: delivery.messageId,
                text: "Delegated tasks reached terminal states.",
                attachments: [],
                modelSelection: codexSelection,
                dispatchMode: { type: "queue_after_active" },
                delegatedCompletion: {
                  parentRunId: fanoutRun.id,
                  generation: delivery.generation,
                  taskIds: delivery.taskIds,
                },
              });
            const deliveryRunStatus = (
              projection: OrchestrationV2ThreadProjection,
              delivery: OrchestrationV2DelegatedCompletionDelivery,
            ) => projection.runs.find((run) => run.userMessageId === delivery.messageId)?.status;

            const beforeFirstStarts = fanoutTasks.slice(0, 2);
            const duringFirst = fanoutTasks.slice(2, 7);
            const beforeSecondStarts = fanoutTasks.slice(7, 10);
            const duringSecond = fanoutTasks.slice(10, 12);

            yield* finishFanoutChildren(beforeFirstStarts);
            const firstReserved = yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) =>
                deliveryStates(projection, beforeFirstStarts).every(
                  (state) => state === "claimed",
                ) && fanoutDelivery(projection)?.taskIds.length === 2,
              "fanout-first-delivery-reserved",
            );
            const firstFanoutDelivery = fanoutDelivery(firstReserved);
            if (firstFanoutDelivery === null) {
              return yield* Effect.die(new Error("First fan-out delivery missing."));
            }
            expect(sortedIds(firstFanoutDelivery.taskIds)).toEqual(idsOf(beforeFirstStarts));
            firstFanoutMessageId = firstFanoutDelivery.messageId;
            messageTerminalGates.set(firstFanoutDelivery.messageId, firstFanoutDeliveryGate);
            yield* dispatchFanoutDelivery("first", firstFanoutDelivery);
            yield* Deferred.succeed(fanoutParentGate, undefined);
            yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) => deliveryRunStatus(projection, firstFanoutDelivery) === "running",
              "fanout-first-delivery-running",
            );
            // Run status can precede adapter entry; fence this delivery before completing more children.
            yield* Deferred.await(fanoutFirstAdapterEntered);

            yield* finishFanoutChildren(duringFirst);
            const pendingDuringFirst = yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) =>
                deliveryStates(projection, duringFirst).every((state) => state === "pending"),
              "fanout-during-first-pending",
            );
            expect(fanoutDelivery(pendingDuringFirst)).toEqual(firstFanoutDelivery);
            expectAtMostOneOutstandingDelivery(pendingDuringFirst);

            yield* Deferred.succeed(fanoutFirstStartedGate, undefined);
            yield* Deferred.succeed(firstFanoutDeliveryGate, undefined);
            messageTerminalGates.delete(firstFanoutDelivery.messageId);
            yield* awaitNativeTerminal(
              (terminal) => terminal.messageId === firstFanoutDelivery.messageId,
            );
            yield* worker.drain();
            const secondReserved = yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) =>
                deliveryRunStatus(projection, firstFanoutDelivery) === "completed" &&
                fanoutDelivery(projection)?.generation === firstFanoutDelivery.generation + 1,
              "fanout-second-delivery-reserved",
            );
            expect(sortedIds(fanoutDelivery(secondReserved)?.taskIds ?? [])).toEqual(
              idsOf(duringFirst),
            );
            expect(deliveryStates(secondReserved, beforeFirstStarts)).toEqual([
              "delivered",
              "delivered",
            ]);

            yield* finishFanoutChildren(beforeSecondStarts);
            const secondJoined = yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) =>
                deliveryStates(projection, beforeSecondStarts).every(
                  (state) => state === "claimed",
                ) && fanoutDelivery(projection)?.taskIds.length === 8,
              "fanout-second-delivery-coalesced",
            );
            const secondFanoutDelivery = fanoutDelivery(secondJoined);
            if (secondFanoutDelivery === null) {
              return yield* Effect.die(new Error("Second fan-out delivery missing."));
            }
            expect(sortedIds(secondFanoutDelivery.taskIds)).toEqual(
              idsOf([...duringFirst, ...beforeSecondStarts]),
            );
            expectAtMostOneOutstandingDelivery(secondJoined);
            messageTerminalGates.set(secondFanoutDelivery.messageId, secondFanoutDeliveryGate);
            yield* dispatchFanoutDelivery("second", secondFanoutDelivery);
            yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) => deliveryRunStatus(projection, secondFanoutDelivery) === "running",
              "fanout-second-delivery-running",
            );

            yield* finishFanoutChildren(duringSecond);
            const pendingDuringSecond = yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) =>
                deliveryStates(projection, duringSecond).every((state) => state === "pending"),
              "fanout-during-second-pending",
            );
            expectAtMostOneOutstandingDelivery(pendingDuringSecond);

            messageTerminalGates.delete(secondFanoutDelivery.messageId);
            yield* Deferred.succeed(secondFanoutDeliveryGate, undefined);
            yield* awaitNativeTerminal(
              (terminal) => terminal.messageId === secondFanoutDelivery.messageId,
            );
            yield* worker.drain();
            const thirdReserved = yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) =>
                deliveryRunStatus(projection, secondFanoutDelivery) === "completed" &&
                fanoutDelivery(projection)?.generation === secondFanoutDelivery.generation + 1,
              "fanout-third-delivery-reserved",
            );
            const thirdFanoutDelivery = fanoutDelivery(thirdReserved);
            if (thirdFanoutDelivery === null) {
              return yield* Effect.die(new Error("Third fan-out delivery missing."));
            }
            expect(sortedIds(thirdFanoutDelivery.taskIds)).toEqual(idsOf(duringSecond));
            yield* dispatchFanoutDelivery("third", thirdFanoutDelivery);
            yield* awaitNativeTerminal(
              (terminal) => terminal.messageId === thirdFanoutDelivery.messageId,
            );
            yield* worker.drain();
            const fanoutDrained = yield* waitForProjection(
              orchestrator,
              fanoutParentThreadId,
              (projection) =>
                deliveryRunStatus(projection, thirdFanoutDelivery) === "completed" &&
                fanoutDelivery(projection) === null,
              "fanout-deliveries-drained",
            );
            expect(deliveryStates(fanoutDrained, fanoutTasks)).toEqual(
              fanoutTasks.map(() => "delivered"),
            );
            expect(
              fanoutTasks.map(
                (task) =>
                  fanoutDrained.subagents.find((candidate) => candidate.id === task.id)?.status,
              ),
            ).toEqual(fanoutTasks.map(() => "interrupted"));
            const drainedDeliveryRuns = fanoutDeliveryRuns(fanoutDrained);
            expect(drainedDeliveryRuns.map((run) => run.status)).toEqual([
              "completed",
              "completed",
              "completed",
            ]);
            const deliveredTaskIds = drainedDeliveryRuns.flatMap(
              (run) =>
                fanoutDrained.messages.find((message) => message.id === run.userMessageId)
                  ?.delegatedCompletion?.taskIds ?? [],
            );
            expect(sortedIds(deliveredTaskIds)).toEqual(idsOf(fanoutTasks));
            const offeredDeliveries = new Set(
              (yield* Ref.get(continuationOffers)).map(
                (offer) => offer.delegatedCompletion?.messageId,
              ),
            );
            expect(offeredDeliveries).toEqual(
              new Set([
                firstFanoutDelivery.messageId,
                secondFanoutDelivery.messageId,
                thirdFanoutDelivery.messageId,
              ]),
            );

            // Keep completion delivery separate from the earlier fan-out cohorts.
            const approvalParentGate = yield* Deferred.make<void>();
            const approvalChildGate = yield* Deferred.make<void>();
            parentTerminalGates.set(approvalParentId, approvalParentGate);
            promptTerminalGates.set(approvalCompletionPrompt, approvalChildGate);
            yield* Ref.set(continuationOffers, []);
            const approvalStart = (yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:approval-parent:create"),
              threadId: approvalParentId,
              projectId,
              title: "Approval parent",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            })).sequence;
            const awaitApprovalEvent = (
              threadId: ThreadId,
              matches: (event: OrchestrationV2DomainEvent) => boolean,
            ) =>
              orchestrator.streamStoredEventsFrom({ threadId, afterSequence: approvalStart }).pipe(
                Stream.filter((stored) => matches(stored.event)),
                Stream.runHead,
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.die("Approval scenario event stream ended."),
                    onSome: () => Effect.void,
                  }),
                ),
              );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:approval-parent:start"),
              threadId: approvalParentId,
              messageId: MessageId.make("message:approval-parent:start"),
              text: "Hold this parent while its child asks for approval.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            yield* awaitApprovalEvent(
              approvalParentId,
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
            const approvalScope = yield* callerScopeFor(approvalParentId);
            const delegateApproval = invokeAs(approvalScope, "delegate_task", {
              task: approvalCompletionPrompt,
              title: "Approval completion",
              target: { providerInstanceId: codexInstanceId, model: codexModel },
              mode: "wait",
              timeoutMs: 30_000,
              clientRequestId: "delegate-approval-completion",
            });
            const approvalWait = yield* delegateApproval.pipe(Effect.forkChild);
            yield* awaitApprovalEvent(
              approvalParentId,
              (event) => event.type === "subagent.updated" && event.payload.childThreadId !== null,
            );
            const approvalTask = (yield* orchestrator.getThreadProjection(approvalParentId))
              .subagents[0]!;
            const approvalChildId = approvalTask.childThreadId!;
            yield* awaitApprovalEvent(
              approvalChildId,
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
            const approvalChild = yield* orchestrator.getThreadProjection(approvalChildId);
            const approvalRun = approvalChild.runs[0]!;
            const approvalNode = approvalChild.nodes.find((node) => node.runId === approvalRun.id)!;
            const approvalAskedAt = yield* DateTime.now;
            const approvalRequest = (
              id: string,
              overrides: Partial<OrchestrationV2RuntimeRequest> = {},
            ): OrchestrationV2RuntimeRequest => ({
              id: RuntimeRequestId.make(`request:approval:${id}`),
              nodeId: approvalNode.id,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: approvalChild.providerSessions[0]!.id,
              },
              createdAt: approvalAskedAt,
              resolvedAt: null,
              ...overrides,
            });
            const eventSink = yield* EventSink.EventSinkV2;
            let approvalEventId = 0;
            const persistApprovalEvent = (event: OrchestrationV2DomainEvent) =>
              eventSink.write({ events: [event] });
            const persistRequest = (
              request: OrchestrationV2RuntimeRequest,
              threadId = approvalChildId,
            ) =>
              persistApprovalEvent({
                id: EventId.make(`event:approval:${++approvalEventId}`),
                type: "runtime-request.updated",
                threadId,
                occurredAt: approvalAskedAt,
                payload: request,
              });
            const readApprovalStatus = () =>
              invokeAs(approvalScope, "task_status", { taskId: approvalTask.id }).pipe(
                Effect.flatMap((result) => decodeDelegateTaskResult(result.structuredContent)),
                Effect.orDie,
              );

            // These durable records must not make the parent's wait return an approval.
            for (const request of [
              approvalRequest("resolved", { status: "resolved", resolvedAt: approvalAskedAt }),
              approvalRequest("expired", { status: "expired", resolvedAt: approvalAskedAt }),
              approvalRequest("cancelled", { status: "cancelled", resolvedAt: approvalAskedAt }),
              approvalRequest("message", { responseCapability: { type: "message" } }),
              approvalRequest("not-live", {
                responseCapability: { type: "not_resumable", reason: "Session ended." },
              }),
              approvalRequest("question", {
                kind: "user_input",
                responseCapability: { type: "message" },
              }),
              approvalRequest("auth", { kind: "auth_refresh" }),
              approvalRequest("tool", { kind: "dynamic_tool_call" }),
              approvalRequest("missing-node", { nodeId: NodeId.make("node:missing-approval") }),
            ]) {
              yield* persistRequest(request);
            }
            expect((yield* readApprovalStatus()).pendingApproval).toBeNull();

            // An unrelated untagged turn must not inherit the task's approval ownership.
            const { delegatedTaskId: _, ...legacyRun } = approvalRun;
            const foreignRun = {
              ...legacyRun,
              id: RunId.make("run:foreign-approval"),
              ordinal: 2,
            };
            const foreignNode = {
              ...approvalNode,
              id: NodeId.make("node:foreign-approval"),
              runId: foreignRun.id,
            };
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("event:foreign-approval-run"),
                  type: "run.updated",
                  threadId: approvalChildId,
                  occurredAt: approvalAskedAt,
                  payload: foreignRun,
                },
                {
                  id: EventId.make("event:foreign-approval-node"),
                  type: "node.updated",
                  threadId: approvalChildId,
                  occurredAt: approvalAskedAt,
                  payload: foreignNode,
                },
              ],
            });
            yield* persistRequest(approvalRequest("foreign", { nodeId: foreignNode.id }));
            expect((yield* readApprovalStatus()).pendingApproval).toBeNull();

            const liveApproval = approvalRequest("live");
            yield* persistRequest(liveApproval);
            const approvalResult = yield* decodeDelegateTaskResult(
              (yield* Fiber.join(approvalWait)).structuredContent,
            ).pipe(Effect.orDie);
            const expectedApproval = {
              requestId: liveApproval.id,
              kind: "command",
              runId: approvalRun.id,
            };
            expect(approvalResult).toMatchObject({
              taskId: approvalTask.id,
              status: "running",
              hasPendingQuestion: false,
              pendingApproval: expectedApproval,
              waitTimedOut: false,
            });
            expect(approvalResult.pendingApproval).toEqual(expectedApproval);
            // A retry sees the persisted approval in its initial snapshot.
            expect((yield* delegateApproval).structuredContent).toMatchObject({
              taskId: approvalTask.id,
              status: "running",
              pendingApproval: expectedApproval,
              waitTimedOut: false,
            });
            const earlierApproval = approvalRequest("earlier", {
              createdAt: DateTime.subtract(approvalAskedAt, { seconds: 1 }),
            });
            yield* persistRequest(earlierApproval);
            expect((yield* readApprovalStatus()).pendingApproval?.requestId).toBe(
              earlierApproval.id,
            );
            yield* persistRequest({
              ...earlierApproval,
              status: "resolved",
              resolvedAt: approvalAskedAt,
            });

            // Legacy ownership falls back to the original run, never the other run.
            yield* persistApprovalEvent({
              id: EventId.make("event:approval-legacy"),
              type: "run.updated",
              threadId: approvalChildId,
              occurredAt: approvalAskedAt,
              payload: legacyRun,
            });
            expect((yield* readApprovalStatus()).pendingApproval).toEqual(expectedApproval);
            yield* persistRequest({
              ...liveApproval,
              status: "resolved",
              resolvedAt: approvalAskedAt,
            });
            expect((yield* readApprovalStatus()).pendingApproval).toBeNull();
            // Finish the synthetic foreign run before releasing the real child.
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("event:approval-modern"),
                  type: "run.updated",
                  threadId: approvalChildId,
                  occurredAt: approvalAskedAt,
                  payload: approvalRun,
                },
                {
                  id: EventId.make("event:foreign-approval-done"),
                  type: "run.updated",
                  threadId: approvalChildId,
                  occurredAt: approvalAskedAt,
                  payload: { ...foreignRun, status: "completed", completedAt: approvalAskedAt },
                },
              ],
            });
            yield* Deferred.succeed(approvalChildGate, undefined);
            yield* awaitApprovalEvent(
              approvalParentId,
              (event) =>
                event.type === "subagent.updated" &&
                event.payload.id === approvalTask.id &&
                event.payload.status === "completed",
            );
            yield* Deferred.await(approvalOffered);
            yield* worker.drain();
            const approvalCompletedTask = (yield* orchestrator.getThreadProjection(
              approvalParentId,
            )).subagents[0]!;
            expect(approvalCompletedTask).toMatchObject({
              status: "completed",
              completionWake: "always",
              result: `Codex completed: ${approvalCompletionPrompt}`,
            });
            const offers = (yield* Ref.get(continuationOffers)).filter(
              (offer) => offer.threadId === approvalParentId,
            );
            expect(offers).toHaveLength(1);
            const approvalParent = yield* orchestrator.getThreadProjection(approvalParentId);
            const approvalDelivery = approvalParent.runs[0]!.delegatedCompletion?.delivery;
            expect(approvalDelivery?.taskIds).toEqual([approvalTask.id]);
            expect(offers[0]?.delegatedCompletion?.messageId).toBe(approvalDelivery?.messageId);
            expect(yield* readApprovalStatus()).toMatchObject({
              status: "completed",
              summary: `Codex completed: ${approvalCompletionPrompt}`,
              pendingApproval: null,
              waitTimedOut: false,
            });
            // Durable live records may outlast a terminal run or a stopped/disposed task.
            yield* persistRequest(approvalRequest("after-completion"));
            expect((yield* readApprovalStatus()).pendingApproval).toBeNull();
            yield* worker.drain();
            expect(
              (yield* Ref.get(continuationOffers)).filter(
                (offer) => offer.threadId === approvalParentId,
              ),
            ).toHaveLength(1);
            yield* Deferred.succeed(approvalParentGate, undefined);
          }).pipe(Effect.provide(layerTest));
        }),
      ),
  );

  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
  ])("reports $label child results", ({ result, latestSummary }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("delegated-task-status");
        const rawTranscript = yield* readDelegatedTaskStatusTranscript(result);
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(rawTranscript, cwd),
        );
        let replayChildThreadId: ThreadId | undefined;
        const replayExpectedLabels: Array<string> = [];
        const replayHarness = withIssuedCodexMcpReplayExpectations((label) => {
          replayExpectedLabels.push(label);
          const threadId = label.startsWith("parent.")
            ? parentThreadId
            : label.startsWith("child.")
              ? replayChildThreadId
              : undefined;
          return threadId === undefined
            ? undefined
            : {
                threadId,
                instanceId: codexInstanceId,
                modelSelection: codexSelection,
                runtimePolicy: { cwd, runtimeMode: "full-access", interactionMode: "default" },
                // The supported MCP transport publishes a complete-empty scope
                // even when the default planner has no skill releases.
                includeEmptySkillCatalogMarker: true,
              };
        });
        const credentialRegistryLayer = makeCredentialRegistryLayer(
          EnvironmentId.make("environment:mcp-replay"),
        );
        const layerOrchestrator = layerProviderReplay(
          {
            name: "delegated-task-status/codex",
            transcript,
            commands: [],
            runtimePolicyOverride: { cwd },
          },
          replayHarness,
          {
            configureMcp: true,
            mcpSessionRegistryLayer: credentialRegistryLayer,
          },
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerProviderRegistry = ProviderRegistryMock.layer([
          makeProviderSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: codexModel,
          }),
        ]);
        const layerTest = layerOrchestratorToolkit.pipe(
          Layer.provide(
            Layer.merge(
              Layer.mock(ProjectService.ProjectService)({}),
              SecretRequests.layer.pipe(
                Layer.provide(layerMemorySecretStore),
                Layer.provide(layerOrchestration),
              ),
            ),
          ),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(IdAllocator.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provideMerge(credentialRegistryLayer),
          Layer.provide(replayHarness.makeProviderAdapterRegistryLayer(transcript)),
          Layer.provide(layerProviderRegistry),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(layerUnusedScheduledTaskStub),
          Layer.provide(NodeServices.layer),
          Layer.provideMerge(McpProviderSessions.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const parentCreate = yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP replay parent",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-replay-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: parentCreate.sequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.timeout("15 seconds"),
              Effect.catch(() =>
                Effect.die(
                  `Native MCP replay did not reach its required receipt. Expected labels: ${replayExpectedLabels.join(", ")}`,
                ),
              ),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Parent provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
          const mcpConfig = yield* mcpSessions.read(parentThreadId);
          if (mcpConfig === undefined)
            return yield* Effect.die("Parent provider has no issued MCP credential.");
          const credentialRegistry = yield* McpSessionRegistry.McpSessionRegistry;
          const invocation = yield* credentialRegistry.resolve(
            mcpConfig.authorizationHeader.replace(/^Bearer /, ""),
          );
          if (invocation === undefined)
            return yield* Effect.die("Parent provider credential did not resolve.");
          const invoke = (name: string, args: Record<string, unknown>) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                Effect.provideService(McpSchema.McpServerClient, client),
              );

          const ids = yield* IdAllocator.IdAllocatorV2;
          const delegationCommandId = CommandId.make(
            [
              "command",
              "mcp",
              encodeURIComponent(invocation.thread!.providerSessionId),
              "delegate-task",
              "delegate-codex-replay-1",
            ].join(":"),
          );
          replayChildThreadId = ids.derive.delegatedTaskThread({ commandId: delegationCommandId });
          const delegationStartSequence =
            yield* orchestrator.getThreadEventSequence(parentThreadId);
          const delegatedCall = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
            },
            mode: "async",
            clientRequestId: "delegate-codex-replay-1",
          });
          const delegatedStart = yield* decodeDelegateTaskResult(
            delegatedCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegatedStart.childRunId).not.toBeNull();
          expect(delegatedStart.childThreadId).toBe(replayChildThreadId);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: delegationStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.type === "subagent_result" &&
                  stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                  stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
              ),
              Stream.runHead,
              Effect.timeout("15 seconds"),
              Effect.catch(() =>
                Effect.die(
                  `Native MCP replay did not reach its required receipt. Expected labels: ${replayExpectedLabels.join(", ")}`,
                ),
              ),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Delegated result transfer was not created."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const delegatedStatusCall = yield* invoke("task_status", {
            taskId: delegatedStart.taskId,
          });
          const delegated = yield* decodeDelegateTaskResult(
            delegatedStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegated).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            providerInstanceId: codexInstanceId,
            hasPendingChildRuns: false,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });
          expect(delegated.resultContextTransferId).not.toBeNull();

          // Delegated children are subagent threads too, but Scient owns them, so
          const delegatedChild = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
          expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
          const followupStartSequence = yield* orchestrator.getThreadEventSequence(
            delegated.childThreadId,
          );
          const runningFollowupCall = yield* invoke("scient_thread_send", {
            threadId: delegated.childThreadId,
            message: cancellationPrompt,
            clientRequestId: "delegated-child-replay-running-1",
          });
          const runningFollowup = yield* decodeThreadSendResult(
            runningFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: followupStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.timeout("15 seconds"),
              Effect.catch(() =>
                Effect.die(
                  `Native MCP replay did not reach its required receipt. Expected labels: ${replayExpectedLabels.join(", ")}`,
                ),
              ),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const queuedFollowupCall = yield* invoke("scient_thread_send", {
            threadId: delegated.childThreadId,
            message: queuedFollowupPrompt,
            mode: "queue",
            clientRequestId: "delegated-child-replay-queued-1",
          });
          const queuedFollowup = yield* decodeThreadSendResult(
            queuedFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(queuedFollowup).toMatchObject({
            status: "queued",
            delivery: "queued",
          });

          const pendingProjection = yield* orchestrator.getThreadProjection(
            delegated.childThreadId,
          );
          const followupTasks = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.filter(
            (task) =>
              task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
          );
          expect(followupTasks).toHaveLength(2);
          expect(followupTasks.every((task) => task.result === null)).toBe(true);
          expect(followupTasks.map((task) => task.id)).toEqual([
            runningFollowup.taskId,
            queuedFollowup.taskId,
          ]);
          expect(
            pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status,
          ).toBe("completed");
          expect(
            pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status,
          ).toBe("running");
          expect(
            pendingProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status,
          ).toBe("queued");
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
              (run) => run.status === "running",
            ),
          ).toBe(true);

          const pendingStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const pendingStatus = yield* decodeDelegateTaskResult(
            pendingStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(pendingStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: true,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });

          const finalSequence = yield* orchestrator.getThreadEventSequence(delegated.childThreadId);
          const interruptCall = yield* invoke("scient_thread_interrupt", {
            threadId: delegated.childThreadId,
            runId: runningFollowup.runId,
            reason: "Interrupt the current replay follow-up.",
            clientRequestId: "interrupt-delegated-child-replay-1",
          });
          const interrupt = yield* decodeThreadInterruptResult(
            interruptCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(interrupt).toMatchObject({
            runId: runningFollowup.runId,
            status: "interrupt_requested",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === queuedFollowup.runId &&
                  stored.event.payload.status === "queued" &&
                  stored.event.payload.queueHeld === true,
              ),
              Stream.runHead,
              Effect.timeout("15 seconds"),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Interrupted follow-up did not hold its queue."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === runningFollowup.runId &&
                  stored.event.payload.status === "interrupted",
              ),
              Stream.runHead,
              Effect.timeout("15 seconds"),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("The native follow-up did not confirm interruption."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const heldProjection = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(heldProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
            "interrupted",
          );
          expect(heldProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
            "queued",
          );
          yield* orchestrator.dispatch({
            type: "queue.resume",
            threadId: delegated.childThreadId,
            commandId: CommandId.make("command:mcp-replay-child:resume"),
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === queuedFollowup.runId &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.timeout("15 seconds"),
              Effect.catch(() =>
                Effect.die(
                  `Native MCP replay did not reach its required receipt. Expected labels: ${replayExpectedLabels.join(", ")}`,
                ),
              ),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Queued follow-up did not complete."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const finalProjection = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
            "interrupted",
          );
          expect(finalProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
            "completed",
          );
          expect(
            finalProjection.turnItems.find(
              (item) =>
                item.runId === runningFollowup.runId && item.type === "run_interrupt_result",
            ),
          ).toMatchObject({
            // SCIENT-FORK: this fixture's interrupt carries its own reason.
            message: "Stopped by an agent: Interrupt the current replay follow-up.",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === followupTasks[1]!.id &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up task did not settle."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)?.status,
          ).toBe("interrupted");
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id),
          ).toMatchObject({
            status: "completed",
            result,
          });
          expect(
            finishedParent.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === delegated.childThreadId,
            ),
          ).toHaveLength(3);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const finalStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const finalStatus = yield* decodeDelegateTaskResult(
            finalStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(finalStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: false,
            latestTerminalRunId: queuedFollowup.runId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: latestSummary,
          });
          const followupTransfer = finishedParent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourcePoint.runId === queuedFollowup.runId,
          );
          expect(followupTransfer).toBeDefined();
          expect(finalStatus.latestTerminalResultContextTransferId).toBe(followupTransfer?.id);
          expect(finalStatus.latestTerminalResultContextTransferId).not.toBe(
            delegated.resultContextTransferId,
          );
          const read = yield* invoke("scient_thread_inspect", {
            threadId: delegated.childThreadId,
            limit: 100,
          });
          expect(read.isError).not.toBe(true);
          const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            afterRead.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("acknowledged");
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );
});
