import * as NetAddress from "effect/unstable/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  RunId,
  RunAttemptId,
  NodeId,
  ProviderTurnId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProviderAuthState,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/unstable/http";

import {
  serializeComposerCitation,
  expandComposerCitationsForProvider,
} from "@t3tools/shared/composerCitations";
import { makeProviderAuthService } from "../provider/Layers/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderAuthController } from "../provider/Services/ProviderAuthService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../provider/testUtils/providerRegistryMock.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { scientInvocationForMcp } from "../mcp/ScientMcpInvocation.ts";
import { AgentInvocationContext } from "../scient/operations/AgentInvocationContext.ts";
import { dispatchScientOperation } from "../scient/operations/AgentOperationDispatcher.ts";
import { skillReleaseKey } from "@scientfactory/scient-skills";
import { BUILT_IN_SKILL_RELEASES } from "../scient/skills/BuiltInSkillReleases.ts";
import { prepareScientV2SkillTurn } from "../scient/skills/ScientV2SkillTurn.ts";
import { ScientSkillSessionPlanner } from "../scient/skills/ScientSkillSession.ts";
import { readScientThreadForInvocation } from "../mcp/toolkits/threads/handlers.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import {
  loadScientSkillForInvocation,
  listScientSkillsForInvocation,
} from "../mcp/toolkits/skills/handlers.ts";
import { listScientComputeInventory } from "../mcp/toolkits/compute/handlers.ts";
import { ComputeMcpGateway } from "../mcp/toolkits/compute/ComputeMcpGateway.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  codexThreadRuntimeParams,
  CodexProviderCapabilitiesV2,
} from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterEventStreamError,
  type ProviderAdapterV2Event,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const TestDatabaseLayer = SqlitePersistenceMemory;
const TestStoresLayer = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(TestDatabaseLayer),
);
const TestEventSinkLayer = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(TestStoresLayer, TestDatabaseLayer)),
);
const FailingReleaseEventSinkLayer = Layer.effect(
  EventSink.EventSinkV2,
  Effect.gen(function* () {
    const delegate = yield* EventSink.EventSinkV2;
    return EventSink.EventSinkV2.of({
      ...delegate,
      write: (input) =>
        input.events.some(
          (event) =>
            event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"),
        )
          ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
          : delegate.write(input),
    });
  }),
).pipe(Layer.provide(TestEventSinkLayer));

const CodexCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const ExclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexCapabilities,
  sessions: {
    ...CodexCapabilities.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

interface TestProviderRuntimeState {
  readonly openCount: number;
  readonly closeCount: number;
  readonly interruptCount: number;
  readonly resumeCount: number;
  readonly resumedWorkspaces: ReadonlyArray<{
    readonly threadId: ThreadId | null;
    readonly cwd: string | null;
  }>;

  readonly unloadedNativeThreadIds: ReadonlyArray<string>;
  readonly eventQueues: ReadonlyMap<string, Queue.Queue<ProviderAdapterV2Event, Cause.Done>>;
}

const emptyState: TestProviderRuntimeState = {
  openCount: 0,
  closeCount: 0,
  interruptCount: 0,
  resumeCount: 0,
  resumedWorkspaces: [],
  unloadedNativeThreadIds: [],
  eventQueues: new Map(),
};

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapterV2RuntimePolicy;

function makeProviderSession(input: {
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    status: "ready",
    cwd: process.cwd(),
    model: "gpt-5.4",
    capabilities: input.capabilities ?? CodexCapabilities,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly projectId?: ProjectId;
}) {
  return Effect.gen(function* () {
    const projectId =
      input.projectId ??
      (yield* input.idAllocator.allocate.project({
        fixtureName: "provider-session-manager",
      }));
    const providerThreadId = input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    }),
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CODEX_DRIVER,
      nativeId: "native-thread",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function unimplemented(detail: string) {
  return Effect.fail(
    new ProviderAdapterProtocolError({
      driver: CODEX_DRIVER,
      detail,
    }),
  );
}

function makeProviderAdapter(
  state: Ref.Ref<TestProviderRuntimeState>,
  options: {
    readonly instanceId?: ProviderInstanceId;
    readonly driver?: ProviderDriverKind;
    readonly failEventStream?: boolean;
    readonly liveStatus?: (openOrdinal: number) => OrchestrationV2ProviderSession["status"];
    readonly mcpSessionInjection?: boolean | "undeclared";
    readonly capabilities?: OrchestrationV2ProviderCapabilities;
    readonly mcpConfigs?: Ref.Ref<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >;
    readonly beforeOpen?: (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly initialProviderItemIdentityVersion?: 2;
      readonly threadId: ThreadId;
      readonly configureMcp?: boolean;
    }) => Effect.Effect<void>;
    readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
    readonly closeSession?: (id: ProviderSessionId) => Effect.Effect<void>;
    readonly interruptSession?: (
      id: ProviderSessionId,
      events: Queue.Queue<ProviderAdapterV2Event, Cause.Done>,
    ) => Effect.Effect<void>;
    readonly hangSessionScopeClose?: boolean;
    readonly beforeUnload?: Effect.Effect<void>;
    readonly startTurn?: ProviderAdapterV2SessionRuntime["startTurn"];
    readonly steerTurn?: ProviderAdapterV2SessionRuntime["steerTurn"];
    readonly invalidateInitiatedWork?: ProviderAdapterV2SessionRuntime["invalidateInitiatedWork"];
  } = {},
): ProviderAdapterV2Shape {
  const driver = options.driver ?? CODEX_DRIVER;
  const instanceId = options.instanceId ?? modelSelection.instanceId;
  return {
    instanceId,
    driver,
    ...(options.mcpSessionInjection === "undeclared"
      ? {}
      : { mcpSessionInjection: options.mcpSessionInjection ?? true }),
    getCapabilities: () => Effect.succeed(options.capabilities ?? CodexCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        if (options.beforeOpen !== undefined) {
          yield* options.beforeOpen(input);
        }
        if (options.mcpConfigs !== undefined) {
          yield* Ref.update(options.mcpConfigs, (configs) => [
            ...configs,
            input.configureMcp === false
              ? undefined
              : McpProviderSession.readMcpProviderSession(input.threadId),
          ]);
        }
        const now = yield* DateTime.now;
        const openOrdinal = (yield* Ref.get(state)).openCount + 1;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
        const session = makeProviderSession({
          providerSessionId: input.providerSessionId,
          now,
          ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        });
        yield* Ref.update(state, (current) => {
          const eventQueues = new Map(current.eventQueues);
          eventQueues.set(String(input.providerSessionId), events);
          return {
            ...current,
            openCount: current.openCount + 1,
            eventQueues,
          };
        });
        yield* Effect.addFinalizer(() =>
          Ref.update(state, (current) => ({
            ...current,
            closeCount: current.closeCount + 1,
          })),
        );
        const closeSession = options.closeSession?.(input.providerSessionId);
        if (closeSession) yield* Effect.addFinalizer(() => closeSession);
        if (options.hangSessionScopeClose === true) {
          // Registered last so it runs first on scope close, wedging the
          // close before the closeCount finalizer, like a provider process
          // that never yields its message stream.
          yield* Effect.addFinalizer(() => Effect.never);
        }

        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          get providerSession() {
            return {
              ...session,
              providerInstanceId: instanceId,
              driver,
              cwd: input.runtimePolicy.cwd ?? session.cwd,
              status: options.liveStatus?.(openOrdinal) ?? session.status,
            };
          },
          events: options.failEventStream
            ? Stream.fail(
                new ProviderAdapterEventStreamError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  cause: "process exited",
                }),
              )
            : Stream.fromQueue(events),
          ...(options.hasPendingBackgroundWork === undefined
            ? {}
            : { hasPendingBackgroundWork: options.hasPendingBackgroundWork }),
          ...(options.invalidateInitiatedWork === undefined
            ? {}
            : { invalidateInitiatedWork: options.invalidateInitiatedWork }),
          ensureThread: () => unimplemented("ensureThread unused in test"),
          resumeThread: (threadInput) =>
            Ref.update(state, (current) => ({
              ...current,
              resumeCount: current.resumeCount + 1,
              resumedWorkspaces: [
                ...current.resumedWorkspaces,
                {
                  threadId: threadInput.threadId ?? threadInput.providerThread.appThreadId,
                  cwd: threadInput.runtimePolicy?.cwd ?? null,
                },
              ],
            })).pipe(Effect.as(threadInput.providerThread)),
          startTurn: options.startTurn ?? (() => Effect.void),
          steerTurn: options.steerTurn ?? (() => Effect.void),
          interruptTurn: () =>
            Ref.update(state, (current) => ({
              ...current,
              interruptCount: current.interruptCount + 1,
            })).pipe(
              Effect.andThen(
                options.interruptSession?.(input.providerSessionId, events) ?? Effect.void,
              ),
            ),
          unloadThread: ({ providerThread }) =>
            (options.beforeUnload ?? Effect.void).pipe(
              Effect.andThen(
                Ref.update(state, (current) => ({
                  ...current,
                  unloadedNativeThreadIds: [
                    ...current.unloadedNativeThreadIds,
                    providerThread.nativeThreadRef?.nativeId ?? "",
                  ],
                })),
              ),
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in test"),
          rollbackThread: () => unimplemented("rollbackThread unused in test"),
          forkThread: () => unimplemented("forkThread unused in test"),
        } satisfies ProviderAdapterV2SessionRuntime;
      }),
  };
}

function makeTestLayer(input: {
  readonly state: Ref.Ref<TestProviderRuntimeState>;
  readonly adapterRegistryLayer?: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2>;
  readonly idleTimeoutMs: number;
  readonly driver?: ProviderDriverKind;
  readonly maxIdlePinMs?: number;
  readonly failEventStream?: boolean;
  readonly liveStatus?: (openOrdinal: number) => OrchestrationV2ProviderSession["status"];
  readonly mcpSessionInjection?: boolean | "undeclared";
  readonly mcpInjectionEnabled?: Ref.Ref<boolean>;
  readonly configureMcp?: boolean;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly mcpConfigs?: Ref.Ref<
    ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
  >;
  readonly beforeOpen?: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly initialProviderItemIdentityVersion?: 2;
    readonly threadId: ThreadId;
    readonly configureMcp?: boolean;
  }) => Effect.Effect<void>;
  readonly failReleaseEventWrites?: boolean;
  readonly onAuthenticationFailure?: ProviderRegistry.ProviderRegistry["Service"]["setProviderAuthenticationFailure"];
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly closeSession?: (id: ProviderSessionId) => Effect.Effect<void>;
  readonly interruptSession?: (
    id: ProviderSessionId,
    events: Queue.Queue<ProviderAdapterV2Event, Cause.Done>,
  ) => Effect.Effect<void>;
  readonly hangSessionScopeClose?: boolean;
  readonly beforeUnload?: Effect.Effect<void>;
  readonly startTurn?: ProviderAdapterV2SessionRuntime["startTurn"];
  readonly steerTurn?: ProviderAdapterV2SessionRuntime["steerTurn"];
  readonly invalidateInitiatedWork?: ProviderAdapterV2SessionRuntime["invalidateInitiatedWork"];
  readonly serverSettingsLayer?: ReturnType<typeof ServerSettings.layerTest>;
  readonly projectServiceLayer?: Layer.Layer<ProjectService.ProjectService>;
}) {
  const configuredEventSinkLayer = input.failReleaseEventWrites
    ? FailingReleaseEventSinkLayer
    : TestEventSinkLayer;
  const configuredAdapter = makeProviderAdapter(input.state, {
    failEventStream: input.failEventStream ?? false,
    ...(input.liveStatus === undefined ? {} : { liveStatus: input.liveStatus }),
    ...(input.driver === undefined ? {} : { driver: input.driver }),
    ...(input.mcpSessionInjection === undefined
      ? {}
      : { mcpSessionInjection: input.mcpSessionInjection }),
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    ...(input.mcpConfigs === undefined ? {} : { mcpConfigs: input.mcpConfigs }),
    ...(input.beforeOpen === undefined ? {} : { beforeOpen: input.beforeOpen }),
    ...(input.hasPendingBackgroundWork === undefined
      ? {}
      : { hasPendingBackgroundWork: input.hasPendingBackgroundWork }),
    ...(input.closeSession === undefined ? {} : { closeSession: input.closeSession }),
    ...(input.interruptSession === undefined ? {} : { interruptSession: input.interruptSession }),
    ...(input.hangSessionScopeClose === undefined
      ? {}
      : { hangSessionScopeClose: input.hangSessionScopeClose }),
    ...(input.beforeUnload === undefined ? {} : { beforeUnload: input.beforeUnload }),
    ...(input.startTurn === undefined ? {} : { startTurn: input.startTurn }),
    ...(input.steerTurn === undefined ? {} : { steerTurn: input.steerTurn }),
    ...(input.invalidateInitiatedWork === undefined
      ? {}
      : { invalidateInitiatedWork: input.invalidateInitiatedWork }),
  });
  const injectionEnabled = input.mcpInjectionEnabled;
  const registryLayer =
    input.adapterRegistryLayer ??
    (injectionEnabled === undefined
      ? ProviderAdapterRegistry.makeSingleLayer(configuredAdapter)
      : Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            get: () =>
              Ref.get(injectionEnabled).pipe(
                Effect.map((enabled) => ({ ...configuredAdapter, mcpSessionInjection: enabled })),
              ),
            list: () => Effect.succeed([configuredAdapter.instanceId]),
          }),
        ));
  const providerEventIngestorTestLayer = ProviderEventIngestor.layer.pipe(
    Layer.provide(Layer.mergeAll(configuredEventSinkLayer, IdAllocator.layer, TestStoresLayer)),
  );
  return Layer.mergeAll(
    TestStoresLayer,
    configuredEventSinkLayer,
    IdAllocator.layer,
    TestMcpRegistryLayer,
    ProviderSessionManager.layerWithOptions({
      ...(input.configureMcp === undefined ? {} : { configureMcp: input.configureMcp }),
      idleTimeoutMs: input.idleTimeoutMs,
      ...(input.maxIdlePinMs === undefined ? {} : { maxIdlePinMs: input.maxIdlePinMs }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          registryLayer,
          Layer.succeed(ProviderRegistry.ProviderRegistry, {
            ...makeProviderRegistryMock(),
            setProviderAuthenticationFailure:
              input.onAuthenticationFailure ??
              (() =>
                Effect.die("Unexpected authentication invalidation in scripted manager test.")),
          }),
          configuredEventSinkLayer,
          IdAllocator.layer,
          providerEventIngestorTestLayer,
          TestMcpRegistryLayer,
          TestStoresLayer,
          ...(input.serverSettingsLayer === undefined ? [] : [input.serverSettingsLayer]),
          ...(input.projectServiceLayer === undefined ? [] : [input.projectServiceLayer]),
        ),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
}

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-provider-session-manager")),
  getDescriptor: Effect.die("unused"),
});

const TestMcpRegistryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(HttpServer.HttpServer, fakeHttpServer),
      Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      NodeServices.layer,
    ),
  ),
);
const TestLegacyImporterLayer = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.merge(TestDatabaseLayer, TestEventSinkLayer)),
);

function makeBrowserAccessProject(projectId: ProjectId): Project {
  return {
    id: projectId,
    title: "Browser access project",
    workspaceRoot: process.cwd(),
    repositoryIdentity: null,
    faviconPath: null,
    projectIcon: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function runBrowserAccessScenario(input: {
  readonly enableAgentBrowserAccess: boolean;
  readonly enableAgentDeviceAccess?: boolean;
  readonly projectOverride?: boolean;
  readonly deviceOverride?: boolean;
  readonly createThread?: boolean;
  readonly projectExists?: boolean;
}) {
  return Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const projectId = ProjectId.make("project-provider-session-manager-browser-access");
    const threadId = ThreadId.make("thread-provider-session-manager-browser-access");
    const projectServiceLayer = Layer.mock(ProjectService.ProjectService)({
      getById: (requestedProjectId) =>
        Effect.succeed(
          input.projectExists === false
            ? Option.none()
            : Option.some(makeBrowserAccessProject(requestedProjectId)),
        ),
    });

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      if (input.createThread !== false) {
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now, projectId })],
        });
      }
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
        .pipe(Effect.ignore);
      const captured = (yield* Ref.get(mcpConfigs))[0];
      assert.isDefined(captured);
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const scope = yield* registry.resolve(
        captured!.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      assert.isDefined(scope);
      assert.deepEqual(scope!.capabilities, captured!.capabilities);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          projectServiceLayer,
          serverSettingsLayer: ServerSettings.layerTest({
            enableAgentBrowserAccess: input.enableAgentBrowserAccess,
            ...(input.enableAgentDeviceAccess === undefined
              ? {}
              : { enableAgentDeviceAccess: input.enableAgentDeviceAccess }),
            projectSettingsOverrides: {
              [projectId]: {
                ...(input.projectOverride === undefined
                  ? {}
                  : { enableAgentBrowserAccess: input.projectOverride }),
                ...(input.deviceOverride === undefined
                  ? {}
                  : { enableAgentDeviceAccess: input.deviceOverride }),
              },
            },
          }),
        }),
      ),
    );

    return (yield* Ref.get(mcpConfigs))[0];
  });
}

function makePendingRuntimeRequestEvents(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const requestId = yield* input.idAllocator.allocate.runtimeRequest({
      driver: CODEX_DRIVER,
      nativeRequestId: "pending-approval",
    });
    const nodeId = input.idAllocator.derive.approvalNode({ requestId });
    const node = {
      id: nodeId,
      threadId: input.threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "approval_request" as const,
      status: "waiting" as const,
      countsForRun: false,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: input.now,
      completedAt: null,
    };
    const request = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: {
        driver: CODEX_DRIVER,
        nativeId: "pending-approval",
        strength: "strong" as const,
      },
      kind: "command" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: input.providerSessionId,
      },
      createdAt: input.now,
      resolvedAt: null,
    };
    const turnItem = {
      id: input.idAllocator.derive.approvalTurnItem({ requestId }),
      threadId: input.threadId,
      runId: null,
      nodeId,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting" as const,
      title: null,
      startedAt: input.now,
      completedAt: null,
      updatedAt: input.now,
      type: "approval_request" as const,
      requestId,
      requestKind: "command" as const,
    };
    const events = [
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "node.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: node,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "runtime-request.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: request,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "turn-item.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: turnItem,
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
    const providerEvents = [
      {
        type: "runtime_request.updated" as const,
        driver: CODEX_DRIVER,
        threadId: input.threadId,
        runtimeRequest: request,
      },
      {
        type: "node.updated" as const,
        driver: CODEX_DRIVER,
        node,
      },
      {
        type: "turn_item.updated" as const,
        driver: CODEX_DRIVER,
        turnItem,
      },
    ] satisfies ReadonlyArray<ProviderAdapterV2Event>;
    return { events, providerEvents, requestId, nodeId };
  });
}

it.effect("ProviderSessionManagerV2 opens independent sessions concurrently", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const secondOpenStarted = yield* Deferred.make<void>();
    const releaseOpens = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Effect.gen(function* () {
        const openNumber = yield* Ref.modify(openStartedCount, (count) => [count + 1, count + 1]);
        yield* Deferred.succeed(openNumber === 1 ? firstOpenStarted : secondOpenStarted, undefined);
        yield* Deferred.await(releaseOpens);
      });

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-concurrent-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-concurrent-b");
      const firstProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const secondProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: secondThreadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      const firstFiber = yield* manager
        .open({
          threadId: firstThreadId,
          providerSessionId: firstProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* manager
        .open({
          threadId: secondThreadId,
          providerSessionId: secondProviderSessionId,
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);

      yield* Deferred.await(secondOpenStarted);
      assert.equal(yield* Ref.get(openStartedCount), 2);
      yield* Deferred.succeed(releaseOpens, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.notStrictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 closes every live session for a provider instance", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const firstThreadId = ThreadId.make("thread-provider-session-manager-logout-a");
      const secondThreadId = ThreadId.make("thread-provider-session-manager-logout-b");
      const firstProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThreadId,
      });
      const secondProviderSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: secondThreadId,
      });

      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
        ],
      });
      yield* manager.open({
        threadId: firstThreadId,
        providerSessionId: firstProviderSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({
        threadId: secondThreadId,
        providerSessionId: secondProviderSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* manager.closeInstance(modelSelection.instanceId);

      assert.isTrue(Option.isNone(yield* manager.get(firstProviderSessionId)));
      assert.isTrue(Option.isNone(yield* manager.get(secondProviderSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 opens a duplicate session only once", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const openStartedCount = yield* Ref.make(0);
    const firstOpenStarted = yield* Deferred.make<void>();
    const releaseOpen = yield* Deferred.make<void>();
    const beforeOpen = () =>
      Ref.updateAndGet(openStartedCount, (count) => count + 1).pipe(
        Effect.tap(() => Deferred.succeed(firstOpenStarted, undefined)),
        Effect.andThen(Deferred.await(releaseOpen)),
      );

    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-single-flight");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const open = manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const firstFiber = yield* open.pipe(Effect.forkScoped);
      yield* Deferred.await(firstOpenStarted);
      const secondFiber = yield* open.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(openStartedCount), 1);

      yield* Deferred.succeed(releaseOpen, undefined);
      const [firstRuntime, secondRuntime] = yield* Effect.all([
        Fiber.join(firstFiber),
        Fiber.join(secondFiber),
      ]);
      assert.strictEqual(firstRuntime, secondRuntime);
      assert.equal((yield* Ref.get(state)).openCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          beforeOpen,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 releases live sessions when its layer shuts down", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      const liveState = yield* Ref.get(state);
      assert.equal(liveState.openCount, 1);
      assert.equal(liveState.closeCount, 0);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
        }),
      ),
    );

    assert.equal((yield* Ref.get(state)).closeCount, 1);
  }),
);

it.effect("ProviderSessionManagerV2 closes event subscriptions normally on server shutdown", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-shutdown-subscription");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const bufferedSubscription = yield* runtime.subscribeEvents!;
      const activeSubscription = yield* runtime.subscribeEvents!;
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: runtime.providerSession,
      });
      assert.isTrue(Option.isSome(yield* activeSubscription.events.pipe(Stream.runHead)));

      yield* manager.shutdown;

      assert.isEmpty(yield* bufferedSubscription.events.pipe(Stream.runCollect));
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
  }),
);

it.effect("ProviderSessionManagerV2 drains subscribers when the provider stops", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-provider-stop");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const subscription = yield* runtime.subscribeEvents!;
      const collected = yield* subscription.events.pipe(Stream.runCollect, Effect.forkScoped);
      const adapterQueue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterQueue);
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "provider-stop-thread",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "provider-stop-turn",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "turn.terminal",
        driver: CODEX_DRIVER,
        providerThreadId,
        providerTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Queue.offer(adapterQueue!, {
        type: "provider_session.updated",
        driver: CODEX_DRIVER,
        providerSession: {
          ...runtime.providerSession,
          status: "stopped",
          updatedAt: now,
        },
      });
      yield* Queue.end(adapterQueue!);

      const events = Array.from(yield* Fiber.join(collected));
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.terminal", "provider_session.updated"],
      );
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 issues MCP credentials before opening and revokes them on close",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-mcp");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.threadId, threadId);
        assert.equal(captured?.providerInstanceId, modelSelection.instanceId);
        assert.equal(captured?.endpoint, "http://127.0.0.1:43123/mcp");
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);
        const resolved = yield* registry.resolve(token!);
        assert.equal(resolved?.threadId, threadId);
        assert.deepEqual(
          resolved?.capabilities,
          new Set([
            "preview",
            "orchestration",
            "worktree",
            "pull-requests",
            "documents:build",
            "compute:inventory",
            "sources:read",
            "sources:write",
            "threads:read",
            "skills:read",
          ]),
        );

        if (resolved === undefined)
          return yield* Effect.die("The manager-issued token must resolve");
        const invocation = scientInvocationForMcp(resolved);
        const discovery = yield* dispatchScientOperation(
          "skills.list",
          listScientSkillsForInvocation(),
        ).pipe(Effect.provideService(AgentInvocationContext, invocation));
        assert.equal(discovery.scope.status, "pending");
        const inventory = yield* dispatchScientOperation(
          "compute.inventory",
          listScientComputeInventory(),
        ).pipe(
          Effect.provideService(AgentInvocationContext, invocation),
          Effect.provideService(ComputeMcpGateway, {
            runtimeInventory: () => Effect.succeed({ languages: [] }),
          }),
        );
        assert.deepEqual(inventory, { languages: [] });
        const history = yield* dispatchScientOperation(
          "threads.read",
          readScientThreadForInvocation({ threadId }),
        ).pipe(Effect.provideService(AgentInvocationContext, invocation));
        assert.equal(history.thread.threadId, threadId);
        assert.deepEqual(history.items, []);
        const release = BUILT_IN_SKILL_RELEASES.find(
          (candidate) => candidate.name === "improve-workspace-readiness",
        );
        if (release === undefined)
          return yield* Effect.die("Expected the immutable built-in skill release");
        const releaseKey = skillReleaseKey(release);
        const descriptor = {
          releaseKey,
          id: release.id,
          name: release.name,
          description: release.description,
          origin: release.origin,
          activationScope: "user" as const,
          invocationPolicy: "explicit" as const,
        };
        const planner = {
          resolve: () =>
            Effect.succeed({
              delivery: "mcp" as const,
              catalogStatus: "complete" as const,
              releases: new Map([[releaseKey, release]]),
              skills: [descriptor],
              diagnostics: [],
            }),
        };
        yield* prepareScientV2SkillTurn({
          threadId,
          driver: CODEX_DRIVER,
          mcpSessionInjection: true,
          projectRoot: undefined,
          text: "Prepare selected skill",
          selectedScientSkillNames: [release.name],
        }).pipe(Effect.provideService(ScientSkillSessionPlanner, planner));
        const selectedScope = yield* registry.resolve(token!);
        if (selectedScope === undefined)
          return yield* Effect.die("Stable native credential was lost");
        const loaded = yield* dispatchScientOperation(
          "skills.load",
          loadScientSkillForInvocation({ name: release.name }),
        ).pipe(
          Effect.provideService(AgentInvocationContext, scientInvocationForMcp(selectedScope)),
        );
        assert.equal(loaded.instructions, release.instructions);
        assert.equal(loaded.skill.releaseKey, releaseKey);
        yield* prepareScientV2SkillTurn({
          threadId,
          driver: CODEX_DRIVER,
          mcpSessionInjection: true,
          projectRoot: undefined,
          text: "Clear selection",
          selectedScientSkillNames: [],
        }).pipe(Effect.provideService(ScientSkillSessionPlanner, planner));
        const clearedScope = yield* registry.resolve(token!);
        if (clearedScope === undefined)
          return yield* Effect.die("Stable native credential was lost");
        const unavailable = yield* dispatchScientOperation(
          "skills.load",
          loadScientSkillForInvocation({ name: release.name }),
        ).pipe(
          Effect.provideService(AgentInvocationContext, scientInvocationForMcp(clearedScope)),
          Effect.flip,
        );
        assert.equal(unavailable._tag, "ScientSkillToolError");

        yield* manager.close(providerSessionId);
        assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
      });

      yield* effect.pipe(
        Effect.provide(
          Layer.merge(
            makeTestLayer({
              state,
              idleTimeoutMs: 1_000,
              mcpConfigs,
            }),
            TestLegacyImporterLayer,
          ),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 withholds the preview capability when agent browser access is off",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-no-browser");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const captured = (yield* Ref.get(mcpConfigs))[0];
        assert.isDefined(captured);
        assert.equal(captured?.capabilities.has("preview"), false);
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        const resolved = yield* registry.resolve(token!);
        assert.deepEqual(
          resolved?.capabilities,
          new Set([
            "orchestration",
            "worktree",
            "pull-requests",
            "documents:build",
            "compute:inventory",
            "sources:read",
            "sources:write",
            "threads:read",
            "skills:read",
          ]),
        );

        yield* manager.close(providerSessionId);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            // orDie: the test layer's settings-normalization error cannot
            // occur for a literal override and the slot requires error never.
            serverSettingsLayer: ServerSettings.layerTest({
              enableAgentBrowserAccess: false,
            }).pipe(Layer.orDie),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 honors a project browser-access opt-out", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.capabilities.has("preview"), false);
  }),
);

