// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { isRecord } from "effect-omp-rpc/schema";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { persistChatAttachments } from "../AttachmentPersistence.ts";
import * as ServerConfig from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ompTarget } from "../provider/omp/OmpTarget.ts";
import { scriptedOmpRpc } from "../provider/testUtils/scriptedOmpRpc.ts";
import { makeOmpAdapterV2 } from "./Adapters/OmpAdapterV2.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EffectOutboxV2, type OrchestrationEffectV2 } from "./EffectOutbox.ts";
import { OrchestrationEffectWorkerV2, runDaemon } from "./EffectWorker.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJournalFrames = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const boundedEvidence = (value: unknown): unknown => {
  if (typeof value === "string" && (value.startsWith("[") || value.startsWith("{"))) {
    try {
      return boundedEvidence(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(boundedEvidence);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      ["text", "prompt", "message", "content", "data"].includes(key) && typeof entry === "string"
        ? { sha256: digest(entry), bytes: Buffer.byteLength(entry) }
        : boundedEvidence(entry),
    ]),
  );
};

// Raw synthetic evidence stays private; the review trace omits full payloads.
const writeObservation = (phase: string, value: unknown) => {
  const output = process.env.T3_OMP_CONJUNCTION_OUTPUT;
  const record = { phase, at: DateTime.formatIso(DateTime.nowUnsafe()), value };
  const privateOutput = process.env.T3_OMP_CONJUNCTION_PRIVATE_OUTPUT;
  if (privateOutput)
    NodeFS.appendFileSync(privateOutput, `${encodeJson(record)}\n`, { mode: 0o600 });
  if (output) NodeFS.appendFileSync(output, `${encodeJson(boundedEvidence(record))}\n`);
};
const observe = (phase: string, value: unknown) =>
  Effect.sync(() => writeObservation(phase, value));

// Preserve non-enumerable Error causes without changing the actual logged Cause.
const causeEvidence = (value: unknown, depth = 0, seen = new Set<object>()): unknown => {
  if (depth > 12) return { missing: "diagnostic depth limit" };
  if (typeof value === "string" && value.length > 4096)
    return {
      missing: "diagnostic string limit",
      bytes: Buffer.byteLength(value),
      sha256: digest(value),
    };
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return { missing: "diagnostic repeated reference" };
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => causeEvidence(entry, depth + 1, seen));
  const keys = new Set(Object.getOwnPropertyNames(value));
  if (value instanceof Error)
    for (const key of ["name", "message", "stack", "cause"]) keys.add(key);
  return Object.fromEntries(
    [...keys].map((key) => [key, causeEvidence(Reflect.get(value, key), depth + 1, seen)]),
  );
};
const startCauseLogger = Logger.make(({ message, cause }) => {
  if (!Array.isArray(message) || message[0] !== "orchestration V2 provider turn start failed")
    return;
  try {
    writeObservation("actual-provider-start-cause", {
      message: causeEvidence(message),
      cause: causeEvidence(cause),
    });
  } catch {
    try {
      writeObservation("actual-provider-start-cause-missing", {
        missing: "passive logger capture failed",
      });
    } catch {
      /* Preserve the original logging/run outcome. */
    }
  }
});

const waitForThread = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const found = yield* Stream.concat(
    Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("10 seconds"));
  if (Option.isNone(found)) return yield* Effect.die("Native SQL did not converge");
  return found.value;
});

const waitForEffects = Effect.fnUntraced(function* (
  commandId: CommandId,
  predicate: (effects: ReadonlyArray<OrchestrationEffectV2>) => boolean,
) {
  const outbox = yield* EffectOutboxV2;
  const completions = yield* outbox.subscribeCompletions;
  const found = yield* Stream.concat(
    Stream.fromEffect(outbox.listByCommandId(commandId)),
    completions.pipe(Stream.mapEffect(() => outbox.listByCommandId(commandId))),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("10 seconds"));
  if (Option.isNone(found)) return yield* Effect.die("Original durable effect did not settle");
  return found.value;
}, Effect.scoped);

