import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as LegacyV1ThreadImporter from "../legacy/LegacyV1ThreadImporter.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import {
  ProviderAdapterEventStreamError,
  type ProviderAdapterV2Event,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "../ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";

const TestDatabaseLayer = SqlitePersistenceMemory;

const TestStoresLayer = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(TestDatabaseLayer),
);

const TestEventSinkLayer = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(TestStoresLayer, TestDatabaseLayer)),
);

interface ReleaseWriteFailureControl {
  readonly failing: Ref.Ref<boolean>;
  readonly attempted: Deferred.Deferred<void>;
  readonly persisted: Deferred.Deferred<void>;
}

function failingReleaseEventSinkLayer(control: ReleaseWriteFailureControl) {
  return Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) => {
          const isRelease = input.events.some(
            (event) =>
              event.type === "provider-session.updated" &&
              (event.payload.status === "stopped" || event.payload.status === "error"),
          );
          if (!isRelease) return delegate.write(input);
          return Effect.gen(function* () {
            if (yield* Ref.get(control.failing)) {
              yield* Deferred.succeed(control.attempted, undefined);
              return yield* Effect.fail(
                new EventSink.EventSinkWriteError({ eventCount: input.events.length }),
              );
            }
            const result = yield* delegate.write(input);
            yield* Deferred.succeed(control.persisted, undefined);
            return result;
          });
        },
      });
    }),
  ).pipe(Layer.provide(TestEventSinkLayer));
}

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
  readonly nativeThreadId?: string;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: input.nativeThreadId ?? "native-thread",
    }),
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CODEX_DRIVER,
      nativeId: input.nativeThreadId ?? "native-thread",
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
    readonly spawnBeforeOpen?: boolean;
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
        if (options.spawnBeforeOpen !== true && options.beforeOpen !== undefined) {
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

        if (options.spawnBeforeOpen === true && options.beforeOpen !== undefined) {
          yield* options.beforeOpen(input);
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
  readonly spawnBeforeOpen?: boolean;
  readonly beforeOpen?: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly initialProviderItemIdentityVersion?: 2;
    readonly threadId: ThreadId;
    readonly configureMcp?: boolean;
  }) => Effect.Effect<void>;
  readonly releaseWriteFailure?: ReleaseWriteFailureControl;
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
  const configuredEventSinkLayer =
    input.releaseWriteFailure === undefined
      ? TestEventSinkLayer
      : failingReleaseEventSinkLayer(input.releaseWriteFailure);
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
    ...(input.spawnBeforeOpen === undefined ? {} : { spawnBeforeOpen: input.spawnBeforeOpen }),
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
      ? ProviderAdapterRegistry.layerSingle(configuredAdapter)
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
  ).pipe(Layer.provide(ThreadCommandExecutor.layer), Layer.provide(NodeServices.layer));
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
    const createAfterPolicyCapture = yield* Ref.make<Effect.Effect<void>>(
      Effect.die("The missing-thread fixture must install its durable creation before open."),
    );
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
      const created = yield* makeThreadCreatedEvent({ idAllocator, threadId, now, projectId });
      if (input.createThread !== false) {
        yield* eventSink.write({ events: [created] });
      } else {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* Ref.set(
          createAfterPolicyCapture,
          Effect.gen(function* () {
            // openSession starts after capability capture. The thread is genuinely
            // absent for that capture, then becomes durable for native retirement.
            const absent = yield* projections.getThreadProjection(threadId).pipe(Effect.flip);
            assert.equal(absent._tag, "ProjectionStoreThreadNotFoundError");
            const captured = McpProviderSession.readMcpProviderSession(threadId);
            assert.isDefined(captured);
            assert.isFalse(captured!.capabilities.has("preview"));
            yield* eventSink.write({ events: [created] });
          }).pipe(Effect.orDie),
        );
      }
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      if (input.createThread === false) {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.equal((yield* projections.getThreadProjection(threadId)).thread.id, threadId);
      }
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
          ...(input.createThread === false
            ? {
                beforeOpen: () => Ref.get(createAfterPolicyCapture).pipe(Effect.flatten),
              }
            : {}),
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
export {
  CodexCapabilities,
  ExclusiveCapabilities,
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
  makeProviderSession,
  makeThreadCreatedEvent,
  makeProviderThread,
  makeBrowserAccessProject,
  makeProviderAdapter,
  makeTestLayer,
  TestLegacyImporterLayer,
  runBrowserAccessScenario,
  makePendingRuntimeRequestEvents,
};
export type { TestProviderRuntimeState };
