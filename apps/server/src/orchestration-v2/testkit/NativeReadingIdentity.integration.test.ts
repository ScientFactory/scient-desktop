import type { NonNullableUsage, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  DroidSettings,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeDroidAcpRuntime } from "../../provider/acp/DroidAcpSupport.ts";
import { scriptedDroid } from "../../provider/testUtils/scriptedDroid.ts";
import { makeDroidAdapterV2 } from "../Adapters/DroidAdapterV2.ts";
import { EventSinkV2 } from "../EventSink.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ScientTestProviderHost from "./ScientTestProviderHost.ts";
import { ServerConfig } from "../../config.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../../persistence/Sqlite.ts";
import {
  makeClaudeAdapterV2,
  type ClaudeAgentSdkQueryOpenInput,
} from "../Adapters/ClaudeAdapterV2.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "../Orchestrator.ts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "../ProjectionStore.ts";
import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const threadId = ThreadId.make("thread:native-reading-identity");
const instanceId = ProviderInstanceId.make("claude-native-reading");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
const nativeId = "00000000-0000-4000-8000-000000000001";
const outer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer);

const waitFor = Effect.fn("nativeReading.waitFor")(function* (
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const first = yield* orchestrator.getThreadProjection(threadId);
  const found = yield* Stream.concat(
    Stream.succeed(first),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  assert.isTrue(Option.isSome(found));
  return Option.getOrThrow(found);
}, Effect.scoped);

const send = Effect.fn("nativeReading.send")(function* (ordinal: number) {
  return yield* (yield* OrchestratorV2).dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`reading:send:${ordinal}`),
    messageId: MessageId.make(`reading:user:${ordinal}`),
    threadId,
    text: `Read turn ${ordinal}`,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});

// Controlled SDK frames enter the real Claude decoder; no normalized events or
// ready/checkpoint rows are injected into orchestration.
const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "not_available",
  iterations: [],
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  speed: "standard",
} satisfies NonNullableUsage;
const assistantFrame = (text: string): SDKMessage => ({
  type: "assistant",
  uuid: "00000000-0000-4000-8000-000000000002",
  session_id: nativeId,
  parent_tool_use_id: null,
  message: {
    id: "msg_partial_scientific_reply",
    type: "message",
    role: "assistant",
    model: modelSelection.model,
    content: [{ type: "text", text, citations: null }],
    stop_reason: null,
    stop_sequence: null,
    container: null,
    context_management: null,
    stop_details: null,
    usage,
  },
});
const resultFrame = (message: SDKUserMessage): SDKMessage => ({
  type: "result",
  subtype: "error_during_execution",
  duration_ms: 10,
  duration_api_ms: 10,
  is_error: true,
  num_turns: 1,
  stop_reason: "end_turn",
  total_cost_usd: 0,
  usage,
  modelUsage: {},
  permission_denials: [],
  uuid: "00000000-0000-4000-8000-000000000003",
  session_id: nativeId,
  ...(message.uuid === undefined ? {} : { user_message_uuid: message.uuid }),
  terminal_reason: "aborted_streaming",
  errors: ["Error: Request was aborted."],
});

