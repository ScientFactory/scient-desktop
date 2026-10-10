import * as Crypto from "effect/Crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  RunAttemptId,
  NodeId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as CodexClient from "effect-codex-app-server/client";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Predicate from "effect/Predicate";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeCodexAdapterV2 } from "../Adapters/CodexAdapterV2.ts";
import type { CodexAppServerClientFactory } from "../Adapters/CodexAdapterV2.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { ProviderAdapterEventStreamError } from "@t3tools/provider-core/server/ProviderAdapter";
import { EventSinkV2 } from "../EventSink.ts";
import { EventStoreV2 } from "../EventStore.ts";
import { LegacyV1ThreadImporter } from "../legacy/LegacyV1ThreadImporter.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { nativeModelWindowKey } from "../scient-fork/NativeModelContextWindow.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
// SCIENT-FORK:START — failure-only evidence before the synthetic server unwinds.
import { ScientCapacityFailureObservation } from "./ScientCapacityFailureObservation.test-support.ts";
// SCIENT-FORK:END

const instanceId = ProviderInstanceId.make("codex");
const selection = { instanceId, model: "gpt-5.4" };
const defaultSettings = Schema.decodeSync(CodexSettings)({});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Number),
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const decodeTurnInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    threadId: Schema.String,
    input: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
);
const decodeResumeInput = Schema.decodeUnknownEffect(Schema.Struct({ threadId: Schema.String }));
const turn = (id: string, status: "inProgress" | "completed") => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 1782622440,
  completedAt: status === "completed" ? 1782622450 : null,
  durationMs: null,
});
const nativeThread = (id: string, cwd: string) => ({
  id,
  sessionId: id,
  forkedFromId: null,
  preview: "",
  projectId: null,
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1782622440,
  updatedAt: 1782622440,
  status: { type: "idle" },
  path: `/synthetic/${id}.jsonl`,
  cwd,
  cliVersion: "0.156.1",
  source: "vscode",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
});
const waitFor = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (p: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const found = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  return Option.getOrThrow(found);
});

let nextNativeThreadId = 0;
let nextNativeTurnId = 0;

// Select scalar Cause facts only at failure publication; raw references never reach JSON.
const startupCauseFacts = (original: unknown) => {
  const pending = [{ value: original, path: "cause", depth: 0 }];
  const seen = new WeakSet<object>();
  const facts: Array<Readonly<Record<string, unknown>>> = [];
  const truncated: string[] = [];
  const releaseReasons: string[] = [];
  let visited = 0;
  while (pending.length > 0 && visited++ < 128) {
    const entry = pending.shift()!;
    if (entry.depth > 64) {
      truncated.push(`${entry.path}: depth limit`);
      continue;
    }
    const { value, path } = entry;
    if (typeof value === "string") {
      const release = /^Provider session released: ([a-z_]{1,80})\.$/.exec(value);
      if (release !== null) {
        releaseReasons.push(release[1]!);
        facts.push({ path, releaseReason: release[1] });
      } else facts.push({ path, unavailable: "non-release text omitted" });
      continue;
    }
    if (!Predicate.isObjectOrArray(value)) continue;
    if (seen.has(value)) {
      truncated.push(`${path}: repeated reference`);
      continue;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 16) truncated.push(`${path}: array limit`);
      for (let i = 0; i < Math.min(value.length, 16); i++)
        pending.push({ value: value[i], path: `${path}[${i}]`, depth: entry.depth + 1 });
      continue;
    }
    const selected: Record<string, unknown> = { path };
    for (const key of ["_tag", "name", "code", "providerSessionId"]) {
      const scalar = Reflect.get(value, key);
      if (typeof scalar === "number" && Number.isFinite(scalar)) selected[key] = scalar;
      else if (typeof scalar === "string") {
        // Tags/codes/synthetic IDs only: no arbitrary error message, frame or payload.
        selected[key] = /^[a-zA-Z0-9_:./-]{1,200}$/.test(scalar)
          ? scalar
          : { unavailable: "non-identifier scalar omitted" };
      }
    }
    if (Object.keys(selected).length > 1) facts.push(selected);
    for (const key of ["reasons", "error", "cause", "defect", "message"]) {
      if (key in value)
        pending.push({
          value: Reflect.get(value, key),
          path: `${path}.${key}`,
          depth: entry.depth + 1,
        });
    }
  }
  if (pending.length > 0) truncated.push("node limit: remaining Cause branches unavailable");
  return {
    facts,
    truncated,
    releaseReasons:
      releaseReasons.length > 0
        ? releaseReasons
        : { unavailable: "no release reason witnessed in selected Cause branches" },
  };
};

/** One bounded accumulator for the existing peer and warning; it never publishes on success. */
class CapacityStartupObservation {
  private readonly expectedRuns = new Set<string>();
  private readonly ingestion: Array<{ readonly runId: string; readonly originalCause: unknown }> =
    [];
  private readonly peers: Array<{
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly phases: Array<{
      readonly sequence: number;
      readonly phase: string;
      readonly method?: string;
    }>;
    processExits: number;
    lastProcessExit?: Exit.Exit<unknown, unknown>;
    failedProcessExit?: Exit.Exit<unknown, unknown>;
    resourceExit?: Exit.Exit<unknown, unknown>;
  }> = [];
  private sequence = 0;
  private dropped = 0;

  safely(observe: () => void) {
    try {
      observe();
    } catch {
      this.dropped++;
    }
  }

  expectRun(runId: string) {
    this.safely(() => {
      if (this.expectedRuns.size < 32) this.expectedRuns.add(runId);
      else this.dropped++;
    });
  }

