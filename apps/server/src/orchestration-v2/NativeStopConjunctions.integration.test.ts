import * as Crypto from "effect/Crypto";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ServerConfig } from "../config.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import { ClaudeAgentSdkQueryRunnerError, makeClaudeAdapterV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { layerFromAdapters as makeLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const decodeNativeEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.String,
      message: Schema.optional(Schema.Unknown),
      detail: Schema.optional(Schema.String),
    }),
  ),
);
const decodeStopSettings = Schema.decodeEffect(ClaudeSettings);
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const instanceId = ProviderInstanceId.make("claude-stop-conjunction");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
const threadId = ThreadId.make("stop:source");
const peerId = ThreadId.make("stop:peer");
const projectId = ProjectId.make("stop:project");
const outer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer, McpProviderSessions.layer);
const sourceReply = "Exact unfinished source reply α.\n\n";
const peerReply = "Untouched peer reply β.\n\n";
const hasOwnedReply = (p: OrchestrationV2ThreadProjection, text: string) => {
  const running = p.runs.find((run) => run.status === "running");
  const turn = p.providerTurns.find((turn) => turn.runAttemptId === running?.activeAttemptId);
  return (
    running !== undefined &&
    turn?.status === "running" &&
    turn.nativeAcceptance === "accepted" &&
    turn.acceptedAt !== undefined &&
    turn.acceptedAt !== null &&
    p.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.text === text &&
        message.runId === running.id &&
        p.turnItems.some(
          (item) =>
            item.type === "assistant_message" &&
            item.messageId === message.id &&
            item.nodeId === message.nodeId &&
            item.runId === running.id &&
            item.providerTurnId === turn.id &&
            item.providerThreadId === turn.providerThreadId &&
            item.text === text,
        ),
    )
  );
};
const scenarios = [
  { name: "interrupt-fails-close-fails", interrupt: "fail", closeFails: true },
  { name: "interrupt-fails-close-succeeds", interrupt: "fail", closeFails: false },
  { name: "interrupt-never-answers-close-succeeds", interrupt: "never", closeFails: false },
] as const;

const waitFor = Effect.fn("stopConjunction.waitFor")(function* (
  id: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(id);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId: id, afterSequence: cursor }),
  );
  const first = yield* orchestrator.getThreadProjection(id);
  const found = yield* Stream.concat(
    Stream.succeed(first),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(id)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead);
  return Option.getOrThrow(found);
}, Effect.scoped);

