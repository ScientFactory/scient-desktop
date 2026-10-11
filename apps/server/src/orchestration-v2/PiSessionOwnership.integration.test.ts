import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
/** Native Pi JSONL and the actual manager; only the peer and publication gate are controlled. */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as Config from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ScientTestProviderHost from "./testkit/ScientTestProviderHost.ts";
import * as McpRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../provider/testUtils/providerRegistryMock.ts";
import { makePiAdapterV2, makePiRpcConnection } from "@t3tools/provider-pi/testing";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Ingestor from "./ProviderEventIngestor.ts";
import { layerSingle as makeSingleLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2, layerWithOptions } from "./ProviderSessionManager.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const decodeLine = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, pid: Schema.Number })),
);
const instanceId = ProviderInstanceId.make("pi-native-ownership");
const selection = { instanceId, model: "default" };
const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: null } as const;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const sink = EventSink.layer.pipe(Layer.provide(Layer.merge(stores, SqlitePersistenceMemory)));
const fixtureServices = Layer.mergeAll(
  Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer),
  IdAllocator.layer,
  McpProviderSessions.layer,
  Config.layerTest(process.cwd(), { prefix: "pi-native-owner-" }).pipe(
    Layer.provide(Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer)),
  ),
);
const outer = ScientTestProviderHost.layer.pipe(Layer.provideMerge(fixtureServices));