it.effect("ProviderSessionManagerV2 honors a project browser-access opt-in", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: false,
      projectOverride: true,
    });
    assert.isDefined(captured);
    assert.equal(captured?.capabilities.has("preview"), true);
  }),
);

it.effect("ProviderSessionManagerV2 fails browser access closed for a missing project", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: true,
      projectExists: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.capabilities.has("preview"), false);
  }),
);

it.effect("ProviderSessionManagerV2 fails browser access closed for a missing thread", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: true,
      createThread: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.capabilities.has("preview"), false);
  }),
);

it.effect(
  "ProviderSessionManagerV2 withholds only the overridden capability for a missing project",
  () =>
    Effect.gen(function* () {
      const captured = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: true,
        enableAgentDeviceAccess: true,
        deviceOverride: false,
        projectExists: false,
      });
      assert.isDefined(captured);
      assert.isTrue(captured!.capabilities.has("preview"));
      assert.isFalse(captured!.capabilities.has("device"));
    }),
);

it.effect("ProviderSessionManagerV2 revokes MCP credentials when release persistence fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-mcp-release-failure");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      const captured = (yield* Ref.get(mcpConfigs))[0];
      const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);
      assert.isDefined(yield* registry.resolve(token!));

      const closeError = yield* manager.close(providerSessionId).pipe(Effect.flip);
      assert.equal(closeError._tag, "ProviderSessionCloseError");
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
      assert.isUndefined(yield* registry.resolve(token!));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          failReleaseEventWrites: true,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 duplicate detach preserves replacement MCP credentials", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-replacement-mcp");
      const oldSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const replacementSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId: oldSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.detach({ providerSessionId: oldSessionId, threadId });
      yield* manager.open({
        threadId,
        providerSessionId: replacementSessionId,
        modelSelection,
        runtimePolicy,
      });

      const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
      assert.isDefined(replacement);
      const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(replacementToken);
      assert.equal(
        McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
        replacement?.providerSessionId,
      );

      yield* manager.detach({ providerSessionId: oldSessionId, threadId });

      assert.equal(
        McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
        replacement?.providerSessionId,
      );
      assert.equal((yield* registry.resolve(replacementToken!))?.threadId, threadId);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
          mcpConfigs,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 detach of a superseded live session preserves replacement MCP credentials",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-superseded-mcp");
        const oldSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const replacementSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId: oldSessionId,
          modelSelection,
          runtimePolicy,
        });
        // The replacement opens while the old session is still attached: this is
        // the workspace-handoff sequence, where the queued continuation run can
        // start its session before the outbox executes the old session's detach.
        yield* manager.open({
          threadId,
          providerSessionId: replacementSessionId,
          modelSelection,
          runtimePolicy,
        });

        const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(replacement);
        const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(replacementToken);
        assert.equal(
          McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
          replacement?.providerSessionId,
        );

        // First (non-duplicate) detach of the superseded session must not revoke
        // the replacement's credential or clear its config slot.
        yield* manager.detach({ providerSessionId: oldSessionId, threadId });

        assert.equal(
          McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
          replacement?.providerSessionId,
        );
        assert.equal((yield* registry.resolve(replacementToken!))?.threadId, threadId);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            capabilities: ExclusiveCapabilities,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a thread's MCP credential stable across detach and re-attach on a shared session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-stable-mcp");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(original);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);

        // Workspace-change handoff on a shared multi-thread session (codex):
        // the thread detaches while the provider process keeps running, and the
        // process's MCP client keeps using the credential it was started with.
        yield* manager.detach({ providerSessionId, threadId, detail: "Workspace changed." });
        assert.equal(
          (yield* registry.resolve(originalToken!))?.threadId,
          threadId,
          "detach must not revoke the credential the live provider process still holds",
        );

        // The continuation run re-attaches the same thread to the same session;
        // the credential must be reused, not rotated, so the provider process's
        // long-lived MCP client stays authorized.
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        assert.equal(
          McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
          original?.providerSessionId,
          "re-attach must reuse the existing credential, not rotate it",
        );
        assert.equal((yield* registry.resolve(originalToken!))?.threadId, threadId);

        // Releasing the session (provider process gone) still revokes.
        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* registry.resolve(originalToken!));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes a rotated credential despite a stale record on another live session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-stale-record");
        const s1 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const s2 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        // S1 (shared session) records credential C1 for the thread, then the
        // thread detaches; S1 stays alive with the stale record.
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });
        yield* manager.detach({ providerSessionId: s1, threadId });

        // The credential dies externally, so S2's attach must rotate to C2.
        yield* registry.revokeThread(threadId);
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });
        const rotated = McpProviderSession.readMcpProviderSession(threadId);
        assert.isDefined(rotated);
        const rotatedToken = rotated?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(yield* registry.resolve(rotatedToken!));

        // Releasing S2 must revoke C2 even though S1 still carries a stale
        // record (of dead C1) for the same thread.
        yield* manager.close(s2);
        assert.isUndefined(
          yield* registry.resolve(rotatedToken!),
          "stale record on S1 must not veto revoking S2's rotated credential",
        );
        yield* manager.close(s1);
      });

      yield* effect.pipe(
        Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1_000, mcpConfigs })),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 protects a reused credential from a predecessor release during open",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const duringOpen = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-open-race");
        const s1 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const s2 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });
        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);
        yield* manager.detach({ providerSessionId: s1, threadId });

        // While S2's provider process is spawning (after prepare reused the
        // credential, before the entry is visible), the predecessor session
        // releases. Eager adapters (ACP, OpenCode) bake the credential into
        // the process during openSession, so the release must not revoke it;
        // rotating afterwards cannot repair those adapters.
        yield* Ref.set(duringOpen, manager.close(s1).pipe(Effect.orDie));
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });

        const slot = McpProviderSession.readMcpProviderSession(threadId);
        assert.equal(
          slot?.providerSessionId,
          original?.providerSessionId,
          "the credential the adapter was configured with must remain current",
        );
        assert.equal(
          (yield* registry.resolve(originalToken!))?.threadId,
          threadId,
          "the predecessor release must not revoke a credential reserved by an in-flight open",
        );
        yield* manager.close(s2);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            beforeOpen: (input) =>
              input.providerSessionId === undefined
                ? Effect.void
                : Ref.get(duringOpen).pipe(
                    Effect.flatten,
                    Effect.tap(() => Ref.set(duringOpen, Effect.void)),
                  ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 terminal detach revokes the thread's MCP credential", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-terminal-detach");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(yield* registry.resolve(token!));

      // Archive/delete detaches carry revokeMcpCredential: the token must die
      // with the thread even though the shared provider process lives on.
      yield* manager.detach({
        providerSessionId,
        threadId,
        detail: "Thread deleted.",
        revokeMcpCredential: true,
      });
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1_000, mcpConfigs })));
  }),
);

it.effect("ProviderSessionManagerV2 releases idle sessions without sweeping all sessions", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-idle",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-idle",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.openCount, 1);
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 persists release when session scope close hangs", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const scopeCloseGate = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-hung-close",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-hung-close",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
      assert.equal((yield* Ref.get(state)).closeCount, 0);
      assert.equal(
        Option.getOrUndefined(yield* manager.getCloseState!(providerSessionId))?.state,
        "pending",
      );
      // The original timeout assertions precede releasing this synthetic hang.
      yield* Deferred.succeed(scopeCloseGate, undefined);
      yield* manager.close(providerSessionId);
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.ensuring(Deferred.succeed(scopeCloseGate, undefined)),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          closeSession: () => Deferred.await(scopeCloseGate),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 defers idle release while background work is pending", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const pendingWork = yield* Ref.make(true);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-idle-pin",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-idle-pin",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("3 seconds");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 0);

      yield* Ref.set(pendingWork, false);
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          hasPendingBackgroundWork: Ref.get(pendingWork),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 releases pinned idle sessions once the pin cap expires", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-pin-cap",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-pin-cap",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      yield* TestClock.adjust("3 seconds");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          maxIdlePinMs: 3000,
          hasPendingBackgroundWork: Effect.succeed(true),
        }),
      ),
    );
  }),
);

for (const phase of ["pending-work check", "generation invalidation fence"] as const)
  it.effect(
    `ProviderSessionManagerV2 does not idle-release a session that turns busy during the ${phase}`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const logicalInvalidations = yield* Ref.make(0);
        const firstCheck = yield* Ref.make(true);
        const checkEntered = yield* Deferred.make<void>();
        const checkGate = yield* Deferred.make<void>();
        const effect = Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
          const now = yield* DateTime.now;
          const projectId = yield* idAllocator.allocate.project({
            fixtureName: "provider-session-manager-busy-during-check",
          });
          const threadId = yield* idAllocator.allocate.thread({
            fixtureName: "provider-session-manager-busy-during-check",
            projectId,
          });
          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          const providerThread = makeProviderThread({
            idAllocator,
            threadId,
            providerSessionId,
            now,
          });
          const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
          const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
          const rootNodeId = idAllocator.derive.rootNode({ runId });
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: "native-turn-busy-during-check",
          });

          yield* eventSink.write({
            events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
          });
          const runtime = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
          const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;

          yield* TestClock.adjust("1 second");
          yield* Deferred.await(checkEntered);

          // The release fiber is parked inside the pending-work check, so the
          // idle decision it already made is stale once this turn marks the
          // session busy.
          const turnFiber = yield* runtime
            .startTurn({
              appThread,
              threadId,
              runId,
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId,
              rootNodeId,
              providerThread,
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
                text: "hello",
                attachments: [],
              },
              modelSelection,
              runtimePolicy,
            })
            .pipe(Effect.forkDetach);
          for (let i = 0; i < 10; i += 1) {
            yield* Effect.yieldNow;
          }
          yield* Deferred.succeed(checkGate, undefined);
          yield* Fiber.join(turnFiber);
          yield* Effect.yieldNow;

          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
          assert.equal((yield* Ref.get(state)).closeCount, 0);
          assert.equal(yield* Ref.get(logicalInvalidations), 0);

          const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
          assert.isDefined(queue);
          yield* Queue.offer(queue!, {
            type: "turn.terminal",
            driver: CODEX_DRIVER,
            providerThreadId: providerThread.id,
            providerTurnId,
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;
          assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
          assert.equal((yield* Ref.get(state)).closeCount, 1);
          if (phase === "generation invalidation fence")
            assert.equal(yield* Ref.get(logicalInvalidations), 1);
        });

        yield* effect.pipe(
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 1000,
              // Uninterruptible so the markBusy-triggered interrupt cannot land
              // inside the check, mirroring an adapter that masks interruption
              // while inspecting its own state.
              ...(phase === "generation invalidation fence"
                ? {
                    invalidateInitiatedWork: (reserve = Effect.succeed(true)) =>
                      Effect.gen(function* () {
                        if (yield* Ref.getAndSet(firstCheck, false)) {
                          yield* Deferred.succeed(checkEntered, undefined);
                          yield* Deferred.await(checkGate);
                        }
                        if (!(yield* reserve)) return false;
                        yield* Ref.update(logicalInvalidations, (count) => count + 1);
                        return true;
                      }),
                  }
                : {}),
              hasPendingBackgroundWork:
                phase === "generation invalidation fence"
                  ? Effect.succeed(false)
                  : Effect.uninterruptible(
                      Effect.gen(function* () {
                        if (yield* Ref.getAndSet(firstCheck, false)) {
                          yield* Deferred.succeed(checkEntered, undefined);
                          yield* Deferred.await(checkGate);
                        }
                        return false;
                      }),
                    ),
            }),
          ),
        );
      }),
  );

