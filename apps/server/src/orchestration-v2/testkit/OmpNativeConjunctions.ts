// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as ServerConfig from "../../config.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ompTarget } from "../../provider/omp/OmpTarget.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import { makeOmpAdapterV2 } from "../Adapters/OmpAdapterV2.ts";
import { EffectOutboxV2, type OrchestrationEffectV2 } from "../EffectOutbox.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";

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

// This observer neither drives the worker nor adds a settlement deadline.
const nativeSettlementTrace = (
  threadId: ThreadId,
  services: {
    orchestrator: OrchestratorV2["Service"];
    outbox: EffectOutboxV2["Service"];
    receipts: CommandReceiptStoreV2["Service"];
  },
) => {
  let lastWait = "setup";
  const drains: Array<{ phase: string; maxEffects: number; count: number | null }> = [];
  const admissionCommands: CommandId[] = [];
  const at = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      lastWait = phase;
      return effect;
    });
  const drain = <E, R>(phase: string, maxEffects: number, effect: Effect.Effect<number, E, R>) =>
    Effect.suspend(() => {
      const result = { phase, maxEffects, count: null as number | null };
      drains.push(result);
      return effect.pipe(
        Effect.tap((count) =>
          Effect.sync(() => {
            result.count = count;
          }),
        ),
      );
    });
  const read = Effect.fnUntraced(function* (phase: string, native: unknown) {
    const { orchestrator, outbox, receipts } = services;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const admissions = yield* Effect.forEach(admissionCommands, (commandId) =>
      Effect.gen(function* () {
        return {
          commandId,
          receipt: Option.getOrNull(yield* receipts.getByCommandId(commandId)),
          effects: yield* outbox.listByCommandId(commandId),
        };
      }),
    );
    const canonicalEffects = yield* Effect.forEach(projection.runs, (run) =>
      Effect.gen(function* () {
        return {
          runId: run.id,
          checkpointCommandId: `command:effect:checkpoint.capture:${run.id}`,
          checkpointEffectId: `effect:checkpoint.capture:${run.id}`,
          checkpoint: Option.getOrNull(yield* outbox.get(`effect:checkpoint.capture:${run.id}`)),
          // System promotion has an outbox command ID, but no command receipt.
          queuedStarts: yield* Effect.forEach(
            projection.attempts.filter((attempt) => attempt.runId === run.id),
            (attempt) => {
              const commandId = `command:system:start-queued:${run.id}:${attempt.id}`;
              const effectId = `effect:${commandId}:provider-turn.start:${run.id}`;
              return outbox.get(effectId).pipe(
                Effect.map((row) => ({
                  attemptId: attempt.id,
                  commandId,
                  effectId,
                  row: Option.getOrNull(row),
                })),
              );
            },
          ),
        };
      }),
    );
    const witness = {
      threadId,
      phase,
      lastWait,
      drains,
      admissions,
      canonicalEffects,
      projection,
      native,
    };
    yield* Effect.log("NATIVE_SETTLEMENT_WITNESS", witness);
    yield* observe(`${threadId}.${phase}`, witness);
  });
  const capture = (phase: string, native: unknown) =>
    read(phase, native).pipe(
      Effect.timeout("2 seconds"),
      Effect.catchCause((observerCause) =>
        Effect.logWarning("Native settlement observer failed", {
          threadId,
          phase,
          lastWait,
          drains,
          native,
          observerCause,
        }),
      ),
      Effect.withLogger(
        Logger.withConsoleLog(
          Logger.make(({ message }) => NodeUtil.inspect(message, { depth: 12 })),
        ),
      ),
    );
  const failure = (cause: unknown, native: unknown) =>
    capture("failure-before-cleanup", { cause, native });
  return { at, drain, capture, failure, admissionCommands };
};

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
export {
  encodeJson,
  decodeJournalFrames,
  digest,
  observe,
  nativeSettlementTrace,
  waitForThread,
  waitForEffects,
  withNative,
};
