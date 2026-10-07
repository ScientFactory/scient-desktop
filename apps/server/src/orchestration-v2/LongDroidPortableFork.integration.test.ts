/** Controlled ACP subprocess + public portable fork + real worker/SQLite; no vendor account. */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { skillReleaseKey } from "@scientfactory/scient-skills";
import {
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
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../config.ts";
import { makeDroidAcpRuntime } from "../provider/acp/DroidAcpSupport.ts";
import { BUILT_IN_SKILL_RELEASES } from "../scient/skills/BuiltInSkillReleases.ts";
import { ScientSkillSessionPlanner } from "../scient/skills/ScientSkillSession.ts";
import { makeDroidAdapterV2 } from "./Adapters/DroidAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { ConversationForkService } from "./scient-fork/ConversationForkService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const pendingCodec = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    sessionId: Schema.String,
    model: Schema.String,
    autonomy: Schema.String,
    message: Schema.Struct({
      params: Schema.Struct({
        sessionId: Schema.String,
        prompt: Schema.Array(
          Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
        ),
      }),
    }),
  }),
);
const inboundCodec = Schema.fromJsonString(
  Schema.Struct({
    sessionId: Schema.String,
    message: Schema.Struct({ method: Schema.optional(Schema.String) }),
  }),
);

const decodeDroidSettings = Schema.decodeEffect(DroidSettings);
const decodePending = Schema.decodeEffect(pendingCodec);
const decodeInbound = Schema.decodeSync(inboundCodec);

const sourceText = "LONG-DROID-SOURCE-QUESTION: retain the measured dataset.";
const sourceAnswer = "LONG-DROID-SOURCE-ANSWER: the measured dataset is cobalt.";
const targetText = "LONG-DROID-TARGET: continue using that dataset.";
const targetAnswer = "LONG-DROID-COMPLETE: retained cobalt exactly once.";
const layer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "long-droid-portable-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

