import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ProviderAuthState,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
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
import { makeProviderAuthService } from "../provider/Layers/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderAuthController } from "../provider/Services/ProviderAuthService.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { type ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
  makeThreadCreatedEvent,
  makeProviderAdapter,
  makeTestLayer,
  type TestProviderRuntimeState,
} from "./testkit/ProviderSessionManagerTestHarness.ts";

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
