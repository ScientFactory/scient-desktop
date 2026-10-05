// @effect-diagnostics nodeBuiltinImport:off
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
  ProviderSessionId,
  RunAttemptId,
  NodeId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as Context from "effect/Context";
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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeCodexAdapterV2 } from "../Adapters/CodexAdapterV2.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { EventStoreV2 } from "../EventStore.ts";
import { LegacyV1ThreadImporter } from "../legacy/LegacyV1ThreadImporter.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import { nativeModelWindowKey } from "../scient-fork/NativeModelContextWindow.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";

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
    input: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
);
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

/** Only external JSONL is controlled: decoding, native adapter, manager and worker are production. */
const makePeer = (autoComplete: boolean) =>
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
      open: (
        input: Parameters<
          import("../Adapters/CodexAdapterV2.ts").CodexAppServerClientFactoryShape["open"]
        >[0],
      ) =>
        Effect.gen(function* () {
          assert.isTrue(Object.isFrozen(input.settings));
          assert.isTrue(Object.isFrozen(input.environment));
          assert.isTrue(Object.isFrozen(input.launch));
          assert.isTrue(Object.isFrozen(input.launch!.args));
          const queue = yield* Queue.unbounded<Uint8Array>();
          const started = yield* Deferred.make<void>();
          const closed = yield* Deferred.make<void>();
          const nativeId = `capacity-native:${input.providerSessionId}`;
          const turnId = `capacity-turn:${input.providerSessionId}`;
          const emit = (frame: unknown) =>
            Queue.offer(queue, new TextEncoder().encode(`${encodeJson(frame)}\n`));
          const complete = emit({
            method: "turn/completed",
            params: { threadId: nativeId, turn: turn(turnId, "completed") },
          });
          const peer = {
            started,
            closed,
            nativeId,
            turnId,
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
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          let buffer = "";
          const process = (chunk: string | Uint8Array) =>
            Effect.gen(function* () {
              buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
              while (buffer.includes("\n")) {
                const newline = buffer.indexOf("\n");
                const frame = decodeFrame(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                if (frame.id === undefined || frame.method === undefined) continue;
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
                    const params = yield* decodeTurnInput(frame.params).pipe(Effect.orDie);
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
            });
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
            const peer = yield* makePeer(autoComplete);
            const allocator = yield* IdAllocatorV2;
            const registry = makeLayer(
              [instanceId, ProviderInstanceId.make("other-codex")].map((id) =>
                makeCodexAdapterV2({
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
              ),
            );
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
            const layer = makeOrchestratorV2ReplayLayerWithRegistry(
              { name: "first-codex-capacity", runtimePolicyOverride: { cwd } },
              registry,
              {
                databaseLayer: database,
                ...(idleTimeoutMs === undefined
                  ? {}
                  : { providerSessionIdleTimeoutMs: idleTimeoutMs }),
                decorateEventSink: (sink) => ({
                  ...sink,
                  writeIfRunCurrent: (input) => {
                    const gate =
                      input.nativeModelCapacityOwner === undefined ? undefined : pendingGate;
                    if (gate === undefined) return sink.writeIfRunCurrent(input);
                    pendingGate = undefined;
                    return sink.writeIfRunCurrent(input).pipe(
                      Effect.provideService(CapacityGate, gate),
                      Effect.tap((result) => Deferred.succeed(gate.finished, result.committed)),
                    );
                  },
                }),
                serverConfigLayer: configLayer,
                serverSettingsLayer: ServerSettings.layerTest({
                  scientFork: { contextHandoffSize: "maximum" },
                }).pipe(Layer.orDie),
              },
            );
            return yield* effect.pipe(
              Effect.provideService(Peer, peer),
              Effect.provide(layer.pipe(Layer.provideMerge(database))),
            );
          }).pipe(Effect.scoped);
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
                (yield* (yield* ServerSettings.ServerSettingsService).getSettings).providers,
                nominal.providers,
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
              yield* dispatch(id, modelSelection);
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
            yield* Deferred.await(gate.entered).pipe(Effect.timeout("10 seconds"));
            yield* held.peer.complete;
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
            assert.isTrue(yield* Deferred.await(gate.finished));
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
            yield* Deferred.await(failed.peer.closed).pipe(Effect.timeout("10 seconds"));

            // Replacing the durable attempt before the owner transaction rejects a queued old frame.
            const replaced = yield* start("replacement", {
              ...selection,
              model: "replacement-model",
            });
            const replacementGate = yield* makeCapacityGate("before");
            pendingGate = replacementGate;
            yield* replaced.peer.usage(77_777);
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
            Layer.succeed(HostProcessEnvironment, {}),
          ),
        ),
        Effect.timeout("120 seconds"),
      ),
    ),
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