const nativeFixture = Effect.fnUntraced(function* (
  name: string,
  gates: { readonly ready?: boolean; readonly close?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const cwd = yield* checkpointWorkspace(name);
  const home = path.join(config.stateDir, "synthetic-home");
  yield* fs.makeDirectory(home);
  const readyEntered = yield* Deferred.make<void>();
  const readyRelease = yield* Deferred.make<void>();
  const closeEntered = yield* Deferred.make<void>();
  const closeRelease = yield* Deferred.make<void>();
  const prepEntered = yield* Deferred.make<void>();
  const prepRelease = yield* Deferred.make<void>();
  const releaseAll = Effect.all([
    Deferred.succeed(readyRelease, undefined),
    Deferred.succeed(closeRelease, undefined),
    Deferred.succeed(prepRelease, undefined),
  ]);
  yield* Effect.addFinalizer(() => releaseAll);
  const instanceId = ProviderInstanceId.make(name);
  const threadId = ThreadId.make(name);
  const messageId = MessageId.make(`${name}-original`);
  const selection = {
    instanceId,
    model: "controlled/model",
    options: [{ id: "thinkingLevel", value: "high" }],
  };
  const peers: Array<ReturnType<typeof scriptedOmpRpc>> = [];
  const roots: Array<string> = [];
  let shutdownCalls = 0;
  let nativeReadyFrames = 0;
  let holdPrep = false;
  let diagnosticPhase = "fixture-created";
  const diagnosticIdentity: Record<string, unknown> = { threadId, instanceId };
  const phase = (stage: string, identity: Record<string, unknown> = {}) =>
    Effect.sync(() => {
      diagnosticPhase = stage;
      Object.assign(diagnosticIdentity, identity);
    }).pipe(Effect.andThen(observe(`${name}.${stage}`, diagnosticIdentity)));
  // Observe the real private spool file without changing admission, reads, or cleanup.
  const journals: Array<{ path: string; written: Uint8Array[]; read: Uint8Array[] }> = [];
  const observedFs: FileSystem.FileSystem = {
    ...fs,
    open: (filePath, options) =>
      fs.open(filePath, options).pipe(
        Effect.map((file) => {
          if (!filePath.endsWith("/events.bin")) return file;
          const journal = { path: filePath, written: [] as Uint8Array[], read: [] as Uint8Array[] };
          journals.push(journal);
          const originalWriteAll = file.writeAll.bind(file);
          const originalRead = file.read.bind(file);
          Object.defineProperties(file, {
            writeAll: {
              value: ((bytes) =>
                originalWriteAll(bytes).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      journal.written.push(bytes.slice());
                    }),
                  ),
                )) satisfies FileSystem.File["writeAll"],
            },
            read: {
              value: ((bytes) =>
                originalRead(bytes).pipe(
                  Effect.tap((count) =>
                    Effect.sync(() => {
                      if (count > 0) journal.read.push(bytes.slice(0, count));
                    }),
                  ),
                )) satisfies FileSystem.File["read"],
            },
          });
          return file;
        }),
      ),
  };
  const adapter = makeOmpAdapterV2({
    target: ompTarget,
    instanceId,
    settings: { binaryPath: "synthetic-omp", homePath: home },
    environment: { HOME: home },
    fileSystem: observedFs,
    path,
    crypto: yield* Crypto.Crypto,
    spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    idAllocator: yield* IdAllocatorV2,
    serverConfig: config,
    continuations: { offer: () => Effect.void },
    nativeEventLogger: {
      filePath: "synthetic-evidence-only",
      write: (event) =>
        Effect.sync(() => {
          if (isRecord(event) && isRecord(event.event) && event.event.method === "ready")
            nativeReadyFrames++;
        }).pipe(Effect.andThen(observe(`${name}.native`, event))),
      close: () => Effect.void,
    },
    makeProcess: (options) =>
      Effect.gen(function* () {
        const ordinal = peers.length;
        const peer = scriptedOmpRpc({
          models: [
            {
              provider: "controlled",
              id: "model",
              reasoning: true,
              contextWindow: 200_000,
              input: ["text", "image"],
              thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "low" },
            },
          ],
          initial: { provider: "controlled", id: "model" },
          environment: { HOME: home },
          readyDelay:
            ordinal === 0 && gates.ready
              ? Deferred.succeed(readyEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(readyRelease)),
                  Effect.timeout("10 seconds"),
                  Effect.orDie,
                )
              : Effect.void,
        });
        peers.push(peer);
        roots.push(options.sessionDir ?? "");
        yield* observe(`${name}.open`, { ordinal, options });
        const client = yield* peer.makeProcess(options);
        return {
          ...client,
          limits: Effect.suspend(() => {
            if (!holdPrep) return client.limits;
            holdPrep = false;
            return Deferred.succeed(prepEntered, undefined).pipe(
              Effect.andThen(Deferred.await(prepRelease)),
              Effect.timeout("10 seconds"),
              Effect.orDie,
              Effect.andThen(client.limits),
            );
          }),
          shutdown: Effect.sync(() => {
            shutdownCalls++;
          }).pipe(
            Effect.andThen(
              observe(`${name}.shutdown-entry`, {
                ordinal,
                sessionDir: options.sessionDir,
                get shutdownCalls() {
                  return shutdownCalls;
                },
              }),
            ),
            Effect.andThen(
              ordinal === 0 && gates.close
                ? Deferred.succeed(closeEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(closeRelease)),
                    Effect.timeout("10 seconds"),
                    Effect.orDie,
                  )
                : Effect.void,
            ),
            Effect.andThen(
              observe(`${name}.shutdown-gate-released`, {
                ordinal,
                sessionDir: options.sessionDir,
              }),
            ),
            Effect.andThen(client.shutdown),
            Effect.tap((exit) =>
              observe(`${name}.shutdown-completed`, {
                ordinal,
                sessionDir: options.sessionDir,
                exit,
              }),
            ),
          ),
        };
      }),
  });
  const database = makeSqlitePersistenceLive(config.dbPath).pipe(Layer.provide(NodeServices.layer));
  const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
    { name, runtimePolicyOverride: { cwd } },
    makeLayer([adapter]),
    {
      databaseLayer: database,
      serverConfigLayer: Layer.succeed(ServerConfig.ServerConfig, config),
      configureMcp: false,
      runEffectWorker: false,
    },
  ).pipe(Layer.provideMerge(database));
  const lock = (ordinal = peers.length - 1) => path.join(roots[ordinal]!, ".session.lock");
  const snapshot = Effect.fnUntraced(function* (phase: string) {
    const orchestrator = yield* OrchestratorV2;
    const sessions = yield* ProviderSessionManagerV2;
    const sql = yield* SqlClient.SqlClient;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'orchestration%' ORDER BY name`;
    const rows: Record<string, unknown> = {};
    for (const { name } of tables) rows[name] = yield* sql.unsafe(`SELECT * FROM "${name}"`);
    const owners = yield* Effect.forEach(projection.providerSessions, (s) => sessions.get(s.id));
    const files: Record<string, unknown> = {};
    for (const root of new Set(roots)) {
      const lockPath = path.join(root, ".session.lock");
      files[lockPath] = { exists: yield* fs.exists(lockPath) };
      if (!(yield* fs.exists(root))) continue;
      for (const name of yield* fs.readDirectory(root)) {
        const file = path.join(root, name);
        if ((yield* fs.stat(file)).type === "File") {
          const bytes = yield* fs.readFile(file);
          files[file] = {
            exists: true,
            bytes: bytes.length,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          };
        }
      }
    }
    yield* observe(`${threadId}.${phase}`, {
      diagnosticPhase,
      diagnosticIdentity,
      projection,
      rows,
      files,
      publishedOwners: owners.map((o) => (Option.isSome(o) ? o.value.providerSession : null)),
      peers: peers.map((p) => p.state),
      shutdownCalls,
      nativeReadyFrames,
    });
    return projection;
  });
  const seed = Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${name}-create`),
      threadId,
      projectId: ProjectId.make(`${name}-project`),
      title: name,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${name}-start`),
      threadId,
      messageId,
      text: "Retain the original controlled request",
      attachments: [],
      selectedScientSkillNames: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.find((r) => r.userMessageId === messageId)!;
  });
  return {
    runtime,
    threadId,
    instanceId,
    messageId,
    selection,
    peers,
    fs,
    lock,
    readyEntered,
    readyRelease,
    closeEntered,
    closeRelease,
    prepEntered,
    prepRelease,
    holdPreparation: () => {
      holdPrep = true;
    },
    snapshot,
    journals,
    phase,
    seed,
    releaseAll,
    shutdownCalls: () => shutdownCalls,
    nativeReadyFrames: () => nativeReadyFrames,
  };
});

const withNative = <A, E, R>(
  name: string,
  gates: { readonly ready?: boolean; readonly close?: boolean },
  body: (f: Effect.Success<ReturnType<typeof nativeFixture>>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* nativeFixture(name, gates);
      return yield* Effect.gen(function* () {
        const sessions = yield* ProviderSessionManagerV2;
        yield* Effect.addFinalizer(() =>
          f.releaseAll.pipe(
            Effect.andThen(sessions.closeInstance(f.instanceId)),
            Effect.andThen(
              observe(`${name}.cleanup`, {
                // Inspect after the actual owned shutdowns, not from a pre-close count.
                get shutdowns() {
                  return f.peers.map((p) => p.state.shutdowns);
                },
                get lockExists() {
                  return f.peers.map((_, i) => NodeFS.existsSync(f.lock(i)));
                },
              }),
            ),
            Effect.orDie,
          ),
        );
        return yield* body(f).pipe(
          Effect.onError((cause) =>
            gates.close
              ? Effect.gen(function* () {
                  yield* observe(`${name}.original-failure`, cause);
                  yield* f.snapshot("failure-before-release-and-cleanup");
                }).pipe(
                  Effect.timeout("2 seconds"),
                  Effect.catchCause((diagnosticCause) =>
                    observe(`${name}.diagnostic-missing`, diagnosticCause).pipe(Effect.ignoreCause),
                  ),
                )
              : Effect.void,
          ),
          Effect.ensuring(f.releaseAll),
        );
      }).pipe(Effect.provide(f.runtime));
    }).pipe(
      Effect.withLogger(startCauseLogger),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          idAllocatorLayer,
          ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-conjunction-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

for (const superseded of [false, true]) {
  it.live(
    superseded
      ? "rejects the captured OMP owner after preparation when a newer public turn owns the session"
      : "preserves public healthy OMP steering after held payload preparation",
    () =>
      withNative(`omp-preparation-${superseded ? "superseded" : "healthy"}`, {}, (f) =>
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const sessions = yield* ProviderSessionManagerV2;
          const receipts = yield* CommandReceiptStoreV2;
          const original = yield* f.seed;
          yield* worker.drain(8);
          const peer = f.peers[0]!;
          yield* peer.promptDelivered().pipe(Effect.timeout("10 seconds"));
          const active = yield* waitForThread(f.threadId, (p) =>
            p.providerTurns.some(
              (t) => t.runAttemptId === original.activeAttemptId && t.acceptedAt !== undefined,
            ),
          );
          const turn = active.providerTurns[0]!;
          const thread = active.providerThreads.find((t) => t.id === turn.providerThreadId)!;
          const owner = Option.getOrNull(yield* sessions.get(thread.providerSessionId!));
          assert.ok(owner);
          const token = yield* f.fs.readFileString(f.lock());
          yield* worker.drain(8);
          f.holdPreparation();
          const followupId = MessageId.make(`${f.threadId}-followup`);
          const commandId = CommandId.make(`${f.threadId}-steer`);
          // Public effects serialize lifecycle work. Only this superseded-owner
          // negative calls the published native API directly while the worker
          // starts a genuine replacement; it makes no public Steer admission claim.
          const delivery = yield* Effect.gen(function* () {
            if (superseded) {
              yield* owner.steerTurn({
                threadId: f.threadId,
                runId: original.id,
                providerThread: thread,
                providerTurnId: turn.id,
                message: {
                  messageId: followupId,
                  text: "Old captured owner",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
              });
            } else {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId,
                threadId: f.threadId,
                messageId: followupId,
                text: "Healthy current owner",
                attachments: [],
                selectedScientSkillNames: [],
                dispatchMode: { type: "steer_active", targetRunId: original.id },
                createdBy: "user",
                creationSource: "web",
              });
              assert.equal(
                Option.getOrNull(yield* receipts.getByCommandId(commandId))?.status,
                "accepted",
              );
              yield* worker.runOnce;
            }
          }).pipe(Effect.exit, Effect.forkScoped);
          yield* Deferred.await(f.prepEntered).pipe(Effect.timeout("10 seconds"));
          yield* f.snapshot("preparation-held");
          if (superseded) {
            yield* peer.finish();
            yield* waitForThread(f.threadId, (p) =>
              p.attempts.some((a) => a.id === original.activeAttemptId && a.status === "completed"),
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${f.threadId}-replacement`),
              threadId: f.threadId,
              messageId: MessageId.make(`${f.threadId}-replacement`),
              text: "New public owner",
              attachments: [],
              selectedScientSkillNames: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain(8);
            const newer = yield* waitForThread(
              f.threadId,
              (p) =>
                p.providerTurns.length === 2 &&
                p.providerTurns.every((t) => t.acceptedAt !== undefined),
            );
            assert.notEqual(newer.runs[1]!.activeAttemptId, original.activeAttemptId);
            assert.notEqual(newer.providerTurns[1]!.id, turn.id);
            assert.notEqual(
              newer.providerTurns[1]!.nativeTurnRef?.nativeId,
              turn.nativeTurnRef?.nativeId,
            );
            yield* peer.emit([{ type: "agent_start" }]);
            yield* waitForThread(f.threadId, (p) =>
              p.providerSessions.some(
                (s) => s.id === thread.providerSessionId && s.status === "running",
              ),
            );
            yield* f.snapshot("newer-owner-before-release");
          }
          yield* Deferred.succeed(f.prepRelease, undefined);
          const exit = yield* Fiber.join(delivery).pipe(Effect.timeout("10 seconds"));
          if (superseded) {
            assert.isTrue(Exit.isFailure(exit));
            assert.include(encodeJson(exit), "no longer owns this active turn");
            assert.include(encodeJson(exit), '"breaksSession":false');
            assert.deepEqual(
              peer.state.prompts.map((p) => p.frame.type),
              ["prompt", "prompt"],
            );
            assert.equal(peer.state.frames.filter((p) => p.type === "steer").length, 0);
            const current = Option.getOrNull(yield* sessions.get(thread.providerSessionId!));
            assert.strictEqual(current, owner);
            const retained = yield* f.snapshot("superseded-refused");
            assert.equal(
              retained.providerSessions.find((s) => s.id === thread.providerSessionId)?.status,
              "running",
            );
            const newerTurn = retained.providerTurns[1]!;
            const newerRun = retained.runs.find(
              (r) => r.activeAttemptId === newerTurn.runAttemptId,
            )!;
            // Manager publication is a runtime handle, not a mutable status
            // projection. Prove the retained newer generation can still steer.
            yield* current!.steerTurn({
              threadId: f.threadId,
              runId: newerRun.id,
              providerThread: retained.providerThreads.find(
                (t) => t.id === newerTurn.providerThreadId,
              )!,
              providerTurnId: newerTurn.id,
              message: {
                messageId: MessageId.make(`${f.threadId}-newer-steer`),
                text: "Healthy newer captured owner",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            });
            assert.deepEqual(
              peer.state.prompts.map((p) => p.frame.type),
              ["prompt", "prompt", "steer"],
            );
          } else {
            assert.isTrue(Exit.isSuccess(exit));
            yield* worker.drain(8);
            assert.deepEqual(
              peer.state.prompts.map((p) => p.frame.type),
              ["prompt", "steer"],
            );
            assert.include(peer.state.prompts[1]!.frame.message ?? "", "Healthy current owner");
            const projection = yield* f.snapshot("healthy-steer-delivered");
            assert.equal(projection.runs.length, 1);
            assert.equal(projection.providerTurns.length, 1);
            assert.equal(projection.messages.filter((m) => m.id === followupId).length, 1);
          }
          assert.equal(yield* f.fs.readFileString(f.lock()), token);
          assert.equal(f.peers.length, 1);
          assert.equal(peer.state.shutdowns, 0);
          yield* peer.finish();
          yield* waitForThread(f.threadId, (p) =>
            p.attempts.every((a) => a.status === "completed"),
          );
          const final = yield* f.snapshot("terminal-after-release");
          assert.equal(final.providerTurns.length, superseded ? 2 : 1);
          assert.isTrue(final.providerTurns.every((t) => t.status === "completed"));
        }),
      ),
    { timeout: 60_000 },
  );
}