  readonly logger = Logger.make<unknown, void>(({ message }) => {
    this.safely(() => {
      if (
        !Array.isArray(message) ||
        message[0] !== "orchestration V2 provider event ingestion failed"
      )
        return;
      const detail: unknown = message[1];
      if (!Predicate.isObject(detail)) return;
      const runId = Reflect.get(detail, "runId");
      if (typeof runId !== "string" || !this.expectedRuns.has(runId)) return;
      if (this.ingestion.length === 16) {
        this.dropped++;
        return;
      }
      this.ingestion.push({ runId, originalCause: Reflect.get(detail, "cause") });
    });
  });

  open(threadId: ThreadId, providerSessionId: ProviderSessionId) {
    const peer = {
      threadId,
      providerSessionId,
      phases: [],
      processExits: 0,
    } as CapacityStartupObservation["peers"][number];
    this.safely(() => {
      if (this.peers.length < 32) this.peers.push(peer);
      else this.dropped++;
    });
    return peer;
  }

  mark(peer: CapacityStartupObservation["peers"][number], phase: string, method?: string) {
    this.safely(() => {
      if (peer.phases.length === 32) {
        peer.phases.shift();
        this.dropped++;
      }
      peer.phases.push({
        sequence: ++this.sequence,
        phase,
        ...(method === undefined ? {} : { method }),
      });
    });
  }

  snapshot() {
    try {
      const exitFacts = (exit: Exit.Exit<unknown, unknown> | undefined) =>
        exit === undefined
          ? { unavailable: "Exit not witnessed before snapshot" }
          : {
              tag: exit._tag,
              ...(Exit.isFailure(exit) ? { cause: startupCauseFacts(exit.cause) } : {}),
            };
      return {
        ingestion:
          this.ingestion.length === 0
            ? { unavailable: "no matching structured ingestion warning captured" }
            : this.ingestion.map((entry) => ({
                runId: entry.runId,
                cause: startupCauseFacts(entry.originalCause),
              })),
        peers: this.peers.map((peer) => ({
          threadId: peer.threadId,
          providerSessionId: peer.providerSessionId,
          phases: peer.phases,
          processExits: peer.processExits,
          lastProcessExit: exitFacts(peer.lastProcessExit),
          failedProcessExit: exitFacts(peer.failedProcessExit),
          resourceExit: exitFacts(peer.resourceExit),
        })),
        dropped: this.dropped,
        releaseInitiator: { unavailable: "private caller/fiber/generation not witnessed" },
      };
    } catch {
      return { unavailable: "startup observation failed; original test Cause is unchanged" };
    }
  }

  publish(snapshot: unknown) {
    // Preserve the existing single failure-only callback/output semantics.
    const selected = this.snapshot();
    const text = encodeJson({ ...Object(snapshot), startup: selected }) + "\n";
    const destination = process.env.T3_CAPACITY_DIAGNOSTIC_OUTPUT;
    if (destination === undefined) NodeFS.writeSync(2, text);
    else NodeFS.writeFileSync(destination, text, { flag: "wx" });
  }
}