it.layer(layer)("Long Droid portable fork", (it) => {
  it.effect(
    "keeps one real native fork prompt unaccepted past two minutes, then completes once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* checkpointWorkspace("long-droid-portable-fork");
          const control = yield* fs.makeTempDirectoryScoped({ prefix: "long-droid-acp-peer-" });
          const logPath = path.join(control, "inbound.ndjson");
          const pendingPath = path.join(control, "pending.json");
          const releasePath = path.join(control, "release");
          const scriptPath = path.join(control, "peer.mjs");
          const binaryPath = path.join(control, "droid.sh");
          // The existing scriptedDroid peer hardcodes one native session ID. This
          // local equivalent uses real per-process IDs, so source and fork differ.
          yield* fs.writeFileString(
            scriptPath,
            `
import * as fs from "node:fs";
import * as readline from "node:readline";
const sessionId = "long-droid-" + process.pid;
let model = "droid-native", autonomy = "normal";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const reply = (message, result) => send({ jsonrpc: "2.0", id: message.id, result });
const update = value => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const options = () => [
 { id: "autonomy_level", name: "Autonomy", category: "mode", type: "select", currentValue: autonomy,
   options: ["normal", "spec", "auto-low", "auto-medium", "auto-high"].map(value => ({value, name:value})) },
 { id: "model", name: "Model", category: "model", type: "select", currentValue:model,
   options: ["droid-native", "custom:scient-fixture"].map(value => ({value, name:value})) }
];
readline.createInterface({input:process.stdin}).on("line", async line => {
 const message = JSON.parse(line);
 fs.appendFileSync(${encodeString(logPath)}, JSON.stringify({pid:process.pid, sessionId, message}) + "\\n");
 if (message.method === "initialize") return reply(message, {protocolVersion:1, agentCapabilities:{loadSession:true}, authMethods:[]});
 if (message.method === "session/new") return reply(message, {sessionId, configOptions:options()});
 if (message.method === "session/set_config_option") {
   if (message.params.configId === "model") model = message.params.value;
   if (message.params.configId === "autonomy_level") autonomy = message.params.value;
   reply(message, {}); update({sessionUpdate:"config_option_update", configOptions:options()}); return;
 }
 if (message.method !== "session/prompt") {
   if (message.id !== undefined) reply(message, {}); return;
 }
 if (message.params.sessionId !== sessionId) throw new Error("Foreign native session prompt");
 const text = message.params.prompt.filter(part => part.type === "text").map(part => part.text).join("\\n");
 if (text.includes(${encodeString(targetText)})) {
   fs.writeFileSync(${encodeString(pendingPath)}, JSON.stringify({pid:process.pid, sessionId, model, autonomy, message}));
   await new Promise(resolve => {
     const watch = fs.watch(${encodeString(control)}, () => {
       if (fs.existsSync(${encodeString(releasePath)})) { watch.close(); resolve(); }
     });
     if (fs.existsSync(${encodeString(releasePath)})) { watch.close(); resolve(); }
   });
   update({sessionUpdate:"agent_message_chunk", content:{type:"text", text:${encodeString(targetAnswer)}}});
 } else if (text.includes(${encodeString(sourceText)})) {
   update({sessionUpdate:"agent_message_chunk", content:{type:"text", text:${encodeString(sourceAnswer)}}});
 } else throw new Error("Unexpected ordinary prompt");
 reply(message, {stopReason:"end_turn"});
});
`,
          );
          yield* fs.writeFileString(
            binaryPath,
            `#!/bin/sh\nexec ${encodeString(process.execPath)} ${encodeString(scriptPath)} "$@"\n`,
          );
          yield* fs.chmod(binaryPath, 0o755);
          const config = yield* ServerConfig.ServerConfig;
          const instanceId = ProviderInstanceId.make("long-droid-instance");
          const sourceId = ThreadId.make("long-droid-source");
          const targetId = ThreadId.make("long-droid-target");
          const projectId = ProjectId.make("long-droid-project");
          const selection = { instanceId, model: "custom:scient-fixture" };
          const adapter = makeDroidAdapterV2({
            instanceId,
            settings: yield* decodeDroidSettings({ enabled: true, binaryPath }),
            environment: { PATH: process.env.PATH },
            sensitiveEnvironmentValues: [],
            makeRuntime: makeDroidAcpRuntime,
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            fileSystem: fs,
            crypto: yield* Crypto.Crypto,
            serverConfig: config,
            idAllocator: yield* IdAllocatorV2,
            selfInvocation: yield* resolveSelfInvocation(),
            onAuthenticationRejected: () => Effect.die("No account in controlled peer"),
          });
          const release = BUILT_IN_SKILL_RELEASES.find((value) => value.name === "pdf-authoring")!;
          assert.ok(release);
          const releaseKey = skillReleaseKey(release);
          // Deterministic reviewed catalog; the actual StartService prepares the
          // selected skill using the replay harness MCP descriptor testkit. This
          // checks native prompt delivery, not discovery or operation authority.
          const plannerLayer = Layer.succeed(ScientSkillSessionPlanner, {
            resolve: () =>
              Effect.succeed({
                delivery: "mcp" as const,
                catalogStatus: "complete" as const,
                releases: new Map([[releaseKey, release]]),
                skills: [
                  {
                    releaseKey,
                    id: release.id,
                    name: release.name,
                    description: release.description,
                    origin: release.origin,
                    activationScope: "user" as const,
                    invocationPolicy: "explicit" as const,
                  },
                ],
                diagnostics: [],
              }),
          });
          const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "long-droid-portable-fork", runtimePolicyOverride: { cwd } },
            makeLayer([adapter]),
            {
              configureMcp: true,
              runEffectWorker: false,
              serverConfigLayer: Layer.succeed(ServerConfig.ServerConfig, config),
            },
          ).pipe(Layer.provide(plannerLayer));
          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            const store = yield* ProjectionStoreV2;
            const waitFor = (
              threadId: ThreadId,
              predicate: (p: OrchestrationV2ThreadProjection) => boolean,
            ) =>
              Effect.gen(function* () {
                const cursor = yield* orchestrator.getThreadEventSequence(threadId);
                const pull = yield* Stream.toPull(
                  orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
                );
                const found = yield* Stream.concat(
                  Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
                  Stream.fromPull(Effect.succeed(pull)).pipe(
                    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
                  ),
                ).pipe(Stream.filter(predicate), Stream.runHead);
                if (Option.isNone(found))
                  return yield* Effect.die("Native event stream ended before receipt");
                return found.value;
              }).pipe(Effect.timeout("15 seconds"), TestClock.withLive);
            const now = yield* DateTime.now;
            yield* (yield* EventSinkV2).commitProjectCommand({
              commandId: CommandId.make("long-droid-project-create"),
              projectId,
              commandType: "project.create",
              acceptedAt: now,
              event: {
                eventId: EventId.make("long-droid-project-created"),
                type: "project.created",
                aggregateKind: "project",
                aggregateId: projectId,
                occurredAt: DateTime.formatIso(now),
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: {
                  projectId,
                  title: "Long Droid",
                  workspaceRoot: cwd,
                  scripts: [],
                  defaultModelSelection: selection,
                  createdAt: DateTime.formatIso(now),
                  updatedAt: DateTime.formatIso(now),
                },
              },
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("long-droid-source-create"),
              threadId: sourceId,
              projectId,
              title: "Source",
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
              commandId: CommandId.make("long-droid-source-send"),
              threadId: sourceId,
              messageId: MessageId.make("long-droid-source-message"),
              text: sourceText,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain(24);
            yield* waitFor(
              sourceId,
              (p) =>
                p.runs[0]?.status === "waiting" &&
                p.providerTurns.some((turn) => turn.status === "completed"),
            );
            yield* worker.drain(24);
            const source = yield* waitFor(
              sourceId,
              (p) =>
                p.runs[0]?.status === "completed" &&
                p.checkpoints.some((cp) => cp.runId === p.runs[0]?.id && cp.status === "ready"),
            );
            const answer = source.turnItems.find(
              (item) => item.type === "assistant_message" && item.status === "completed",
            );
            assert.ok(answer?.type === "assistant_message");
            assert.equal(answer.text, sourceAnswer);
            const forkCommand = {
              type: "thread.fork" as const,
              commandId: CommandId.make("long-droid-fork"),
              originThreadId: sourceId,
              newThreadId: targetId,
              sourceAssistantMessageId: answer.messageId,
              workspaceMode: "local" as const,
            };
            const forkService = yield* ConversationForkService;
            const forkFiber = yield* forkService.dispatch(forkCommand).pipe(Effect.forkScoped);
            const outbox = yield* EffectOutboxV2;
            yield* TestClock.withLive(
              Effect.gen(function* () {
                while ((yield* outbox.listByCommandId(forkCommand.commandId)).length === 0)
                  yield* Effect.sleep("10 millis");
              }).pipe(Effect.timeout("15 seconds")),
            );
            const pendingFork = yield* store.getThreadProjection(targetId);
            assert.equal(pendingFork.thread.conversationFork?.status, "pending");
            const provisioning = yield* outbox.listByCommandId(forkCommand.commandId);
            assert.lengthOf(provisioning, 1);
            assert.equal(provisioning[0]?.request.type, "scient-fork.provision");
            yield* worker.drain(24);
            const receipt = yield* Fiber.join(forkFiber);
            const frozen = yield* store.getThreadProjection(targetId);
            assert.equal(frozen.thread.conversationFork?.status, "ready");
            assert.deepEqual(
              frozen.messages.map((message) => message.text),
              [sourceText, sourceAnswer],
            );
            assert.lengthOf(frozen.runs, 0);
            assert.lengthOf(frozen.contextTransfers, 1);
            assert.equal(frozen.contextTransfers[0]?.status, "pending");
            assert.isUndefined(frozen.contextTransfers[0]?.frozenSource);
            const command = {
              type: "message.dispatch" as const,
              commandId: CommandId.make("long-droid-target-send"),
              threadId: targetId,
              messageId: MessageId.make("long-droid-target-message"),
              text: targetText,
              attachments: [],
              modelSelection: selection,
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              selectedScientSkillNames: ["pdf-authoring"],
              dispatchMode: { type: "start_immediately" as const },
              createdBy: "user" as const,
              creationSource: "web" as const,
            };
            const sendReceipt = yield* orchestrator.dispatch(command);
            yield* worker.drain(24);
            yield* TestClock.withLive(
              Effect.gen(function* () {
                while (!(yield* fs.exists(pendingPath))) yield* Effect.sleep("10 millis");
              }).pipe(Effect.timeout("15 seconds")),
            );
            const pending = yield* decodePending(yield* fs.readFileString(pendingPath));
            assert.isTrue(Number.isSafeInteger(pending.pid) && pending.pid > 0);
            assert.doesNotThrow(() => process.kill(pending.pid, 0));
            assert.equal(pending.model, selection.model);
            assert.equal(pending.autonomy, "auto-high");
            assert.equal(pending.message.params.sessionId, pending.sessionId);
            const offeredText = pending.message.params.prompt
              .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
              .join("\n");
            for (const text of [sourceText, sourceAnswer, targetText])
              assert.equal(offeredText.split(text).length - 1, 1);
            assert.include(offeredText, "`pdf-authoring` (selected by the user)");
            const before = yield* waitFor(
              targetId,
              (p) => p.providerTurns[0]?.nativeAcceptance === "unknown",
            );
            const run = before.runs[0]!;
            const turn = before.providerTurns[0]!;
            const owner = {
              runId: run.id,
              attemptId: run.activeAttemptId,
              nodeId: run.rootNodeId,
              providerThreadId: run.providerThreadId,
              providerTurnId: turn.id,
            };
            assert.notEqual(
              before.providerThreads[0]?.nativeThreadRef?.nativeId,
              source.providerThreads[0]?.nativeThreadRef?.nativeId,
            );
            assert.equal(before.providerThreads[0]?.nativeThreadRef?.nativeId, pending.sessionId);
            assert.equal(turn.runAttemptId, owner.attemptId);
            assert.equal(turn.nodeId, owner.nodeId);
            assert.deepEqual(run.modelSelection, selection);
            assert.equal(run.runtimeMode, "full-access");
            assert.equal(run.interactionMode, "default");
            assert.deepEqual(
              before.messages.find((message) => message.id === command.messageId)
                ?.selectedScientSkillNames,
              ["pdf-authoring"],
            );
            assert.lengthOf(before.contextHandoffs, 1);
            assert.equal(before.contextTransfers[0]?.resolution?.strategy, "portable_context");
            const deliveryStatus = before.contextHandoffs[0]?.delivery?.status;
            assert.equal(
              deliveryStatus,
              "inline",
              "Inline bookkeeping is separate from native acceptance",
            );
            const began = yield* Clock.currentTimeMillis;
            yield* TestClock.adjust("121 seconds");
            assert.equal((yield* Clock.currentTimeMillis) - began, 121000);
            assert.deepEqual(yield* orchestrator.dispatch(command), sendReceipt);
            assert.deepEqual(yield* forkService.dispatch(forkCommand), receipt);
            yield* worker.drain(24);
            const held = yield* store.getThreadProjection(targetId);
            assert.lengthOf(held.runs, 1);
            assert.lengthOf(held.attempts, 1);
            assert.lengthOf(held.providerTurns, 1);
            assert.equal(held.runs[0]?.id, owner.runId);
            assert.equal(held.runs[0]?.activeAttemptId, owner.attemptId);
            assert.equal(held.runs[0]?.rootNodeId, owner.nodeId);
            assert.equal(held.runs[0]?.providerThreadId, owner.providerThreadId);
            assert.equal(held.providerTurns[0]?.id, owner.providerTurnId);
            assert.equal(held.providerTurns[0]?.nativeAcceptance, "unknown");
            assert.isUndefined(held.providerTurns[0]?.acceptedAt);
            assert.equal(held.providerTurns[0]?.status, "running");
            assert.notInclude(
              ["completed", "failed", "interrupted", "cancelled"],
              held.runs[0]?.status,
            );
            assert.isNull(held.runs[0]?.completedAt);
            assert.isFalse(held.turnItems.some((item) => item.type === "error"));
            assert.doesNotThrow(() => process.kill(pending.pid, 0));
            const readLog = () =>
              fs.readFileString(logPath).pipe(
                Effect.map((text) =>
                  text
                    .trim()
                    .split("\n")
                    .map((line) => decodeInbound(line)),
                ),
              );
            assert.equal(
              (yield* readLog()).filter(
                (row) =>
                  row.message.method === "session/prompt" && row.sessionId === pending.sessionId,
              ).length,
              1,
            );
            yield* fs.writeFileString(releasePath, "release the exact pending native response");
            yield* waitFor(
              targetId,
              (p) => p.runs[0]?.status === "waiting" && p.providerTurns[0]?.status === "completed",
            );
            yield* worker.drain(24);
            const done = yield* waitFor(
              targetId,
              (p) =>
                p.runs[0]?.status === "completed" &&
                p.checkpoints.some((cp) => cp.runId === owner.runId && cp.status === "ready"),
            );
            assert.lengthOf(done.runs, 1);
            assert.lengthOf(done.attempts, 1);
            assert.lengthOf(done.providerTurns, 1);
            assert.equal(done.providerTurns[0]?.id, owner.providerTurnId);
            assert.equal(done.providerTurns[0]?.nativeAcceptance, "accepted");
            assert.ok(done.providerTurns[0]?.acceptedAt);
            assert.equal(done.providerTurns[0]?.status, "completed");
            assert.equal(done.runs[0]?.id, owner.runId);
            assert.equal(done.runs[0]?.rootNodeId, owner.nodeId);
            assert.deepEqual(
              done.messages
                .filter((message) => message.role === "assistant")
                .map((message) => message.text),
              [sourceAnswer, targetAnswer],
            );
            assert.lengthOf(done.contextHandoffs, 1);
            assert.lengthOf(done.contextTransfers, 1);
            assert.equal(done.contextTransfers[0]?.status, "consumed");
            assert.equal(done.contextTransfers[0]?.targetRunId, owner.runId);
            const resolution = done.contextTransfers[0]?.resolution;
            assert.ok(resolution?.strategy === "portable_context");
            assert.equal(resolution.contextHandoffId, done.contextHandoffs[0]?.id);
            assert.deepEqual(
              done.contextHandoffs[0]?.history?.messages.map((message) => message.text),
              [sourceText, sourceAnswer],
            );
            assert.equal(done.contextHandoffs[0]?.delivery?.status, "inline");
            assert.lengthOf(
              done.visibleTurnItems.filter(
                (row) => row.visibility === "local" && row.item.type === "handoff",
              ),
              1,
            );
            assert.equal(
              (yield* readLog()).filter((row) => row.message.method === "session/prompt").length,
              2,
              "One source offer and one target offer; no retry/phantom resume",
            );
            assert.deepEqual(
              (yield* store.getThreadProjection(targetId)).providerTurns,
              done.providerTurns,
            );
            assert.deepEqual(
              (yield* store.getThreadProjection(sourceId)).messages,
              source.messages,
            );
          }).pipe(Effect.provide(runtime));
        }),
      ),
    { timeout: 30_000 },
  );
});
