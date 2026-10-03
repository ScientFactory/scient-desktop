import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type OrchestrationV2AppThread, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NetAddress from "effect/unstable/net/NetAddress";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "../../orchestration-v2/ProviderEventIngestor.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  configMap,
  first,
  second,
  harness,
} from "./ProviderInstanceRegistryNativeLifetime.test-harness.ts";

const storesLayer = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const sinkLayer = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(storesLayer, SqlitePersistenceMemory)),
);
const mcpLayer = Layer.effect(
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
      getEnvironmentId: Effect.succeed(EnvironmentId.make("registry-native-lifetime")),
    }),
  ),
  Layer.provide(NodeServices.layer),
);
const testLayer = Layer.mergeAll(
  storesLayer,
  sinkLayer,
  mcpLayer,
  IdAllocator.layer,
  NodeServices.layer,
);

type NativeHarness = Effect.Success<ReturnType<typeof harness>>;

const managerLayer = Effect.fnUntraced(function* (h: NativeHarness) {
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const mcp = yield* McpSessionRegistry.McpSessionRegistry;
  const revoked = yield* Deferred.make<void>();
  const observedMcp = {
    ...mcp,
    revokeProviderSession: (credentialId: string) =>
      mcp
        .revokeProviderSession(credentialId)
        .pipe(Effect.tap(() => Deferred.succeed(revoked, undefined))),
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(EventSink.EventSinkV2, sink),
    Layer.succeed(ProjectionStore.ProjectionStoreV2, store),
    Layer.succeed(IdAllocator.IdAllocatorV2, allocator),
    Layer.succeed(McpSessionRegistry.McpSessionRegistry, observedMcp),
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

const seedThread = Effect.fnUntraced(function* (h: NativeHarness, instanceId: typeof first) {
  const input = h.input(instanceId);
  const sink = yield* EventSink.EventSinkV2;
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const now = yield* DateTime.now;
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: yield* allocator.allocate.project({ fixtureName: "registry-lifetime" }),
    title: "Native registry lifetime",
    providerInstanceId: instanceId,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
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
  yield* sink.write({
    events: [
      {
        id: yield* allocator.allocate.event({ threadId: input.threadId }),
        type: "thread.created",
        threadId: input.threadId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  return input;
});

const credentialFor = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const config = McpProviderSession.readMcpProviderSession(threadId);
    if (config === undefined)
      return yield* Effect.die("Expected a freshly issued native MCP credential");
    return config.authorizationHeader.replace(/^Bearer\s+/, "");
  });

it.layer(testLayer)("Registry retirement through the actual native session manager", (it) => {
  it.effect("reuses the same normalized workspace without replacing native ownership", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const input = yield* seedThread(h, first);
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const configured = yield* managerLayer(h);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const initial = { ...input, runtimePolicy: { ...input.runtimePolicy, cwd } };
        const opened = yield* manager.open(initial);
        const originalCredential = yield* credentialFor(input.threadId);
        const same = yield* manager.open({
          ...initial,
          runtimePolicy: { ...initial.runtimePolicy, cwd: `${cwd}/.` },
        });
        assert.equal(same, opened);
        assert.equal(yield* credentialFor(input.threadId), originalCredential);
        assert.isFalse(h.log.some((entry) => entry.startsWith("close:")));
      }).pipe(Effect.provide(configured.layer), Effect.scoped);
    }).pipe(Effect.scoped),
  );

  for (const changed of ["workspace", "instance"] as const) {
    it.effect(`rejects reuse of a live session identity with a different ${changed}`, () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const input = yield* seedThread(h, first);
        const fs = yield* FileSystem.FileSystem;
        const originalCwd = yield* fs.makeTempDirectoryScoped();
        const targetCwd = yield* fs.makeTempDirectoryScoped();
        const configured = yield* managerLayer(h);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const initial = { ...input, runtimePolicy: { ...input.runtimePolicy, cwd: originalCwd } };
          const opened = yield* manager.open(initial);
          const originalCredential = yield* credentialFor(input.threadId);
          const requested =
            changed === "workspace"
              ? { ...initial, runtimePolicy: { ...initial.runtimePolicy, cwd: targetCwd } }
              : { ...initial, modelSelection: { ...initial.modelSelection, instanceId: second } };
          const result = yield* Effect.result(manager.open(requested));
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(result.failure._tag, "ProviderSessionOpenError");
          const live = yield* manager.get(input.providerSessionId);
          assert.isTrue(Option.isSome(live));
          if (Option.isSome(live)) assert.equal(live.value, opened);
          assert.equal(opened.instanceId, first);
          assert.equal(opened.providerSession.cwd, originalCwd);
          assert.equal(yield* credentialFor(input.threadId), originalCredential);
          assert.isFalse(h.log.some((entry) => entry.startsWith("close:")));
        }).pipe(Effect.provide(configured.layer), Effect.scoped);
      }).pipe(Effect.scoped),
    );
  }

  it.effect(
    "persists terminal session state and revokes only the removed instance's MCP credential",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const target = yield* seedThread(h, first);
        const peer = yield* seedThread(h, second);
        const mcp = yield* McpSessionRegistry.McpSessionRegistry;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const configured = yield* managerLayer(h);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const runtime = yield* manager.open(target);
          yield* manager.open(peer);
          const targetToken = yield* credentialFor(target.threadId);
          const peerToken = yield* credentialFor(peer.threadId);
          assert.isDefined(yield* mcp.resolve(targetToken));
          assert.isDefined(yield* mcp.resolve(peerToken));
          yield* h.mutator.reconcile({ [second]: configMap()[second]! });
          // Observe actual revocation completion, not an arbitrary delay after the wake-up.
          yield* Deferred.await(configured.revoked);
          const projection = yield* projections.getThreadRecords(target.threadId, [
            "providerSessions",
          ]);
          assert.equal(
            projection.providerSessions.find((session) => session.id === target.providerSessionId)
              ?.status,
            "stopped",
          );
          assert.isTrue(Option.isNone(yield* manager.get(target.providerSessionId)));
          assert.isTrue(Option.isSome(yield* manager.get(peer.providerSessionId)));
          assert.isUndefined(yield* mcp.resolve(targetToken));
          assert.isDefined(yield* mcp.resolve(peerToken));
          assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 1);
          assert.isFalse(h.log.includes(`close:${second}:1`));
          const stale = yield* Effect.result(
            runtime.ensureThread({
              threadId: target.threadId,
              modelSelection: target.modelSelection,
              runtimePolicy: target.runtimePolicy,
            }),
          );
          assert.equal(stale._tag, "Failure");
        }).pipe(Effect.provide(configured.layer));
      }),
  );

  it.effect("revokes the freshly issued credential when removal interrupts native opening", () =>
    Effect.gen(function* () {
      const openingStarted = yield* Deferred.make<void>();
      const openingGate = yield* Deferred.make<void>();
      const h = yield* harness({ openingStarted, openingGate });
      const target = yield* seedThread(h, first);
      const mcp = yield* McpSessionRegistry.McpSessionRegistry;
      const configured = yield* managerLayer(h);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const opening = yield* manager.open(target).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(openingStarted);
        const token = yield* credentialFor(target.threadId);
        assert.isDefined(yield* mcp.resolve(token));
        yield* h.mutator.reconcile({ [second]: configMap()[second]! });
        const result = yield* Fiber.join(opening);
        assert.equal(result._tag, "Failure");
        yield* Deferred.await(configured.revoked);
        assert.isUndefined(yield* mcp.resolve(token));
        assert.isTrue(Option.isNone(yield* manager.get(target.providerSessionId)));
        assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 1);
      }).pipe(Effect.provide(configured.layer));
    }),
  );

  it.effect(
    "caller cancellation tears down the opening transport and revokes its fresh credential",
    () =>
      Effect.gen(function* () {
        const openingStarted = yield* Deferred.make<void>();
        const openingGate = yield* Deferred.make<void>();
        const h = yield* harness({ openingStarted, openingGate });
        const target = yield* seedThread(h, first);
        const mcp = yield* McpSessionRegistry.McpSessionRegistry;
        const configured = yield* managerLayer(h);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const opening = yield* manager.open(target).pipe(Effect.forkChild);
          yield* Deferred.await(openingStarted);
          const token = yield* credentialFor(target.threadId);
          assert.isDefined(yield* mcp.resolve(token));
          yield* Fiber.interrupt(opening);
          const exit = yield* Fiber.await(opening);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause));
          yield* Deferred.await(configured.revoked);
          assert.isUndefined(yield* mcp.resolve(token));
          assert.isTrue(Option.isNone(yield* manager.get(target.providerSessionId)));
          assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 1);
          assert.isDefined(yield* h.registry.getInstance(first));
        }).pipe(Effect.provide(configured.layer));
      }),
  );

  it.effect(
    "a cancelled replacement open preserves the credential held by its live predecessor",
    () =>
      Effect.gen(function* () {
        const openingStarted = yield* Deferred.make<void>();
        const openingGate = yield* Deferred.make<void>();
        const h = yield* harness({
          beforeOpen: (input) =>
            input.providerSessionId.endsWith(":2")
              ? Deferred.succeed(openingStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(openingGate)),
                )
              : Effect.void,
        });
        const target = yield* seedThread(h, first);
        const mcp = yield* McpSessionRegistry.McpSessionRegistry;
        const configured = yield* managerLayer(h);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          yield* manager.open(target);
          const token = yield* credentialFor(target.threadId);
          const replacement = h.input(first, 2);
          const opening = yield* manager.open(replacement).pipe(Effect.forkChild);
          yield* Deferred.await(openingStarted);
          assert.equal(yield* credentialFor(target.threadId), token);
          yield* Fiber.interrupt(opening);
          const exit = yield* Fiber.await(opening);
          assert.isTrue(Exit.isFailure(exit));
          assert.isFalse(yield* Deferred.isDone(configured.revoked));
          assert.isDefined(yield* mcp.resolve(token));
          assert.isTrue(Option.isSome(yield* manager.get(target.providerSessionId)));
          assert.isTrue(Option.isNone(yield* manager.get(replacement.providerSessionId)));
          assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 1);
        }).pipe(Effect.provide(configured.layer));
      }),
  );

  it.effect(
    "a failed credential issuer preserves the exact token already adopted by a live replacement",
    () =>
      Effect.gen(function* () {
        const openingStarted = yield* Deferred.make<void>();
        const openingGate = yield* Deferred.make<void>();
        const h = yield* harness({
          beforeOpen: (input) =>
            input.providerSessionId.endsWith(":1")
              ? Deferred.succeed(openingStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(openingGate)),
                )
              : Effect.void,
        });
        const target = yield* seedThread(h, first);
        const mcp = yield* McpSessionRegistry.McpSessionRegistry;
        const configured = yield* managerLayer(h);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const issuer = yield* manager.open(target).pipe(Effect.forkChild);
          yield* Deferred.await(openingStarted);
          const token = yield* credentialFor(target.threadId);
          const replacement = h.input(first, 2);
          yield* manager.open(replacement);
          assert.equal(yield* credentialFor(target.threadId), token);
          yield* Fiber.interrupt(issuer);
          assert.isFalse(yield* Deferred.isDone(configured.revoked));
          assert.isDefined(yield* mcp.resolve(token));
          assert.isTrue(Option.isNone(yield* manager.get(target.providerSessionId)));
          assert.isTrue(Option.isSome(yield* manager.get(replacement.providerSessionId)));
          yield* manager.close(replacement.providerSessionId);
          assert.isUndefined(yield* mcp.resolve(token));
        }).pipe(Effect.provide(configured.layer));
      }),
  );

  it.effect(
    "the last failed pending holder revokes the fresh credential left by its failed issuer",
    () =>
      Effect.gen(function* () {
        const issuerStarted = yield* Deferred.make<void>();
        const replacementStarted = yield* Deferred.make<void>();
        const openingGate = yield* Deferred.make<void>();
        const h = yield* harness({
          beforeOpen: (input) =>
            Deferred.succeed(
              input.providerSessionId.endsWith(":1") ? issuerStarted : replacementStarted,
              undefined,
            ).pipe(Effect.andThen(Deferred.await(openingGate))),
        });
        const target = yield* seedThread(h, first);
        const mcp = yield* McpSessionRegistry.McpSessionRegistry;
        const configured = yield* managerLayer(h);
        yield* Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const issuer = yield* manager.open(target).pipe(Effect.forkChild);
          yield* Deferred.await(issuerStarted);
          const token = yield* credentialFor(target.threadId);
          const replacement = h.input(first, 2);
          const pending = yield* manager.open(replacement).pipe(Effect.forkChild);
          yield* Deferred.await(replacementStarted);
          yield* Fiber.interrupt(issuer);
          assert.isFalse(yield* Deferred.isDone(configured.revoked));
          assert.isDefined(yield* mcp.resolve(token));
          yield* Fiber.interrupt(pending);
          yield* Deferred.await(configured.revoked);
          assert.isUndefined(yield* mcp.resolve(token));
          assert.isTrue(Option.isNone(yield* manager.get(target.providerSessionId)));
          assert.isTrue(Option.isNone(yield* manager.get(replacement.providerSessionId)));
          assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 2);
        }).pipe(Effect.provide(configured.layer));
      }),
  );

  it.effect("releasing a live owner defers revocation until its pending replacement fails", () =>
    Effect.gen(function* () {
      const openingStarted = yield* Deferred.make<void>();
      const openingGate = yield* Deferred.make<void>();
      const h = yield* harness({
        beforeOpen: (input) =>
          input.providerSessionId.endsWith(":2")
            ? Deferred.succeed(openingStarted, undefined).pipe(
                Effect.andThen(Deferred.await(openingGate)),
              )
            : Effect.void,
      });
      const target = yield* seedThread(h, first);
      const mcp = yield* McpSessionRegistry.McpSessionRegistry;
      const configured = yield* managerLayer(h);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        yield* manager.open(target);
        const token = yield* credentialFor(target.threadId);
        const pending = yield* manager.open(h.input(first, 2)).pipe(Effect.forkChild);
        yield* Deferred.await(openingStarted);
        yield* manager.close(target.providerSessionId);
        assert.isFalse(yield* Deferred.isDone(configured.revoked));
        assert.isDefined(yield* mcp.resolve(token));
        yield* Fiber.interrupt(pending);
        yield* Deferred.await(configured.revoked);
        assert.isUndefined(yield* mcp.resolve(token));
      }).pipe(Effect.provide(configured.layer));
    }),
  );
});