/** Only external JSONL is controlled: decoding, native adapter, manager and worker are production. */
const makePeer = (autoComplete: boolean, startup: CapacityStartupObservation) =>
  Effect.sync(() => {
    const opened: Array<{
      readonly started: Deferred.Deferred<void>;
      readonly closed: Deferred.Deferred<void>;
      readonly nativeId: string;
      readonly turnId: string;
      readonly appThreadId: ThreadId;
      readonly emit: (frame: unknown) => Effect.Effect<boolean>;
      readonly usage: (
        maxTokens: number | null | undefined,
        thread?: string,
        turn?: string,
      ) => Effect.Effect<boolean>;
      readonly complete: Effect.Effect<boolean>;
      readonly offered: string[];
      readonly injections: unknown[];
    }> = [];
    return {
      opened,
      open: (input: Parameters<CodexAppServerClientFactory["Service"]["open"]>[0]) =>
        Effect.gen(function* () {
          assert.isTrue(Object.isFrozen(input.settings));
          assert.isTrue(Object.isFrozen(input.environment));
          assert.isTrue(Object.isFrozen(input.launch));
          assert.isTrue(Object.isFrozen(input.launch!.args));
          const queue = yield* Queue.unbounded<Uint8Array>();
          const started = yield* Deferred.make<void>();
          const closed = yield* Deferred.make<void>();
          let nativeId = "";
          let turnId = "";
          const emit = (frame: unknown) =>
            Queue.offer(queue, new TextEncoder().encode(`${encodeJson(frame)}\n`));
          const complete = Effect.suspend(() =>
            emit({
              method: "turn/completed",
              params: { threadId: nativeId, turn: turn(turnId, "completed") },
            }),
          );
          const peer = {
            started,
            closed,
            get nativeId() {
              return nativeId;
            },
            get turnId() {
              return turnId;
            },
            appThreadId: input.threadId,
            emit,
            complete,
            offered: [] as string[],
            injections: [] as unknown[],
            usage: (
              maxTokens: number | null | undefined,
              threadId = nativeId,
              nativeTurnId = turnId,
            ) =>
              emit({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId,
                  turnId: nativeTurnId,
                  tokenUsage: {
                    total: {
                      totalTokens: 11839,
                      inputTokens: 11833,
                      cachedInputTokens: 3456,
                      outputTokens: 6,
                      reasoningOutputTokens: 0,
                    },
                    last: {
                      totalTokens: 126,
                      inputTokens: 120,
                      cachedInputTokens: 0,
                      outputTokens: 6,
                      reasoningOutputTokens: 0,
                    },
                    ...(maxTokens === undefined ? {} : { modelContextWindow: maxTokens }),
                  },
                },
              }),
          };
          opened.push(peer);
          const witness = startup.open(input.threadId, input.providerSessionId);
          yield* Effect.addFinalizer((exit) => {
            startup.safely(() => {
              witness.resourceExit = exit;
              startup.mark(witness, "resource.finalizer");
            });
            return Deferred.succeed(closed, undefined);
          });
          let buffer = "";
          const process = (chunk: string | Uint8Array) =>
            Effect.gen(function* () {
              startup.mark(witness, "process.entry");
              buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
              while (buffer.includes("\n")) {
                const newline = buffer.indexOf("\n");
                startup.mark(witness, "envelope.decode.entry");
                const frame = decodeFrame(buffer.slice(0, newline));
                startup.mark(witness, "envelope.decoded");
                buffer = buffer.slice(newline + 1);
                if (frame.id === undefined || frame.method === undefined) continue;
                startup.mark(
                  witness,
                  "request.recognized",
                  [
                    "initialize",
                    "thread/start",
                    "thread/resume",
                    "thread/inject_items",
                    "turn/start",
                  ].includes(frame.method)
                    ? frame.method
                    : "unrecognized",
                );
                let result: unknown;
                switch (frame.method) {
                  case "initialize":
                    result = {
                      userAgent: "Synthetic Codex",
                      codexHome: "/synthetic",
                      platformFamily: "unix",
                      platformOs: "macos",
                    };
                    break;
                  case "thread/start":
                    nativeId = `capacity-native:${++nextNativeThreadId}`;
                    result = {
                      thread: nativeThread(nativeId, input.runtimePolicy.cwd ?? "/synthetic"),
                      model: "gpt-5.4",
                      modelProvider: "openai",
                      serviceTier: null,
                      cwd: input.runtimePolicy.cwd ?? "/synthetic",
                      instructionSources: [],
                      approvalPolicy: "on-request",
                      approvalsReviewer: "user",
                      sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
                      reasoningEffort: "medium",
                    };
                    break;
                  case "thread/resume":
                    nativeId = yield* decodeResumeInput(frame.params).pipe(
                      Effect.map((params) => params.threadId),
                      Effect.orDie,
                    );
                    result = {
                      thread: nativeThread(nativeId, input.runtimePolicy.cwd ?? "/synthetic"),
                      model: "gpt-5.4",
                    };
                    break;
                  case "thread/inject_items":
                    peer.injections.push(frame.params?.items);
                    result = {};
                    break;
                  case "turn/start": {
                    startup.mark(witness, "turn.input.decode.entry", "turn/start");
                    const params = yield* decodeTurnInput(frame.params).pipe(Effect.orDie);
                    assert.equal(params.threadId, nativeId);
                    startup.mark(witness, "turn.input.decoded-and-thread-asserted", "turn/start");
                    turnId = `capacity-turn:${++nextNativeTurnId}`;
                    peer.offered.push(
                      params.input
                        .flatMap((item) => (item.text === undefined ? [] : [item.text]))
                        .join("\n"),
                    );
                    yield* emit({ id: frame.id, result: { turn: turn(turnId, "inProgress") } });
                    yield* emit({
                      method: "turn/started",
                      params: { threadId: nativeId, turn: turn(turnId, "inProgress") },
                    });
                    yield* Deferred.succeed(started, undefined);
                    if (autoComplete) yield* complete;
                    continue;
                  }
                  default:
                    return yield* Effect.die(`Unexpected native request ${frame.method}`);
                }
                yield* emit({ id: frame.id, result });
              }
            }).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() =>
                  startup.safely(() => {
                    witness.processExits++;
                    startup.mark(witness, "process.exit");
                    witness.lastProcessExit = exit;
                    if (Exit.isFailure(exit)) witness.failedProcessExit = exit;
                  }),
                ),
              ),
            );
          return yield* CodexClient.make(
            Stdio.make({
              args: Effect.succeed([]),
              stdin: Stream.fromQueue(queue),
              stdout: () => Sink.forEach(process),
              stderr: () => Sink.drain,
            }),
          );
        }),
    };
  });

