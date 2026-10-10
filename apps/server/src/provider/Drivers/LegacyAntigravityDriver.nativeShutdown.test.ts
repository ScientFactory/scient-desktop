import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as NetAddress from "effect/net/NetAddress";
import { HttpClient, HttpServer } from "effect/http";
import { PtyAdapter, PtySpawnError, type PtyExitEvent } from "@t3tools/shared/PtyAdapter";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ModelManifest from "../ModelManifest.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventIngestor from "../../orchestration-v2/ProviderEventIngestor.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeProviderInstanceRegistry } from "../ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistry } from "../ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../ProviderRegistry.ts";
import { LegacyAntigravityDriver } from "./LegacyAntigravityDriver.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { layerConfigConsistentTestProviderHost } from "../testUtils/providerHost.ts";

const first = ProviderInstanceId.make("legacy-agy-shutdown-target");
const second = ProviderInstanceId.make("legacy-agy-shutdown-peer");
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/agy-stream-mock.ts",
);
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      event: Schema.Literal("user"),
      message: Schema.Struct({ content: Schema.String }),
    }),
  ),
);
const encodeSourceString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const encodeIdleEvidence = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
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
      getEnvironmentId: Effect.succeed(EnvironmentId.make("legacy-agy-native-shutdown")),
    }),
  ),
  Layer.provide(NodeServices.layer),
);
const providerDependenciesLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "legacy-agy-native-shutdown-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ThreadCommandExecutor.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ProviderContinuationRequests.layer),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(McpProviderSessions.layer),
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
const testLayer = layerConfigConsistentTestProviderHost.pipe(
  Layer.provideMerge(providerDependenciesLayer),
);

