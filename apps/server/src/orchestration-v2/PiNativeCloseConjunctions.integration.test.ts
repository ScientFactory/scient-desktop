// @effect-diagnostics nodeBuiltinImport:off - observes only the synthetic peer's owned PID.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as Config from "../config.ts";
import { makePiAdapterV2 } from "@t3tools/provider-pi/testing";
import { EventStoreV2 } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layerSingle as makeSingleLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProjectStoreV2 } from "./ProjectStore.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ScientTestProviderHost from "./testkit/ScientTestProviderHost.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

const fixtureServices = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  McpProviderSessions.layer,
  Config.layerTest(process.cwd(), { prefix: "pi-close-native-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const adapterLayer = ScientTestProviderHost.layer.pipe(Layer.provideMerge(fixtureServices));

const artifacts = process.env.SCIENT_TEST_PI_CLOSE_ARTIFACTS;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeWire = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.String,
      pid: Schema.Number,
      file: Schema.String,
      record: Schema.optional(Schema.Unknown),
    }),
  ),
);
const instanceId = ProviderInstanceId.make("pi-close-native-peer");
const threadId = ThreadId.make("pi-close-accepted-thread");
const modelSelection = { instanceId, model: "default" };
const terminalStatuses = new Set(["completed", "failed", "interrupted", "cancelled"]);

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

const waitForProjection = Effect.fn("PiClose.waitForProjection")(function* (
  orchestrator: OrchestratorV2["Service"],
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
  targetThreadId = threadId,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const cursor = yield* orchestrator.getThreadEventSequence(targetThreadId);
      const pull = yield* Stream.toPull(
        orchestrator.streamStoredEventsFrom({ threadId: targetThreadId, afterSequence: cursor }),
      );
      const current = yield* orchestrator.getThreadProjection(targetThreadId);
      const found = yield* Stream.concat(
        Stream.succeed(current),
        Stream.fromPull(Effect.succeed(pull)).pipe(
          Stream.mapEffect(() => orchestrator.getThreadProjection(targetThreadId)),
        ),
      ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("10 seconds"));
      if (Option.isNone(found)) return yield* Effect.die("Required Pi close projection missing");
      return found.value;
    }),
  );
});