const dispatch = Effect.fnUntraced(function* (
  threadId: ThreadId,
  modelSelection: ModelSelection = selection,
) {
  yield* (yield* OrchestratorV2).dispatch({
    type: "message.dispatch",
    threadId,
    commandId: CommandId.make(`send:${threadId}`),
    messageId: MessageId.make(`send:${threadId}`),
    text: 'Continue "exactly" 🧪',
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});

it.live(
  "commits first decoded Codex capacity before terminal and consumes it after complete server reopen",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* checkpointWorkspace("first-codex-capacity");
        const databaseFile = NodePath.join(config.stateDir, "capacity.sqlite");
        const startup = new CapacityStartupObservation();
        const allocator = yield* IdAllocatorV2;
        const observation = new ScientCapacityFailureObservation(databaseFile, (snapshot) =>
          startup.publish(snapshot),
        );
        const configLayer = Layer.succeed(ServerConfig, config);
        const projectId = ProjectId.make("capacity-project");
        let profile = "A";
        let binary = "/synthetic/codex";
        const settings = defaultSettings;
        let pendingGate: CapacityGate["Service"] | undefined;
        const serve = <A, E, R>(
          effect: Effect.Effect<A, E, R>,
          autoComplete: boolean,
          idleTimeoutMs?: number,
        ) =>
          Effect.gen(function* () {
            const peer = yield* makePeer(autoComplete, startup);
            const allocator = yield* IdAllocatorV2;
            const crypto = yield* Crypto.Crypto;
            const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
            const adapters = yield* Effect.forEach(
              [instanceId, ProviderInstanceId.make("other-codex")],
              (id) =>
                makeCodexAdapterV2({
                  crypto,
                  instanceId: id,
                  settings,
                  environment: {},
                  fileSystem: fs,
                  path: yieldPath,
                  idAllocator: allocator,
                  serverConfig: config,
                  clientFactory: peer,
                  resolveRuntime: Effect.sync(() => ({
                    config: { ...settings, binaryPath: binary },
                    environment: {
                      HOME: `/synthetic/${profile}`,
                      CAPACITY_SECRET: "private-canary",
                    },
                    revision: "synthetic",
                  })),
                }),
            );
            const registry = makeLayer(adapters);
            const actualDatabase = makeSqlitePersistenceLive(databaseFile).pipe(
              Layer.provide(NodeServices.layer),
            );
            const database = Layer.effect(
              SqlClient.SqlClient,
              Effect.map(SqlClient.SqlClient, (sql) => {
                const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
                  Effect.gen(function* () {
                    const marker = yield* Effect.serviceOption(CapacityGate);
                    if (Option.isNone(marker)) return yield* sql.withTransaction(effect);
                    const gate = marker.value;
                    const held = Effect.gen(function* () {
                      yield* Deferred.succeed(gate.entered, undefined);
                      yield* Deferred.await(gate.release);
                      return yield* effect;
                    });
                    return yield* gate.phase === "inside"
                      ? sql.withTransaction(held)
                      : Effect.gen(function* () {
                          yield* Deferred.succeed(gate.entered, undefined);
                          yield* Deferred.await(gate.release);
                          return yield* sql.withTransaction(effect);
                        });
                  });
                return new Proxy(sql, {
                  get: (target, key, receiver) =>
                    key === "withTransaction"
                      ? withTransaction
                      : Reflect.get(target, key, receiver),
                });
              }),
            ).pipe(Layer.provide(actualDatabase));
            const layer = ProviderReplayHarness.layerWithRegistry(
              { name: "first-codex-capacity", runtimePolicyOverride: { cwd } },
              registry,
              {
                databaseLayer: database,
                mcpProviderSessionsLayer: Layer.succeed(
                  McpProviderSessions.McpProviderSessions,
                  mcpSessions,
                ),
                ...(idleTimeoutMs === undefined
                  ? {}
                  : { providerSessionIdleTimeoutMs: idleTimeoutMs }),
                decorateEventSink: (sink) => ({
                  ...sink,
                  writeWithEffects: (input) =>
                    observation.forward(
                      "writeWithEffects",
                      input.events,
                      sink.writeWithEffects(input),
                    ),
                  writeIfRunCurrent: (input) => {
                    const gate =
                      input.nativeModelCapacityOwner === undefined ? undefined : pendingGate;
                    if (gate === undefined)
                      return observation.forward(
                        "writeIfRunCurrent",
                        input.events,
                        sink.writeIfRunCurrent(input),
                      );
                    pendingGate = undefined;
                    return observation.forward(
                      "writeIfRunCurrent.gated",
                      input.events,
                      Effect.gen(function* () {
                        // Park before publication ownership so the replacement write can commit.
                        if (gate.phase === "before") {
                          yield* Deferred.succeed(gate.entered, undefined);
                          yield* Deferred.await(gate.release);
                          return yield* sink.writeIfRunCurrent(input);
                        }
                        return yield* sink
                          .writeIfRunCurrent(input)
                          .pipe(Effect.provideService(CapacityGate, gate));
                      }).pipe(
                        Effect.tap((result) => Deferred.succeed(gate.finished, result.committed)),
                      ),
                    );
                  },
                }),
                layerServerConfig: configLayer,
                layerServerSettings: ServerSettings.layerTest({
                  scientFork: { contextHandoffSize: "maximum" },
                }).pipe(Layer.orDie),
              },
            );
            // SCIENT-FORK:START — catch the original body Exit while server resources still exist.
            return yield* observation
              .beforeCleanup(effect, observation.liveOwners(peer.opened))
              .pipe(
                // SCIENT-FORK:END
                Effect.provideService(Peer, peer),
                Effect.provide(layer.pipe(Layer.provideMerge(database))),
              );
          }).pipe(
            Effect.scoped,
            // Surround provisioning so the Manager and ingestion children inherit this additive logger.
            Effect.provide(Logger.layer([startup.logger], { mergeWithExisting: true })),
          );
        const yieldPath = yield* Path.Path;
        const original = yield* serve(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const sql = yield* SqlClient.SqlClient;
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* (yield* EventStoreV2).appendProjectEvent({
              eventId: EventId.make("capacity-project-create"),
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
                title: "Capacity",
                workspaceRoot: cwd,
                scripts: [],
                defaultModelSelection: selection,
                createdAt: now,
                updatedAt: now,
              },
            });
            const source = ThreadId.make("capacity-first-report");
            yield* orchestrator.dispatch({
              type: "thread.create",
              threadId: source,
              commandId: CommandId.make(`create:${source}`),
              projectId,
              title: "Capacity",
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            startup.expectRun(allocator.derive.run({ threadId: source, ordinal: 1 }));
            yield* dispatch(source);
            const running = yield* waitFor(source, (p) =>
              p.providerTurns.some((t) => t.nativeAcceptance === "accepted"),
            );
            const p = (yield* Peer).opened[0]!;
            const manager = yield* ProviderSessionManagerV2;
            const session = Option.getOrThrow(
              yield* manager.get(running.providerThreads[0]!.providerSessionId!),
            );
            assert.isUndefined(session.getModelContextWindow?.(selection));
            const fingerprint = session.modelContextWindowLaunchFingerprint!;
            assert.match(fingerprint, /^codex-launch:v1:[a-f0-9]{64}$/);
            assert.notInclude(fingerprint, "private-canary");
            assert.deepEqual(yield* sql`SELECT * FROM scient_model_context_windows`, []);
            profile = "B"; // Later defaults cannot retarget the captured running owner.
            const usageCursor = yield* orchestrator.getThreadEventSequence(source);
            const usagePull = yield* Stream.toPull(
              orchestrator.streamStoredEventsFrom({ threadId: source, afterSequence: usageCursor }),
            );
            yield* p.usage(20_000);
            yield* Stream.fromPull(Effect.succeed(usagePull)).pipe(
              Stream.filter(
                (event) =>
                  event.event.type === "provider-turn.updated" &&
                  event.event.payload.tokenUsage?.maxTokens === 20_000,
              ),
              Stream.runHead,
              Effect.timeout("10 seconds"),
            );
            const key = yield* nativeModelWindowKey(selection, fingerprint);
            const rows = yield* sql<{
              readonly model_selection_json: string;
              readonly max_tokens: number;
            }>`SELECT * FROM scient_model_context_windows`;
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.model_selection_json, key);
            assert.equal(rows[0]!.max_tokens, 20_000);
            const active = yield* orchestrator.getThreadProjection(source);
            assert.equal(active.runs[0]!.status, "running");
            assert.equal(active.providerTurns.at(-1)!.tokenUsage!.usedTokens, 126);
            assert.equal(active.providerTurns.at(-1)!.tokenUsage!.inputTokens, 120);
            assert.equal(p.offered.length, 1);
            assert.equal((yield* Peer).opened.length, 1);
            const sink = yield* EventSinkV2;
            const history = yield* (yield* EventStoreV2)
              .read({ threadId: source })
              .pipe(Stream.runCollect);
            const usage = history
              .map((stored) => stored.event)
              .findLast(
                (event) =>
                  event.type === "provider-turn.updated" &&
                  event.payload.tokenUsage?.maxTokens === 20_000,
              )!;
            if (usage.type !== "provider-turn.updated")
              return yield* Effect.die("Missing actual canonical capacity report");
            type CapacityInput = Parameters<EventSinkV2["Service"]["writeIfRunCurrent"]>[0];
            const base: CapacityInput = {
              threadId: source,
              runId: active.runs[0]!.id,
              activeAttemptId: active.attempts[0]!.id,
              expectedStatus: "running",
              nativeModelCapacityOwner: {
                modelSelection: selection,
                launchFingerprint: fingerprint,
                providerSessionId: session.providerSessionId,
                providerThreadId: active.providerThreads[0]!.id,
                nativeThreadId: p.nativeId,
              },
              events: [usage],
            };
            const reject = Effect.fnUntraced(function* (name: string, input: CapacityInput) {
              const before = yield* orchestrator.getThreadEventSequence(source);
              const result = yield* sink.writeIfRunCurrent(input);
              assert.isFalse(result.committed, name);
              assert.deepEqual(result.storedEvents, [], name);
              assert.equal(yield* orchestrator.getThreadEventSequence(source), before, name);
              assert.equal(
                (yield* sql<{
                  max_tokens: number;
                }>`SELECT max_tokens FROM scient_model_context_windows WHERE model_selection_json = ${key}`)[0]!
                  .max_tokens,
                20_000,
                name,
              );
              assert.equal(
                (yield* sql`SELECT * FROM scient_model_context_windows`).length,
                1,
                name,
              );
            });
            const withTurn = (patch: Partial<typeof usage.payload>): CapacityInput => ({
              ...base,
              events: [{ ...usage, payload: { ...usage.payload, ...patch } }],
            });
            for (const value of [undefined, null, 0, -1, NaN, Infinity]) {
              yield* reject(
                `invalid-${value}`,
                withTurn({ tokenUsage: { ...usage.payload.tokenUsage!, maxTokens: value } }),
              );
            }
            yield* reject("foreign-session", {
              ...base,
              nativeModelCapacityOwner: {
                ...base.nativeModelCapacityOwner!,
                providerSessionId: ProviderSessionId.make("foreign-session"),
              },
            });
            yield* reject("foreign-native-thread", {
              ...base,
              nativeModelCapacityOwner: {
                ...base.nativeModelCapacityOwner!,
                nativeThreadId: "foreign-native-thread",
              },
            });
            yield* reject("foreign-instance", {
              ...base,
              nativeModelCapacityOwner: {
                ...base.nativeModelCapacityOwner!,
                modelSelection: {
                  ...selection,
                  instanceId: ProviderInstanceId.make("other-codex"),
                },
              },
            });
            yield* reject("different-selection", {
              ...base,
              nativeModelCapacityOwner: {
                ...base.nativeModelCapacityOwner!,
                modelSelection: {
                  ...selection,
                  options: [{ id: "reasoningEffort", value: "low" }],
                },
              },
            });
            yield* reject("old-attempt", {
              ...base,
              activeAttemptId: RunAttemptId.make("old-attempt"),
            });
            yield* reject(
              "old-native-turn",
              withTurn({
                nativeTurnRef: { ...usage.payload.nativeTurnRef!, nativeId: "old-native-turn" },
              }),
            );
            const root = active.nodes.find((node) => node.id === active.runs[0]!.rootNodeId)!;
            const childId = NodeId.make(`${root.id}:child`);
            yield* sink.write({
              events: [
                {
                  id: EventId.make("capacity-child"),
                  type: "node.updated",
                  threadId: source,
                  occurredAt: yield* DateTime.now,
                  payload: { ...root, id: childId, parentNodeId: root.id, kind: "subagent" },
                },
              ],
            });
            yield* reject("child", {
              ...base,
              events: [
                { ...usage, nodeId: childId, payload: { ...usage.payload, nodeId: childId } },
              ],
            });
            const providerThread = active.providerThreads[0]!;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("capacity-unbind-thread"),
                  type: "provider-thread.updated",
                  threadId: source,
                  occurredAt: yield* DateTime.now,
                  payload: { ...providerThread, providerSessionId: null },
                },
              ],
            });
            yield* reject("replaced-provider-thread-session", base);
            yield* sink.write({
              events: [
                {
                  id: EventId.make("capacity-restore-thread"),
                  type: "provider-thread.updated",
                  threadId: source,
                  occurredAt: yield* DateTime.now,
                  payload: providerThread,
                },
              ],
            });
            yield* sink.write({
              events: [
                {
                  id: EventId.make("capacity-detach"),
                  type: "provider-session.detached",
                  threadId: source,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    providerSessionId: session.providerSessionId,
                    detachedAt: yield* DateTime.now,
                  },
                },
              ],
            });
            yield* reject("lost-binding", base);
            yield* sink.write({
              events: [
                {
                  id: EventId.make("capacity-reattach"),
                  type: "provider-session.attached",
                  threadId: source,
                  occurredAt: yield* DateTime.now,
                  payload: session.providerSession,
                },
              ],
            });
            assert.isTrue(
              (yield* sink.writeIfRunCurrent({
                ...base,
                events: [{ ...usage, id: EventId.make("capacity-valid-replay") }],
              })).committed,
            );
            for (const value of [undefined, null, 0, -1, 20_000]) yield* p.usage(value);
            yield* p.usage(777, "foreign-native-thread");
            yield* p.usage(777, p.nativeId, "old-native-turn");
            yield* p.complete;
            const completed = yield* waitFor(
              source,
              (projection) => projection.runs.at(-1)?.status === "completed",
            );
            assert.equal(completed.runs.length, 1);
            yield* reject("post-terminal", base);
            assert.equal(
              (yield* sql<{
                readonly max_tokens: number;
              }>`SELECT max_tokens FROM scient_model_context_windows`)[0]!.max_tokens,
              20_000,
            );
            const logs = yield* (yield* EventStoreV2).read().pipe(Stream.runCollect);
            assert.notInclude(encodeJson(logs), "private-canary");
            return { key, fingerprint, peer: p };
          }),
          false,
        );
        assert.isTrue(yield* Deferred.isDone(original.peer.closed));
        profile = "A";
        yield* serve(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const importer = yield* LegacyV1ThreadImporter;
            const text = `WHOLE_HISTORY:${"x".repeat(100_000)}:END`;
            const cases: ReadonlyArray<{
              suffix: string;
              profile: string;
              binary?: string;
              selection: ModelSelection;
              bounded: boolean;
            }> = [
              { suffix: "reopened", profile: "A", selection, bounded: true },
              { suffix: "environment-miss", profile: "B", selection, bounded: false },
              { suffix: "restored", profile: "A", selection, bounded: true },
              {
                suffix: "binary-miss",
                profile: "A",
                binary: "/synthetic/other-codex",
                selection,
                bounded: false,
              },
              {
                suffix: "model-miss",
                profile: "A",
                selection: { ...selection, model: "other-model" },
                bounded: false,
              },
              {
                suffix: "option-miss",
                profile: "A",
                selection: { ...selection, options: [{ id: "reasoningEffort", value: "low" }] },
                bounded: false,
              },
              {
                suffix: "instance-miss",
                profile: "A",
                selection: { ...selection, instanceId: ProviderInstanceId.make("other-codex") },
                bounded: false,
              },
            ];
            const nominal = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
            for (const test of cases) {
              profile = test.profile;
              binary = test.binary ?? "/synthetic/codex";
              const id = ThreadId.make(`capacity-consumer:${test.suffix}`);
              const now = DateTime.formatIso(yield* DateTime.now);
              yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES (${id}, ${projectId}, ${id}, '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', ${now}, ${now})`;
              yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`${id}:history`}, ${id}, 'assistant', ${text}, 0, ${now}, ${now})`;
              yield* importer.reconcileShells;
              yield* importer.ensureTranscript(id);
              startup.expectRun(allocator.derive.run({ threadId: id, ordinal: 1 }));
              yield* dispatch(id, test.selection);
              const settled = yield* waitFor(
                id,
                (projection) => projection.runs.at(-1)?.status === "completed",
              );
              const handoff = settled.contextHandoffs.at(-1)!;
              assert.equal(handoff.budgetPolicy, "scient");
              assert.equal(handoff.history!.messages[0]!.text, text);
              assert.equal(handoff.delivery!.omittedItemIds!.length > 0, test.bounded);
              const p = (yield* Peer).opened.find((candidate) => candidate.appThreadId === id)!;
              assert.equal(p.offered.at(-1), 'Continue "exactly" 🧪');
              assert.equal(encodeJson(p.injections).includes(text), !test.bounded);
              assert.equal(
                settled.messages.find((message) => message.role === "assistant")!.text,
                text,
              );
              assert.deepEqual(
                (yield* (yield* ServerSettings.ServerSettingsService).getSettings)
                  .providerInstances,
                nominal.providerInstances,
              );
              yield* (yield* ProviderSessionManagerV2).closeInstance(test.selection.instanceId);
            }
            const rows = yield* sql<{
              readonly model_selection_json: string;
              readonly max_tokens: number;
            }>`SELECT * FROM scient_model_context_windows`;
            assert.deepEqual(
              rows.map((row) => [row.model_selection_json, row.max_tokens]),
              [[original.key, 20_000]],
            );
            assert.notInclude(encodeJson(rows), "private-canary");
          }),
          true,
        );
        // A new native owner learns its first bound while actual SQLite is held across idle close.
        yield* serve(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const sink = yield* EventSinkV2;
            const sql = yield* SqlClient.SqlClient;
            const start = Effect.fnUntraced(function* (
              suffix: string,
              modelSelection: ModelSelection,
            ) {
              const id = ThreadId.make(`capacity-race:${suffix}`);
              yield* orchestrator.dispatch({
                type: "thread.create",
                threadId: id,
                commandId: CommandId.make(`create:${id}`),
                projectId,
                title: id,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
              });
              observation.at("race.dispatch", id);
              startup.expectRun(allocator.derive.run({ threadId: id, ordinal: 1 }));
              yield* dispatch(id, modelSelection);
              observation.at("race.accepted", id);
              const projection = yield* waitFor(id, (p) =>
                p.providerTurns.some((t) => t.nativeAcceptance === "accepted"),
              );
              const peer = (yield* Peer).opened.find((p) => p.appThreadId === id)!;
              const runtime = Option.getOrThrow(
                yield* (yield* ProviderSessionManagerV2).get(
                  projection.providerThreads[0]!.providerSessionId!,
                ),
              );
              return { id, projection, peer, runtime };
            });
            const orderingSelection = {
              ...selection,
              options: [{ id: "reasoningEffort", value: "high" }],
            };
            const held = yield* start("idle-drain", orderingSelection);
            const orderingKey = yield* nativeModelWindowKey(
              orderingSelection,
              held.runtime.modelContextWindowLaunchFingerprint!,
            );
            const gate = yield* makeCapacityGate("inside");
            pendingGate = gate;
            yield* held.peer.usage(22_000);
            observation.at("idle.capacity.entered", held.id);
            yield* Deferred.await(gate.entered).pipe(Effect.timeout("10 seconds"));
            yield* held.peer.complete;
            observation.at("idle.peer.closed", held.id);
            yield* Deferred.await(held.peer.closed).pipe(Effect.timeout("10 seconds"));
            const reader = yield* Effect.acquireRelease(
              Effect.sync(() => new NodeSqlite.DatabaseSync(databaseFile, { readOnly: true })),
              (db) => Effect.sync(() => db.close()),
            );
            assert.deepEqual(
              reader
                .prepare("SELECT status FROM orchestration_v2_projection_runs WHERE thread_id = ?")
                .get(held.id),
              { status: "running" },
            );
            assert.isUndefined(
              reader
                .prepare(
                  "SELECT max_tokens FROM scient_model_context_windows WHERE model_selection_json = ?",
                )
                .get(orderingKey),
            );
            yield* Deferred.succeed(gate.release, undefined);
            observation.at("idle.capacity.finished", held.id);
            assert.isTrue(yield* Deferred.await(gate.finished));
            observation.at("idle.run.completed", held.id);
            const completed = yield* waitFor(held.id, (p) => p.runs.at(-1)?.status === "completed");
            assert.equal(completed.runs.length, 1);
            assert.equal(
              (yield* sql<{
                max_tokens: number;
              }>`SELECT max_tokens FROM scient_model_context_windows WHERE model_selection_json = ${orderingKey}`)[0]!
                .max_tokens,
              22_000,
            );
            const stored = yield* orchestrator
              .streamStoredEventsFrom({ threadId: held.id, afterSequence: 0 })
              .pipe(
                Stream.takeUntil(
                  (e) => e.event.type === "run.updated" && e.event.payload.status === "completed",
                ),
                Stream.runCollect,
              );
            const capacityIndex = stored.findIndex(
              (e) =>
                e.event.type === "provider-turn.updated" &&
                e.event.payload.tokenUsage?.maxTokens === 22_000,
            );
            const completionIndex = stored.findIndex(
              (e) => e.event.type === "run.updated" && e.event.payload.status === "completed",
            );
            assert.isAtLeast(capacityIndex, 0);
            assert.isAbove(completionIndex, capacityIndex);
            assert.equal(
              stored.filter(
                (e) => e.event.type === "run.updated" && e.event.payload.status === "completed",
              ).length,
              1,
            );

            // Actual database failure rolls back both capacity and canonical usage and fails the worker.
            const failed = yield* start("sql-failure", { ...selection, model: "failure-model" });
            const failureKey = yield* nativeModelWindowKey(
              failed.projection.runs[0]!.modelSelection,
              failed.runtime.modelContextWindowLaunchFingerprint!,
            );
            yield* sql`CREATE TRIGGER capacity_write_failure BEFORE INSERT ON scient_model_context_windows WHEN NEW.max_tokens = 42_000 BEGIN SELECT RAISE(ABORT, 'synthetic capacity write failure'); END`;
            yield* failed.peer.usage(42_000);
            observation.at("sql.run.failed", failed.id);
            const failureProjection = yield* waitFor(
              failed.id,
              (p) => p.runs.at(-1)?.status === "failed",
            );
            assert.equal(failureProjection.runs.length, 1);
            assert.isTrue(failureProjection.turnItems.some((item) => item.type === "error"));
            assert.deepEqual(
              yield* sql`SELECT * FROM scient_model_context_windows WHERE model_selection_json = ${failureKey}`,
              [],
            );
            const failedEvents = yield* (yield* EventStoreV2)
              .read({ threadId: failed.id })
              .pipe(Stream.runCollect);
            assert.isFalse(
              failedEvents.some(
                (e) =>
                  e.event.type === "provider-turn.updated" &&
                  e.event.payload.tokenUsage?.maxTokens === 42_000,
              ),
            );
            yield* sql`DROP TRIGGER capacity_write_failure`;
            yield* failed.peer.complete;
            observation.at("sql.peer.closed", failed.id);
            yield* Deferred.await(failed.peer.closed).pipe(Effect.timeout("10 seconds"));

            // Replacing the durable attempt before the owner transaction rejects a queued old frame.
            const replaced = yield* start("replacement", {
              ...selection,
              model: "replacement-model",
            });
            const replacementGate = yield* makeCapacityGate("before");
            pendingGate = replacementGate;
            yield* replaced.peer.usage(77_777);
            observation.at("replacement.capacity.entered", replaced.id);
            yield* Deferred.await(replacementGate.entered).pipe(Effect.timeout("10 seconds"));
            const oldRun = replaced.projection.runs[0]!;
            const oldAttempt = replaced.projection.attempts[0]!;
            const newAttemptId = RunAttemptId.make(`${oldAttempt.id}:replacement`);
            const now = yield* DateTime.now;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("capacity-replace-attempt"),
                  type: "run-attempt.updated",
                  threadId: replaced.id,
                  occurredAt: now,
                  payload: {
                    ...oldAttempt,
                    id: newAttemptId,
                    attemptOrdinal: oldAttempt.attemptOrdinal + 1,
                  },
                },
                {
                  id: EventId.make("capacity-replace-run"),
                  type: "run.updated",
                  threadId: replaced.id,
                  occurredAt: now,
                  payload: { ...oldRun, activeAttemptId: newAttemptId },
                },
              ],
            });
            yield* Deferred.succeed(replacementGate.release, undefined);
            observation.at("replacement.capacity.finished", replaced.id);
            assert.isFalse(yield* Deferred.await(replacementGate.finished));
            const replacementKey = yield* nativeModelWindowKey(
              oldRun.modelSelection,
              replaced.runtime.modelContextWindowLaunchFingerprint!,
            );
            assert.deepEqual(
              yield* sql`SELECT * FROM scient_model_context_windows WHERE model_selection_json = ${replacementKey}`,
              [],
            );
            const after = yield* orchestrator.getThreadProjection(replaced.id);
            assert.equal(after.runs[0]!.activeAttemptId, newAttemptId);
            assert.equal(
              after.providerTurns[0]!.tokenUsage?.maxTokens,
              replaced.projection.providerTurns[0]!.tokenUsage?.maxTokens,
            );
            assert.isFalse(
              (yield* (yield* EventStoreV2)
                .read({ threadId: replaced.id })
                .pipe(Stream.runCollect)).some(
                (e) =>
                  e.event.type === "provider-turn.updated" &&
                  e.event.payload.tokenUsage?.maxTokens === 77_777,
              ),
            );
            const owners = [
              { ...held, maxTokens: 22_000 },
              { ...failed, maxTokens: null },
              { ...replaced, maxTokens: null },
            ];
            assert.equal(new Set(owners.map((owner) => owner.peer.nativeId)).size, 3);
            assert.equal(new Set(owners.map((owner) => owner.peer.turnId)).size, 3);
            assert.equal(
              new Set(owners.map((owner) => owner.projection.providerTurns[0]!.id)).size,
              3,
            );
            for (const owner of owners) {
              const expected = owner.projection.providerTurns[0]!;
              const projection = yield* orchestrator.getThreadProjection(owner.id);
              assert.equal(projection.providerTurns.length, 1);
              assert.equal(projection.providerTurns[0]!.id, expected.id);
              assert.equal(projection.providerTurns[0]!.nativeTurnRef?.nativeId, owner.peer.turnId);
              assert.equal(
                projection.providerTurns[0]!.tokenUsage?.maxTokens ?? null,
                owner.maxTokens,
              );
              assert.deepEqual(
                yield* sql`SELECT provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id,
                  json_extract(payload_json, '$.tokenUsage.maxTokens') AS max_tokens
                  FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id = ${expected.id}`,
                [
                  {
                    provider_turn_id: expected.id,
                    thread_id: owner.id,
                    provider_thread_id: expected.providerThreadId,
                    node_id: expected.nodeId,
                    run_attempt_id: expected.runAttemptId,
                    max_tokens: owner.maxTokens,
                  },
                ],
              );
            }
          }),
          false,
          5,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            idAllocatorLayer,
            ServerConfig.layerTest(process.cwd(), { prefix: "first-codex-capacity-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            Layer.succeed(HostProcess.Environment, {}),
            McpProviderSessions.layer,
          ),
        ),
        Effect.timeout("120 seconds"),
      ),
    ),
);