const makeFixture = Effect.fn("nativeReading.makeFixture")(function* (
  driver: "claude" | "droid" = "claude",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const allocator = yield* IdAllocatorV2;
  const config = yield* Effect.acquireRelease(makeReplayServerConfig("native-reading"), (config) =>
    fs.remove(config.baseDir, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const cwd = yield* checkpointWorkspace("native-reading");
  const databaseLayer = makeSqlitePersistenceLive(config.dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
  const offers = yield* Queue.unbounded<SDKUserMessage>();
  const interruptEntered = yield* Deferred.make<void>();
  const releaseAcknowledgement = yield* Deferred.make<void>();
  const processed = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
  const events: ProviderAdapterV2Event[] = [];
  const opened: ClaudeAgentSdkQueryOpenInput[] = [];
  const offered: SDKUserMessage[] = [];
  let interruptions = 0;
  let closes = 0;
  let processedFrames = 0;
  const offerAndWait = Effect.fnUntraced(function* (message: SDKMessage) {
    const receipt = yield* Deferred.make<void>();
    processed.set(message, receipt);
    yield* Queue.offer(sdkMessages, message);
    yield* Deferred.await(receipt);
  });
  const nativeAdapter = makeClaudeAdapterV2({
    crypto: yield* Crypto.Crypto,
    instanceId,
    settings: yield* Schema.decodeEffect(ClaudeSettings)({}),
    environment: {},
    attachmentsDir: config.attachmentsDir,
    fileSystem: fs,
    path,
    idAllocator: allocator,
    queryRunner: {
      allocateSessionId: Effect.succeed(nativeId),
      open: (input) =>
        Effect.sync(() => {
          opened.push(input);
          return {
            setPermissionMode: () =>
              Effect.die("Permission-mode mutation is outside this fixture."),
            messages: Stream.fromQueue(sdkMessages).pipe(
              Stream.flatMap((message) =>
                Stream.make(message).pipe(
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.suspend(() => {
                        processedFrames++;
                        const receipt = processed.get(message);
                        return receipt === undefined
                          ? Effect.void
                          : Deferred.succeed(receipt, undefined);
                      }),
                    ).pipe(Stream.drain),
                  ),
                ),
              ),
            ),
            offer: (message) =>
              Effect.gen(function* () {
                offered.push(message);
                yield* Queue.offer(offers, message);
              }),
            setModel: () => Effect.die("No model change in reading preservation"),
            interrupt: Effect.gen(function* () {
              interruptions++;
              assert.equal(closes, 0);
              yield* Deferred.succeed(interruptEntered, undefined);
              yield* Deferred.await(releaseAcknowledgement);
              yield* offerAndWait(resultFrame(offered.at(-1)!));
            }),
            close: Effect.gen(function* () {
              closes++;
              yield* Queue.shutdown(sdkMessages);
            }),
          };
        }),
      forkSession: () => Effect.die("No fork in reading preservation"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const droid =
    driver === "droid"
      ? yield* scriptedDroid(`
function onPrompt(message) {
  const ordinal = Number(message.params.prompt[0].text.match(/Read turn (\\d+)/)[1]);
  for (let index = 1; index <= 40; index++)
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Turn " + ordinal + ", paragraph " + index + ": exact scientific reading text α.\\n\\n" } });
  reply(message, { stopReason: "end_turn" });
}`)
      : undefined;
  const chosen =
    droid === undefined
      ? nativeAdapter
      : yield* makeDroidAdapterV2({
          instanceId,
          settings: yield* Schema.decodeEffect(DroidSettings)({
            enabled: true,
            binaryPath: droid.binaryPath,
          }),
          environment: { PATH: process.env.PATH },
          sensitiveEnvironmentValues: [],
          makeRuntime: makeDroidAcpRuntime,
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          selfInvocation: yield* resolveSelfInvocation(),
          onAuthenticationRejected: () => Effect.die("No authentication in reading peer"),
        }).pipe(
          Effect.provide(
            ScientTestProviderHost.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config))),
          ),
        );
  const adapter = {
    ...chosen,
    openSession: (input: Parameters<typeof chosen.openSession>[0]) =>
      chosen.openSession(input).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          events: runtime.events.pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
          ),
        })),
      ),
  };
  const layer = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "native-reading", runtimePolicyOverride: { cwd } },
    makeLayer([adapter]),
    {
      layerDatabase: databaseLayer,
      configureMcp: false,
      responseStreamingMode: "paragraph",
      layerServerConfig: Layer.succeed(ServerConfig, config),
    },
  );
  const create = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const projectId = ProjectId.make("reading-project");
    yield* (yield* EventSinkV2).commitProjectCommand({
      commandId: CommandId.make("reading:project"),
      projectId,
      commandType: "project.create",
      acceptedAt: yield* DateTime.now,
      event: {
        eventId: EventId.make("reading:project:event"),
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
          title: "Native reading",
          workspaceRoot: cwd,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    yield* (yield* OrchestratorV2).dispatch({
      type: "thread.create",
      commandId: CommandId.make("reading:create"),
      threadId,
      projectId: ProjectId.make("reading-project"),
      title: "Native reading",
      modelSelection: driver === "droid" ? { instanceId, model: "droid-native" } : modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });
  const reopen = Effect.scoped(
    projectionStoreLayer
      .pipe(Layer.provide(databaseLayer))
      .pipe((reader) =>
        Effect.flatMap(ProjectionStoreV2, (store) => store.getThreadSnapshot(threadId)).pipe(
          Effect.provide(reader),
        ),
      ),
  );
  return {
    layer,
    cwd,
    create,
    reopen,
    nativeLog: droid?.readLog(),
    offers,
    offerAndWait,
    events,
    opened,
    offered,
    interruptEntered: Deferred.await(interruptEntered),
    acknowledge: Deferred.succeed(releaseAcknowledgement, undefined),
    counts: () => ({ interruptions, closes, processedFrames }),
  };
});

it.live(
  "partial native Claude reply survives acknowledged Stop, own close and SQLite reopen",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeFixture();
        const partial = "A partial scientific answer.\n\nIts exact unfinished continuation…\n\n";
        const saved = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* h.create;
            yield* send(1);
            const offered = yield* Queue.take(h.offers);
            assert.equal(offered.message.content, "Read turn 1");
            yield* h.offerAndWait(assistantFrame(partial));
            const running = yield* waitFor(
              (p) =>
                p.messages.some(
                  (message) => message.role === "assistant" && message.text === partial,
                ) && p.runs[0]?.status === "running",
            );
            const reply = running.messages.find((message) => message.role === "assistant")!;
            const run = running.runs[0]!;
            yield* (yield* OrchestratorV2).dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("reading:stop"),
              threadId,
              runId: run.id,
            });
            yield* h.interruptEntered.pipe(Effect.timeout("10 seconds"));
            const pending = yield* (yield* OrchestratorV2).getThreadProjection(threadId);
            assert.equal(pending.runs[0]?.status, "running");
            assert.equal(h.counts().closes, 0);
            assert.lengthOf(
              h.events.filter((event) => event.type === "turn.terminal"),
              0,
            );
            yield* h.acknowledge;
            const settled = yield* waitFor(
              (p) => p.runs[0]?.status === "interrupted" && p.runs[0]?.checkpointId !== null,
            );
            assert.equal(h.counts().interruptions, 1);
            assert.equal(h.counts().closes, 1);
            assert.equal(h.counts().processedFrames, 2);
            assert.lengthOf(h.opened, 1);
            assert.lengthOf(h.offered, 1);
            assert.isTrue(settled.providerSessions.every((session) => session.status !== "error"));
            const terminals = h.events.filter((event) => event.type === "turn.terminal");
            assert.lengthOf(terminals, 1);
            assert.equal(terminals[0]?.status, "interrupted");
            assert.equal(terminals[0]?.providerTurnId, settled.providerTurns[0]?.id);
            assert.isFalse(settled.turnItems.some((item) => item.type === "error"));
            assert.isTrue(settled.messages.every((message) => !message.streaming));
            assert.equal(
              settled.messages.find((message) => message.id === reply.id)?.text,
              partial,
            );
            const snapshot = yield* (yield* ProjectionStoreV2).getThreadSnapshot(threadId);
            assert.deepEqual(
              snapshot.projection.messages.find((message) => message.id === reply.id),
              settled.messages.find((message) => message.id === reply.id),
            );
            assert.equal(reply.runId, run.id);
            return { id: reply.id, runId: run.id, text: partial };
          }).pipe(Effect.provide(h.layer)),
        );
        const reopened = yield* h.reopen;
        const reply = reopened.projection.messages.find((message) => message.id === saved.id)!;
        assert.deepEqual(
          { id: reply.id, runId: reply.runId, text: reply.text },
          { id: saved.id, runId: saved.runId, text: saved.text },
        );
        assert.isFalse(reply.streaming);
        assert.equal(
          reopened.projection.runs.find((run) => run.id === saved.runId)?.status,
          "interrupted",
        );
        assert.isFalse(reopened.projection.turnItems.some((item) => item.type === "error"));
      }).pipe(Effect.provide(outer)),
    ),
  { timeout: 60_000 },
);