it.effect("ProviderSessionManagerV2 does not apply a stale idle pin to a replacement session", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const firstCheck = yield* Ref.make(true);
    const checkEntered = yield* Deferred.make<void>();
    const checkGate = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-stale-pin",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-stale-pin",
        }),
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      // Park the first idle fiber inside an uninterruptible pending-work probe.
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(checkEntered);

      // A stale uninterruptible probe cannot publish a pin into a replacement.
      // Retiring ownership now fences replacement until this probe/close ends.
      const closeFiber = yield* manager.close(providerSessionId).pipe(Effect.forkDetach);
      for (let i = 0; i < 20; i += 1) {
        yield* Effect.yieldNow;
      }
      assert.equal(
        (yield* manager
          .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
          .pipe(Effect.flip))._tag,
        "ProviderSessionOpenError",
      );
      assert.equal((yield* Ref.get(state)).openCount, 1);
      // The old probe may finish, but its pin is no longer execution authority.
      yield* Deferred.succeed(checkGate, undefined);
      yield* Fiber.join(closeFiber);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      assert.equal((yield* Ref.get(state)).openCount, 2);
      for (let i = 0; i < 10; i += 1) {
        yield* Effect.yieldNow;
      }

      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);

      // Replacement has no pending background work. After one idle window it
      // must release. A stale pin stamp would have deferred release until
      // maxIdlePinMs.
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          maxIdlePinMs: 60_000,
          hasPendingBackgroundWork: Effect.uninterruptible(
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(firstCheck, false)) {
                yield* Deferred.succeed(checkEntered, undefined);
                yield* Deferred.await(checkGate);
                return true;
              }
              return false;
            }),
          ),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 keeps active sessions alive until the provider turn terminates",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-active",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-active",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn",
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;
        yield* runtime.startTurn({
          appThread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId,
          rootNodeId,
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });

        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: providerThread.id,
          providerTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        const liveSession = yield* manager.get(providerSessionId);
        const projection = yield* projectionStore.getThreadProjection(threadId);
        assert.isTrue(Option.isNone(liveSession));
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.equal(projection.providerSessions.at(-1)?.status, "stopped");
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect("ProviderSessionManagerV2 uses the same release path for runtime failures", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-runtime-error",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-runtime-error",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.release({
        providerSessionId,
        reason: "runtime_error",
        detail: "process exited",
      });

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "error");
      assert.equal(projection.providerSessions.at(-1)?.lastError, "process exited");
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 releases sessions when provider event streams fail", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-stream-error",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-stream-error",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.events.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      yield* Effect.yieldNow;

      const liveSession = yield* manager.get(providerSessionId);
      const runtimeState = yield* Ref.get(state);
      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.isTrue(Option.isNone(liveSession));
      assert.equal(runtimeState.closeCount, 1);
      assert.equal(projection.providerSessions.at(-1)?.status, "error");
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          failEventStream: true,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 marks pending runtime requests non-live on release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-request-expire",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-request-expire",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({ events: pendingRequest.events });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.release({
        providerSessionId,
        reason: "runtime_error",
        detail: "process exited",
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.at(-1);
      const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
      const requestTurnItem = projection.turnItems.find(
        (item) => item.type === "approval_request" && item.requestId === request?.id,
      );

      assert.equal(request?.status, "expired");
      assert.equal(request?.responseCapability.type, "not_resumable");
      assert.equal(requestNode?.status, "failed");
      assert.equal(requestTurnItem?.status, "failed");
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);
it.effect("ProviderSessionManagerV2 terminalizes a pending input transcript item on release", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-request-expire",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-request-expire",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({
        events: pendingRequest.events.map((event) =>
          event.type === "turn-item.updated"
            ? { ...event, payload: { ...event.payload, type: "user_input_request", questions: [] } }
            : event,
        ),
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.release({
        providerSessionId,
        reason: "runtime_error",
        detail: "process exited",
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.at(-1);
      const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
      const requestTurnItem = projection.turnItems.find(
        (item) => item.type === "user_input_request" && item.requestId === request?.id,
      );

      assert.equal(request?.status, "expired");
      assert.equal(request?.responseCapability.type, "not_resumable");
      assert.equal(requestNode?.status, "failed");
      assert.equal(requestTurnItem?.status, "failed");
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect("ProviderSessionManagerV2 persists session-scoped runtime requests without a run", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-session-request",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-session-request",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      const afterSequence = yield* eventSink.latestSequence({ threadId });
      const persistedFiber = yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "runtime-request.updated" ||
            stored.event.type === "node.updated" ||
            stored.event.type === "turn-item.updated",
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const adapterEvents = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(adapterEvents);
      yield* Queue.offerAll(adapterEvents!, pendingRequest.providerEvents);
      const persisted = Array.from(yield* Fiber.join(persistedFiber));

      assert.sameMembers(
        persisted.map((stored) => stored.event.type),
        ["runtime-request.updated", "node.updated", "turn-item.updated"],
      );
      const projection = yield* projectionStore.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === pendingRequest.requestId,
      );
      const node = projection.nodes.find((candidate) => candidate.id === pendingRequest.nodeId);
      const turnItem = projection.turnItems.find(
        (candidate) =>
          candidate.type === "approval_request" && candidate.requestId === pendingRequest.requestId,
      );
      assert.equal(request?.status, "pending");
      assert.equal(request?.providerTurnId, null);
      assert.equal(node?.runId, null);
      assert.equal(node?.status, "waiting");
      assert.equal(turnItem?.runId, null);
      assert.equal(turnItem?.status, "waiting");
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
  }),
);

it.effect(
  "ProviderSessionManagerV2 preserves item identity during eager native session activation",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-request-expire",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-request-expire",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* eventSink.write({
          events: (yield* makePendingRuntimeRequestEvents({
            idAllocator,
            threadId,
            providerSessionId,
            providerThread,
            now,
          })).events,
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
          initialNativeThreadId: "native-import",
          initialProviderItemIdentityVersion: 2,
        });
        yield* manager.release({
          providerSessionId,
          reason: "runtime_error",
          detail: "process exited",
        });

        const projection = yield* projectionStore.getThreadProjection(threadId);
        const request = projection.runtimeRequests.at(-1);
        const requestNode = projection.nodes.find((node) => node.id === request?.nodeId);
        const requestTurnItem = projection.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === request?.id,
        );

        assert.equal(request?.status, "expired");
        assert.equal(request?.responseCapability.type, "not_resumable");
        assert.equal(requestNode?.status, "failed");
        assert.equal(requestTurnItem?.status, "failed");
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1000,
            beforeOpen: (input) =>
              Effect.sync(() => assert.equal(input.initialProviderItemIdentityVersion, 2)),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a multi-thread session alive until all turns finish",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-multi-thread-active",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-multi-thread-active-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-multi-thread-active-b",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: firstThreadId,
        });
        const firstProviderThread = makeProviderThread({
          idAllocator,
          threadId: firstThreadId,
          providerSessionId,
          now,
        });
        const secondProviderThread = makeProviderThread({
          idAllocator,
          threadId: secondThreadId,
          providerSessionId,
          now,
        });
        const firstRunId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
        const secondRunId = idAllocator.derive.run({ threadId: secondThreadId, ordinal: 1 });
        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn-a",
        });
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn-b",
        });

        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });
        const runtime = yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
        const firstAppThread = (yield* projectionStore.getThreadProjection(firstThreadId)).thread;
        const secondAppThread = (yield* projectionStore.getThreadProjection(secondThreadId)).thread;
        yield* runtime.startTurn({
          appThread: firstAppThread,
          threadId: firstThreadId,
          runId: firstRunId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId: firstRunId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId: firstRunId }),
          providerThread: firstProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId: firstThreadId, ordinal: 1 }),
            text: "first",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn({
          appThread: secondAppThread,
          threadId: secondThreadId,
          runId: secondRunId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId: secondRunId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId: secondRunId }),
          providerThread: secondProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({
              threadId: secondThreadId,
              ordinal: 1,
            }),
            text: "second",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });

        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: firstProviderThread.id,
          providerTurnId: firstProviderTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("2 seconds");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        yield* Queue.offer(queue!, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: secondProviderThread.id,
          providerTurnId: secondProviderTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 opens one shared runtime, broadcasts events, and detaches threads independently",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-shared-runtime",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-shared-runtime-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-shared-runtime-b",
          projectId,
        });
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });

        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });
        const firstProviderThread = makeProviderThread({
          idAllocator,
          threadId: firstThreadId,
          providerSessionId,
          now,
        });
        const secondProviderThread = makeProviderThread({
          idAllocator,
          threadId: secondThreadId,
          providerSessionId,
          now,
        });
        const firstRunId = idAllocator.derive.run({ threadId: firstThreadId, ordinal: 1 });
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-thread.updated",
              threadId: firstThreadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: firstProviderThread,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: firstThreadId }),
              type: "provider-turn.updated",
              threadId: firstThreadId,
              runId: firstRunId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: {
                id: idAllocator.derive.providerTurn({
                  driver: CODEX_DRIVER,
                  nativeTurnId: "native-turn-shared-runtime-a",
                }),
                providerThreadId: firstProviderThread.id,
                nodeId: idAllocator.derive.rootNode({ runId: firstRunId }),
                runAttemptId: null,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        const firstRuntime = yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const secondRuntime = yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        assert.strictEqual(firstRuntime, secondRuntime);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        const resumeSecondThread = secondRuntime.resumeThread({
          providerThread: secondProviderThread,
          threadId: secondThreadId,
          modelSelection,
          runtimePolicy,
        });
        yield* resumeSecondThread;
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 1);
        yield* secondRuntime.resumeThread({
          providerThread: secondProviderThread,
          threadId: secondThreadId,
          modelSelection: { ...modelSelection, model: "gpt-5.4-mini" },
          runtimePolicy,
        });
        assert.equal((yield* Ref.get(state)).resumeCount, 2);
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 3);
        const subscribe = firstRuntime.subscribeEvents;
        assert.isDefined(subscribe);
        if (subscribe === undefined) return;
        const firstSubscription = yield* subscribe;
        const secondSubscription = yield* subscribe;
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.isDefined(queue);
        yield* Queue.offer(queue!, {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: firstRuntime.providerSession,
        });
        const received = yield* Effect.all([
          firstSubscription.events.pipe(Stream.runHead),
          secondSubscription.events.pipe(Stream.runHead),
        ]);
        assert.isTrue(received.every(Option.isSome));
        assert.isTrue(
          received.every(
            (event) => Option.isSome(event) && event.value.type === "provider_session.updated",
          ),
        );

        yield* manager.detach({ providerSessionId, threadId: secondThreadId });
        yield* manager.open({
          threadId: secondThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* resumeSecondThread;
        assert.equal((yield* Ref.get(state)).resumeCount, 4);

        // The second thread has no persisted provider thread, so nothing is unloaded.
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);

        yield* manager.detach({ providerSessionId, threadId: firstThreadId });
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.equal((yield* Ref.get(state)).interruptCount, 1);
        // The runtime stays up for the second thread; the first thread's
        // native state is unloaded after its turn is interrupted.
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-thread"]);

        yield* manager.detach({ providerSessionId, threadId: secondThreadId });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 reloads a different app-owned row for the same native thread",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("same-native-owned-row");
        const providerSessionId = yield* allocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* sink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator: allocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const first = makeProviderThread({
          idAllocator: allocator,
          threadId,
          providerSessionId,
          now,
        });
        const second = { ...first, id: ProviderThreadId.make("next-app-owned-row") };
        for (const providerThread of [first, first, second, second, first]) {
          const resumed = yield* runtime.resumeThread({
            providerThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          assert.equal(resumed.id, providerThread.id);
        }
        assert.equal((yield* Ref.get(state)).resumeCount, 3);
        assert.equal((yield* Ref.get(state)).openCount, 1);
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 re-attaching a thread waits for its in-flight unload, then reloads it",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const unloadStarted = yield* Deferred.make<void>();
      const releaseUnload = yield* Deferred.make<void>();
      // Resumes the provider had served when the unload actually reached it.
      let resumesBeforeUnload: number | undefined;
      // The unload parks after detach removed the attachment, leaving the
      // window in which the same thread's next turn re-attaches it.
      const beforeUnload = Effect.gen(function* () {
        yield* Deferred.succeed(unloadStarted, undefined);
        yield* Deferred.await(releaseUnload);
        resumesBeforeUnload = (yield* Ref.get(state)).resumeCount;
      });
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-unload-race",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-unload-race-a",
          projectId,
        });
        const otherThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-unload-race-b",
          projectId,
        });
        const providerSessionId = idAllocator.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        const providerThread = makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: otherThreadId, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: providerThread,
            },
          ],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        // A second thread keeps the shared runtime up after the detach.
        yield* manager.open({
          threadId: otherThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        // Resuming re-attaches the thread to the shared runtime.
        const resume = runtime.resumeThread({
          providerThread,
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* resume;

        const detach = yield* manager
          .detach({ providerSessionId, threadId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(unloadStarted);
        // The same thread's next turn re-attaches while the unload is parked.
        // Give it room to run: unfixed, it reaches the provider's resume
        // here; serialized, it waits for the unload.
        const reattach = yield* resume.pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseUnload, undefined);
        yield* Fiber.join(detach);
        yield* Fiber.join(reattach);

        // The unload reached the provider before the re-attached resume, so
        // that resume reloads the thread instead of being torn down after it.
        assert.equal(resumesBeforeUnload, 1);
        assert.equal((yield* Ref.get(state)).resumeCount, 2);
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-thread"]);
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(
        Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000, beforeUnload })),
        Effect.scoped,
      );
    }),
);