it.live.each(
  [
    { key: "accepted-session", pending: false, all: false, lateAck: true },
    { key: "pending-session-positive", pending: true, all: false, lateAck: true },
    { key: "pending-session-rejected", pending: true, all: false, lateAck: false },
    { key: "pending-instance-positive", pending: true, all: true, lateAck: true },
    { key: "pending-instance-rejected", pending: true, all: true, lateAck: false },
    { key: "pending-shutdown-positive", pending: true, all: true, lateAck: true },
  ].map((scenario) => {
    const shutdown = scenario.key === "pending-shutdown-positive";
    const caseArtifacts = artifacts === undefined ? undefined : `${artifacts}/${scenario.key}`;

    return {
      caseTitle: shutdown
        ? "ends pending native subscription normally and fences positive ACK across shutdown"
        : `keeps ${scenario.key} native ownership truthful across administrative close and reuse`,
      scenario,
      shutdown,
      caseArtifacts,
    };
  }),
)("$caseTitle", ({ scenario, shutdown, caseArtifacts }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scope = yield* Scope.Scope;
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      if (caseArtifacts !== undefined) yield* fs.makeDirectory(caseArtifacts, { recursive: true });
      const cwd = yield* checkpointWorkspace("pi-close-native-accepted");
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-close-native-peer-" });
      const wirePath = `${directory}/wire.jsonl`;
      const peerPath = `${directory}/peer.cjs`;
      const binaryPath = `${directory}/pi-peer.sh`;
      const processes: Array<{
        pid: number;
        exit: Deferred.Deferred<Exit.Exit<number, unknown>>;
      }> = [];
      yield* fs.writeFileString(wirePath, "");
      yield* fs.writeFileString(
        peerPath,
        String.raw`const fs = require("node:fs"), path = require("node:path"), rl = require("node:readline"), crypto = require("node:crypto");
const sessionArguments = process.argv.slice(2);
const sessionIndex = sessionArguments.indexOf("--session");
if (sessionIndex < 0 || sessionArguments.lastIndexOf("--session") !== sessionIndex || !sessionArguments[sessionIndex + 1] || !path.isAbsolute(sessionArguments[sessionIndex + 1])) throw Error("Exactly one owned session file is required");
let file = sessionArguments[sessionIndex + 1];
let streaming = false;
let pendingPrompt = null;
const record = (kind, value) => fs.appendFileSync(process.env.PI_CLOSE_WIRE, JSON.stringify({ kind, pid: process.pid, file, ...(value === undefined ? {} : { record: value }) }) + "\n");
const emit = value => { record("out", value); process.stdout.write(JSON.stringify(value) + "\n"); };
if (!fs.readFileSync(file, "utf8").trim()) fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
record("spawn", { argv: sessionArguments, sessionId: header.id });
process.on("SIGTERM", () => {
 record("signal", "SIGTERM");
 if (pendingPrompt) emit({ type: "response", command: "prompt", success: process.env.PI_CLOSE_LATE_ACK === "positive", ...(process.env.PI_CLOSE_LATE_ACK === "positive" ? {} : { error: "late rejected prompt" }) });
 process.exit(0);
});
process.on("exit", code => record("exit", code));
rl.createInterface({ input: process.stdin }).on("line", line => {
 const r = JSON.parse(line); record("in", r);
 let data = {};
 if (r.type === "switch_session") { if (r.sessionPath !== file) throw Error("Foreign native file switch"); data = { cancelled: false }; }
 if (r.type === "get_state") data = { sessionFile: file, sessionId: header.id, model: { provider: "fixture", id: "native-model" }, thinkingLevel: "high", isStreaming: streaming, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 };
 if (r.type === "get_entries") data = { entries: [], leafId: null };
 if (r.type === "get_available_models") data = { models: [] };
 if (r.type === "get_commands") data = { commands: [] };
 if (r.id) emit({ type: "response", id: r.id, command: r.type, success: true, data });
 if (r.type === "prompt") {
   if (r.message.includes("PENDING_NATIVE_HELD_610")) { pendingPrompt = r; record("pending_prompt", r); return; }
   streaming = true;
   emit({ type: "response", command: "prompt", success: true });
   emit({ type: "agent_start" });
   if (r.message.includes("SAME_FILE_REPLACEMENT_609")) {
     emit({ type: "message_start", message: { role: "assistant", content: [] } });
     emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Same-file replacement completed." }], model: "native-model", provider: "fixture", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } });
     emit({ type: "agent_end", messages: [] });
     streaming = false;
     emit({ type: "agent_settled", state: { sessionFile: file, sessionId: header.id, isStreaming: false, isCompacting: false, messageCount: 2, pendingMessageCount: 0 } });
   }
 }
});`,
      );
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      yield* fs.writeFileString(
        binaryPath,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peerPath)} "$@"\n`,
      );
      yield* fs.chmod(binaryPath, 0o755);
      const spawner = ChildProcessSpawner.make((command) =>
        nativeSpawner.spawn(command).pipe(
          Effect.tap((handle) =>
            Effect.gen(function* () {
              const exit = yield* Deferred.make<Exit.Exit<number, unknown>>();
              processes.push({ pid: handle.pid, exit });
              yield* handle.exitCode.pipe(
                Effect.exit,
                Effect.flatMap((result) => Deferred.succeed(exit, result)),
                Effect.forkIn(scope),
              );
            }),
          ),
        ),
      );
      const config = yield* Config.ServerConfig;
      const adapter = yield* makePiAdapterV2({
        instanceId,
        settings: { enabled: true, binaryPath, launchArgs: "", customModels: [] },
        environment: {
          PI_CLOSE_WIRE: wirePath,
          PI_CLOSE_LATE_ACK: scenario.lateAck ? "positive" : "rejected",
        },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const registry = makeSingleLayer(adapter);
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "pi-close-native-conjunction" },
        registry,
        {
          configureMcp: false,
          mcpProviderSessionsLayer: Layer.succeed(
            McpProviderSessions.McpProviderSessions,
            mcpSessions,
          ),
          runEffectWorker: false,
          providerSessionIdleTimeoutMs: 60_000,
          layerServerConfig: Layer.succeed(Config.ServerConfig, config),
        },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const projects = yield* ProjectStoreV2;
        const manager = yield* ProviderSessionManagerV2;
        const events = yield* EventStoreV2;
        const projectId = ProjectId.make("pi-close-native-project");
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("pi-close-native-project:1"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Native Pi close",
            workspaceRoot: cwd,
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        const snapshots: Array<unknown> = [];
        const snapshot = Effect.fn("PiClose.snapshot")(function* (stage: string) {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const stored = Array.from(yield* events.read({ threadId }).pipe(Stream.runCollect));
          const wire = (yield* fs.readFileString(wirePath))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => decodeWire(line));
          const pids = yield* Effect.forEach(processes, ({ pid, exit }) =>
            Effect.gen(function* () {
              return { pid, live: processIsLive(pid), exit: yield* Deferred.poll(exit) };
            }),
          );
          const files = yield* Effect.forEach(
            [...new Set(wire.map((record) => record.file))],
            (file) => fs.readFileString(file).pipe(Effect.map((bytes) => ({ file, bytes }))),
          );
          const closeStates = yield* Effect.forEach(projection.providerSessions, (session) =>
            manager.getCloseState!(session.id).pipe(
              Effect.map((state) => ({ id: session.id, state })),
            ),
          );
          const data = { stage, projection, stored, wire, pids, files, closeStates };
          snapshots.push(data);
          if (caseArtifacts !== undefined)
            yield* fs.writeFileString(
              `${caseArtifacts}/native-observations.json`,
              encodeJson(snapshots),
            );
          return { projection, stored, wire, pids };
        });
        yield* Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("pi-close-create"),
            threadId,
            projectId,
            title: "Native Pi close",
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
            commandId: CommandId.make("pi-close-held-dispatch"),
            messageId: MessageId.make("pi-close-held-message"),
            threadId,
            text: scenario.pending ? "PENDING_NATIVE_HELD_610" : "ACCEPTED_NATIVE_HELD_609",
            dispatchMode: { type: "start_immediately" },
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain(24);
          const accepted = yield* waitForProjection(
            orchestrator,
            (projection) =>
              projection.providerTurns[0]?.nativeAcceptance ===
              (scenario.pending ? "unknown" : "accepted"),
          );
          assert.lengthOf(accepted.runs, 1);
          assert.equal(accepted.runs[0]!.status, "running");
          const turn = accepted.providerTurns[0]!;
          if (scenario.pending) assert.isUndefined(turn.acceptedAt);
          else assert.exists(turn.acceptedAt);
          assert.equal(turn.status, "running");
          const session = accepted.providerSessions[0]!;
          assert.equal(
            accepted.providerThreads.find((row) => row.id === turn.providerThreadId)
              ?.providerSessionId,
            session.id,
          );
          assert.lengthOf(processes, 1);
          const oldProcess = processes[0]!;
          assert.isAbove(oldProcess.pid, 0);
          assert.isTrue(processIsLive(oldProcess.pid));
          const before = yield* snapshot("accepted-native-before-administrative-close");
          const oldFile = before.wire.find((record) => record.kind === "spawn")!.file;
          const siblingId = ThreadId.make("pi-close-native-sibling");
          let siblingSessionId = session.id;
          let siblingBefore: OrchestrationV2ThreadProjection | undefined;
          if (scenario.pending) {
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("pi-close-sibling-create"),
              threadId: siblingId,
              projectId,
              title: "Native Pi sibling",
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
              commandId: CommandId.make("pi-close-sibling-dispatch"),
              messageId: MessageId.make("pi-close-sibling-message"),
              threadId: siblingId,
              text: "SIBLING_NATIVE_HELD_610",
              dispatchMode: { type: "start_immediately" },
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain(24);
            const sibling = yield* waitForProjection(
              orchestrator,
              (p) => p.providerTurns[0]?.nativeAcceptance === "accepted",
              siblingId,
            );
            siblingBefore = sibling;
            siblingSessionId = sibling.providerSessions[0]!.id;
            assert.notEqual(siblingSessionId, session.id);
            assert.lengthOf(processes, 2);
            assert.isTrue(processIsLive(processes[1]!.pid));
            const pendingWire = (yield* fs.readFileString(wirePath))
              .trim()
              .split("\n")
              .map((line) => decodeWire(line));
            assert.lengthOf(
              pendingWire.filter(
                (row) => row.pid === oldProcess.pid && row.kind === "pending_prompt",
              ),
              1,
            );
          }
          if (shutdown) {
            const sourceOwner = yield* manager.get(session.id);
            assert.isTrue(Option.isSome(sourceOwner));
            if (Option.isNone(sourceOwner)) return yield* Effect.die("Source owner missing");
            const subscription = yield* sourceOwner.value.subscribeEvents!;
            yield* manager.shutdown;
            const subscriptionExit = yield* subscription.events.pipe(
              Stream.runCollect,
              Effect.timeout("10 seconds"),
              Effect.exit,
            );
            assert.isTrue(Exit.isSuccess(subscriptionExit), "Shutdown must end normally");
            for (const owned of processes) {
              const exit = yield* Deferred.await(owned.exit).pipe(Effect.timeout("10 seconds"));
              assert.isTrue(Exit.isSuccess(exit));
              if (Exit.isSuccess(exit)) assert.equal(exit.value, 0);
              assert.isFalse(processIsLive(owned.pid));
            }
            const owners = yield* Effect.forEach([session.id, siblingSessionId], (ownedId) =>
              Effect.gen(function* () {
                return {
                  providerSessionId: ownedId,
                  live: yield* manager.get(ownedId),
                  closeState: yield* manager.getCloseState!(ownedId),
                };
              }),
            );
            for (const owner of owners) {
              assert.isTrue(Option.isNone(owner.live));
              assert.isTrue(Option.isNone(owner.closeState));
            }
            const after = yield* snapshot("shutdown-normal-eof-and-both-native-exits");
            const pending = after.projection.providerTurns.find((row) => row.id === turn.id)!;
            assert.exists(pending);
            assert.equal(pending.nativeAcceptance, "unknown");
            assert.isUndefined(pending.acceptedAt);
            assert.lengthOf(
              after.stored.filter(
                (row) =>
                  row.event.type === "provider-turn.updated" &&
                  row.event.payload.id === turn.id &&
                  (row.event.payload.nativeAcceptance === "accepted" ||
                    row.event.payload.acceptedAt !== undefined),
              ),
              0,
            );
            const late = after.wire
              .filter((row) => row.pid === oldProcess.pid && row.kind === "out")
              .map((row) => row.record);
            assert.deepInclude(late, { type: "response", command: "prompt", success: true });
            assert.lengthOf(processes, 2);
            if (caseArtifacts !== undefined)
              yield* fs.writeFileString(
                `${caseArtifacts}/shutdown-subscription.json`,
                encodeJson({ subscriptionExit, owners }),
              );
            return;
          }
          // This is the exact-instance administrative lifecycle used by Auth,
          // not public run.interrupt: failed retirement is allowed, false live ownership is not.
          if (scenario.all) yield* manager.closeInstance(instanceId);
          else yield* manager.close(session.id);
          const nativeExit = yield* Deferred.await(oldProcess.exit).pipe(
            Effect.timeout("10 seconds"),
          );
          assert.isTrue(Exit.isSuccess(nativeExit));
          if (Exit.isSuccess(nativeExit)) assert.equal(nativeExit.value, 0);
          assert.isFalse(processIsLive(oldProcess.pid));
          yield* waitForProjection(orchestrator, (projection) =>
            terminalStatuses.has(projection.runs[0]!.status),
          );
          yield* worker.drain(24);
          const after = yield* snapshot("administrative-close-physical-exit-and-durable-state");
          const run = after.projection.runs[0]!;
          const owningTurn = after.projection.providerTurns.find((row) => row.id === turn.id)!;
          assert.equal(owningTurn.status, "failed", "Closed native owner must settle in SQL");
          assert.exists(owningTurn.completedAt);
          assert.equal(owningTurn.nativeAcceptance, scenario.pending ? "unknown" : "accepted");
          if (scenario.pending) assert.isUndefined(owningTurn.acceptedAt);
          assert.deepEqual(owningTurn.acceptedAt, turn.acceptedAt);
          assert.equal(run.status, "failed");
          const errors = after.projection.turnItems.filter(
            (item) => item.type === "error" && item.runId === run.id,
          );
          assert.lengthOf(errors, 1);
          assert.equal(errors[0]!.providerTurnId, turn.id);
          const failedReceipts = after.stored.filter(
            (row) =>
              row.event.type === "provider-turn.updated" &&
              row.event.payload.id === turn.id &&
              row.event.payload.status === "failed",
          );
          assert.lengthOf(failedReceipts, 1);
          const rootTerminals = after.stored.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === run.id &&
              terminalStatuses.has(stored.event.payload.status),
          );
          assert.lengthOf(rootTerminals, 1);
          const sessionStopped = after.stored.find(
            (stored) =>
              stored.event.type === "provider-session.updated" &&
              stored.event.payload.id === session.id &&
              stored.event.payload.status === "stopped",
          );
          assert.exists(sessionStopped);
          assert.isBelow(rootTerminals[0]!.sequence, sessionStopped!.sequence);
          assert.isTrue(Option.isNone(yield* manager.getCloseState!(session.id)));
          if (scenario.pending) {
            const late = after.wire
              .filter((row) => row.pid === oldProcess.pid && row.kind === "out")
              .map((row) => row.record);
            assert.deepInclude(
              late,
              scenario.lateAck
                ? { type: "response", command: "prompt", success: true }
                : {
                    type: "response",
                    command: "prompt",
                    success: false,
                    error: "late rejected prompt",
                  },
            );
            const sibling = yield* orchestrator.getThreadProjection(siblingId);
            assert.equal(sibling.runs[0]!.status, scenario.all ? "failed" : "running");
            assert.equal(sibling.providerTurns[0]!.status, scenario.all ? "failed" : "running");
            assert.equal(sibling.providerTurns[0]!.nativeAcceptance, "accepted");
            assert.deepEqual(
              sibling.providerTurns[0]!.acceptedAt,
              siblingBefore!.providerTurns[0]!.acceptedAt,
            );
            const siblingEvents = Array.from(
              yield* events.read({ threadId: siblingId }).pipe(Stream.runCollect),
            );
            const siblingTerminals = siblingEvents.filter(
              (row) =>
                row.event.type === "run.updated" && terminalStatuses.has(row.event.payload.status),
            );
            assert.lengthOf(siblingTerminals, scenario.all ? 1 : 0);
            if (scenario.all) {
              assert.exists(sibling.providerTurns[0]!.completedAt);
              const stopped = siblingEvents.find(
                (row) =>
                  row.event.type === "provider-session.updated" &&
                  row.event.payload.id === siblingSessionId &&
                  row.event.payload.status === "stopped",
              );
              assert.exists(stopped);
              assert.isBelow(siblingTerminals[0]!.sequence, stopped!.sequence);
            }
            if (scenario.all) {
              const siblingExit = yield* Deferred.await(processes[1]!.exit).pipe(
                Effect.timeout("10 seconds"),
              );
              assert.isTrue(Exit.isSuccess(siblingExit));
              if (Exit.isSuccess(siblingExit)) assert.equal(siblingExit.value, 0);
              assert.isFalse(processIsLive(processes[1]!.pid));
              assert.isTrue(Option.isNone(yield* manager.getCloseState!(siblingSessionId)));
            } else {
              assert.isTrue(processIsLive(processes[1]!.pid));
              assert.isTrue(Option.isSome(yield* manager.get(siblingSessionId)));
            }
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("pi-close-replacement-dispatch"),
            messageId: MessageId.make("pi-close-replacement-message"),
            threadId,
            text: "SAME_FILE_REPLACEMENT_609",
            dispatchMode: { type: "start_immediately" },
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain(24);
          yield* waitForProjection(
            orchestrator,
            (projection) => projection.runs[1]?.status === "waiting",
          );
          yield* worker.drain(24);
          const replacement = yield* snapshot("same-file-replacement-completed");
          assert.equal(replacement.projection.runs[1]?.status, "completed");
          const replacementIndex = scenario.pending ? 2 : 1;
          assert.lengthOf(processes, replacementIndex + 1);
          assert.notEqual(processes[replacementIndex]!.pid, oldProcess.pid);
          assert.isTrue(processIsLive(processes[replacementIndex]!.pid));
          const spawns = replacement.wire.filter((record) => record.kind === "spawn");
          assert.lengthOf(spawns, replacementIndex + 1);
          assert.equal(spawns[replacementIndex]!.file, oldFile);
          if (scenario.pending) assert.notEqual(spawns[1]!.file, oldFile);
          assert.equal(replacement.projection.providerTurns[1]?.nativeAcceptance, "accepted");
          const replacementRun = replacement.projection.runs[1]!;
          const answers = replacement.projection.turnItems.filter(
            (item) => item.type === "assistant_message" && item.runId === replacementRun.id,
          );
          assert.lengthOf(answers, 1);
          if (answers[0]!.type === "assistant_message")
            assert.equal(answers[0]!.text, "Same-file replacement completed.");
          assert.lengthOf(
            replacement.stored.filter(
              (row) =>
                row.event.type === "run.updated" &&
                row.event.payload.id === replacementRun.id &&
                row.event.payload.status === "completed",
            ),
            1,
          );
          assert.lengthOf(
            replacement.wire.filter(
              (row) =>
                row.pid === oldProcess.pid &&
                row.kind === "in" &&
                (row.record as { type?: string }).type === "prompt",
            ),
            1,
          );
          assert.lengthOf(
            replacement.wire.filter(
              (row) =>
                row.pid === processes[replacementIndex]!.pid &&
                row.kind === "in" &&
                (row.record as { type?: string }).type === "prompt",
            ),
            1,
          );
        }).pipe(
          Effect.onExit((exit) =>
            snapshot(Exit.isSuccess(exit) ? "case-success" : "case-failure").pipe(
              Effect.andThen(
                artifacts === undefined
                  ? Effect.void
                  : fs.writeFileString(
                      `${caseArtifacts}/native-outcome.json`,
                      encodeJson(
                        Exit.isSuccess(exit)
                          ? { success: true }
                          : { success: false, cause: Cause.pretty(exit.cause) },
                      ),
                    ),
              ),
              Effect.ignore,
            ),
          ),
        );
      }).pipe(Effect.provide(runtime));
    }),
  ).pipe(Effect.provide(adapterLayer)),
);