const withNativePi = <A, E, R>(
  run: (h: {
    manager: ProviderSessionManagerV2["Service"];
    file: string;
    fileAlias: string;
    open: (
      id: string,
      thread?: string,
      file?: string,
    ) => ReturnType<ProviderSessionManagerV2["Service"]["open"]>;
    startupEntered: Effect.Effect<void>;
    releaseStartup: Effect.Effect<boolean>;
    publicationEntered: Effect.Effect<void>;
    releasePublication: Effect.Effect<boolean>;
    requests: Effect.Effect<ReadonlyArray<{ type: string; pid: number }>>;
    processes: ReadonlyArray<number>;
  }) => Effect.Effect<A, E, R>,
  hold: "startup" | "publication" | "scope-failure" | undefined = undefined,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const processes: number[] = [];
      const spawner = ChildProcessSpawner.make((command) =>
        nativeSpawner
          .spawn(command)
          .pipe(Effect.tap((handle) => Effect.sync(() => processes.push(handle.pid)))),
      );
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-native-ownership-" });
      const file = `${directory}/native.jsonl`;
      const fileAlias = `${directory}/alias.jsonl`;
      const log = `${directory}/wire.jsonl`;
      const script = `${directory}/peer.cjs`;
      yield* fs.writeFileString(
        file,
        '{"type":"session","id":"00000000-0000-4000-8000-000000000002"}\n',
      );
      yield* fs.symlink(file, fileAlias);
      yield* fs.writeFileString(log, "");
      yield* fs.writeFileString(
        script,
        `const fs = require("node:fs"), rl = require("node:readline");
let file = process.env.PI_OWNER_FILE;
const record = value => fs.appendFileSync(process.env.PI_OWNER_LOG, JSON.stringify({ ...value, pid: process.pid }) + "\\n");
record({ type: "spawn" });
rl.createInterface({ input: process.stdin }).on("line", line => {
 const r = JSON.parse(line); record(r);
 let data = {};
 if (r.type === "switch_session") { file = r.sessionPath; data = { cancelled: false }; }
 if (r.type === "get_state") data = { sessionFile: file, sessionId: "00000000-0000-4000-8000-000000000002", model: { provider: "fixture", id: "native-model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 };
 if (r.type === "get_available_models") data = { models: [] };
 if (r.type === "get_commands") data = { commands: [] };
 if (r.id) process.stdout.write(JSON.stringify({ type: "response", id: r.id, command: r.type, success: true, data }) + "\\n");
});`,
      );
      const binary = `${directory}/pi-peer.sh`;
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      yield* fs.writeFileString(
        binary,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
      );
      yield* fs.chmod(binary, 0o755);
      const startupEntered = yield* Deferred.make<void>();
      const startupReleased = yield* Deferred.make<void>();
      const publicationEntered = yield* Deferred.make<void>();
      const publicationReleased = yield* Deferred.make<void>();
      let startupHeld = false;
      let publicationHeld = false;
      const adapter = yield* makePiAdapterV2({
        instanceId,
        settings: { enabled: true, binaryPath: binary, launchArgs: "", customModels: [] },
        environment: { PI_OWNER_FILE: file, PI_OWNER_LOG: log },
        makeConnection: (input) =>
          makePiRpcConnection(input).pipe(
            Effect.tap(() =>
              hold === "scope-failure"
                ? Effect.addFinalizer(() => Effect.die("Controlled native scope cleanup failure"))
                : Effect.void,
            ),
            Effect.tap(() => {
              if (hold !== "startup" || startupHeld) return Effect.void;
              startupHeld = true;
              return Deferred.succeed(startupEntered, undefined).pipe(
                Effect.andThen(Deferred.await(startupReleased)),
              );
            }),
          ),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const controlledSink = Layer.effect(
        EventSink.EventSinkV2,
        Effect.gen(function* () {
          const delegate = yield* EventSink.EventSinkV2;
          return EventSink.EventSinkV2.of({
            ...delegate,
            write: (input) =>
              Effect.gen(function* () {
                if (
                  hold === "publication" &&
                  !publicationHeld &&
                  input.events.some((e) => e.type === "provider-session.attached")
                ) {
                  publicationHeld = true;
                  yield* Deferred.succeed(publicationEntered, undefined);
                  yield* Deferred.await(publicationReleased);
                }
                return yield* delegate.write(input);
              }),
          });
        }),
      ).pipe(Layer.provide(sink));
      const dependencies = Layer.mergeAll(stores, controlledSink, IdAllocator.layer);
      const managerLayer = layerWithOptions({ configureMcp: false, idleTimeoutMs: 60_000 }).pipe(
        Layer.provide(
          Layer.mergeAll(
            dependencies,
            makeSingleLayer(adapter),
            Layer.succeed(ProviderRegistry.ProviderRegistry, makeProviderRegistryMock()),
            Layer.mock(McpRegistry.McpSessionRegistry)({}),
            Ingestor.layer.pipe(Layer.provide(dependencies)),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const events = yield* Effect.forEach(
          ["pi-owner-thread", "pi-replacement-thread", "pi-other-thread"],
          (name) =>
            Effect.gen(function* () {
              const threadId = ThreadId.make(name);
              return {
                id: yield* allocator.allocate.event({ threadId }),
                type: "thread.created",
                threadId,
                occurredAt: now,
                payload: {
                  id: threadId,
                  projectId: ProjectId.make("pi-owner-project"),
                  title: "Pi ownership",
                  providerInstanceId: instanceId,
                  modelSelection: selection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: threadId,
                  },
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                  createdBy: "user",
                  creationSource: "web",
                },
              } satisfies OrchestrationV2DomainEvent;
            }),
        );
        yield* eventSink.write({ events });
        return yield* run({
          manager,
          file,
          fileAlias,
          processes,
          open: (id, thread = "pi-owner-thread", nativeFile) =>
            manager.open({
              providerSessionId: ProviderSessionId.make(id),
              threadId: ThreadId.make(thread),
              modelSelection: selection,
              runtimePolicy: policy,
              ...(nativeFile === undefined ? {} : { initialNativeThreadId: nativeFile }),
            }),
          startupEntered: Deferred.await(startupEntered),
          releaseStartup: Deferred.succeed(startupReleased, undefined),
          publicationEntered: Deferred.await(publicationEntered),
          releasePublication: Deferred.succeed(publicationReleased, undefined),
          requests: fs.readFileString(log).pipe(
            Effect.orDie,
            Effect.map((text) =>
              text
                .split("\n")
                .filter(Boolean)
                .map((line) => decodeLine(line)),
            ),
          ),
        });
      }).pipe(Effect.provide(Layer.mergeAll(managerLayer, dependencies)));
    }),
  ).pipe(Effect.provide(outer));