for (const workspaceCapability of [true, false, undefined] as const) {
  it.effect(
    `ProviderSessionManagerV2 shares different project workspaces only with explicit per-thread authority (${workspaceCapability})`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const fs = yield* FileSystem.FileSystem;
        const firstCwd = yield* fs.makeTempDirectoryScoped();
        const secondCwd = yield* fs.makeTempDirectoryScoped();
        const capabilities = {
          ...CodexCapabilities,
          sessions: {
            ...CodexCapabilities.sessions,
            supportsPerThreadWorkspace: workspaceCapability,
          },
        };
        yield* Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const allocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const now = yield* DateTime.now;
          const firstThread = ThreadId.make("pooled-workspace-first");
          const secondThread = ThreadId.make("pooled-workspace-second");
          const providerSessionId = yield* allocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId: firstThread,
          });
          yield* sink.write({
            events: [
              yield* makeThreadCreatedEvent({ idAllocator: allocator, threadId: firstThread, now }),
              yield* makeThreadCreatedEvent({
                idAllocator: allocator,
                threadId: secondThread,
                now,
              }),
            ],
          });
          const firstRuntime = yield* manager.open({
            threadId: firstThread,
            providerSessionId,
            modelSelection,
            runtimePolicy: { ...runtimePolicy, cwd: firstCwd },
          });
          const result = yield* Effect.result(
            manager.open({
              threadId: secondThread,
              providerSessionId,
              modelSelection,
              runtimePolicy: { ...runtimePolicy, cwd: secondCwd },
            }),
          );
          if (workspaceCapability === true) {
            assert.equal(result._tag, "Success");
            if (result._tag === "Success") assert.equal(result.success, firstRuntime);
            for (const threadId of [firstThread, secondThread]) {
              const native = {
                ...makeProviderThread({ threadId, providerSessionId, now, idAllocator: allocator }),
                id: allocator.derive.providerThread({
                  driver: CODEX_DRIVER,
                  nativeThreadId: threadId,
                }),
                nativeThreadRef: {
                  driver: CODEX_DRIVER,
                  nativeId: String(threadId),
                  strength: "strong" as const,
                },
              };
              yield* firstRuntime.resumeThread({
                providerThread: native,
                threadId,
                modelSelection,
                runtimePolicy: {
                  ...runtimePolicy,
                  cwd: threadId === firstThread ? firstCwd : secondCwd,
                },
              });
            }
            assert.equal((yield* Ref.get(state)).resumeCount, 2);
            assert.deepEqual((yield* Ref.get(state)).resumedWorkspaces, [
              { threadId: firstThread, cwd: firstCwd },
              { threadId: secondThread, cwd: secondCwd },
            ]);
            assert.isDefined(McpProviderSession.readMcpProviderSession(secondThread));
          } else {
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure")
              assert.equal(result.failure._tag, "ProviderSessionOpenError");
            assert.isUndefined(McpProviderSession.readMcpProviderSession(secondThread));
          }
          assert.equal(firstRuntime.providerSession.cwd, firstCwd);
          assert.equal((yield* Ref.get(state)).openCount, 1);
          assert.equal((yield* Ref.get(state)).closeCount, 0);
        }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000, capabilities })));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect(
  "ProviderSessionManagerV2 rejects a second thread when the provider runtime is exclusive",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-exclusive-runtime",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-b",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: firstThreadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });

        yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const error = yield* manager
          .open({
            threadId: secondThreadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderSessionOpenError");
        assert.equal((yield* Ref.get(state)).openCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({ state, idleTimeoutMs: 1000, capabilities: ExclusiveCapabilities }),
        ),
      );
    }),
);

for (const workspaceState of ["missing", "file"] as const) {
  it.effect(`rejects a ${workspaceState} workspace before opening a provider session`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      if (workspaceState === "file") yield* fileSystem.writeFileString(cwd, "not a directory");
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make(`thread-${workspaceState}-workspace`);
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const error = yield* manager
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: { ...runtimePolicy, cwd },
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.include(error.message, cwd);
        assert.include(error.message, "Restore the folder at this path before retrying.");
        assert.equal((yield* Ref.get(state)).openCount, 0);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          [],
        );
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect(
  "rejects a deleted workspace before reusing a live session without changing its state",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      yield* fileSystem.makeDirectory(cwd);
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make("thread-deleted-live-workspace");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const input = {
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, cwd },
        };
        const runtime = yield* manager.open(input);
        const before = yield* projectionStore.getThreadProjection(threadId);
        yield* fileSystem.remove(cwd, { recursive: true });
        const error = yield* manager.open(input).pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.strictEqual(Option.getOrThrow(yield* manager.get(providerSessionId)), runtime);
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          before.providerSessions,
        );
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderSessionManagerV2 applies project device access independently of browser access",
  () =>
    Effect.gen(function* () {
      const enabled = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
      });
      assert.isTrue(enabled?.capabilities?.has("device"));
      assert.isFalse(enabled?.capabilities.has("preview"));
      const denied = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
        projectExists: false,
      });
      assert.isFalse(denied?.capabilities?.has("device"));
    }),
);

for (const stalePolicy of [
  "missing-owned-grants",
  "excess-device-grant",
  "missing-skill-scope",
] as const) {
  it.effect(
    `ProviderSessionManagerV2 rotates ${stalePolicy} and reuses only the complete native policy`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const mcpConfigs = yield* Ref.make<
          ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
        >([]);
        yield* Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const now = yield* DateTime.now;
          const threadId = ThreadId.make(`thread-mcp-policy-${stalePolicy}`);
          yield* eventSink.write({
            events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
          });
          const stale = yield* registry.issue({
            threadId,
            providerInstanceId: modelSelection.instanceId,
            browserToolsAvailable: false,
            capabilities: new Set(
              stalePolicy === "missing-owned-grants"
                ? ["orchestration", "worktree", "pull-requests"]
                : [
                    "orchestration",
                    "worktree",
                    "pull-requests",
                    "documents:build",
                    "compute:inventory",
                    "sources:read",
                    "sources:write",
                    "threads:read",
                    "skills:read",
                    ...(stalePolicy === "excess-device-grant" ? ["device" as const] : []),
                  ],
            ),
          });
          McpProviderSession.setMcpProviderSession(stale.config);
          const firstId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          const first = yield* manager.open({
            threadId,
            providerSessionId: firstId,
            modelSelection,
            runtimePolicy,
          });
          assert.isTrue(first.mcpSessionInjection);
          const configured = McpProviderSession.readMcpProviderSession(threadId);
          if (configured === undefined)
            return yield* Effect.die("Injectable native session must have a credential");
          assert.notEqual(configured.authorizationHeader, stale.config.authorizationHeader);
          assert.isUndefined(
            yield* registry.resolve(stale.config.authorizationHeader.replace(/^Bearer\s+/, "")),
          );
          assert.isFalse(configured.capabilities.has("device"));
          assert.isTrue(configured.capabilities.has("threads:read"));
          assert.isTrue(configured.capabilities.has("skills:read"));
          const secondId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          yield* manager.open({
            threadId,
            providerSessionId: secondId,
            modelSelection,
            runtimePolicy,
          });
          assert.equal(
            McpProviderSession.readMcpProviderSession(threadId)?.authorizationHeader,
            configured.authorizationHeader,
          );
          yield* manager.close(firstId);
          assert.isDefined(
            yield* registry.resolve(configured.authorizationHeader.replace(/^Bearer\s+/, "")),
          );
          yield* manager.close(secondId);
          assert.isUndefined(
            yield* registry.resolve(configured.authorizationHeader.replace(/^Bearer\s+/, "")),
          );
        }).pipe(
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 1000,
              mcpConfigs,
              serverSettingsLayer: ServerSettings.layerTest({
                enableAgentBrowserAccess: false,
                enableAgentDeviceAccess: false,
              }),
            }),
          ),
        );
      }),
  );
}

for (const injectionPolicy of ["non-injectable", "disabled", "undeclared"] as const) {
  it.effect(
    `ProviderSessionManagerV2 withholds host credentials when injection is ${injectionPolicy}`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const mcpConfigs = yield* Ref.make<
          ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
        >([]);
        yield* Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const now = yield* DateTime.now;
          const threadId = ThreadId.make("thread-mcp-unavailable-instance");
          yield* eventSink.write({
            events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
          });
          const stale = yield* registry.issue({
            threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities: new Set(["skills:read"]),
          });
          McpProviderSession.setMcpProviderSession(stale.config);
          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          const native = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          assert.isFalse(native.mcpSessionInjection);
          assert.deepEqual(yield* Ref.get(mcpConfigs), [undefined]);
          assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
          assert.isUndefined(
            yield* registry.resolve(stale.config.authorizationHeader.replace(/^Bearer\s+/, "")),
          );
          yield* manager.close(providerSessionId);
        }).pipe(
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 1000,
              mcpConfigs,
              mcpSessionInjection:
                injectionPolicy === "undeclared" ? "undeclared" : injectionPolicy === "disabled",
              ...(injectionPolicy === "disabled" ? { configureMcp: false } : {}),
              beforeOpen: (opening) =>
                Effect.sync(() => {
                  assert.isFalse(opening.configureMcp);
                  assert.isUndefined(
                    codexThreadRuntimeParams({
                      threadId: opening.threadId,
                      configureMcp: opening.configureMcp !== false,
                    }).config.mcp_servers,
                  );
                }),
            }),
          ),
        );
      }),
  );
}

