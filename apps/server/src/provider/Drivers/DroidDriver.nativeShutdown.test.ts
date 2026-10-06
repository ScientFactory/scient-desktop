// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NetAddress from "effect/unstable/net/NetAddress";
import { HttpClient, HttpServer } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "../../orchestration-v2/ProviderContinuationRequests.ts";
import * as ProviderEventIngestor from "../../orchestration-v2/ProviderEventIngestor.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "../Layers/ProviderInstanceRegistryLive.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import { DroidDriver } from "./DroidDriver.ts";

const first = ProviderInstanceId.make("droid-shutdown-target");
const second = ProviderInstanceId.make("droid-shutdown-peer");
const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      params: Schema.optional(Schema.Unknown),
    }),
  ),
);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const sink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(stores, SqlitePersistenceMemory)));
const mcp = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(
    Layer.succeed(HttpServer.HttpServer, {
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
      serve: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("droid-native-shutdown")),
    }),
  ),
  Layer.provide(NodeServices.layer),
);
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "droid-native-shutdown-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ProviderContinuationRequests.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Native shutdown fixture must not contact a vendor")),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(stores, sink, mcp)),
);

const harness = Effect.fn("DroidShutdown.harness")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "droid-shutdown-fixture-" });
  const controls = {
    beforeTargetSpawn: Effect.void,
    beforeTargetFinalize: Effect.void,
    failTargetFinalize: false,
  };
  const launches: Array<{
    instanceId: string;
    environment: Readonly<NodeJS.ProcessEnv>;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];
  const ownedFiles = new Map<ThreadId, string>();
  const nativeScopes = new Map<ThreadId, Scope.Scope>();
  const logs = new Map<ProviderInstanceId, string>();
  const configMap = Object.fromEntries(
    yield* Effect.forEach([first, second], (instanceId) =>
      Effect.gen(function* () {
        const directory = path.join(root, instanceId);
        yield* fs.makeDirectory(directory);
        const binary = path.join(directory, "droid");
        const requestLog = path.join(directory, "requests.ndjson");
        logs.set(instanceId, requestLog);
        // Native children use the real ACP client/decoder. The shell only supplies
        // this synthetic executable's version; no installed Droid or account state.
        yield* fs.writeFileString(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then echo 0.228.0; exit 0; fi',
            `exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)}`,
            "",
          ].join("\n"),
        );
        yield* fs.chmod(binary, 0o755);
        return [
          instanceId,
          {
            // Disable opportunistic discovery in this fixture; explicit native opens remain real.
            driver: DroidDriver.driverKind,
            config: { ...DroidDriver.defaultConfig(), enabled: false, binaryPath: binary },
            environment: [
              { name: "FACTORY_HOME_OVERRIDE", value: directory },
              { name: "FACTORY_API_KEY", value: "" },
              { name: "DROID_SHUTDOWN_INSTANCE", value: instanceId },
              { name: "T3_ACP_REQUEST_LOG_PATH", value: requestLog },
              { name: "T3_ACP_AUTH_METHOD_ID", value: "device-pairing" },
              { name: "T3_ACP_DROID_AUTONOMY", value: "normal" },
              { name: "T3_ACP_DROID_ASYNC_CONFIG_REFRESH", value: "1" },
            ].map((variable) => ({ ...variable, sensitive: false })),
          },
        ] as const;
      }),
    ),
  );
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || !command.args.includes("acp"))
        return yield* spawner.spawn(command);
      const instanceId = command.options.env?.DROID_SHUTDOWN_INSTANCE;
      if (instanceId === first) {
        const gate = controls.beforeTargetSpawn;
        controls.beforeTargetSpawn = Effect.void;
        yield* gate;
      }
      const handle = yield* spawner.spawn(command);
      launches.push({
        instanceId: instanceId ?? "unknown",
        environment: command.options.env ?? {},
        handle,
      });
      return handle;
    }),
  );
  // The actual factory's native request logger runs in the admitted session's
  // scope. A scoped private file and defective finalizer exercise that owner,
  // rather than making a fake stopAll counter decide the callback result.
  const loggers = {
    ...NoOpProviderEventLoggers,
    native: {
      filePath: path.join(root, "native-fixture.ndjson"),
      close: () => Effect.void,
      write: (_event: unknown, threadId: ThreadId | null) =>
        Effect.gen(function* () {
          if (threadId === null || ownedFiles.has(threadId)) return;
          const scope = yield* Effect.serviceOption(Scope.Scope);
          if (Option.isNone(scope))
            return yield* Effect.die("Native request logging must retain the actual session scope");
          nativeScopes.set(threadId, scope.value);
          const privateFile = path.join(root, `${threadId}.private`);
          yield* fs
            .writeFileString(privateFile, "synthetic private native bytes")
            .pipe(Effect.orDie);
          ownedFiles.set(threadId, privateFile);
          yield* Scope.addFinalizer(
            scope.value,
            Effect.gen(function* () {
              if (threadId.startsWith(first)) yield* controls.beforeTargetFinalize;
              yield* fs.remove(privateFile);
              if (threadId.startsWith(first) && controls.failTargetFinalize)
                return yield* Effect.die("owned native fixture teardown failed");
            }).pipe(Effect.orDie),
          );
        }),
    },
  };
  const registered = yield* makeProviderInstanceRegistry({
    drivers: [DroidDriver],
    configMap,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
    Effect.provideService(ProviderEventLoggers, loggers),
  );
  const target = yield* registered.registry.getInstance(first);
  const peer = yield* registered.registry.getInstance(second);
  if (!target || !peer || !target.connectionActions)
    return yield* Effect.die("Actual Droid factory or connection actions missing");
  const readRequests = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const log = logs.get(instanceId)!;
      if (!(yield* fs.exists(log))) return [];
      return (yield* fs.readFileString(log))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => decodeRequest(line));
    });
  const input = (instanceId: ProviderInstanceId, suffix = "initial") => ({
    threadId: ThreadId.make(`${instanceId}:${suffix}`),
    providerSessionId: ProviderSessionId.make(`${instanceId}:${suffix}:native`),
    modelSelection: createModelSelection(instanceId, "default"),
    runtimePolicy: { cwd: root, runtimeMode: "full-access", interactionMode: "default" } as const,
  });
  return {
    ...registered,
    configMap,
    target,
    peer,
    fs,
    root,
    controls,
    launches,
    ownedFiles,
    nativeScopes,
    readRequests,
    input,
  };
});
type Harness = Effect.Success<ReturnType<typeof harness>>;
const assertClosed = Effect.fn("DroidShutdown.assertClosed")(function* (
  h: Harness,
  launches: ReadonlyArray<Harness["launches"][number]> = h.launches.filter(
    (launch) => launch.instanceId === first,
  ),
) {
  for (const launch of launches) expect(yield* launch.handle.isRunning).toBe(false);
  for (const [threadId, file] of h.ownedFiles)
    if (threadId.startsWith(first)) expect(yield* h.fs.exists(file)).toBe(false);
});
const seedThread = Effect.fn("DroidShutdown.seedThread")(function* (
  h: Harness,
  instanceId: ProviderInstanceId,
  suffix = "initial",
) {
  const input = h.input(instanceId, suffix);
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: yield* allocator.allocate.project({ fixtureName: "droid-shutdown" }),
    title: "Native shutdown",
    providerInstanceId: instanceId,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: h.root,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.write({
    events: [
      {
        id: yield* allocator.allocate.event({ threadId: input.threadId }),
        type: "thread.created",
        threadId: input.threadId,
        occurredAt: now,
        payload: appThread,
      },
    ],
  });
  return { input, appThread };
});
const turn = Effect.fn("DroidShutdown.turn")(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  seeded: Effect.Success<ReturnType<typeof seedThread>>,
  ordinal: number,
) {
  const providerThread = yield* runtime.ensureThread(seeded.input);
  if (!runtime.subscribeEvents)
    return yield* Effect.die("Expected the actual manager event subscription");
  const subscription = yield* runtime.subscribeEvents;
  yield* Effect.addFinalizer(() => subscription.close);
  yield* runtime.startTurn({
    ...seeded.input,
    appThread: seeded.appThread,
    providerThread,
    runId: RunId.make(`${seeded.input.threadId}:${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`${seeded.input.threadId}:${ordinal}:attempt`),
    rootNodeId: NodeId.make(`${seeded.input.threadId}:${ordinal}:node`),
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`${seeded.input.threadId}:${ordinal}:message`),
      text: "Prove the native child can answer",
      attachments: [],
    },
  });
  const terminal = yield* subscription.events.pipe(
    Stream.filter(
      (event) =>
        event.type === "provider_turn.updated" &&
        event.providerTurn.ordinal === ordinal &&
        event.providerTurn.status !== "running" &&
        event.providerTurn.status !== "pending",
    ),
    Stream.runHead,
  );
  expect(Option.isSome(terminal)).toBe(true);
  if (Option.isSome(terminal) && terminal.value.type === "provider_turn.updated")
    expect(terminal.value.providerTurn.status).toBe("completed");
  yield* subscription.close;
});
const managerLayer = Effect.fn("DroidShutdown.managerLayer")(function* (h: Harness) {
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const mcp = yield* McpSessionRegistry.McpSessionRegistry;
  const revoked = yield* Deferred.make<void>();
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      setProviderAuthenticationFailure: () =>
        Effect.die("Unexpected fixture authentication mutation"),
    }),
    Layer.succeed(EventSink.EventSinkV2, sink),
    Layer.succeed(ProjectionStore.ProjectionStoreV2, store),
    Layer.succeed(IdAllocator.IdAllocatorV2, allocator),
    Layer.succeed(McpSessionRegistry.McpSessionRegistry, {
      ...mcp,
      revokeProviderSession: (credentialId) =>
        mcp
          .revokeProviderSession(credentialId)
          .pipe(Effect.tap(() => Deferred.succeed(revoked, undefined))),
    }),
    ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
      Layer.provide(Layer.succeed(ProviderInstanceRegistry, h.registry)),
    ),
    ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(EventSink.EventSinkV2, sink),
          Layer.succeed(ProjectionStore.ProjectionStoreV2, store),
          Layer.succeed(IdAllocator.IdAllocatorV2, allocator),
        ),
      ),
    ),
    NodeServices.layer,
  );
  return {
    revoked,
    layer: ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
      Layer.provide(dependencies),
    ),
  };
});
const tokenFor = (threadId: ThreadId) =>
  McpProviderSession.readMcpProviderSession(threadId)!.authorizationHeader.replace(
    /^Bearer\s+/,
    "",
  );

it.layer(testLayer)("Droid factory native shutdown", (it) => {
  it.effect.skipIf(windowsHost)(
    "awaits physical teardown before credentials, releases manager/MCP and keeps peer and fresh native delivery",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const target = yield* seedThread(h, first);
        const peer = yield* seedThread(h, second);
        const configured = yield* managerLayer(h);
        const mcp = yield* McpSessionRegistry.McpSessionRegistry;
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const old = yield* manager.open(target.input);
          const other = yield* manager.open(peer.input);
          const targetToken = tokenFor(target.input.threadId);
          const peerToken = tokenFor(peer.input.threadId);
          for (const seeded of [target, peer]) {
            const bound = McpProviderSession.readMcpProviderSession(seeded.input.threadId)!;
            const created = (yield* h.readRequests(seeded.input.modelSelection.instanceId)).find(
              (request) => request.method === "session/new",
            );
            expect(created?.params).toEqual(
              expect.objectContaining({
                mcpServers: [
                  expect.objectContaining({
                    name: "scient",
                    env: expect.arrayContaining([
                      { name: "T3_ACP_MCP_ENDPOINT", value: bound.endpoint },
                      { name: "T3_ACP_MCP_AUTHORIZATION", value: bound.authorizationHeader },
                    ]),
                  }),
                ],
              }),
            );
          }
          const owned = h.launches.filter((launch) => launch.instanceId === first);
          expect(owned).toHaveLength(1);
          expect(h.ownedFiles.has(target.input.threadId)).toBe(true);
          expect(h.nativeScopes.get(target.input.threadId)?.state._tag).toBe("Open");
          let credentialSpawnObserved = false;
          h.controls.beforeTargetSpawn = Effect.gen(function* () {
            yield* assertClosed(h, owned);
            for (const launch of h.launches.filter((launch) => launch.instanceId === second))
              expect(yield* launch.handle.isRunning).toBe(true);
            expect(yield* mcp.resolve(peerToken)).toBeDefined();
            credentialSpawnObserved = true;
          }).pipe(Effect.orDie);
          yield* h.target.connectionActions!.disconnect.pipe(Effect.scoped);
          expect(credentialSpawnObserved).toBe(true);
          expect((yield* h.readRequests(first)).map((request) => request.method)).toContain(
            "auth/logout",
          );
          yield* Deferred.await(configured.revoked);
          expect(Option.isNone(yield* manager.get(target.input.providerSessionId))).toBe(true);
          expect(yield* mcp.resolve(targetToken)).toBeUndefined();
          expect(Option.isSome(yield* manager.get(peer.input.providerSessionId))).toBe(true);
          expect(yield* mcp.resolve(peerToken)).toBeDefined();
          const before = (yield* h.readRequests(first)).length;
          expect((yield* Effect.result(old.ensureThread(target.input)))._tag).toBe("Failure");
          expect((yield* h.readRequests(first)).length).toBe(before);
          yield* turn(other, peer, 1);
          expect((yield* h.readRequests(second)).map((request) => request.method)).toContain(
            "session/prompt",
          );
          const fresh = yield* seedThread(h, first, "fresh");
          const opened = yield* manager.open(fresh.input);
          yield* turn(opened, fresh, 1);
          expect(opened.instanceId).toBe(first);
          expect(opened.providerSession.cwd).toBe(h.root);
          const freshLaunch = h.launches.findLast((launch) => launch.instanceId === first)!;
          expect(freshLaunch.environment.DROID_SHUTDOWN_INSTANCE).toBe(first);
          expect(freshLaunch.environment.FACTORY_HOME_OVERRIDE).toBe(
            owned[0]!.environment.FACTORY_HOME_OVERRIDE,
          );
          expect(freshLaunch.environment.T3_ACP_REQUEST_LOG_PATH).toBe(
            owned[0]!.environment.T3_ACP_REQUEST_LOG_PATH,
          );
          expect(yield* freshLaunch.handle.isRunning).toBe(true);
          expect(yield* mcp.resolve(tokenFor(fresh.input.threadId))).toBeDefined();
          expect(
            (yield* h.readRequests(first)).filter((request) => request.method === "session/prompt"),
          ).toHaveLength(1);
          expect(yield* h.registry.getInstance(first)).toBe(h.target);
        }).pipe(Effect.provide(configured.layer), Effect.scoped);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.effect.skipIf(windowsHost)(
    "interrupts registered startup without a late child or MCP reservation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const target = yield* seedThread(h, first);
        const configured = yield* managerLayer(h);
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        h.controls.beforeTargetSpawn = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        );
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const opening = yield* manager.open(target.input).pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(entered);
          const token = tokenFor(target.input.threadId);
          const mcp = yield* McpSessionRegistry.McpSessionRegistry;
          expect(yield* mcp.resolve(token)).toBeDefined();
          yield* h.target.connectionActions!.disconnect.pipe(Effect.scoped);
          yield* Deferred.succeed(gate, undefined);
          expect(Exit.isFailure(yield* Fiber.join(opening))).toBe(true);
          yield* Deferred.await(configured.revoked);
          expect(yield* mcp.resolve(token)).toBeUndefined();
          expect(Option.isNone(yield* manager.get(target.input.providerSessionId))).toBe(true);
          // Only the credential-operation child launched; the cancelled opener cannot escape.
          expect(h.launches.filter((launch) => launch.instanceId === first)).toHaveLength(1);
          expect((yield* h.readRequests(first)).map((request) => request.method)).not.toContain(
            "session/new",
          );
        }).pipe(Effect.provide(configured.layer), Effect.scoped);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.effect.skipIf(windowsHost)(
    "refuses competing opens while finalizers run and fences an old direct runtime",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const input = h.input(first);
        const old = yield* h.target.orchestrationAdapter.openSession(input);
        const events = yield* old.events.pipe(Stream.runDrain, Effect.forkChild);
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        h.controls.beforeTargetFinalize = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        );
        const closing = yield* h.target.connectionActions!.disconnect.pipe(
          Effect.scoped,
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        expect(
          (yield* Effect.result(
            h.target.orchestrationAdapter.openSession(h.input(first, "racing")),
          ))._tag,
        ).toBe("Failure");
        const before = (yield* h.readRequests(first)).length;
        expect((yield* Effect.result(old.ensureThread(input)))._tag).toBe("Failure");
        expect((yield* h.readRequests(first)).length).toBe(before);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(closing);
        yield* Fiber.join(events);
        yield* assertClosed(h);
        const fresh = yield* h.target.orchestrationAdapter.openSession(h.input(first, "fresh"));
        expect(fresh.instanceId).toBe(first);
        expect(fresh.providerSession.cwd).toBe(h.root);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.effect.skipIf(windowsHost)(
    "caller cancellation waits for admitted teardown and does not mutate credentials",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.target.orchestrationAdapter.openSession(h.input(first));
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        h.controls.beforeTargetFinalize = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        );
        const closing = yield* h.target.connectionActions!.disconnect.pipe(
          Effect.scoped,
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        const cancellationRequested = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.succeed(cancellationRequested, undefined).pipe(
          Effect.andThen(Fiber.interrupt(closing)),
          Effect.forkChild,
        );
        yield* Deferred.await(cancellationRequested);
        expect(
          (yield* Effect.result(
            h.target.orchestrationAdapter.openSession(h.input(first, "while-cancelled")),
          ))._tag,
        ).toBe("Failure");
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(cancelled);
        const exit = yield* Fiber.await(closing);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        yield* assertClosed(h);
        expect((yield* h.readRequests(first)).map((request) => request.method)).not.toContain(
          "auth/logout",
        );
        expect(h.launches.filter((launch) => launch.instanceId === first)).toHaveLength(1);
        const fresh = yield* h.target.orchestrationAdapter.openSession(
          h.input(first, "after-cancel"),
        );
        expect(fresh.instanceId).toBe(first);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.effect.skipIf(windowsHost)(
    "retains teardown failure, refuses credentials and new opens, and preserves peer/catalog",
    () => {
      let assertionsCompleted = false;
      return Effect.gen(function* () {
        const h = yield* harness();
        yield* h.target.orchestrationAdapter.openSession(h.input(first));
        yield* h.target.orchestrationAdapter.openSession(h.input(first, "sibling"));
        const peer = yield* h.peer.orchestrationAdapter.openSession(h.input(second));
        h.controls.failTargetFinalize = true;
        const before = h.launches.length;
        const firstClose = yield* Effect.result(
          h.target.connectionActions!.disconnect.pipe(Effect.scoped),
        );
        expect(firstClose._tag).toBe("Failure");
        if (firstClose._tag === "Failure")
          expect(firstClose.failure.message).toContain("stop active Droid sessions");
        yield* assertClosed(h);
        expect(h.launches).toHaveLength(before);
        expect(
          (yield* Effect.result(h.target.connectionActions!.disconnect.pipe(Effect.scoped)))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.result(
            h.target.orchestrationAdapter.openSession(h.input(first, "refused")),
          ))._tag,
        ).toBe("Failure");
        expect(h.launches).toHaveLength(before);
        expect((yield* h.readRequests(first)).map((request) => request.method)).not.toContain(
          "auth/logout",
        );
        expect(yield* h.registry.getInstance(first)).toBe(h.target);
        expect(yield* h.registry.getInstance(second)).toBe(h.peer);
        yield* peer.ensureThread(h.input(second));
        for (const launch of h.launches.filter((launch) => launch.instanceId === second))
          expect(yield* launch.handle.isRunning).toBe(true);
        // Failed teardown is sticky: no retry may treat Scope.close's no-op as cleanup.
        // Registry retirement is separately responsible for the permanent instance.
        assertionsCompleted = true;
      }).pipe(
        Effect.scoped,
        Effect.exit,
        Effect.map((exit) => {
          expect(assertionsCompleted).toBe(true);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.pretty(exit.cause)).toContain("owned native fixture teardown failed");
        }),
      );
    },
    20_000,
  );
  it.effect.skipIf(windowsHost)(
    "refuses native opening after caller or configured instance retirement",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const caller = yield* Scope.make();
        yield* Scope.close(caller, Exit.void);
        const initialCount = h.launches.length;
        expect(
          (yield* Effect.result(
            h.target.orchestrationAdapter
              .openSession(h.input(first, "closed-caller"))
              .pipe(Effect.provideService(Scope.Scope, caller)),
          ))._tag,
        ).toBe("Failure");
        expect(h.launches).toHaveLength(initialCount);
        const old = yield* h.target.orchestrationAdapter.openSession(h.input(first));
        const peer = yield* h.peer.orchestrationAdapter.openSession(h.input(second));
        yield* h.mutator.reconcile({ [second]: h.configMap[second]! });
        yield* assertClosed(h);
        const before = h.launches.length;
        expect(
          (yield* Effect.result(
            h.target.orchestrationAdapter.openSession(h.input(first, "closed-instance")),
          ))._tag,
        ).toBe("Failure");
        expect((yield* Effect.result(old.ensureThread(h.input(first))))._tag).toBe("Failure");
        expect(
          (yield* Effect.result(h.target.connectionActions!.disconnect.pipe(Effect.scoped)))._tag,
        ).toBe("Failure");
        expect(h.launches).toHaveLength(before);
        expect((yield* h.readRequests(first)).map((request) => request.method)).not.toContain(
          "auth/logout",
        );
        expect(yield* h.registry.getInstance(first)).toBeUndefined();
        expect(peer.instanceId).toBe(second);
        expect(yield* h.registry.getInstance(second)).toBe(h.peer);
        yield* peer.ensureThread(h.input(second));
        for (const launch of h.launches.filter((launch) => launch.instanceId === second))
          expect(yield* launch.handle.isRunning).toBe(true);
      }).pipe(Effect.scoped),
    20_000,
  );
});