{
  it.live("coalesces concurrent native Pi starts on the same app thread into one process", () =>
    withNativePi(
      (h) =>
        Effect.gen(function* () {
          const first = yield* h.open("pi-session").pipe(Effect.forkScoped);
          yield* h.startupEntered.pipe(Effect.raceFirst(Fiber.join(first)));
          const second = yield* h.open("pi-session").pipe(Effect.forkScoped);
          yield* h.releaseStartup;
          const a = yield* Fiber.join(first),
            b = yield* Fiber.join(second);
          assert.strictEqual(a, b);
          yield* a.ensureThread({
            threadId: ThreadId.make("pi-owner-thread"),
            modelSelection: selection,
            runtimePolicy: policy,
          });
          assert.lengthOf(
            (yield* h.requests).filter((r) => r.type === "spawn"),
            1,
          );
        }),
      "startup",
    ),
  );

  it.live(
    "cancels a native Pi start waiting on the owned session lock without spawning another process",
    () =>
      withNativePi(
        (h) =>
          Effect.gen(function* () {
            const first = yield* h.open("pi-session").pipe(Effect.forkScoped);
            yield* h.startupEntered.pipe(Effect.raceFirst(Fiber.join(first)));
            const waiting = yield* h.open("pi-session").pipe(Effect.forkScoped);
            yield* Fiber.interrupt(waiting);
            const cancelled = yield* Fiber.await(waiting);
            assert.isTrue(Exit.isFailure(cancelled) && Cause.hasInterrupts(cancelled.cause));
            yield* h.releaseStartup;
            const owner = yield* Fiber.join(first);
            yield* owner.ensureThread({
              threadId: ThreadId.make("pi-owner-thread"),
              modelSelection: selection,
              runtimePolicy: policy,
            });
            assert.lengthOf(h.processes, 1);
            assert.isTrue(processIsLive(h.processes[0]!));
          }),
        "startup",
      ),
  );

  it.live("cancels native Pi startup before publication and permits a fresh owner", () =>
    withNativePi(
      (h) =>
        Effect.gen(function* () {
          const starting = yield* h.open("pi-session").pipe(Effect.forkScoped);
          yield* h.startupEntered.pipe(Effect.raceFirst(Fiber.join(starting)));
          yield* Fiber.interrupt(starting);
          const stopped = yield* Fiber.await(starting);
          assert.isTrue(Exit.isFailure(stopped) && Cause.hasInterrupts(stopped.cause));
          assert.isFalse(processIsLive(h.processes[0]!));
          assert.isTrue(Option.isNone(yield* h.manager.get(ProviderSessionId.make("pi-session"))));
          const replacement = yield* h.open("pi-session");
          yield* replacement.ensureThread({
            threadId: ThreadId.make("pi-owner-thread"),
            modelSelection: selection,
            runtimePolicy: policy,
          });
          assert.lengthOf(
            (yield* h.requests).filter((r) => r.type === "get_state"),
            1,
          );
        }),
      "startup",
    ),
  );

  it.live(
    "cancellation after native Pi publication releases the process and its durable file lease",
    () =>
      withNativePi(
        (h) =>
          Effect.gen(function* () {
            const starting = yield* h
              .open("pi-session", "pi-owner-thread", h.file)
              .pipe(Effect.forkScoped);
            yield* h.publicationEntered.pipe(Effect.raceFirst(Fiber.join(starting)));
            assert.isTrue(
              Option.isSome(yield* h.manager.get(ProviderSessionId.make("pi-session"))),
            );
            assert.isTrue(
              Exit.isFailure(
                yield* h.open("pi-competing-start", "pi-other-thread", h.file).pipe(Effect.exit),
              ),
            );
            assert.lengthOf(h.processes, 1);
            yield* Fiber.interrupt(starting);
            assert.isFalse(processIsLive(h.processes[0]!));
            assert.isTrue(
              Option.isNone(yield* h.manager.get(ProviderSessionId.make("pi-session"))),
            );
            const replacement = yield* h.open(
              "pi-session-replacement",
              "pi-replacement-thread",
              h.file,
            );
            yield* replacement.ensureThread({
              threadId: ThreadId.make("pi-replacement-thread"),
              modelSelection: selection,
              runtimePolicy: policy,
            });
            assert.lengthOf(
              (yield* h.requests).filter((r) => r.type === "get_state"),
              1,
            );
          }),
        "publication",
      ),
  );

  it.live(
    "excludes concurrent native Pi writers to one durable session file until the owner closes",
    () =>
      withNativePi((h) =>
        Effect.gen(function* () {
          const first = yield* h.open("pi-session", "pi-owner-thread", h.file);
          const ownerThreadId = ThreadId.make("pi-owner-thread");
          const providerThread = yield* first.ensureThread({
            threadId: ownerThreadId,
            modelSelection: selection,
            runtimePolicy: policy,
          });
          const competing = yield* h
            .open("pi-other-session", "pi-other-thread", h.fileAlias)
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(competing));
          assert.lengthOf(
            (yield* h.requests).filter((r) => r.type === "spawn"),
            1,
          );
          yield* h.manager.close(ProviderSessionId.make("pi-session"));
          const staleEnsure = yield* first
            .ensureThread({
              threadId: ownerThreadId,
              modelSelection: selection,
              runtimePolicy: policy,
            })
            .pipe(Effect.exit, Effect.timeoutOption("2 seconds"));
          const staleExit = Option.getOrThrow(staleEnsure);
          assert.isTrue(Exit.isFailure(staleExit));
          const appThread = {
            id: ownerThreadId,
            projectId: ProjectId.make("pi-owner-project"),
            title: "Pi ownership",
            providerInstanceId: instanceId,
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: ownerThreadId,
            },
            forkedFrom: null,
            createdAt: providerThread.createdAt,
            updatedAt: providerThread.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
            createdBy: "user",
            creationSource: "web",
          } satisfies OrchestrationV2AppThread;
          const requestCountAfterClose = (yield* h.requests).length;
          const staleStart = yield* first
            .startTurn({
              appThread,
              threadId: ownerThreadId,
              runId: RunId.make("pi-stale-start-run"),
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: RunAttemptId.make("pi-stale-start-attempt"),
              rootNodeId: NodeId.make("pi-stale-start-node"),
              providerThread,
              message: {
                messageId: MessageId.make("pi-stale-start-message"),
                text: "This must not reach the closed Pi process",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
              modelSelection: selection,
              runtimePolicy: policy,
            })
            .pipe(Effect.exit, Effect.timeoutOption("2 seconds"));
          const staleStartExit = Option.getOrThrow(staleStart);
          assert.isTrue(Exit.isFailure(staleStartExit));
          assert.lengthOf(yield* h.requests, requestCountAfterClose);
          const replacement = yield* h.open("pi-other-session", "pi-other-thread", h.file);
          yield* replacement.ensureThread({
            threadId: ThreadId.make("pi-other-thread"),
            modelSelection: selection,
            runtimePolicy: policy,
          });
          assert.lengthOf(
            (yield* h.requests).filter((r) => r.type === "spawn"),
            2,
          );
        }),
      ),
  );
  it.live("retains the native Pi file lease when process-scope cleanup fails", () =>
    withNativePi(
      (h) =>
        Effect.gen(function* () {
          const first = yield* h.open("pi-session", "pi-owner-thread", h.file);
          yield* first.ensureThread({
            threadId: ThreadId.make("pi-owner-thread"),
            modelSelection: selection,
            runtimePolicy: policy,
          });
          assert.isTrue(
            Exit.isFailure(
              yield* h.manager.close(ProviderSessionId.make("pi-session")).pipe(Effect.exit),
            ),
          );
          assert.isTrue(
            Exit.isFailure(
              yield* h.open("pi-other-session", "pi-other-thread", h.file).pipe(Effect.exit),
            ),
          );
          assert.lengthOf(h.processes, 1);
          assert.isFalse(processIsLive(h.processes[0]!));
        }),
      "scope-failure",
    ),
  );
}