for (const predecessorState of ["live", "pending"] as const) {
  it.effect(
    `ProviderSessionManagerV2 preserves ${predecessorState} injectable ownership during an unsupported replacement`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const enabled = yield* Ref.make(true);
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let firstId: ProviderSessionId | undefined;
        yield* Effect.gen(function* () {
          const events = yield* EventSink.EventSinkV2;
          const ids = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const threadId = ThreadId.make(`thread-mcp-unsupported-replacement-${predecessorState}`);
          const now = yield* DateTime.now;
          yield* events.write({
            events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
          });
          const predecessorId = yield* ids.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          firstId = predecessorId;
          const firstOpening = yield* manager
            .open({ threadId, providerSessionId: predecessorId, modelSelection, runtimePolicy })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          if (predecessorState === "live") yield* Fiber.join(firstOpening);
          const credential = McpProviderSession.readMcpProviderSession(threadId);
          if (credential === undefined)
            return yield* Effect.die("Injectable predecessor must hold a credential");
          const token = credential.authorizationHeader.replace(/^Bearer\s+/, "");
          assert.isDefined(yield* registry.resolve(token));
          yield* Ref.set(enabled, false);
          const replacementId = yield* ids.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          const replacement = yield* manager.open({
            threadId,
            providerSessionId: replacementId,
            modelSelection,
            runtimePolicy,
          });
          assert.isFalse(replacement.mcpSessionInjection);
          assert.equal(
            McpProviderSession.readMcpProviderSession(threadId)?.authorizationHeader,
            credential.authorizationHeader,
          );
          assert.isDefined(yield* registry.resolve(token));
          yield* manager.close(replacementId);
          assert.isDefined(yield* registry.resolve(token));
          if (predecessorState === "pending") {
            yield* Deferred.succeed(gate, undefined);
            yield* Fiber.join(firstOpening);
          }
          yield* manager.close(predecessorId);
          assert.isUndefined(yield* registry.resolve(token));
        }).pipe(
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 1000,
              mcpInjectionEnabled: enabled,
              beforeOpen: (opening) =>
                Effect.gen(function* () {
                  if (opening.providerSessionId === firstId) {
                    yield* Deferred.succeed(started, undefined);
                    if (predecessorState === "pending") yield* Deferred.await(gate);
                  } else {
                    // Actual native Codex prepare parameters must not inherit the live peer's MCP channel.
                    assert.isFalse(opening.configureMcp);
                    const native = codexThreadRuntimeParams({
                      threadId: opening.threadId,
                      configureMcp: opening.configureMcp !== false,
                    });
                    assert.isUndefined(native.config.mcp_servers);
                  }
                }),
            }),
          ),
        );
      }),
  );
}

for (const driver of [
  CODEX_DRIVER,
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("cursor"),
]) {
  it.effect(
    `ProviderSessionManagerV2 expands file quotes on native ${driver} starts and steering without changing source text`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const sent = yield* Ref.make<ReadonlyArray<string>>([]);
        const effect = Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const ids = yield* IdAllocator.IdAllocatorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const now = yield* DateTime.now;
          const threadId = ThreadId.make("native-file-quote");
          const providerSessionId = yield* ids.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          yield* sink.write({
            events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
          });
          const runtime = yield* manager.open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          });
          const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
            threadId,
          );
          const baseThread = makeProviderThread({
            idAllocator: ids,
            threadId,
            providerSessionId,
            now,
          });
          const providerThread = {
            ...baseThread,
            driver,
            nativeThreadRef: { ...baseThread.nativeThreadRef!, driver },
          };
          const quote = serializeComposerCitation({
            kind: "file",
            version: 1,
            environmentId: EnvironmentId.make("remote-source"),
            threadId: ThreadId.make("original-thread"),
            cwd: "/original/worktree",
            path: "notes.md",
            revision: `sha256:${"a".repeat(64)}`,
            origin: "draft",
            sourceStart: 0,
            sourceEnd: 50,
            startLine: 1,
            endLine: 4,
            from: 1,
            to: 12,
            text: "Exact quote\n  with indentation",
            prefix: "",
            suffix: "",
            comment: "Explain this.",
          });
          const prompt = `Explain ${quote}`;
          const message = Object.freeze({
            messageId: MessageId.make("native-file-quote-message"),
            createdBy: "user" as const,
            creationSource: "web" as const,
            text: prompt,
            attachments: [],
          });
          yield* sink.write({
            events: [
              {
                id: yield* ids.allocate.event({ threadId }),
                type: "message.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: message.messageId,
                  threadId,
                  runId: null,
                  nodeId: null,
                  createdBy: "user",
                  creationSource: "web",
                  role: "user",
                  text: prompt,
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
          const messagesBefore =
            (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId))
              .messages;
          assert.equal(messagesBefore[0]?.text, prompt);
          yield* runtime.startTurn({
            appThread: projection.thread,
            threadId,
            runId: RunId.make("native-file-quote-run"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("native-file-quote-attempt"),
            rootNodeId: NodeId.make("native-file-quote-node"),
            providerThread,
            message,
            modelSelection,
            runtimePolicy,
          });
          yield* runtime.steerTurn({
            threadId,
            runId: RunId.make("native-file-quote-run"),
            providerThread,
            providerTurnId: ProviderTurnId.make("native-file-quote-turn"),
            message,
          });
          const inputs = yield* Ref.get(sent);
          assert.deepEqual(inputs, [
            expandComposerCitationsForProvider(prompt),
            expandComposerCitationsForProvider(prompt),
          ]);
          for (const text of inputs) {
            assert.include(text, '"cwd": "/original/worktree"');
            assert.include(text, '"origin": "draft"');
            assert.include(text, '"text": "Exact quote\\n  with indentation"');
            assert.notInclude(text, "scient-file-citation:");
          }
          assert.equal(message.text, prompt);
          assert.deepEqual(
            (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId))
              .messages,
            messagesBefore,
          );
          const plain = "Plain input [File quote](scient-file-citation://v2/?data=x)";
          yield* runtime.steerTurn({
            threadId,
            runId: RunId.make("native-file-quote-run"),
            providerThread,
            providerTurnId: ProviderTurnId.make("native-file-quote-turn"),
            message: { ...message, text: plain },
          });
          assert.equal((yield* Ref.get(sent)).at(-1), plain);
        });
        yield* effect.pipe(
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 60_000,
              driver,
              configureMcp: false,
              startTurn: (input) => Ref.update(sent, (values) => [...values, input.message.text]),
              steerTurn: (input) => Ref.update(sent, (values) => [...values, input.message.text]),
            }),
          ),
        );
      }),
  );
}

it.effect(
  "forwards only the owned native authentication control signal to the provider registry",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const failures = yield* Ref.make<
        ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly message: string }>
      >([]);
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:owned-native-auth");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const subscription = yield* runtime.subscribeEvents!;
        const consumed = yield* subscription.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.ok(queue);
        // Ordinary status and another driver's private signal confer no authority.
        yield* Queue.offer(queue, {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: {
            ...runtime.providerSession,
            status: "ready",
            lastError: "Sign-in telemetry",
            updatedAt: now,
          },
        });
        yield* Queue.offer(queue, {
          type: "authentication.invalidated",
          driver: ProviderDriverKind.make("claudeAgent"),
          message: "Foreign runtime",
        });
        yield* Queue.offer(queue, {
          type: "authentication.invalidated",
          driver: CODEX_DRIVER,
          message: "OAuth access token has been revoked.",
        });
        yield* Queue.offer(queue, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: idAllocator.derive.providerThread({
            driver: CODEX_DRIVER,
            nativeThreadId: "native-auth",
          }),
          providerTurnId: idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: "native-auth",
          }),
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        assert.isTrue(Option.isSome(yield* Fiber.join(consumed)));
        assert.deepEqual(yield* Ref.get(failures), [
          {
            instanceId: modelSelection.instanceId,
            message: "OAuth access token has been revoked.",
          },
        ]);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            onAuthenticationFailure: (failure) =>
              Ref.update(failures, (current) => [...current, failure]).pipe(Effect.as([])),
          }),
        ),
      );
    }),
);

const makeRetainedCloseChild = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "scient-retained-close-" });
  const childScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(childScope, Exit.void));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make(
        process.execPath,
        [
          "-e",
          'const fs=require("node:fs");process.on("SIGTERM",()=>process.exit(0));console.log("ready");setInterval(()=>{if(fs.existsSync(process.env.HOME+"/crash"))process.exit(19)},10)',
        ],
        {
          cwd: home,
          env: { HOME: home },
          extendEnv: false,
        },
      ),
    )
    .pipe(Scope.provide(childScope));
  const ready = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.take(1),
    Stream.runCollect,
  );
  assert.deepEqual(ready, ["ready"]);
  assert.isAbove(Number(child.pid), 1);
  process.kill(Number(child.pid), 0);
  const started = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();
  const attempts = yield* Ref.make(0);
  const fail = yield* Ref.make(false);
  const expectedExitCode = yield* Ref.make(0);
  const close = Effect.gen(function* () {
    yield* Ref.update(attempts, (n) => n + 1);
    yield* Deferred.succeed(started, undefined);
    yield* Deferred.await(gate);
    if (yield* Ref.get(fail))
      return yield* Effect.die("Owned native child close failed before exit");
    yield* Scope.close(childScope, Exit.void);
    assert.equal(yield* child.exitCode, yield* Ref.get(expectedExitCode));
    assert.throws(() => process.kill(Number(child.pid), 0), /ESRCH/);
  }).pipe(Effect.orDie);
  const crash = Ref.set(expectedExitCode, 19).pipe(
    Effect.andThen(fs.writeFileString(`${home}/crash`, "synthetic native loss")),
    Effect.orDie,
  );
  return { child, close, started, gate, attempts, fail, crash };
});