const makeFixture = Effect.fn("stopConjunction.fixture")(function* (
  scenario: (typeof scenarios)[number],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const allocator = yield* IdAllocatorV2;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fixtureScope = yield* Scope.Scope;
  const config = yield* Effect.acquireRelease(makeReplayServerConfig(scenario.name), (config) =>
    fs.remove(config.baseDir, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const cwd = yield* checkpointWorkspace(scenario.name);
  const artifactDir =
    process.env.SCIENT_STOP_PROOF_ARTIFACT_DIR ??
    (yield* fs.makeTempDirectoryScoped({ prefix: "t3-stop-receipts-" }));
  assert.isDefined(artifactDir, "causal receipts need an explicit private artifact directory");
  const artifactPath = path.join(artifactDir!, scenario.name);
  yield* fs.makeDirectory(artifactPath, { recursive: true });
  const events: ProviderAdapterV2Event[] = [];
  let allocated = 0;
  const peers = new Map<
    string,
    {
      pid: number;
      wire: string[];
      counts: { offers: number; interrupts: number; closes: number };
      interruptEntered: Deferred.Deferred<void>;
      assistantProcessed: Deferred.Deferred<void>;
      offers: SDKUserMessage[];
      closeFinished: Deferred.Deferred<void>;
      close: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
    }
  >();

  const nativeAdapter = yield* makeClaudeAdapterV2({
    crypto: yield* Crypto.Crypto,
    instanceId,
    settings: yield* decodeStopSettings({}),
    environment: {},
    attachmentsDir: config.attachmentsDir,
    fileSystem: fs,
    path,
    idAllocator: allocator,
    queryRunner: {
      allocateSessionId: Effect.sync(
        () => `00000000-0000-4000-8000-${String(++allocated).padStart(12, "0")}`,
      ),
      open: (input) =>
        Effect.gen(function* () {
          const physicalScope = yield* Scope.make();
          yield* Scope.addFinalizer(fixtureScope, Scope.close(physicalScope, Exit.void));
          const home = path.join(config.baseDir, `sdk-${allocated}`);
          yield* fs.makeDirectory(home, { recursive: true });
          const commands = path.join(home, "commands.ndjson");
          yield* fs.writeFileString(commands, "");
          const nativeId = input.options.sessionId ?? input.options.resume!;
          const isSource = input.threadId === threadId;
          const counts = { offers: 0, interrupts: 0, closes: 0 };
          const wire: string[] = [];
          const ready = yield* Deferred.make<void>();
          const interruptEntered = yield* Deferred.make<void>();
          const assistantProcessed = yield* Deferred.make<void>();
          const offers: SDKUserMessage[] = [];
          const closeFinished = yield* Deferred.make<void>();
          const interruptResponses = yield* Queue.unbounded<void>();
          const messages = yield* Queue.unbounded<SDKMessage>();
          // The controlled SDK peer echoes the actual offered prompt and emits an unfinished reply.
          // EOF from actual child exit, never an injected result/terminal, ends it.
          const script = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const emit = (x) => console.log(JSON.stringify(x));
process.on("SIGTERM", () => {
  fs.appendFileSync(${encodeReceipt(path.join(artifactPath, `${input.threadId.replaceAll(":", "-")}.inbound.ndjson`))}, JSON.stringify({ signal: "SIGTERM", pid: process.pid }) + "\\n");
  process.exit(0);
});
let consumed = 0;
setInterval(() => {
  const lines = fs.readFileSync(${encodeReceipt(commands)}, "utf8").split("\\n").filter(Boolean);
  for (; consumed < lines.length; consumed++) {
    const command = JSON.parse(lines[consumed]);
    fs.appendFileSync(${encodeReceipt(path.join(artifactPath, `${input.threadId.replaceAll(":", "-")}.inbound.ndjson`))}, lines[consumed] + "\\n");
    if (command.type === "interrupt") {
      emit({ kind: "interrupt-entered" });
      if (${encodeReceipt(isSource ? scenario.interrupt : "never")} === "fail")
        emit({ kind: "interrupt-error", detail: "Native SDK rejected exact captured interrupt" });
    } else if (command.type === "offer") {
      emit({ kind: "sdk", message: {
        ...command.message, session_id: ${encodeReceipt(nativeId)}, parent_tool_use_id: null,
        user_message_uuid: command.message.uuid
      }});
      emit({ kind: "sdk", message: {
        type: "assistant", uuid: crypto.randomUUID(), user_message_uuid: command.message.uuid,
        session_id: ${encodeReceipt(nativeId)}, parent_tool_use_id: null,
        message: { id: "msg_" + crypto.randomUUID(), type: "message", role: "assistant", model: "claude-sonnet-4-6",
          content: [{ type: "text", text: ${encodeReceipt(isSource ? sourceReply : peerReply)}, citations: null }],
          stop_reason: null, stop_sequence: null, container: null, context_management: null, stop_details: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            inference_geo: "not_available", iterations: [], server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard", speed: "standard" } }
      }});
    }
  }
}, 10);
emit({ kind: "ready" });
`;
          const child = yield* spawner
            .spawn(
              ChildProcess.make(process.execPath, ["-e", script], {
                cwd: home,
                env: { HOME: home },
                extendEnv: false,
              }),
            )
            .pipe(Scope.provide(physicalScope));
          yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.gen(function* () {
                wire.push(line);
                yield* fs.writeFileString(
                  path.join(artifactPath, `${input.threadId.replaceAll(":", "-")}.wire.ndjson`),
                  line + "\n",
                  { flag: "a" },
                );
                const envelope = yield* decodeNativeEnvelope(line);
                if (envelope.kind === "ready") yield* Deferred.succeed(ready, undefined);
                else if (envelope.kind === "sdk")
                  yield* Queue.offer(messages, envelope.message as SDKMessage);
                else if (envelope.kind === "interrupt-entered")
                  yield* Deferred.succeed(interruptEntered, undefined);
                else if (envelope.kind === "interrupt-error")
                  yield* Queue.offer(interruptResponses, undefined);
              }),
            ),
            Effect.orDie,
            Effect.forkIn(physicalScope),
          );
          yield* Deferred.await(ready);
          process.kill(Number(child.pid), 0);
          yield* fs.writeFileString(
            path.join(artifactPath, `${input.threadId.replaceAll(":", "-")}.owner.json`),
            encodeReceipt({
              pid: Number(child.pid),
              sessionId: input.providerSessionId,
              nativeId,
              home,
            }),
          );
          const close = yield* Effect.cached(
            Effect.gen(function* () {
              counts.closes++;
              if (isSource && scenario.closeFails)
                return yield* new ClaudeAgentSdkQueryRunnerError({
                  method: "close",
                  cause: "Owned SDK child close failed before exit",
                });
              yield* Scope.close(physicalScope, Exit.void);
              assert.equal(
                Number(
                  yield* child.exitCode.pipe(
                    Effect.mapError(
                      (cause) =>
                        new ClaudeAgentSdkQueryRunnerError({ method: "close.exitCode", cause }),
                    ),
                  ),
                ),
                0,
              );
              assert.throws(() => process.kill(Number(child.pid), 0), /ESRCH/);
              yield* Queue.shutdown(messages);
              yield* Deferred.succeed(closeFinished, undefined);
            }),
          );
          peers.set(input.providerSessionId, {
            pid: Number(child.pid),
            wire,
            counts,
            interruptEntered,
            assistantProcessed,
            offers,
            closeFinished,
            close,
          });
          const write = (value: unknown) =>
            fs
              .writeFileString(commands, encodeReceipt(value) + "\n", { flag: "a" })
              .pipe(Effect.orDie);
          return {
            setPermissionMode: () =>
              Effect.die("Permission-mode mutation is outside this fixture."),
            messages: Stream.fromQueue(messages).pipe(
              Stream.flatMap((message) =>
                Stream.make(message).pipe(
                  Stream.concat(
                    Stream.fromEffect(
                      message.type === "assistant"
                        ? Deferred.succeed(assistantProcessed, undefined)
                        : Effect.void,
                    ).pipe(Stream.drain),
                  ),
                ),
              ),
            ),
            offer: (message: SDKUserMessage) =>
              Effect.gen(function* () {
                counts.offers++;
                offers.push(message);
                yield* write({ type: "offer", message });
              }),
            interrupt: Effect.gen(function* () {
              counts.interrupts++;
              yield* write({
                type: "interrupt",
                session_id: nativeId,
                user_message_uuid: offers.at(-1)?.uuid,
              });
              yield* Queue.take(interruptResponses);
              return yield* new ClaudeAgentSdkQueryRunnerError({
                method: "interrupt",
                cause: "Native SDK rejected exact captured interrupt",
              });
            }),
            close,
            setModel: () => Effect.die("No model switch in captured Stop proof"),
          };
        }).pipe(Effect.orDie),
      forkSession: () => Effect.die("No fork in Stop conjunction proof"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const adapter = {
    ...nativeAdapter,
    openSession: (input: Parameters<typeof nativeAdapter.openSession>[0]) =>
      nativeAdapter.openSession(input).pipe(
        Effect.tap(() =>
          Effect.addFinalizer(() =>
            Effect.suspend(
              () => peers.get(input.providerSessionId)?.close.pipe(Effect.orDie) ?? Effect.void,
            ),
          ),
        ),
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
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  let fixtureOrchestrator: OrchestratorV2["Service"] | undefined;
  const delegatedStops: Array<{ readonly threadId: ThreadId; readonly commandId: CommandId }> = [];
  const layer = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: scenario.name, runtimePolicyOverride: { cwd } },
    makeLayer([adapter]),
    {
      databaseLayer: makeSqlitePersistenceLive(config.dbPath).pipe(
        Layer.provide(NodeServices.layer),
      ),
      layerServerConfig: Layer.succeed(ServerConfig, config),
      configureMcp: false,
      mcpProviderSessionsLayer: Layer.succeed(McpProviderSessions.McpProviderSessions, mcpSessions),
      runEffectWorker: false,
      responseStreamingMode: "paragraph",
      threads: {
        stopDelegatedTasks: (input) =>
          Effect.gen(function* () {
            assert.ok(fixtureOrchestrator);
            const { subagents } = yield* fixtureOrchestrator.getThreadRecords(input.threadId, [
              "subagents",
            ]);
            assert.isEmpty(
              subagents.filter(
                (task) => task.origin === "app_owned" && task.childThreadId !== null,
              ),
            );
            assert.deepEqual(input, {
              threadId,
              commandId: CommandId.make("stop:public"),
              reason: undefined,
            });
            delegatedStops.push({ threadId: input.threadId, commandId: input.commandId });
          }),
      },
    },
  );
  const save = (name: string, value: unknown) =>
    fs.writeFileString(path.join(artifactPath, `${name}.json`), encodeReceipt(value));
  const capture = Effect.gen(function* () {
    yield* save(
      "native-wire",
      [...peers].map(([sessionId, peer]) => ({
        sessionId,
        pid: peer.pid,
        counts: { ...peer.counts },
        offers: peer.offers,
        wire: peer.wire,
      })),
    );
    yield* save("adapter-events", events);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (yield* fs.exists(config.dbPath + suffix))
        yield* fs.copyFile(
          config.dbPath + suffix,
          path.join(artifactPath, "database.sqlite" + suffix),
        );
    }
  });
  return {
    layer,
    cwd,
    peers,
    events,
    save,
    capture,
    delegatedStops,
    bindOrchestrator: (orchestrator: OrchestratorV2["Service"]) => {
      fixtureOrchestrator = orchestrator;
    },
  };
});

it.effect.each(
  scenarios.map((scenario) => ({ caseTitle: `public captured Stop: ${scenario.name}`, scenario })),
)(
  "$caseTitle",
  ({ scenario }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeFixture(scenario);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            h.bindOrchestrator(orchestrator);
            const worker = yield* OrchestrationEffectWorkerV2;
            const manager = yield* ProviderSessionManagerV2;
            const outbox = yield* EffectOutboxV2;
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* (yield* EventSinkV2).commitProjectCommand({
              commandId: CommandId.make("stop:project:create"),
              projectId,
              commandType: "project.create",
              acceptedAt: yield* DateTime.now,
              event: {
                eventId: EventId.make("stop:project:event"),
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
                  title: "Stop conjunction",
                  workspaceRoot: h.cwd,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: now,
                  updatedAt: now,
                },
              },
            });
            yield* h.save("phase", { phase: "starting native source and peer" });
            for (const id of [threadId, peerId]) {
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`${id}:create`),
                threadId: id,
                projectId,
                title: String(id),
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
              });
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${id}:send`),
                threadId: id,
                messageId: MessageId.make(`${id}:message`),
                text: `Read ${id}`,
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              yield* worker.drain();
              const started = yield* orchestrator.getThreadProjection(id);
              const nativePeer = h.peers.get(started.providerThreads[0]!.providerSessionId!)!;
              yield* Deferred.await(nativePeer.assistantProcessed);
              // Advance only the existing display coalescer after decoder receipt.
              // SQL ownership/prefix is still decided by the durable event stream.
              yield* TestClock.adjust("50 millis");
              yield* waitFor(id, (p) =>
                hasOwnedReply(p, id === threadId ? sourceReply : peerReply),
              );
            }
            const runningSource = yield* waitFor(threadId, (p) => hasOwnedReply(p, sourceReply));
            const peerBefore = yield* waitFor(peerId, (p) => hasOwnedReply(p, peerReply));
            const run = runningSource.runs[0]!;
            const turn = runningSource.providerTurns.find(
              (turn) => turn.runAttemptId === run.activeAttemptId,
            )!;
            const sessionId = runningSource.providerThreads.find(
              (t) => t.id === turn.providerThreadId,
            )!.providerSessionId!;
            const session = h.peers.get(sessionId)!;
            const peerSession = h.peers.get(
              peerBefore.providerThreads.find(
                (t) => t.id === peerBefore.providerTurns[0]!.providerThreadId,
              )!.providerSessionId!,
            )!;
            const sourceBytes = yield* (yield* FileSystem.FileSystem).readFileString(
              `${h.cwd}/README.md`,
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("stop:queued"),
              threadId,
              messageId: MessageId.make("stop:queued:message"),
              text: "Held next question",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            // This same persisted snapshot owns the exact reply, captured run/turn and native queue.
            const before = yield* waitFor(
              threadId,
              (p) =>
                hasOwnedReply(p, sourceReply) &&
                p.runs.filter((candidate) => candidate.status === "queued").length === 1,
            );
            assert.equal(
              before.runs.find((candidate) => candidate.status === "running")?.id,
              run.id,
            );
            assert.equal(
              before.providerTurns.find(
                (candidate) => candidate.runAttemptId === run.activeAttemptId,
              )?.id,
              turn.id,
            );
            const queued = before.runs.filter((candidate) => candidate.status === "queued");
            assert.lengthOf(queued, 1);
            assert.isTrue(queued.every((candidate) => candidate.queueHeld !== true));
            assert.deepEqual(session.counts, { offers: 1, interrupts: 0, closes: 0 });
            assert.deepEqual(peerSession.counts, { offers: 1, interrupts: 0, closes: 0 });
            yield* h.save("phase", {
              phase: "native replies persisted; dispatching public Stop",
              before,
              peerBefore,
            });
            const stopId = CommandId.make("stop:public");
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: stopId,
              threadId,
              runId: run.id,
              holdQueue: true,
            });
            const accepted = yield* outbox.listByCommandId(stopId);
            const captured = accepted.find((e) => e.request.type === "provider-turn.interrupt")!;
            assert.deepEqual(captured.request, {
              type: "provider-turn.interrupt",
              providerSessionId: sessionId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
            });
            const interrupt = yield* worker.runOnce.pipe(Effect.forkScoped);
            yield* Deferred.await(session.interruptEntered);
            yield* h.save("phase", {
              phase: "native interrupt entered",
              captured,
              sourcePid: session.pid,
              peerPid: peerSession.pid,
            });
            if (scenario.interrupt === "never") {
              yield* TestClock.adjust("10 seconds");
              yield* Deferred.await(session.closeFinished);
            }
            yield* Fiber.join(interrupt);
            if (scenario.interrupt === "fail") {
              for (const millis of [100, 200, 400, 800]) {
                yield* TestClock.adjust(millis);
                yield* worker.drain();
              }
            } else {
              yield* worker.drain();
              yield* waitFor(
                threadId,
                (p) => p.runs.find((r) => r.id === run.id)?.status === "interrupted",
              );
            }
            if (scenario.closeFails) {
              // Automatic exact-query close failure must be durably visible
              // before any independent manager-close fixture probe.
              yield* waitFor(threadId, (p) =>
                p.turnItems.some(
                  (item) => item.type === "error" && item.providerTurnId === turn.id,
                ),
              );
            } else {
              yield* waitFor(
                threadId,
                (p) => p.runs.find((r) => r.id === run.id)?.status === "interrupted",
              );
            }
            const after = yield* orchestrator.getThreadProjection(threadId);
            const stopEffects = yield* outbox.listByCommandId(stopId);
            assert.deepEqual(h.delegatedStops, [{ threadId, commandId: stopId }]);
            assert.equal(
              stopEffects.find((effect) => effect.request.type === "delegated-tasks.stop")?.status,
              "succeeded",
            );
            const publicObservation = {
              before,
              after,
              stopEffects,
              closeAttempts: session.counts.closes,
              managerLive: Option.isSome(yield* manager.get(sessionId)),
              closeState: yield* manager.getCloseState!(sessionId),
              peerAfter: yield* orchestrator.getThreadProjection(peerId),
            };
            yield* h.save("public-observation", publicObservation);
            yield* h.capture;
            assert.isTrue(
              after.runs.filter((r) => r.status === "queued").every((r) => r.queueHeld === true),
            );
            assert.deepEqual(
              after.runs.filter((r) => r.status === "queued").map((r) => r.id),
              queued.map((r) => r.id),
            );
            assert.deepEqual(
              after.runs.map((r) => r.id),
              before.runs.map((r) => r.id),
              "Stop cannot create or substitute a newer root",
            );
            assert.equal(session.counts.offers, 1, "held work must never reach native SDK");
            assert.deepEqual(publicObservation.peerAfter, peerBefore);
            assert.deepEqual(peerSession.counts, { offers: 1, interrupts: 0, closes: 0 });
            process.kill(peerSession.pid, 0);
            assert.equal(
              yield* (yield* FileSystem.FileSystem).readFileString(`${h.cwd}/README.md`),
              sourceBytes,
            );
            assert.equal(
              after.messages.find(
                (m) => m.id === before.messages.find((m) => m.role === "assistant")!.id,
              )?.text,
              sourceReply,
            );

            if (scenario.closeFails) {
              assert.equal(
                publicObservation.closeAttempts,
                1,
                "automatic captured close actually failed once",
              );
              assert.isTrue(publicObservation.managerLive);
              assert.isTrue(
                Option.isNone(publicObservation.closeState),
                "query failure is not a manager close receipt",
              );
              assert.lengthOf(
                after.turnItems.filter(
                  (item) => item.type === "error" && item.providerTurnId === turn.id,
                ),
                1,
              );
              assert.equal(after.providerTurns.find((t) => t.id === turn.id)?.status, "running");
              assert.lengthOf(
                h.events.filter((e) => e.type === "turn.terminal" && e.providerTurnId === turn.id),
                0,
              );
              assert.equal(
                stopEffects.find((e) => e.request.type === "provider-turn.interrupt")?.status,
                "failed",
              );
              // Independently prove the negative physical-close fixture AFTER freezing
              // the untouched public outcome. This probe cannot count as public Stop.
              const probe = yield* manager.close(sessionId).pipe(Effect.exit);
              const closeState = yield* manager.getCloseState!(sessionId);
              yield* h.save("separate-close-fixture-probe", {
                probe,
                closeState,
                closes: session.counts.closes,
              });
              process.kill(session.pid, 0);
              assert.isTrue(Exit.isFailure(probe));
              assert.equal(Option.getOrThrow(closeState).state, "failed");
              assert.isAtLeast(
                publicObservation.closeAttempts,
                1,
                "public Stop must attempt the exact owner's shutdown after interrupt failure",
              );
              assert.equal(
                after.runs.find((r) => r.id === run.id)?.status,
                "running",
                "unresolved stop must not claim a terminal release",
              );
              assert.isTrue(
                after.turnItems.some((item) => item.type === "error"),
                "unresolved public Stop must expose a truthful failure",
              );
            } else {
              assert.equal(
                publicObservation.closeAttempts,
                1,
                "public Stop must close its exact SDK owner once",
              );
              assert.throws(() => process.kill(session.pid, 0), /ESRCH/);
              assert.equal(after.runs.find((r) => r.id === run.id)?.status, "interrupted");
              assert.lengthOf(
                h.events.filter(
                  (event) => event.type === "turn.terminal" && event.providerTurnId === turn.id,
                ),
                1,
              );
              assert.isFalse(after.turnItems.some((item) => item.type === "error"));
              assert.isTrue(after.providerSessions.every((s) => s.lastError === null));
            }
          }).pipe(Effect.provide(h.layer)),
        );
      }).pipe(Effect.provide(outer)),
    ),
  { timeout: 60_000 },
);