for (const stop of [false, true]) {
  it.live(
    stop
      ? "C387 public Stop during parked OMP startup cleans once and preserves the original Retry owner"
      : "C386 parked healthy OMP startup publishes no ready owner or catalog until the handshake releases",
    () =>
      withNative(`omp-startup-${stop ? "stop" : "healthy"}`, { ready: true }, (f) =>
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const sessions = yield* ProviderSessionManagerV2;
          const receipts = yield* CommandReceiptStoreV2;
          const outbox = yield* EffectOutboxV2;
          const original = yield* f.seed;
          const opening = yield* worker.runOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(f.readyEntered).pipe(Effect.timeout("10 seconds"));
          const parked = yield* f.snapshot("startup-held");
          assert.include(["preparing", "starting"], parked.runs[0]!.status);
          assert.equal(parked.providerTurns.length, 0);
          assert.equal(parked.providerSessions.filter((s) => s.status === "ready").length, 0);
          for (const s of parked.providerSessions)
            assert.isTrue(Option.isNone(yield* sessions.get(s.id)));
          assert.equal(f.peers.length, 1);
          assert.equal(f.peers[0]!.state.frames.length, 0);
          assert.equal(f.nativeReadyFrames(), 0);
          assert.isTrue(yield* f.fs.exists(f.lock()));
          assert.isUndefined(opening.pollUnsafe());
          if (stop) {
            const stopId = CommandId.make(`${f.threadId}-stop`);
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: stopId,
              threadId: f.threadId,
              runId: original.id,
            });
            assert.equal(
              Option.getOrNull(yield* receipts.getByCommandId(stopId))?.status,
              "accepted",
            );
            yield* Fiber.join(opening).pipe(Effect.timeout("10 seconds"));
            const cancelled = yield* f.snapshot("startup-stop-cleaned");
            assert.equal(
              cancelled.attempts.find((a) => a.id === original.activeAttemptId)?.status,
              "interrupted",
            );
            assert.equal(f.peers[0]!.state.shutdowns, 1);
            assert.equal(f.shutdownCalls(), 1);
            assert.isFalse(yield* f.fs.exists(f.lock(0)));
            const originalEffects = yield* outbox.listByCommandId(
              CommandId.make(`${f.threadId}-start`),
            );
            assert.isTrue(
              originalEffects.some(
                (e) => e.request.type === "provider-turn.start" && e.status === "cancelled",
              ),
            );
            // V2 Retry is a new public dispatch of the preserved original message;
            // the prior interrupted attempt remains immutable and explicit.
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${f.threadId}-retry`),
              threadId: f.threadId,
              messageId: f.messageId,
              text: cancelled.messages.find((m) => m.id === f.messageId)!.text,
              attachments: [],
              selectedScientSkillNames: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
          } else {
            yield* Deferred.succeed(f.readyRelease, undefined);
            yield* Fiber.join(opening).pipe(Effect.timeout("10 seconds"));
          }
          yield* worker.drain(8);
          const peer = f.peers.at(-1)!;
          yield* peer.promptDelivered().pipe(Effect.timeout("10 seconds"));
          const accepted = yield* waitForThread(f.threadId, (p) =>
            p.providerTurns.some((t) => t.acceptedAt !== undefined),
          );
          const run = accepted.runs.find(
            (r) => r.id === accepted.messages.find((m) => m.id === f.messageId)!.runId,
          )!;
          assert.equal(accepted.messages.filter((m) => m.id === f.messageId).length, 1);
          assert.deepEqual(run.modelSelection, f.selection);
          assert.equal(run.runtimeMode, "full-access");
          assert.equal(run.interactionMode, "default");
          assert.equal(peer.state.prompts.length, 1);
          assert.include(
            peer.state.prompts[0]!.frame.message ?? "",
            "Retain the original controlled request",
          );
          assert.equal(f.peers.length, stop ? 2 : 1);
          assert.equal(f.nativeReadyFrames(), 1);
          if (stop) {
            assert.notEqual(run.id, original.id);
            assert.notEqual(run.activeAttemptId, original.activeAttemptId);
            assert.equal(f.peers[0]!.state.shutdowns, 1);
            assert.equal(
              yield* f.fs.readFileString(f.lock(0)),
              yield* f.fs.readFileString(f.lock(1)),
            );
          }
          const token = yield* f.fs.readFileString(f.lock());
          const ownerId = accepted.providerThreads.find(
            (t) => t.id === run.providerThreadId,
          )!.providerSessionId!;
          assert.ok(Option.getOrNull(yield* sessions.get(ownerId)));
          yield* peer.finish();
          yield* waitForThread(f.threadId, (p) =>
            p.attempts.some((a) => a.id === run.activeAttemptId && a.status === "completed"),
          );
          yield* f.snapshot("startup-final-owned");
          assert.equal(yield* f.fs.readFileString(f.lock()), token);
          assert.equal(peer.state.shutdowns, 0);
        }),
      ),
    { timeout: 60_000 },
  );
}

for (const cancelRestart of [false, true]) {
  it.live(
    cancelRestart
      ? "C389 public Stop cancels the exact restart waiting on the original held OMP shutdown"
      : "C388 two public Stops finish one held OMP shutdown before the original durable restart executes once",
    () =>
      withNative(
        `omp-close-${cancelRestart ? "cancel-restart" : "restart"}`,
        { close: true },
        (f) =>
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            const outbox = yield* EffectOutboxV2;
            const receipts = yield* CommandReceiptStoreV2;
            const sessions = yield* ProviderSessionManagerV2;
            const original = yield* f.seed;
            yield* worker.drain(8);
            const peer = f.peers[0]!;
            yield* peer.promptDelivered().pipe(Effect.timeout("10 seconds"));
            yield* peer.emit([{ type: "agent_start" }]);
            const active = yield* waitForThread(
              f.threadId,
              (p) =>
                p.runs.some((r) => r.id === original.id && r.status === "running") &&
                p.providerTurns.some(
                  (t) => t.runAttemptId === original.activeAttemptId && t.acceptedAt !== undefined,
                ),
            );
            yield* worker.drain(8);
            const turn = active.providerTurns[0]!;
            const ownerId = active.providerThreads.find(
              (t) => t.id === turn.providerThreadId,
            )!.providerSessionId!;
            const owner = Option.getOrThrow(yield* sessions.get(ownerId));
            const subscription = yield* owner.subscribeEvents!;
            const finalPrefix = yield* subscription.events.pipe(
              Stream.runCollect,
              Effect.forkScoped,
            );
            const originalToken = yield* f.fs.readFileString(f.lock());
            const originalMessage = active.messages.find((m) => m.id === f.messageId)!;
            const firstStop = CommandId.make(`${f.threadId}-stop-1`);
            const secondStop = CommandId.make(`${f.threadId}-stop-2`);
            const restart = CommandId.make(`${f.threadId}-restart`);
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: firstStop,
              threadId: f.threadId,
              runId: original.id,
            });
            yield* f.phase("first-stop-dispatched", {
              commandId: firstStop,
              runId: original.id,
              originalAttemptId: original.activeAttemptId,
              providerTurnId: turn.id,
              nativeTurnRef: turn.nativeTurnRef,
              providerThreadId: turn.providerThreadId,
            });
            const closing = yield* worker.runOnce.pipe(Effect.forkScoped);
            yield* Deferred.await(f.closeEntered).pipe(Effect.timeout("10 seconds"));
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: secondStop,
              threadId: f.threadId,
              runId: original.id,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: restart,
              threadId: f.threadId,
              messageId: f.messageId,
              text: originalMessage.text,
              attachments: originalMessage.attachments,
              selectedScientSkillNames: originalMessage.selectedScientSkillNames,
              dispatchMode: { type: "restart_active", targetRunId: original.id },
              createdBy: originalMessage.createdBy,
              creationSource: originalMessage.creationSource,
            });
            const held = yield* f.snapshot("restart-requested-before-cleanup-release");
            const waiting = held.runs.find((r) => r.id === original.id)!;
            assert.equal(waiting.status, "starting");
            assert.notEqual(waiting.activeAttemptId, original.activeAttemptId);
            assert.equal(
              held.attempts.find((a) => a.id === waiting.activeAttemptId)?.reason,
              "steering_restart",
            );
            assert.equal(
              held.attempts.find((a) => a.id === waiting.activeAttemptId)?.providerTurnId,
              null,
            );
            assert.equal(held.messages.filter((m) => m.id === f.messageId).length, 1);
            for (const id of [firstStop, secondStop, restart])
              assert.equal(
                Option.getOrNull(yield* receipts.getByCommandId(id))?.status,
                "accepted",
              );
            assert.equal((yield* outbox.listByCommandId(firstStop))[0]!.status, "running");
            assert.equal((yield* outbox.listByCommandId(secondStop))[0]!.status, "pending");
            const pending = (yield* outbox.listByCommandId(restart)).find(
              (e) => e.request.type === "provider-turn.restart",
            )!;
            assert.equal(pending.status, "pending");
            assert.equal(
              pending.request.type === "provider-turn.restart"
                ? pending.request.interruptedAttemptId
                : null,
              original.activeAttemptId,
            );
            assert.equal(f.peers.length, 1);
            assert.equal(f.shutdownCalls(), 1);
            assert.equal(peer.state.shutdowns, 0);
            assert.equal(yield* f.fs.readFileString(f.lock()), originalToken);
            assert.isUndefined(closing.pollUnsafe());
            if (cancelRestart) {
              const stopWaiting = CommandId.make(`${f.threadId}-stop-waiting-restart`);
              yield* orchestrator.dispatch({
                type: "run.interrupt",
                commandId: stopWaiting,
                threadId: f.threadId,
                runId: waiting.id,
              });
              assert.equal(
                Option.getOrNull(yield* receipts.getByCommandId(stopWaiting))?.status,
                "accepted",
              );
              const stopped = yield* f.snapshot("waiting-restart-public-stop");
              assert.equal(stopped.runs.find((r) => r.id === waiting.id)?.status, "interrupted");
              assert.equal(
                stopped.attempts.find((a) => a.id === waiting.activeAttemptId)?.status,
                "interrupted",
              );
              assert.equal(Option.getOrNull(yield* outbox.get(pending.id))?.status, "cancelled");
            }
            // Run the existing production daemon; its real outbox admission excludes
            // these requests until the running interrupt effect finishes cleanup.
            yield* f.phase("restart-held", {
              firstStop,
              secondStop,
              restart,
              restartEffectId: pending.id,
              replacementAttemptId: waiting.activeAttemptId,
            });
            const daemon = yield* runDaemon.pipe(Effect.forkScoped);
            yield* f.phase("shutdown-release-entry");
            yield* Deferred.succeed(f.closeRelease, undefined);
            yield* f.phase("shutdown-release-completed");
            yield* f.phase("original-effect-join-entry");
            const joined = yield* Fiber.join(closing).pipe(Effect.timeout("10 seconds"));
            yield* f.phase("original-effect-join-completed", { joined });
            for (const id of [firstStop, secondStop]) {
              yield* f.phase("stop-completion-entry", { commandId: id });
              const effects = yield* waitForEffects(
                id,
                (es) => es.length > 0 && es.every((e) => e.status === "succeeded"),
              );
              yield* f.phase("stop-completion-completed", { commandId: id, effects });
              assert.equal(effects.length, 1);
              assert.equal(effects[0]!.attemptCount, 1);
            }
            yield* f.phase("restart-completion-entry", {
              commandId: restart,
              effectId: pending.id,
            });
            const result = yield* waitForEffects(restart, (es) =>
              es.some(
                (e) =>
                  e.id === pending.id && e.status === (cancelRestart ? "cancelled" : "succeeded"),
              ),
            );
            yield* f.phase("restart-completion-completed", { effects: result });
            assert.equal(
              result.find((e) => e.id === pending.id)?.attemptCount,
              cancelRestart ? 0 : 1,
            );
            if (cancelRestart) {
              yield* waitForThread(f.threadId, (p) =>
                p.providerTurns.some(
                  (t) =>
                    t.id === turn.id &&
                    t.providerThreadId === turn.providerThreadId &&
                    t.runAttemptId === original.activeAttemptId &&
                    t.status === "interrupted",
                ),
              );
            }
            const prefix = Array.from(
              yield* Fiber.join(finalPrefix).pipe(Effect.timeout("10 seconds")),
            );
            yield* observe(`${f.threadId}.exact-owner-drained-prefix`, prefix);
            const terminals = prefix.filter(
              (e) => e.type === "turn.terminal" && e.providerTurnId === turn.id,
            );
            assert.equal(terminals.length, 1);
            assert.deepInclude(terminals[0], {
              status: "interrupted",
              threadDisposition: "broken",
            });
            assert.isTrue(
              prefix.some(
                (e, i) =>
                  i > prefix.indexOf(terminals[0]!) &&
                  e.type === "provider_session.updated" &&
                  e.providerSession.status === "stopped",
              ),
            );
            const journal = f.journals[0]!;
            const written = Buffer.concat(journal.written);
            const read = Buffer.concat(journal.read);
            const frames: unknown[] = [];
            for (let offset = 0; offset < written.length;) {
              const length = written.readUInt32BE(offset);
              frames.push(
                ...(yield* decodeJournalFrames(
                  written.subarray(offset + 4, offset + 4 + length).toString(),
                )),
              );
              offset += 4 + length;
            }
            yield* observe(`${f.threadId}.exact-owner-journal-drain`, {
              writtenBytes: written.length,
              readBytes: read.length,
              writtenSha256: digest(written.toString("hex")),
              readSha256: digest(read.toString("hex")),
              frames,
              prefix,
            });
            assert.isAbove(written.length, 0);
            assert.deepEqual(read, written);
            assert.isFalse(yield* f.fs.exists(journal.path));
            const after = yield* f.snapshot("close-and-original-request-settled");
            assert.equal(peer.state.shutdowns, 1);
            assert.equal(f.shutdownCalls(), 1);
            assert.equal(after.providerTurns.find((t) => t.id === turn.id)?.status, "interrupted");
            assert.equal(after.messages.filter((m) => m.id === f.messageId).length, 1);
            if (cancelRestart) {
              assert.equal(f.peers.length, 1);
              assert.isFalse(yield* f.fs.exists(f.lock(0)));
              for (const s of after.providerSessions)
                assert.isTrue(Option.isNone(yield* sessions.get(s.id)));
              assert.equal(after.providerTurns.length, 1);
            } else {
              yield* f.phase("replacement-acceptance-entry", {
                runId: original.id,
                attemptId: waiting.activeAttemptId,
              });
              const accepted = yield* waitForThread(f.threadId, (p) =>
                p.providerTurns.some(
                  (t) => t.runAttemptId === waiting.activeAttemptId && t.acceptedAt !== undefined,
                ),
              );
              const replacement = f.peers[1]!;
              const nextTurn = accepted.providerTurns.find(
                (t) => t.runAttemptId === waiting.activeAttemptId,
              )!;
              yield* f.phase("replacement-acceptance-completed", {
                providerTurn: nextTurn,
                providerThreads: accepted.providerThreads,
              });
              assert.equal(accepted.runs.length, 1);
              assert.equal(accepted.runs[0]!.activeAttemptId, waiting.activeAttemptId);
              assert.equal(accepted.attempts.length, 2);
              assert.notEqual(nextTurn.id, turn.id);
              assert.notEqual(nextTurn.nativeTurnRef?.nativeId, turn.nativeTurnRef?.nativeId);
              assert.equal(f.peers.length, 2);
              assert.equal(replacement.state.prompts.length, 1);
              assert.include(
                replacement.state.prompts[0]!.frame.message ?? "",
                originalMessage.text,
              );
              assert.deepEqual(
                accepted.messages.find((m) => m.id === f.messageId)?.attachments,
                originalMessage.attachments,
              );
              assert.deepEqual(accepted.runs[0]!.modelSelection, f.selection);
              const token = yield* f.fs.readFileString(f.lock(1));
              assert.notEqual(token, originalToken);
              assert.equal(yield* f.fs.readFileString(f.lock(0)), token);
              const ownerId = accepted.providerThreads.find(
                (t) => t.id === nextTurn.providerThreadId,
              )!.providerSessionId!;
              assert.ok(Option.getOrNull(yield* sessions.get(ownerId)));
              yield* replacement.finish();
              yield* waitForThread(f.threadId, (p) =>
                p.attempts.some(
                  (a) => a.id === waiting.activeAttemptId && a.status === "completed",
                ),
              );
              yield* f.snapshot("replacement-completed-lock-preserved");
              assert.equal(yield* f.fs.readFileString(f.lock(1)), token);
              assert.equal(peer.state.shutdowns, 1);
              assert.equal(replacement.state.shutdowns, 0);
            }
            yield* Fiber.interrupt(daemon);
          }),
      ),
    { timeout: 60_000 },
  );
}

it.live(
  "C398 redispatches one exact follow-up prompt when the predecessor completes during actual OMP payload preparation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const cwd = yield* checkpointWorkspace("omp-native-conjunction", {
          ".scient/skills/project-method/SKILL.md":
            "---\nname: project-method\ndescription: Controlled OMP conjunction.\n---\n\nRetain exact inputs.\n",
        });
        const home = path.join(config.stateDir, "synthetic-home");
        yield* fs.makeDirectory(home);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        let holdPreparation = false;
        let sessionRoot = "";
        let launches = 0;
        const instanceId = ProviderInstanceId.make("omp-native-conjunction-instance");
        const threadId = ThreadId.make("omp-native-conjunction-thread");
        const followupId = MessageId.make("omp-native-conjunction-followup");
        const followupCommand = CommandId.make("omp-native-conjunction-steer");
        const selection = {
          instanceId,
          model: "controlled/model",
          options: [{ id: "thinkingLevel", value: "high" }],
        };
        const peer = scriptedOmpRpc({
          models: [
            {
              provider: "controlled",
              id: "model",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 200_000,
              thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "low" },
            },
          ],
          initial: { provider: "controlled", id: "model" },
          environment: { HOME: home },
        });
        const adapter = makeOmpAdapterV2({
          target: ompTarget,
          instanceId,
          settings: { binaryPath: "synthetic-omp", homePath: home },
          environment: { HOME: home },
          fileSystem: fs,
          path,
          crypto: yield* Crypto.Crypto,
          spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          idAllocator: yield* IdAllocatorV2,
          serverConfig: config,
          continuations: { offer: () => Effect.void },
          nativeEventLogger: {
            filePath: "synthetic-evidence-only",
            write: (event) => observe("native.rpc", event),
            close: () => Effect.void,
          },
          makeProcess: (options) =>
            Effect.gen(function* () {
              launches++;
              sessionRoot = options.sessionDir ?? "";
              yield* observe("native.open", { launches, options });
              const client = yield* peer.makeProcess(options);
              return {
                ...client,
                // The normal generic owner validation has already returned when
                // production OMP payload preparation reaches this transport seam.
                limits: Effect.suspend(() => {
                  if (!holdPreparation) return client.limits;
                  holdPreparation = false;
                  return observe("preparation.entered", { launches }).pipe(
                    Effect.andThen(Deferred.succeed(entered, undefined)),
                    Effect.andThen(Deferred.await(release)),
                    Effect.timeout("10 seconds"),
                    Effect.orDie,
                    Effect.andThen(client.limits),
                  );
                }),
              };
            }),
        });
        const database = makeSqlitePersistenceLive(config.dbPath).pipe(
          Layer.provide(NodeServices.layer),
        );
        const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "omp-native-conjunction", runtimePolicyOverride: { cwd } },
          makeLayer([adapter]),
          {
            databaseLayer: database,
            serverConfigLayer: Layer.succeed(ServerConfig.ServerConfig, config),
            configureMcp: false,
            runEffectWorker: false,
          },
        ).pipe(Layer.provideMerge(database));
        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const receipts = yield* CommandReceiptStoreV2;
          const sessions = yield* ProviderSessionManagerV2;
          const sql = yield* SqlClient.SqlClient;
          const lockPath = () => path.join(sessionRoot, ".session.lock");
          const snapshot = Effect.fnUntraced(function* (phase: string) {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
              WHERE type = 'table' AND name LIKE 'orchestration%' ORDER BY name`;
            const rows: Record<string, unknown> = {};
            for (const { name } of tables)
              rows[name] = yield* sql.unsafe(`SELECT * FROM "${name}"`);
            const owner = projection.providerSessions[0];
            const current = owner ? yield* sessions.get(owner.id) : Option.none();
            const files: Record<string, string> = {};
            if (sessionRoot && (yield* fs.exists(sessionRoot))) {
              for (const name of yield* fs.readDirectory(sessionRoot)) {
                const file = path.join(sessionRoot, name);
                if ((yield* fs.stat(file)).type === "File")
                  files[name] = yield* fs.readFileString(file);
              }
            }
            yield* observe(phase, {
              projection,
              rows,
              files,
              launches,
              publishedOwner: Option.isSome(current) ? current.value.providerSession : null,
              wire: peer.state.frames,
              nativeState: peer.state,
            });
            return projection;
          });
          const waitFor = Effect.fnUntraced(function* (
            predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
          ) {
            const cursor = yield* orchestrator.getThreadEventSequence(threadId);
            const pull = yield* Stream.toPull(
              orchestrator.streamStoredEventsFrom({
                threadId,
                afterSequence: cursor,
              }),
            );
            const found = yield* Stream.concat(
              Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
              Stream.fromPull(Effect.succeed(pull)).pipe(
                Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
              ),
            ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("10 seconds"));
            if (Option.isNone(found)) return yield* Effect.die("Native SQL did not converge");
            return found.value;
          });
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(
              Effect.andThen(sessions.closeInstance(instanceId)),
              Effect.andThen(
                Effect.gen(function* () {
                  yield* observe("cleanup.closed", {
                    shutdowns: peer.state.shutdowns,
                    lockExists: sessionRoot ? yield* fs.exists(lockPath()) : false,
                    launches,
                  });
                }),
              ),
              Effect.orDie,
            ),
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("omp-native-conjunction-create"),
            threadId,
            projectId: ProjectId.make("omp-native-conjunction-project"),
            title: "Actual native preparation race",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("omp-native-conjunction-start"),
            threadId,
            messageId: MessageId.make("omp-native-conjunction-first"),
            text: "Foreground",
            attachments: [],
            selectedScientSkillNames: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain(8);
          yield* peer.promptDelivered().pipe(Effect.timeout("10 seconds"));
          yield* peer.emit([{ type: "agent_start" }]);
          const active = yield* waitFor((p) =>
            p.providerTurns.some((t) => t.acceptedAt !== undefined),
          );
          const first = active.runs[0]!;
          const firstTurn = active.providerTurns[0]!;
          assert.equal(firstTurn.runAttemptId, first.activeAttemptId);
          const token = yield* fs.readFileString(lockPath());
          const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
          const attachments = yield* persistChatAttachments({
            threadId,
            messageId: followupId,
            attachments: [
              {
                type: "image",
                name: "current.png",
                mimeType: "image/png",
                sizeBytes: bytes.length,
                dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
              },
            ],
          });
          yield* worker.drain(8);
          holdPreparation = true;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: followupCommand,
            threadId,
            messageId: followupId,
            text: "$project-method inspect the current image exactly once.",
            attachments,
            selectedScientSkillNames: ["project-method"],
            dispatchMode: { type: "steer_active", targetRunId: first.id },
            createdBy: "user",
            creationSource: "web",
          });
          assert.equal(
            Option.getOrNull(yield* receipts.getByCommandId(followupCommand))?.status,
            "accepted",
          );
          const delivery = yield* worker.runOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"));
          const prepared = yield* snapshot("sql.preparation-held");
          assert.equal(
            prepared.providerTurns.find((t) => t.id === firstTurn.id)?.status,
            "running",
          );
          assert.deepEqual(
            peer.state.prompts.map((p) => p.frame.type),
            ["prompt"],
          );
          yield* peer.finish();
          // The provider-turn update precedes the subscriber's canonical
          // terminal transaction. Await that exact attempt, not its queue hint.
          yield* waitFor(
            (p) =>
              p.providerTurns.some((t) => t.id === firstTurn.id && t.status === "completed") &&
              p.attempts.some((a) => a.id === first.activeAttemptId && a.status === "completed"),
          );
          const terminal = yield* snapshot("sql.terminal-before-release");
          assert.equal(
            terminal.attempts.find((a) => a.id === first.activeAttemptId)?.status,
            "completed",
          );
          assert.equal(yield* fs.readFileString(lockPath()), token);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(delivery).pipe(Effect.timeout("10 seconds"));
          yield* worker.drain(16);
          const final = yield* snapshot("sql.delivery-after-release");
          // Decide the native endpoint before waiting for a consequence that a
          // successful idle Steer need not produce on a scripted peer.
          assert.deepEqual(
            peer.state.prompts.map((p) => p.frame.type),
            ["prompt", "prompt"],
          );
          assert.equal(peer.state.frames.filter((f) => f.type === "steer").length, 0);
          const accepted = yield* waitFor(
            (p) =>
              p.providerTurns.length === 2 &&
              p.providerTurns.every((t) => t.acceptedAt !== undefined),
          );
          const message = accepted.messages.find((m) => m.id === followupId)!;
          const followup = accepted.runs.find((r) => r.id === message.runId)!;
          assert.equal(accepted.messages.filter((m) => m.id === followupId).length, 1);
          assert.equal(final.messages.filter((m) => m.id === followupId).length, 1);
          assert.notEqual(followup.id, first.id);
          assert.notEqual(followup.activeAttemptId, first.activeAttemptId);
          const followupTurn = accepted.providerTurns.find(
            (t) => t.runAttemptId === followup.activeAttemptId,
          )!;
          assert.notEqual(followupTurn.id, firstTurn.id);
          assert.notEqual(followupTurn.nativeTurnRef?.nativeId, firstTurn.nativeTurnRef?.nativeId);
          assert.deepEqual(followup.modelSelection, selection);
          assert.equal(followup.runtimeMode, "full-access");
          assert.equal(followup.interactionMode, "default");
          assert.deepEqual(message.attachments, attachments);
          assert.deepEqual(message.selectedScientSkillNames, ["project-method"]);
          assert.equal(message.text, "$project-method inspect the current image exactly once.");
          assert.include(peer.state.prompts[1]!.frame.message ?? "", message.text);
          const expectedImages = [
            {
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: "image/png",
            },
          ];
          assert.deepEqual(peer.state.prompts[1]!.frame.images, expectedImages);
          assert.equal(peer.state.thinkingLevel, "high");
          assert.equal(yield* fs.readFileString(lockPath()), token);
          assert.equal(launches, 1);
        }).pipe(Effect.provide(runtime));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            idAllocatorLayer,
            ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-conjunction-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      ),
    ),
  { timeout: 60_000 },
);