it.effect(
  "ProviderSessionManagerV2 retained close does not turn a failed live child into a successful retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const native = yield* makeRetainedCloseChild();
        yield* Ref.set(native.fail, true);
        yield* Deferred.succeed(native.gate, undefined);
        const effect = Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const ids = yield* IdAllocator.IdAllocatorV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const threadId = ThreadId.make("retained-close-failed");
          const id = yield* ids.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          yield* eventSink.write({
            events: [
              yield* makeThreadCreatedEvent({
                idAllocator: ids,
                threadId,
                now: yield* DateTime.now,
              }),
            ],
          });
          yield* manager.open({ threadId, providerSessionId: id, modelSelection, runtimePolicy });
          const mcp = yield* McpSessionRegistry.McpSessionRegistry;
          const credential = McpProviderSession.readMcpProviderSession(threadId);
          assert.isDefined(credential);
          const token = credential!.authorizationHeader.replace(/^Bearer\s+/, "");
          assert.isDefined(yield* mcp.resolve(token));
          assert.equal(
            (yield* manager.close(id).pipe(Effect.flip))._tag,
            "ProviderSessionCloseError",
          );
          process.kill(Number(native.child.pid), 0);
          assert.isTrue(Option.isNone(yield* manager.get(id)));
          assert.isUndefined(yield* mcp.resolve(token));
          assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
          assert.isTrue(
            Option.isNone(
              yield* manager.resolveMcpInvocationPolicy({
                threadId,
                providerInstanceId: modelSelection.instanceId,
                providerSessionId: credential!.providerSessionId,
              }),
            ),
          );
          assert.equal(
            (yield* projections.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
            "stopped",
          );
          const retry = yield* manager.close(id).pipe(Effect.exit);
          assert.isTrue(
            Exit.isFailure(retry),
            "A failed exact native owner cannot disappear on retry",
          );
          assert.isTrue(
            Exit.isFailure(
              yield* manager.closeInstance(modelSelection.instanceId).pipe(Effect.exit),
            ),
          );
          assert.equal(
            yield* Ref.get(native.attempts),
            1,
            "No no-op Scope.close masquerades as a native retry",
          );
          process.kill(Number(native.child.pid), 0);
          assert.equal(Option.getOrUndefined(yield* manager.getCloseState!(id))?.state, "failed");
          assert.equal(
            (yield* manager
              .open({ threadId, providerSessionId: id, modelSelection, runtimePolicy })
              .pipe(Effect.flip))._tag,
            "ProviderSessionOpenError",
          );
        });
        yield* effect.pipe(
          Effect.provide(
            makeTestLayer({ state, idleTimeoutMs: 60000, closeSession: () => native.close }),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

type RetainedCloseChild = Effect.Success<ReturnType<typeof makeRetainedCloseChild>>;
const retainedPeerId = ProviderInstanceId.make("codex-shared-peer");
const retainedIndependentId = ProviderInstanceId.make("codex-independent");

const runRetainedCloseTest = <E>(
  test: (context: {
    manager: ProviderSessionManager.ProviderSessionManagerV2Shape;
    projections: ProjectionStore.ProjectionStoreV2Shape;
    events: EventSink.EventSinkV2Shape;
    state: Ref.Ref<TestProviderRuntimeState>;
    open: (
      thread: string,
      instanceId?: ProviderInstanceId,
      sessionId?: ProviderSessionId,
    ) => Effect.Effect<{
      id: ProviderSessionId;
      threadId: ThreadId;
      runtime: ProviderAdapterV2SessionRuntime;
      native: RetainedCloseChild;
    }>;
    auth: Awaited<Effect.Success<typeof makeProviderAuthService>>;
    registry: McpSessionRegistry.McpSessionRegistryShape;
    mutations: string[];
  }) => Effect.Effect<void, E, Scope.Scope>,
  options: {
    idleTimeoutMs?: number;
    hasPendingBackgroundWork?: Effect.Effect<boolean>;
    finishProbe?: Effect.Effect<void>;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const parent = yield* Effect.scope;
      const children = new Map<ProviderInstanceId, RetainedCloseChild[]>();
      const adapters = [modelSelection.instanceId, retainedPeerId, retainedIndependentId].map(
        (instanceId) => {
          const owned: RetainedCloseChild[] = [];
          children.set(instanceId, owned);
          return makeProviderAdapter(state, {
            instanceId,
            beforeOpen: () =>
              makeRetainedCloseChild().pipe(
                Scope.provide(parent),
                Effect.provide(NodeServices.layer),
                Effect.orDie,
                Effect.tap((native) => Effect.sync(() => owned.push(native))),
                Effect.asVoid,
              ),
            closeSession: () => owned.at(-1)!.close,
            ...(options.hasPendingBackgroundWork
              ? { hasPendingBackgroundWork: options.hasPendingBackgroundWork }
              : {}),
          });
        },
      );
      const adapterRegistryLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        {
          get: (id: ProviderInstanceId) => {
            const adapter = adapters.find((adapter) => adapter.instanceId === id);
            return adapter
              ? Effect.succeed(adapter)
              : Effect.fail(
                  new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
                    instanceId: id,
                  }),
                );
          },
          list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
        },
      );
      const mutations: string[] = [];
      const authState: ProviderAuthState = {
        phase: "idle",
        flowId: null,
        instanceId: modelSelection.instanceId,
        authorizationUrl: null,
        expiresAt: null,
        message: null,
      };
      const instances: ProviderInstance[] = adapters.map((adapter) => {
        const instanceId = adapter.instanceId;
        const auth: ProviderAuthController = {
          credentialBinding: {
            owner: "provider",
            key: instanceId === retainedIndependentId ? "independent" : "retained-shared",
          },
          start: (_owner, stop) =>
            (stop ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  mutations.push(`start:${instanceId}`);
                  return { ...authState, instanceId };
                }),
              ),
            ),
          logout: (stop) =>
            stop.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  mutations.push(`logout:${instanceId}`);
                  return { ...authState, instanceId };
                }),
              ),
            ),
          importProfile: (_profile, stop) =>
            stop.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  mutations.push(`import:${instanceId}`);
                  return { ...authState, instanceId };
                }),
              ),
            ),
          invalidate: Effect.sync(() => {
            mutations.push(`invalidate:${instanceId}`);
          }),
          complete: () => Effect.succeed(authState),
          cancel: () => Effect.succeed(authState),
          subscribe: () => Stream.empty,
        };
        return {
          instanceId,
          driverKind: CODEX_DRIVER,
          enabled: true,
          displayName: undefined,
          continuationIdentity: { driverKind: CODEX_DRIVER, continuationKey: instanceId },
          auth,
          get snapshot(): never {
            throw new Error("Native close fixture must not refresh discovery");
          },
          orchestrationAdapter: adapter,
          get adapter(): never {
            throw new Error("Native close fixture must not use V1");
          },
          get textGeneration(): never {
            throw new Error("Native close fixture must not generate text");
          },
        };
      });
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const events = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const auth = yield* makeProviderAuthService.pipe(
          Effect.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) =>
                Effect.succeed(instances.find((instance) => instance.instanceId === id)),
              listInstances: Effect.succeed(instances),
            }),
          ),
        );
        const open = Effect.fnUntraced(function* (
          thread: string,
          instanceId = modelSelection.instanceId,
          sessionId?: ProviderSessionId,
        ) {
          const threadId = ThreadId.make(thread);
          if (
            Option.isNone(yield* projections.getThreadRecords(threadId, []).pipe(Effect.option))
          ) {
            const event = yield* makeThreadCreatedEvent({
              idAllocator: ids,
              threadId,
              now: yield* DateTime.now,
            });
            yield* events.write({
              events: [
                {
                  ...event,
                  payload: {
                    ...event.payload,
                    providerInstanceId: instanceId,
                    modelSelection: { ...modelSelection, instanceId },
                  },
                },
              ],
            });
          }
          const id =
            sessionId ??
            (yield* ids.allocate.providerSession({ providerInstanceId: instanceId, threadId }));
          const runtime = yield* manager.open({
            threadId,
            providerSessionId: id,
            modelSelection: { ...modelSelection, instanceId },
            runtimePolicy,
          });
          const native = children.get(instanceId)!.at(-1)!;
          return { id, threadId, runtime, native };
        }, Effect.orDie);
        yield* test({ manager, projections, events, state, open, auth, registry, mutations }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* options.finishProbe ?? Effect.void;
              for (const owned of children.values())
                for (const native of owned) yield* Deferred.succeed(native.gate, undefined);
            }),
          ),
        );
      });
      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: options.idleTimeoutMs ?? 60000,
            adapterRegistryLayer,
          }),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect(
  "ProviderSessionManagerV2 retained close survives interrupted waiters and joins one actual child close",
  () =>
    runRetainedCloseTest((ctx) =>
      Effect.gen(function* () {
        const first = yield* ctx.open("retained-interrupted");
        const waiter = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
        yield* Deferred.await(first.native.started);
        const state = yield* ctx.manager.getCloseState!(first.id);
        assert.deepEqual(Option.getOrUndefined(state), {
          providerSessionId: first.id,
          instanceId: modelSelection.instanceId,
          state: "pending",
        });
        assert.isTrue(Option.isNone(yield* ctx.manager.get(first.id)));
        yield* Fiber.interrupt(waiter);
        const follower = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
        const instanceFollower = yield* ctx.manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.forkChild);
        const input = {
          threadId: first.threadId,
          providerSessionId: first.id,
          modelSelection,
          runtimePolicy,
        };
        assert.equal(
          (yield* ctx.manager.open(input).pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        assert.equal(
          (yield* ctx.manager
            .open({ ...input, providerSessionId: ProviderSessionId.make("conflicting-new-id") })
            .pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        assert.equal((yield* Ref.get(ctx.state)).openCount, 1);
        process.kill(Number(first.native.child.pid), 0);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        assert.isUndefined(follower.pollUnsafe());
        assert.isUndefined(instanceFollower.pollUnsafe());
        yield* Deferred.succeed(first.native.gate, undefined);
        yield* Fiber.join(follower);
        yield* Fiber.join(instanceFollower);
        assert.throws(() => process.kill(Number(first.native.child.pid), 0), /ESRCH/);
        assert.isTrue(Option.isNone(yield* ctx.manager.getCloseState!(first.id)));
        const replacement = yield* ctx.open(
          "retained-interrupted",
          modelSelection.instanceId,
          first.id,
        );
        assert.notEqual(replacement.runtime, first.runtime);
        assert.notEqual(replacement.native.child.pid, first.native.child.pid);
        assert.equal((yield* Ref.get(ctx.state)).openCount, 2);
        yield* Deferred.succeed(replacement.native.gate, undefined);
        yield* ctx.manager.close(replacement.id);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        assert.equal(yield* Ref.get(replacement.native.attempts), 1);
      }),
    ),
);

it.effect(
  "ProviderSessionManagerV2 retained close starts physical cleanup before an interrupted idle-probe join",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const probeGate = yield* Deferred.make<void>();
      let firstProbe = true;
      const probe = Effect.uninterruptible(
        Effect.gen(function* () {
          if (!firstProbe) return false;
          firstProbe = false;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(probeGate);
          return true;
        }),
      );
      yield* runRetainedCloseTest(
        (ctx) =>
          Effect.gen(function* () {
            const first = yield* ctx.open("retained-idle-join");
            yield* TestClock.adjust("1 second");
            yield* Deferred.await(entered);
            const waiter = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
            yield* Deferred.await(first.native.started);
            assert.isTrue(Option.isSome(yield* ctx.manager.getCloseState!(first.id)));
            yield* Fiber.interrupt(waiter);
            assert.equal(
              (yield* ctx.manager
                .open({
                  threadId: first.threadId,
                  providerSessionId: first.id,
                  modelSelection,
                  runtimePolicy,
                })
                .pipe(Effect.flip))._tag,
              "ProviderSessionOpenError",
            );
            const follower = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
            yield* Deferred.succeed(first.native.gate, undefined);
            yield* first.native.child.exitCode;
            assert.throws(() => process.kill(Number(first.native.child.pid), 0), /ESRCH/);
            assert.isUndefined(
              follower.pollUnsafe(),
              "Idle cleanup is retained after physical exit",
            );
            yield* Deferred.succeed(probeGate, undefined);
            yield* Fiber.join(follower);
            assert.equal(yield* Ref.get(first.native.attempts), 1);
            const replacement = yield* ctx.open(
              "retained-idle-join",
              modelSelection.instanceId,
              first.id,
            );
            yield* Deferred.succeed(replacement.native.gate, undefined);
            yield* ctx.manager.close(replacement.id);
          }),
        {
          idleTimeoutMs: 1000,
          hasPendingBackgroundWork: probe,
          finishProbe: Deferred.succeed(probeGate, undefined).pipe(Effect.asVoid),
        },
      );
    }),
);

it.effect.each([false, true])(
  "ProviderSessionManagerV2 retained close preserves timeout and late failure truth: %s",
  (lateFailure) =>
    runRetainedCloseTest((ctx) =>
      Effect.gen(function* () {
        const first = yield* ctx.open(`retained-timeout-${lateFailure}`);
        yield* Ref.set(first.native.fail, lateFailure);
        const registry = ctx.registry;
        const credential = McpProviderSession.readMcpProviderSession(first.threadId)!;
        const token = credential.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(yield* registry.resolve(token));
        const released = yield* ctx.events
          .stream({ threadId: first.threadId, eventType: "provider-session.updated" })
          .pipe(
            Stream.filter(
              (row) =>
                row.event.type === "provider-session.updated" &&
                row.event.payload.status === "stopped",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
        const waiter = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
        yield* Deferred.await(first.native.started);
        yield* TestClock.adjust("30 seconds");
        assert.isTrue(
          Exit.isFailure(yield* Fiber.await(waiter)),
          "A timed-out public close is pending, not success",
        );
        assert.lengthOf(yield* Fiber.join(released), 1);
        assert.isUndefined(yield* registry.resolve(token));
        assert.isUndefined(McpProviderSession.readMcpProviderSession(first.threadId));
        assert.equal(
          (yield* ctx.projections.getThreadProjection(first.threadId)).providerSessions.at(-1)
            ?.status,
          "stopped",
        );
        assert.equal(
          Option.getOrUndefined(yield* ctx.manager.getCloseState!(first.id))?.state,
          "pending",
        );
        assert.isTrue(Option.isNone(yield* ctx.manager.get(first.id)));
        process.kill(Number(first.native.child.pid), 0);
        assert.equal(
          (yield* ctx.manager
            .open({
              threadId: first.threadId,
              providerSessionId: first.id,
              modelSelection,
              runtimePolicy,
            })
            .pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        let configWrites = 0;
        const config = yield* ctx.manager.closeInstance(modelSelection.instanceId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              configWrites++;
            }),
          ),
          Effect.forkChild,
        );
        const logout = yield* ctx.auth
          .logout({ instanceId: modelSelection.instanceId })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.isTrue(Exit.isFailure(yield* Fiber.await(config)));
        assert.isTrue(Exit.isFailure(yield* Fiber.await(logout)));
        assert.equal(configWrites, 0);
        assert.deepEqual(ctx.mutations, []);
        process.kill(Number(first.native.child.pid), 0);
        yield* Deferred.succeed(first.native.gate, undefined);
        const late = yield* ctx.manager.close(first.id).pipe(Effect.exit);
        assert.equal(Exit.isFailure(late), lateFailure);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        if (lateFailure) {
          assert.equal(
            Option.getOrUndefined(yield* ctx.manager.getCloseState!(first.id))?.state,
            "failed",
          );
          process.kill(Number(first.native.child.pid), 0);
          assert.isTrue(
            Exit.isFailure(
              yield* ctx.manager.closeInstance(modelSelection.instanceId).pipe(Effect.exit),
            ),
          );
        } else {
          assert.throws(() => process.kill(Number(first.native.child.pid), 0), /ESRCH/);
          assert.isTrue(Option.isNone(yield* ctx.manager.getCloseState!(first.id)));
          yield* ctx.auth.logout({ instanceId: modelSelection.instanceId });
          assert.include(ctx.mutations, `logout:${modelSelection.instanceId}`);
        }
      }),
    ),
);

it.effect(
  "ProviderSessionManagerV2 retained close fences actual auth retries through stopped shared peers without touching independent owners",
  () =>
    runRetainedCloseTest((ctx) =>
      Effect.gen(function* () {
        const peer = yield* ctx.open("retained-auth-peer", retainedPeerId);
        const independent = yield* ctx.open("retained-auth-independent", retainedIndependentId);
        yield* Ref.set(peer.native.fail, true);
        yield* Deferred.succeed(peer.native.gate, undefined);
        assert.isTrue(Exit.isFailure(yield* ctx.manager.close(peer.id).pipe(Effect.exit)));
        assert.equal(
          (yield* ctx.projections.getThreadProjection(peer.threadId)).providerSessions.at(-1)
            ?.status,
          "stopped",
        );
        const profile = {
          registration: { clientId: "oaiapp_synthetic" },
          credentials: {
            clientId: "oaiapp_synthetic",
            accessToken: "synthetic-access",
            refreshToken: null,
            idToken: "synthetic-id",
            issuer: "synthetic",
            expiresAt: 0,
            earliestRefreshAt: null,
            scopes: [],
            subject: "synthetic",
            email: null,
          },
        };
        for (const operation of [
          ctx.auth.logout({ instanceId: modelSelection.instanceId }),
          ctx.auth.start({ instanceId: modelSelection.instanceId }, "synthetic-owner"),
          ctx.auth.importProfile({ instanceId: modelSelection.instanceId, profile }),
        ]) {
          const result = yield* operation.pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          process.kill(Number(peer.native.child.pid), 0);
          assert.equal(yield* Ref.get(peer.native.attempts), 1);
          assert.deepEqual(ctx.mutations, []);
        }
        assert.isTrue(Option.isSome(yield* ctx.manager.get(independent.id)));
        assert.isTrue(Option.isNone(yield* ctx.manager.getCloseState!(independent.id)));
        process.kill(Number(independent.native.child.pid), 0);
        assert.equal(yield* Ref.get(independent.native.attempts), 0);
        yield* Deferred.succeed(independent.native.gate, undefined);
        yield* ctx.auth.logout({ instanceId: retainedIndependentId });
        assert.throws(() => process.kill(Number(independent.native.child.pid), 0), /ESRCH/);
        assert.deepEqual(ctx.mutations, [`logout:${retainedIndependentId}`]);
        assert.equal(yield* Ref.get(peer.native.attempts), 1);
        process.kill(Number(peer.native.child.pid), 0);
      }),
    ),
);

it.effect(
  "ProviderSessionManagerV2 retained close recovers after genuine child loss without letting old cleanup erase a replacement",
  () =>
    runRetainedCloseTest((ctx) =>
      Effect.gen(function* () {
        const first = yield* ctx.open("retained-native-loss");
        const oldQueue = (yield* Ref.get(ctx.state)).eventQueues.get(String(first.id))!;
        const loss = yield* first.native.child.exitCode.pipe(
          Effect.tap((code) => Effect.sync(() => assert.equal(code, 19))),
          Effect.andThen(Queue.end(oldQueue)),
          Effect.forkChild,
        );
        yield* first.native.crash;
        yield* Fiber.join(loss);
        assert.throws(() => process.kill(Number(first.native.child.pid), 0), /ESRCH/);
        yield* Deferred.await(first.native.started);
        assert.isTrue(Option.isNone(yield* ctx.manager.get(first.id)));
        assert.equal(
          Option.getOrUndefined(yield* ctx.manager.getCloseState!(first.id))?.state,
          "pending",
        );
        assert.equal(
          (yield* ctx.manager
            .open({
              threadId: first.threadId,
              providerSessionId: first.id,
              modelSelection,
              runtimePolicy,
            })
            .pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        assert.equal(
          (yield* Ref.get(ctx.state)).openCount,
          1,
          "No assertion requires replacement launch before old cleanup",
        );
        const closing = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
        yield* Deferred.succeed(first.native.gate, undefined);
        yield* Fiber.join(closing);
        const replacement = yield* ctx.open(
          "retained-native-loss",
          modelSelection.instanceId,
          first.id,
        );
        assert.notEqual(replacement.runtime, first.runtime);
        assert.notEqual(replacement.native.child.pid, first.native.child.pid);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        process.kill(Number(replacement.native.child.pid), 0);
        // A retired consumer cannot feed a stale frame into the new canonical owner.
        assert.isFalse(
          yield* Queue.offer(oldQueue, {
            type: "provider_session.updated",
            driver: CODEX_DRIVER,
            providerSession: { ...first.runtime.providerSession, status: "error" },
          }),
        );
        assert.isTrue(Option.isSome(yield* ctx.manager.get(replacement.id)));
        assert.equal(
          (yield* ctx.projections.getThreadProjection(first.threadId)).providerSessions.at(-1)
            ?.status,
          "ready",
        );
        process.kill(Number(replacement.native.child.pid), 0);
        yield* Deferred.succeed(replacement.native.gate, undefined);
        yield* ctx.manager.close(replacement.id);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        assert.equal(yield* Ref.get(replacement.native.attempts), 1);
      }),
    ),
);

for (const status of ["ready", "running", "waiting"] as const) {
  it.effect(`ProviderSessionManagerV2 retains a healthy live ${status} owner`, () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const events = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make(`healthy-live-${status}`);
        const providerSessionId = ProviderSessionId.make(`healthy-live-${status}`);
        yield* events.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now: yield* DateTime.now }),
          ],
        });
        const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
        const original = yield* manager.open(input);
        assert.strictEqual(yield* manager.open(input), original);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
      }).pipe(
        Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000, liveStatus: () => status })),
      );
    }),
  );
}