it.live(
  "twelve burst-streamed native turns retain exact reading identities through SQLite reopen",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeFixture("droid");
        const saved = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* h.create;
            const triples = [];
            for (let ordinal = 1; ordinal <= 12; ordinal++) {
              yield* send(ordinal);
              const chunks = Array.from(
                { length: 40 },
                (_, index) =>
                  `Turn ${ordinal}, paragraph ${index + 1}: exact scientific reading text α.\n\n`,
              );
              const text = chunks.join("");
              const settled = yield* waitFor(
                (p) =>
                  p.runs[ordinal - 1]?.status === "completed" &&
                  p.runs[ordinal - 1]?.checkpointId !== null,
              );
              const run = settled.runs[ordinal - 1]!;
              assert.ok(run.checkpointId);
              const checkpoint = settled.checkpoints.find(
                (checkpoint) => checkpoint.id === run.checkpointId,
              )!;
              assert.equal(checkpoint.status, "ready");
              assert.equal(checkpoint.runId, run.id);
              assert.equal(checkpoint.appRunOrdinal, ordinal);
              assert.ok(checkpoint.ref);
              assert.equal(
                Number(
                  yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(
                    ChildProcess.make(
                      "git",
                      ["rev-parse", "--verify", `${checkpoint.ref}^{commit}`],
                      { cwd: h.cwd },
                    ),
                  ),
                ),
                0,
              );
              const reply = settled.messages.find(
                (message) => message.role === "assistant" && message.runId === run.id,
              )!;
              assert.ok(reply);
              assert.equal(reply.text, text);
              assert.isFalse(reply.streaming);
              triples.push({ id: reply.id, runId: reply.runId, text: reply.text });
              const fresh = yield* (yield* ProjectionStoreV2).getThreadSnapshot(threadId);
              for (const saved of triples) {
                const message = fresh.projection.messages.find(
                  (message) => message.id === saved.id,
                )!;
                assert.deepEqual(
                  { id: message.id, runId: message.runId, text: message.text },
                  saved,
                );
              }
            }
            assert.equal(new Set(triples.map((message) => message.id)).size, 12);
            assert.equal(new Set(triples.map((message) => message.runId)).size, 12);
            const prompts = (yield* h.nativeLog!).filter((row) => row.method === "session/prompt");
            assert.lengthOf(prompts, 12);
            for (const [index, prompt] of prompts.entries()) {
              const blocks = prompt.params?.prompt as ReadonlyArray<{ text?: string }>;
              assert.equal(
                blocks[0]?.text?.match(/Read turn \d+/gu)?.join(""),
                `Read turn ${index + 1}`,
              );
            }
            assert.isAtLeast(
              h.events.filter(
                (event) => event.type === "message.updated" && event.message.role === "assistant",
              ).length,
              12 * 40,
            );
            assert.equal(h.counts().interruptions, 0);
            assert.lengthOf(
              h.events.filter((event) => event.type === "turn.terminal"),
              12,
            );
            return triples;
          }).pipe(Effect.provide(h.layer)),
        );
        const reopened = yield* h.reopen;
        assert.lengthOf(reopened.projection.runs, 12);
        assert.isTrue(
          reopened.projection.runs.every(
            (run) => run.status === "completed" && run.checkpointId !== null,
          ),
        );
        assert.lengthOf(
          reopened.projection.messages.filter((message) => message.role === "assistant"),
          12,
        );
        for (const savedReply of saved) {
          const reply = reopened.projection.messages.find(
            (message) => message.id === savedReply.id,
          )!;
          assert.deepEqual({ id: reply.id, runId: reply.runId, text: reply.text }, savedReply);
          assert.isFalse(reply.streaming);
        }
      }).pipe(Effect.provide(outer)),
    ),
  { timeout: 60_000 },
);