const harness = Effect.fn("LegacyShutdown.harness")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-shutdown-fixture-" });
  const controls = {
    beforeTargetSpawn: Effect.void,
    beforeTargetFinalize: Effect.void,
    beforeCredential: Effect.void,
    failTargetFinalize: false,
  };
  const staging: Array<{
    directory: string;
    scope: Scope.Scope;
    instanceId?: string;
    finalizerRuns: number;
  }> = [];
  const launches: Array<{
    instanceId: string;
    environment: Readonly<NodeJS.ProcessEnv>;
    args: ReadonlyArray<string>;
    cwd: string | undefined;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];
  const credentialLaunches: Array<{
    instanceId: string;
    args: ReadonlyArray<string>;
    home: string;
  }> = [];
  const homes = new Map<ProviderInstanceId, string>();
  const accounts = new Map<ProviderInstanceId, string>();
  const logs = new Map<ProviderInstanceId, string>();
  const configMap = Object.fromEntries(
    yield* Effect.forEach([first, second], (instanceId) =>
      Effect.gen(function* () {
        const directory = path.join(root, instanceId);
        homes.set(instanceId, directory);
        const account = path.join(
          directory,
          ".gemini",
          "antigravity-cli",
          "antigravity-oauth-token",
        );
        accounts.set(instanceId, account);
        yield* fs.makeDirectory(path.dirname(account), { recursive: true });
        yield* fs.writeFileString(account, "synthetic account marker; no credential");
        const requestLog = path.join(directory, "requests.ndjson");
        logs.set(instanceId, requestLog);
        const agentPath = path.join(directory, "agy-native-mock.ts");
        const encodedLog = yield* encodeSourceString(requestLog);
        const agentSource = (yield* fs.readFileString(mockAgentPath))
          .replace(
            'import * as NodeReadline from "node:readline";',
            'import * as NodeReadline from "node:readline";\nimport * as NodeFS from "node:fs";',
          )
          .replace(
            'lines.on("line", (line) => {',
            `lines.on("line", (line) => {\n  NodeFS.appendFileSync(${encodedLog}, line + "\\n");`,
          );
        expect(agentSource).toContain(`NodeFS.appendFileSync(${encodedLog}`);
        yield* fs.writeFileString(agentPath, agentSource);
        const binary = path.join(directory, "agy");
        yield* fs.writeFileString(
          binary,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then echo 0.0.0; exit 0; fi',
            'if [ "$1" = "-p" ] && [ "$2" = "/skills" ]; then',
            `  echo '{ "command": { "name": "skills", "data": { "skills": [] } } }'; exit 0`,
            "fi",
            'if [ "$1" = "models" ]; then',
            '  if [ -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ]; then echo gemini-3.7-flash; exit 0; fi',
            "  exit 1",
            "fi",
            'if [ "$1" = "--prompt-interactive" ] && [ "$2" = "/logout" ]; then',
            '  /bin/rm "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"',
            "  echo Signed out; exit 0",
            "fi",
            `exec ${shellQuote(process.execPath)} ${shellQuote(agentPath)} "$@"`,
            "",
          ].join("\n"),
        );
        yield* fs.chmod(binary, 0o755);
        return [
          instanceId,
          {
            driver: LegacyAntigravityDriver.driverKind,
            // Explicit native opens use only the configured private executable.
            config: {
              ...LegacyAntigravityDriver.defaultConfig(),
              enabled: false,
              binaryPath: binary,
            },
            environment: [
              { name: "HOME", value: directory },
              { name: "USERPROFILE", value: directory },
              { name: "GEMINI_API_KEY", value: "synthetic-must-be-filtered" },
              { name: "GOOGLE_API_KEY", value: "synthetic-must-be-filtered" },
            ].map((variable) => ({ ...variable, sensitive: false })),
          },
        ] as const;
      }),
    ),
  );
  // Observe the actual native staging scope. Its real filesystem finalizer
  // still removes the directory; the controlled sibling defect tests close truth.
  const observedFs = FileSystem.FileSystem.of({
    ...fs,
    makeTempDirectoryScoped: (options) =>
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped(options);
        if (options?.prefix !== "scient-antigravity-attachments-") return directory;
        const scope = yield* Effect.scope;
        const owned = {
          directory,
          scope,
          instanceId: "",
          finalizerRuns: 0,
        };
        staging.push(owned);
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            owned.finalizerRuns++;
            if (
              owned.instanceId === first &&
              owned === staging.find((item) => item.instanceId === first)
            )
              yield* controls.beforeTargetFinalize;
            if (
              owned.instanceId === first &&
              controls.failTargetFinalize &&
              owned === staging.find((item) => item.instanceId === first)
            )
              return yield* Effect.die("owned legacy native staging teardown failed");
          }),
        );
        return directory;
      }),
  });
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected fixture pipeline");
      const home = command.options.env?.HOME;
      const instanceId = path.basename(home ?? "");
      if (
        !home ||
        ![first, second].some((id) => id === instanceId) ||
        command.command !== path.join(home, "agy")
      )
        return yield* Effect.die(
          `Only this fixture's configured agy may spawn; received ${command.command} with HOME=${home ?? "<unset>"}`,
        );
      if (!command.args.includes("stream-json")) return yield* spawner.spawn(command);
      const scope = yield* Effect.scope;
      const owned = staging.findLast((item) => item.scope === scope);
      if (!owned) return yield* Effect.die("Actual native private staging scope missing");
      owned.instanceId = instanceId;
      if (instanceId === first) {
        const gate = controls.beforeTargetSpawn;
        controls.beforeTargetSpawn = Effect.void;
        yield* gate;
      }
      const handle = yield* spawner.spawn(command);
      launches.push({
        instanceId,
        environment: command.options.env ?? {},
        args: command.args,
        cwd: command.options.cwd,
        handle,
      });
      return handle;
    }),
  );
  // The PTY service boundary runs a real scoped /logout subprocess, without
  // claiming terminal geometry or installed node-pty compatibility. Native agy
  // sessions use the production spawner and stream decoder independently.
  const pty = PtyAdapter.of({
    spawn: Effect.fn("LegacyShutdown.ptySpawn")(function* (input) {
      const home = input.env.HOME;
      const instanceId = path.basename(home ?? "");
      if (
        !home ||
        ![first, second].some((id) => id === instanceId) ||
        input.shell !== path.join(home, "agy") ||
        input.args?.join(" ") !== "--prompt-interactive /logout"
      )
        return yield* Effect.die("Only the synthetic /logout subprocess is authorized");
      const callerScope = yield* Effect.serviceOption(Scope.Scope);
      if (Option.isNone(callerScope))
        return yield* Effect.die("Synthetic logout must retain its caller-owned scope");
      if (instanceId === first) yield* controls.beforeCredential;
      const child = yield* Effect.try({
        try: () =>
          NodeChildProcess.spawn(input.shell, input.args!, {
            cwd: input.cwd,
            env: input.env,
            stdio: "pipe",
          }),
        catch: (cause) =>
          new PtySpawnError({ adapter: "synthetic-local-subprocess", shell: input.shell, cause }),
      });
      const exited = yield* Deferred.make<void>();
      let exitEvent: PtyExitEvent | undefined;
      const listeners = new Set<(event: PtyExitEvent) => void>();
      const onExit = (code: number | null) => {
        exitEvent = { exitCode: code ?? -1, signal: null };
        Deferred.doneUnsafe(exited, Effect.void);
        for (const listener of listeners) listener(exitEvent);
      };
      const onError = (cause: Error) => Deferred.doneUnsafe(exited, Effect.die(cause));
      child.once("exit", onExit);
      child.once("error", onError);
      yield* Scope.addFinalizer(
        callerScope.value,
        Effect.gen(function* () {
          if (!exitEvent) yield* Effect.sync(() => child.kill());
          yield* Deferred.await(exited);
          child.off("exit", onExit);
          child.off("error", onError);
          listeners.clear();
        }),
      );
      if (child.pid === undefined)
        return yield* new PtySpawnError({
          adapter: "synthetic-local-subprocess",
          shell: input.shell,
        });
      credentialLaunches.push({ instanceId, args: input.args!, home });
      return {
        pid: child.pid,
        write: (data) => {
          child.stdin.write(data);
        },
        resize: () => {
          throw new Error("Fixture does not implement terminal geometry");
        },
        kill: () => {
          child.kill();
        },
        onData: (callback) => {
          const onData = (data: Buffer) => callback(data.toString());
          child.stdout.on("data", onData);
          return () => {
            child.stdout.off("data", onData);
          };
        },
        onExit: (callback) => {
          if (exitEvent) callback(exitEvent);
          else listeners.add(callback);
          return () => {
            listeners.delete(callback);
          };
        },
      };
    }),
  });
  const registered = yield* makeProviderInstanceRegistry({
    drivers: [LegacyAntigravityDriver],
    configMap,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
    Effect.provideService(FileSystem.FileSystem, observedFs),
    Effect.provideService(PtyAdapter, pty),
    Effect.provideService(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  );
  const target = yield* registered.registry.getInstance(first);
  const peer = yield* registered.registry.getInstance(second);
  if (!target || !peer || !target.connectionActions)
    return yield* Effect.die("Actual legacy factory missing");
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
    modelSelection: {
      instanceId,
      model: "mock-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimePolicy: { cwd: root, runtimeMode: "full-access", interactionMode: "default" } as const,
  });
  // Each direct consumer has a session caller scope, as the real manager does.
  // Raw native shutdown must never try to retire the surrounding test/factory.
  const open = Effect.fn("LegacyShutdown.openCaller")(function* (
    instanceId: ProviderInstanceId,
    suffix = "initial",
  ) {
    const caller = yield* Scope.fork(yield* Scope.Scope);
    const instance = instanceId === first ? target : peer;
    return yield* instance.orchestrationAdapter
      .openSession(input(instanceId, suffix))
      .pipe(Effect.provideService(Scope.Scope, caller));
  });
  return {
    ...registered,
    configMap,
    target,
    peer,
    fs,
    path,
    root,
    controls,
    launches,
    credentialLaunches,
    staging,
    homes,
    accounts,
    readRequests,
    input,
    open,
  };
});
type Harness = Effect.Success<ReturnType<typeof harness>>;
const assertClosed = Effect.fn("LegacyShutdown.assertClosed")(function* (h: Harness) {
  for (const launch of h.launches.filter((item) => item.instanceId === first))
    expect(yield* launch.handle.isRunning).toBe(false);
  for (const owned of h.staging.filter((item) => item.instanceId === first))
    expect(yield* h.fs.exists(owned.directory)).toBe(false);
});
const seedThread = Effect.fn("LegacyShutdown.seedThread")(function* (
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
    projectId: yield* allocator.allocate.project({ fixtureName: "legacy-shutdown" }),
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
const turnInput = (
  seeded: Effect.Success<ReturnType<typeof seedThread>>,
  providerThread: OrchestrationV2ProviderThread,
  ordinal: number,
  attachments: ReadonlyArray<ChatAttachment> = [],
) => {
  return {
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
      attachments,
    },
  } as const;
};
const turn = Effect.fn("LegacyShutdown.turn")(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  seeded: Effect.Success<ReturnType<typeof seedThread>>,
  ordinal: number,
  attachments: ReadonlyArray<ChatAttachment> = [],
) {
  const providerThread = yield* runtime.ensureThread(seeded.input);
  if (!runtime.subscribeEvents)
    return yield* Effect.die("Expected the actual manager event subscription");
  const subscription = yield* runtime.subscribeEvents;
  yield* Effect.addFinalizer(() => subscription.close);
  yield* runtime.startTurn(turnInput(seeded, providerThread, ordinal, attachments));
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
const managerLayer = Effect.fn("LegacyShutdown.managerLayer")(function* (h: Harness) {
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const mcp = yield* McpSessionRegistry.McpSessionRegistry;
  const released = yield* Deferred.make<void>();
  const observations = {
    isReleased: (_providerSessionId: ProviderSessionId) => Effect.succeed(false),
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      setProviderAuthenticationFailure: () =>
        Effect.die("Unexpected fixture authentication mutation"),
    }),
    Layer.succeed(EventSink.EventSinkV2, {
      ...sink,
      write: (input) =>
        sink.write(input).pipe(
          Effect.tap(() =>
            Effect.forEach(
              input.events,
              (event) => {
                if (
                  event.type !== "provider-session.updated" ||
                  !["error", "stopped"].includes(event.payload.status) ||
                  !event.threadId.startsWith(first)
                )
                  return Effect.void;
                // A native stopped update can precede manager release. Require
                // the manager's actual removal and its persisted terminal receipt.
                return observations
                  .isReleased(event.payload.id)
                  .pipe(
                    Effect.flatMap((removed) =>
                      removed ? Deferred.succeed(released, undefined) : Effect.void,
                    ),
                  );
              },
              { discard: true },
            ),
          ),
        ),
    }),
    Layer.succeed(ProjectionStore.ProjectionStoreV2, store),
    Layer.succeed(IdAllocator.IdAllocatorV2, allocator),
    Layer.succeed(McpSessionRegistry.McpSessionRegistry, mcp),
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
    released,
    observations,
    layer: ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
      Layer.provide(dependencies),
    ),
  };
});
it.layer(testLayer, { excludeTestServices: true })("Legacy factory native shutdown", (it) => {
  it.effect.skipIf(windowsHost)(
    "closes native processes and private copies before logout while peer and fresh configured delivery survive",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const target = yield* seedThread(h, first);
        const peer = yield* seedThread(h, second);
        const configured = yield* managerLayer(h);
        const config = yield* ServerConfig;
        const id = "thread-123e4567-e89b-12d3-a456-426614174000";
        yield* h.fs.makeDirectory(config.attachmentsDir, { recursive: true });
        const source = h.path.join(config.attachmentsDir, `${id}.png`);
        yield* h.fs.writeFileString(source, "synthetic native image bytes");
        const attachment = {
          type: "image",
          id,
          name: "result.png",
          mimeType: "image/png",
          sizeBytes: 28,
        } as const;
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          configured.observations.isReleased = (id) =>
            manager.get(id).pipe(Effect.map(Option.isNone), Effect.orDie);
          const old = yield* manager.open(target.input);
          const other = yield* manager.open(peer.input);
          expect(old.mcpSessionInjection).toBe(false);
          expect(other.mcpSessionInjection).toBe(false);
          expect(yield* sessions.read(target.input.threadId)).toBeUndefined();
          expect(yield* sessions.read(peer.input.threadId)).toBeUndefined();
          yield* turn(old, target, 1, [attachment]);
          yield* turn(other, peer, 1, [attachment]);
          const oldThread = yield* old.ensureThread(target.input);
          const stagedFor = (requests: Effect.Success<ReturnType<typeof h.readRequests>>) =>
            requests.at(-1)?.message.content.match(/available at: ([^\]]+)\]/u)?.[1];
          const targetCopy = stagedFor(yield* h.readRequests(first));
          const peerCopy = stagedFor(yield* h.readRequests(second));
          if (!targetCopy || !peerCopy)
            return yield* Effect.die("Actual native attachment offers missing");
          for (const copy of [targetCopy, peerCopy]) {
            expect(copy).not.toBe(source);
            expect(yield* h.fs.readFileString(copy)).toBe("synthetic native image bytes");
            expect((yield* h.fs.stat(copy)).mode & 0o777).toBe(0o600);
            expect((yield* h.fs.stat(h.path.dirname(copy))).mode & 0o777).toBe(0o700);
          }
          const owned = h.launches.find((launch) => launch.instanceId === first)!;
          expect(yield* owned.handle.isRunning).toBe(true);
          expect(owned.args).toEqual(
            expect.arrayContaining([
              "--input-format",
              "stream-json",
              "--output-format",
              "--model",
              "mock-model",
              "--effort",
              "high",
              "--dangerously-skip-permissions",
              "--add-dir",
              h.root,
            ]),
          );
          expect(owned.environment.HOME).toBe(h.homes.get(first));
          expect(owned.environment.GEMINI_API_KEY).toBeUndefined();
          expect(owned.environment.GOOGLE_API_KEY).toBeUndefined();
          expect(owned.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
          let physicalCloseObserved = false;
          h.controls.beforeCredential = Effect.gen(function* () {
            yield* assertClosed(h);
            expect(yield* h.fs.exists(h.accounts.get(first)!)).toBe(true);
            expect(yield* h.fs.exists(targetCopy)).toBe(false);
            expect(yield* h.fs.readFileString(peerCopy)).toBe("synthetic native image bytes");
            for (const launch of h.launches.filter((item) => item.instanceId === second))
              expect(yield* launch.handle.isRunning).toBe(true);
            physicalCloseObserved = true;
          }).pipe(Effect.orDie);
          yield* h.target.connectionActions!.disconnect.pipe(Effect.scoped);
          expect(physicalCloseObserved).toBe(true);
          expect(h.credentialLaunches).toEqual([
            {
              instanceId: first,
              args: ["--prompt-interactive", "/logout"],
              home: h.homes.get(first),
            },
          ]);
          expect(yield* h.fs.exists(h.accounts.get(first)!)).toBe(false);
          expect(yield* h.fs.exists(h.accounts.get(second)!)).toBe(true);
          expect(yield* h.fs.readFileString(source)).toBe("synthetic native image bytes");
          yield* Deferred.await(configured.released);
          expect(Option.isNone(yield* manager.get(target.input.providerSessionId))).toBe(true);
          expect(Option.isSome(yield* manager.get(peer.input.providerSessionId))).toBe(true);
          const before = (yield* h.readRequests(first)).length;
          expect((yield* Effect.result(old.startTurn(turnInput(target, oldThread, 2))))._tag).toBe(
            "Failure",
          );
          expect((yield* h.readRequests(first)).length).toBe(before);
          yield* turn(other, peer, 2);
          yield* h.fs.writeFileString(h.accounts.get(first)!, "synthetic reconnected account");
          const fresh = yield* seedThread(h, first, "fresh");
          const opened = yield* manager.open(fresh.input);
          yield* turn(opened, fresh, 1, [attachment]);
          expect(opened.instanceId).toBe(first);
          expect(opened.providerSession.cwd).toBe(h.root);
          const replacement = h.launches.findLast((item) => item.instanceId === first)!;
          expect(replacement).not.toBe(owned);
          expect(replacement.environment.HOME).toBe(owned.environment.HOME);
          expect(replacement.args).toEqual(
            expect.arrayContaining(["--model", "mock-model", "--effort", "high"]),
          );
          expect(yield* replacement.handle.isRunning).toBe(true);
          expect(yield* h.registry.getInstance(first)).toBe(h.target);
          expect(yield* h.registry.getInstance(second)).toBe(h.peer);
        }).pipe(Effect.provide(configured.layer), Effect.scoped);
      }).pipe(Effect.scoped),
    20_000,
  );
  it.effect.skipIf(windowsHost)(
    "cancels registered pending opening and its staging without a late native process or offer",
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
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          const opening = yield* manager.open(target.input).pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(entered);
          expect(h.staging.filter((item) => item.instanceId === first)).toHaveLength(1);
          expect(h.launches).toHaveLength(0);
          expect(yield* sessions.read(target.input.threadId)).toBeUndefined();
          yield* h.target.connectionActions!.disconnect.pipe(Effect.scoped);
          yield* Deferred.succeed(gate, undefined);
          expect(Exit.isFailure(yield* Fiber.join(opening))).toBe(true);
          yield* assertClosed(h);
          expect(h.launches).toHaveLength(0);
          expect(yield* h.readRequests(first)).toEqual([]);
          expect(Option.isNone(yield* manager.get(target.input.providerSessionId))).toBe(true);
          expect(yield* sessions.read(target.input.threadId)).toBeUndefined();
          expect(yield* h.fs.exists(h.accounts.get(first)!)).toBe(false);
        }).pipe(Effect.provide(configured.layer), Effect.scoped);
      }).pipe(Effect.scoped),
    20_000,
  );
  it.effect.skipIf(windowsHost)(
    "makes racing closes wait for one physical teardown and refuses competing opens and old offers",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const old = yield* h.open(first);
        const events = yield* old.events.pipe(Stream.runDrain, Effect.forkChild);
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        h.controls.beforeTargetFinalize = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        );
        h.controls.beforeCredential = assertClosed(h).pipe(Effect.orDie);
        const closing = yield* h.target.connectionActions!.disconnect.pipe(
          Effect.scoped,
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        const secondStarted = yield* Deferred.make<void>();
        const racing = yield* Deferred.succeed(secondStarted, undefined).pipe(
          Effect.andThen(h.target.connectionActions!.disconnect.pipe(Effect.scoped)),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(secondStarted);
        expect((yield* Effect.result(h.open(first, "racing")))._tag).toBe("Failure");
        expect((yield* Effect.result(old.ensureThread(h.input(first))))._tag).toBe("Failure");
        expect(closing.pollUnsafe()).toBeUndefined();
        expect(racing.pollUnsafe()).toBeUndefined();
        expect(h.launches).toHaveLength(1);
        expect(h.credentialLaunches).toHaveLength(0);
        expect(yield* h.fs.exists(h.accounts.get(first)!)).toBe(true);
        yield* Deferred.succeed(gate, undefined);
        expect((yield* Fiber.join(closing))._tag).toBe("Success");
        expect((yield* Fiber.join(racing))._tag).toBe("Success");
        yield* Fiber.join(events);
        yield* assertClosed(h);
        expect(h.staging[0]!.finalizerRuns).toBe(1);
        const fresh = yield* h.open(first, "fresh");
        expect(fresh.instanceId).toBe(first);
        expect(yield* h.launches.at(-1)!.handle.isRunning).toBe(true);
      }).pipe(Effect.scoped),
    20_000,
  );
  it.effect.skipIf(windowsHost)(
    "caller interruption waits for admitted native cleanup and leaves the synthetic account intact",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.open(first);
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
        const interruptRequested = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.succeed(interruptRequested, undefined).pipe(
          Effect.andThen(Fiber.interrupt(closing)),
          Effect.forkChild,
        );
        yield* Deferred.await(interruptRequested);
        expect((yield* Effect.result(h.open(first, "cancelled-race")))._tag).toBe("Failure");
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(interrupted);
        const exit = yield* Fiber.await(closing);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        yield* assertClosed(h);
        expect(h.credentialLaunches).toHaveLength(0);
        expect(yield* h.fs.exists(h.accounts.get(first)!)).toBe(true);
        const fresh = yield* h.open(first, "after-cancel");
        expect(fresh.instanceId).toBe(first);
      }).pipe(Effect.scoped),
    20_000,
  );
  it.effect.skipIf(windowsHost)(
    "closes every native sibling after a finalizer defect and retains repeat-close failure while peer delivery survives",
    () => {
      let assertionsCompleted = false;
      return Effect.gen(function* () {
        const h = yield* harness();
        const target = yield* h.open(first);
        yield* h.open(first, "sibling");
        const peer = yield* seedThread(h, second);
        const configured = yield* managerLayer(h);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const other = yield* manager.open(peer.input);
          yield* turn(other, peer, 1);
          h.controls.failTargetFinalize = true;
          const before = h.launches.length;
          const closed = yield* Effect.result(
            h.target.connectionActions!.disconnect.pipe(Effect.scoped),
          );
          expect(closed._tag).toBe("Failure");
          if (closed._tag === "Failure")
            expect(closed.failure.message).toContain("stop active Antigravity sessions");
          yield* assertClosed(h);
          expect(h.staging.filter((item) => item.instanceId === first)).toHaveLength(2);
          expect(
            h.staging.filter((item) => item.instanceId === first).map((item) => item.finalizerRuns),
          ).toEqual([1, 1]);
          // Clearing the defect cannot turn a failed one-shot close into success.
          h.controls.failTargetFinalize = false;
          expect(
            (yield* Effect.result(h.target.connectionActions!.disconnect.pipe(Effect.scoped)))._tag,
          ).toBe("Failure");
          expect((yield* Effect.result(h.open(first, "refused")))._tag).toBe("Failure");
          expect((yield* Effect.result(target.ensureThread(h.input(first))))._tag).toBe("Failure");
          expect(h.launches).toHaveLength(before);
          expect(h.credentialLaunches).toHaveLength(0);
          expect(yield* h.fs.exists(h.accounts.get(first)!)).toBe(true);
          expect(yield* h.fs.exists(h.accounts.get(second)!)).toBe(true);
          yield* turn(other, peer, 2);
          expect(yield* h.registry.getInstance(first)).toBe(h.target);
          expect(yield* h.registry.getInstance(second)).toBe(h.peer);
          assertionsCompleted = true;
        }).pipe(Effect.provide(configured.layer), Effect.scoped);
      }).pipe(
        Effect.scoped,
        Effect.exit,
        Effect.map((exit) => {
          expect(assertionsCompleted).toBe(true);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.pretty(exit.cause)).toContain(
              "owned legacy native staging teardown failed",
            );
        }),
      );
    },
    20_000,
  );
  it.effect.skipIf(windowsHost)(
    "refuses closed callers and retired configured factories without closing a peer or changing account state",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const caller = yield* Scope.make();
        yield* Scope.close(caller, Exit.void);
        expect(
          (yield* Effect.result(
            h.target.orchestrationAdapter
              .openSession(h.input(first, "closed-caller"))
              .pipe(Effect.provideService(Scope.Scope, caller)),
          ))._tag,
        ).toBe("Failure");
        expect(h.launches).toHaveLength(0);
        const old = yield* h.open(first);
        const peer = yield* h.open(second);
        yield* h.mutator.reconcile({ [second]: h.configMap[second]! });
        yield* assertClosed(h);
        const before = h.launches.length;
        expect((yield* Effect.result(old.ensureThread(h.input(first))))._tag).toBe("Failure");
        expect((yield* Effect.result(h.open(first, "closed-factory")))._tag).toBe("Failure");
        expect(
          (yield* Effect.result(h.target.connectionActions!.disconnect.pipe(Effect.scoped)))._tag,
        ).toBe("Failure");
        expect(h.launches).toHaveLength(before);
        expect(h.credentialLaunches).toHaveLength(0);
        expect(yield* h.fs.exists(h.accounts.get(first)!)).toBe(true);
        expect(yield* h.registry.getInstance(first)).toBeUndefined();
        expect(yield* h.registry.getInstance(second)).toBe(h.peer);
        yield* peer.ensureThread(h.input(second));
        for (const launch of h.launches.filter((item) => item.instanceId === second))
          expect(yield* launch.handle.isRunning).toBe(true);
      }).pipe(Effect.scoped),
    20_000,
  );
  it.effect.skipIf(windowsHost)(
    "ordinary next send recovers an idle native death with the observed conversation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.mutator.reconcile({
          ...h.configMap,
          [first]: {
            ...h.configMap[first]!,
            config: { ...h.configMap[first]!.config, enabled: true },
          },
        });
        const config = yield* ServerConfig;
        const cwd = yield* checkpointWorkspace("legacy-idle-recovery");
        const threadId = ThreadId.make("legacy-agy-idle-recovery");
        const modelSelection = h.input(first).modelSelection;
        const layer = makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "legacy-idle-recovery", runtimePolicyOverride: { cwd } },
          ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
            Layer.provide(Layer.succeed(ProviderInstanceRegistry, h.registry)),
          ),
          {
            layerDatabase: SqlitePersistenceMemory,
            configureMcp: false,
            layerServerConfig: Layer.succeed(ServerConfig, config),
          },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const waitFor = (predicate: (p: OrchestrationV2ThreadProjection) => boolean) =>
            Effect.scoped(
              Effect.gen(function* () {
                const cursor = yield* orchestrator.getThreadEventSequence(threadId);
                const pull = yield* Stream.toPull(
                  orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
                );
                const initial = yield* orchestrator.getThreadProjection(threadId);
                const result = yield* Stream.concat(
                  Stream.succeed(initial),
                  Stream.fromPull(Effect.succeed(pull)).pipe(
                    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
                  ),
                ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("20 seconds"));
                return Option.getOrThrow(result);
              }),
            );
          const send = (ordinal: number, text: string) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`legacy-idle-send:${ordinal}`),
              messageId: MessageId.make(`legacy-idle-user:${ordinal}`),
              threadId,
              text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
          const projectId = ProjectId.make("legacy-idle-project");
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* (yield* EventSink.EventSinkV2).commitProjectCommand({
            commandId: CommandId.make("legacy-idle-project-create"),
            projectId,
            commandType: "project.create",
            acceptedAt: yield* DateTime.now,
            event: {
              eventId: EventId.make("legacy-idle-project-event"),
              type: "project.created",
              aggregateKind: "project",
              aggregateId: projectId,
              occurredAt: now,
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: {
                projectId,
                title: "Legacy idle recovery",
                workspaceRoot: cwd,
                defaultModelSelection: null,
                scripts: [],
                createdAt: now,
                updatedAt: now,
              },
            },
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("legacy-idle-create"),
            threadId,
            projectId,
            title: "Legacy idle recovery",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* send(1, "first idle turn");
          const completed = yield* waitFor(
            (p) => p.runs[0]?.status === "completed" && p.runs[0]?.checkpointId !== null,
          );
          const originalThread = completed.providerThreads.find((p) => p.nativeThreadRef !== null)!;
          const observed = originalThread.nativeThreadRef!;
          expect(observed.strength).toBe("strong");
          const originalSessionId = originalThread.providerSessionId!;
          const owned = h.launches.filter((p) => p.instanceId === first);
          expect(owned).toHaveLength(1);
          expect(yield* owned[0]!.handle.isRunning).toBe(true);
          expect(owned[0]!.args).toEqual(
            expect.arrayContaining([
              "--model",
              "mock-model",
              "--effort",
              "high",
              "stream-json",
              "--dangerously-skip-permissions",
            ]),
          );
          expect(owned[0]!.cwd).toBe(cwd);
          expect(
            completed.messages.filter((m) => m.role === "assistant").map((m) => m.text),
          ).toEqual(["turn-1:first idle turn"]);
          expect(completed.providerTurns.map((p) => p.status)).toEqual(["completed"]);
          // This exact completed owner dies while idle; no Stop, explicit reopen
          // or supplied future native ID drives the second user command.
          yield* Effect.sync(() => process.kill(Number(owned[0]!.handle.pid), "SIGTERM"));
          const idleExit = yield* owned[0]!.handle.exitCode.pipe(Effect.exit);
          expect(Exit.isFailure(idleExit)).toBe(true);
          if (Exit.isFailure(idleExit)) expect(Cause.pretty(idleExit.cause)).toContain("SIGTERM");
          expect(yield* owned[0]!.handle.isRunning).toBe(false);
          const dead = yield* waitFor((p) =>
            p.providerSessions.some((s) => s.id === originalSessionId && s.status === "error"),
          );
          expect(dead.runs.map((r) => r.status)).toEqual(["completed"]);
          expect(dead.providerTurns.map((p) => p.status)).toEqual(["completed"]);
          expect(dead.messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual([
            "turn-1:first idle turn",
          ]);
          expect(dead.turnItems.some((i) => i.type === "error")).toBe(false);
          expect(yield* h.readRequests(first)).toHaveLength(1);
          yield* send(2, "after idle crash");
          const recovered = yield* waitFor((p) =>
            ["completed", "failed", "interrupted"].includes(p.runs[1]?.status ?? ""),
          );
          const fresh = yield* store.getThreadSnapshot(threadId);
          const events = yield* (yield* EventStore.EventStoreV2)
            .read({ threadId })
            .pipe(Stream.runCollect);
          const launches = h.launches.filter((p) => p.instanceId === first);
          const requests = yield* h.readRequests(first);
          const evidence = {
            completed,
            dead,
            fresh,
            events,
            requests,
            launches: launches.map((p) => ({
              args: p.args,
              cwd: p.cwd,
              pid: Number(p.handle.pid),
            })),
          };
          expect(recovered.runs[1]?.status, yield* encodeIdleEvidence(evidence)).toBe("completed");
          expect(recovered.runs.map((r) => r.status)).toEqual(["completed", "completed"]);
          expect(recovered.providerTurns.map((p) => p.status)).toEqual(["completed", "completed"]);
          expect(recovered.turnItems.some((i) => i.type === "error")).toBe(false);
          expect(
            recovered.messages.filter((m) => m.role === "assistant").map((m) => m.text),
          ).toEqual(["turn-1:first idle turn", "turn-1:after idle crash"]);
          expect(recovered.messages.every((m) => !m.streaming)).toBe(true);
          expect(launches).toHaveLength(2);
          expect(Number(launches[1]!.handle.pid)).not.toBe(Number(owned[0]!.handle.pid));
          expect(launches[1]!.args).toEqual(
            expect.arrayContaining([
              "--model",
              "mock-model",
              "--effort",
              "high",
              "--conversation",
              observed.nativeId,
              "--dangerously-skip-permissions",
            ]),
          );
          expect(launches[1]!.cwd).toBe(cwd);
          expect(
            recovered.providerThreads.every(
              (p) => p.nativeThreadRef?.nativeId === observed.nativeId,
            ),
          ).toBe(true);
          expect(
            recovered.providerSessions.filter((s) => s.status === "error").map((s) => s.id),
          ).toEqual([originalSessionId]);
          expect(requests.map((r) => r.message.content.split("\n\n").at(-1))).toEqual([
            "first idle turn",
            "after idle crash",
          ]);
          expect(h.credentialLaunches).toHaveLength(0);
          expect(fresh.projection).toEqual(recovered);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    60_000,
  );
});