for (const status of ["error", "stopped"] as const) {
  for (const close of ["success", "pending", "failure"] as const) {
    it.effect(
      `ProviderSessionManagerV2 retires the exact live ${status} owner only after ${close} close`,
      () =>
        Effect.gen(function* () {
          const state = yield* Ref.make(emptyState);
          const closeEntered = yield* Deferred.make<void>();
          const closeRelease = yield* Deferred.make<void>();
          let unhealthy = false;
          yield* Effect.gen(function* () {
            const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
            const events = yield* EventSink.EventSinkV2;
            const ids = yield* IdAllocator.IdAllocatorV2;
            const threadId = ThreadId.make(`unusable-live-${status}-${close}`);
            const providerSessionId = ProviderSessionId.make(`unusable-live-${status}-${close}`);
            yield* events.write({
              events: [
                yield* makeThreadCreatedEvent({
                  idAllocator: ids,
                  threadId,
                  now: yield* DateTime.now,
                }),
              ],
            });
            const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
            const original = yield* manager.open(input);
            assert.equal(original.providerSession.status, "ready");
            yield* Effect.sync(() => {
              unhealthy = true;
            });
            // The exposed opening snapshot remains ready; internal live status decides.
            assert.equal(original.providerSession.status, "ready");
            const reopening = yield* manager.open(input).pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(closeEntered);
            assert.equal((yield* Ref.get(state)).openCount, 1);
            assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
            if (close === "pending") {
              yield* TestClock.adjust("31 seconds");
              const refused = yield* Fiber.join(reopening);
              assert.isTrue(Exit.isFailure(refused));
              assert.equal(
                Option.getOrUndefined(yield* manager.getCloseState!(providerSessionId))?.state,
                "pending",
              );
              assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
              assert.equal((yield* Ref.get(state)).openCount, 1);
            }
            yield* Deferred.succeed(closeRelease, undefined);
            const result = yield* Fiber.join(reopening);
            if (close === "failure") {
              assert.isTrue(Exit.isFailure(result));
              assert.equal(
                Option.getOrUndefined(yield* manager.getCloseState!(providerSessionId))?.state,
                "failed",
              );
              assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
              assert.equal((yield* Ref.get(state)).openCount, 1);
            } else {
              if (close === "pending") yield* manager.close(providerSessionId);
              const replacement =
                close === "pending"
                  ? yield* manager.open(input)
                  : Exit.isSuccess(result)
                    ? result.value
                    : undefined;
              assert.ok(replacement);
              assert.notStrictEqual(replacement, original);
              assert.equal((yield* Ref.get(state)).openCount, 2);
              assert.strictEqual(yield* manager.open(input), replacement);
              assert.equal((yield* Ref.get(state)).closeCount, 1);
            }
          }).pipe(
            Effect.ensuring(Deferred.succeed(closeRelease, undefined)),
            Effect.provide(
              makeTestLayer({
                state,
                idleTimeoutMs: 60_000,
                liveStatus: (ordinal) => (ordinal === 1 && unhealthy ? status : "ready"),
                closeSession: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(closeEntered, undefined);
                    yield* Deferred.await(closeRelease);
                    if (close === "failure")
                      return yield* Effect.die("Controlled exact-owner close failure");
                  }),
              }),
            ),
          );
        }),
    );
  }
}

for (const close of ["success", "failure", "interrupted-waiter"] as const) {
  it.effect(
    `ProviderSessionManagerV2 joins exact sealed-prefix retirement with ${close} without losing peers or same-ID fencing`,
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const closeEntered = yield* Deferred.make<void>();
        const closeRelease = yield* Deferred.make<void>();
        let stopped = false;
        const id = ProviderSessionId.make(`sealed-owner-${close}`);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const ids = yield* IdAllocator.IdAllocatorV2;
          const now = yield* DateTime.now;
          const threadId = ThreadId.make(`sealed-owner-${close}`);
          const peerThreadId = ThreadId.make(`sealed-peer-${close}`);
          const peerId = ProviderSessionId.make(`sealed-peer-${close}`);
          yield* eventSink.write({
            events: [
              yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now }),
              yield* makeThreadCreatedEvent({ idAllocator: ids, threadId: peerThreadId, now }),
            ],
          });
          const input = { threadId, providerSessionId: id, modelSelection, runtimePolicy };
          const original = yield* manager.open(input);
          const peer = yield* manager.open({
            ...input,
            threadId: peerThreadId,
            providerSessionId: peerId,
          });
          const oldQueue = (yield* Ref.get(state)).eventQueues.get(String(id))!;
          const subscription = yield* original.subscribeEvents!;
          const prefix = yield* subscription.events.pipe(Stream.runCollect, Effect.forkScoped);
          const providerThread = makeProviderThread({
            idAllocator: ids,
            threadId,
            providerSessionId: id,
            now,
          });
          const interruption = yield* original
            .interruptTurn({ providerThread, providerTurnId: ProviderTurnId.make("sealed-turn") })
            .pipe(Effect.exit, Effect.forkScoped);
          yield* Deferred.await(closeEntered);
          assert.isUndefined(interruption.pollUnsafe());
          assert.isTrue(Option.isNone(yield* manager.get(id)));
          assert.equal(Option.getOrUndefined(yield* manager.getCloseState!(id))?.state, "pending");
          assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
          assert.strictEqual(Option.getOrUndefined(yield* manager.get(peerId)), peer);
          const drained = Array.from(yield* Fiber.join(prefix));
          assert.deepEqual(
            drained.map((e) => e.type),
            ["provider_session.updated"],
          );
          assert.equal(
            drained[0]?.type === "provider_session.updated"
              ? drained[0].providerSession.status
              : undefined,
            "stopped",
          );
          if (close === "interrupted-waiter") yield* Fiber.interrupt(interruption);
          yield* Deferred.succeed(closeRelease, undefined);
          if (close === "interrupted-waiter") yield* manager.close(id);
          else assert.equal(Exit.isFailure(yield* Fiber.join(interruption)), close === "failure");
          assert.equal((yield* Ref.get(state)).closeCount, 1);
          if (close === "failure") {
            assert.equal(Option.getOrUndefined(yield* manager.getCloseState!(id))?.state, "failed");
            assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
            assert.equal((yield* Ref.get(state)).openCount, 2);
          } else {
            assert.isTrue(Option.isNone(yield* manager.getCloseState!(id)));
            const replacement = yield* manager.open(input);
            assert.notStrictEqual(replacement, original);
            yield* Queue.end(oldQueue);
            assert.strictEqual(yield* manager.open(input), replacement);
            assert.strictEqual(Option.getOrUndefined(yield* manager.get(id)), replacement);
            assert.equal((yield* Ref.get(state)).openCount, 3);
          }
          assert.strictEqual(Option.getOrUndefined(yield* manager.get(peerId)), peer);
        }).pipe(
          Effect.ensuring(Deferred.succeed(closeRelease, undefined)),
          Effect.provide(
            makeTestLayer({
              state,
              idleTimeoutMs: 60_000,
              liveStatus: (ordinal) => (ordinal === 1 && stopped ? "stopped" : "ready"),
              interruptSession: (sessionId, events) =>
                Effect.gen(function* () {
                  assert.equal(sessionId, id);
                  stopped = true;
                  const providerSession = makeProviderSession({
                    providerSessionId: id,
                    now: yield* DateTime.now,
                  });
                  yield* Queue.offer(events, {
                    type: "provider_session.updated",
                    driver: CODEX_DRIVER,
                    providerSession: { ...providerSession, status: "stopped" },
                  });
                  yield* Queue.end(events);
                }),
              closeSession: (sessionId) =>
                Effect.suspend(() =>
                  sessionId !== id || !stopped
                    ? Effect.void
                    : Deferred.succeed(closeEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(closeRelease)),
                        Effect.andThen(
                          close === "failure"
                            ? Effect.die("Original close unconfirmed")
                            : Effect.void,
                        ),
                      ),
                ),
            }),
          ),
        );
      }),
  );
}