it.effect(
  "keeps the original failure and one snapshot while selecting a deep release Cause without payloads",
  () =>
    Effect.gen(function* () {
      const startup = new CapacityStartupObservation();
      const runId = "synthetic-observation-run";
      const privatePayload = "private-observation-canary";
      startup.expectRun(runId);
      let nested: unknown = "Provider session released: idle_timeout.";
      for (let i = 0; i < 20; i++) nested = { cause: nested, payload: privatePayload };
      const ingestionCause = Cause.fail(
        new ProviderAdapterEventStreamError({
          driver: ProviderDriverKind.make("codex"),
          providerSessionId: ProviderSessionId.make("synthetic-observation-session"),
          cause: nested,
        }),
      );
      const published: unknown[] = [];
      const observer = new ScientCapacityFailureObservation(
        "/synthetic/unavailable-capacity.sqlite",
        (snapshot) => {
          published.push({ ...Object(snapshot), startup: startup.snapshot() });
        },
      );
      yield* observer.beforeCleanup(Effect.void, Effect.succeed([]));
      assert.deepEqual(published, []);
      yield* Effect.gen(function* () {
        yield* Effect.logWarning("orchestration V2 provider event ingestion failed", {
          runId: "unrelated-run",
          cause: Cause.fail(privatePayload),
        });
        yield* Effect.logWarning("orchestration V2 provider event ingestion failed", {
          runId,
          cause: ingestionCause,
        });
      }).pipe(Effect.provide(Logger.layer([startup.logger], { mergeWithExisting: true })));
      // Even an observer defect cannot replace the original assertion failure.
      startup.safely(() => {
        throw new Error(privatePayload);
      });
      const original = new Error("synthetic original assertion failure");
      const failed = yield* observer
        .beforeCleanup(Effect.fail(original), Effect.succeed([]))
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      if (Exit.isFailure(failed))
        assert.equal(Cause.findErrorOption(failed.cause).pipe(Option.getOrThrow), original);
      yield* observer.beforeCleanup(Effect.fail(original), Effect.succeed([])).pipe(Effect.exit);
      assert.equal(published.length, 1);
      const selected = encodeJson(published);
      assert.include(selected, "synthetic original assertion failure");
      assert.include(selected, "ProviderAdapterEventStreamError");
      assert.include(selected, "idle_timeout");
      assert.notInclude(selected, privatePayload);
      assert.notInclude(selected, "unrelated-run");
      assert.include(selected, "private caller/fiber/generation not witnessed");
    }),
);

class Peer extends Context.Service<Peer, Effect.Success<ReturnType<typeof makePeer>>>()(
  "t3/orchestration-v2/testkit/CodexCapacityIngress.native.test/Peer",
) {}

class CapacityGate extends Context.Service<
  CapacityGate,
  {
    readonly phase: "inside" | "before";
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
    readonly finished: Deferred.Deferred<boolean>;
  }
>()("t3/orchestration-v2/testkit/CodexCapacityIngress.native.test/CapacityGate") {}
const makeCapacityGate = Effect.fnUntraced(function* (phase: "inside" | "before") {
  return {
    phase,
    entered: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
    finished: yield* Deferred.make<boolean>(),
  };
});
