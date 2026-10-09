/** Controlled OMP process, production RPC/adapter/worker and file-backed SQL. */
import * as NodeURL from "node:url";
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import { makeOmpCustomModelsClientFactory } from "../provider/omp/OmpCustomModels.ts";
import { layer as gateLayer } from "../provider/omp/OmpExecutableGate.ts";
import { ompTarget } from "../provider/omp/OmpTarget.ts";
import { makeOmpAdapterV2 } from "./Adapters/OmpAdapterV2.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./testkit/ProviderReplayHarness.ts";
import { ConversationForkService } from "./scient-fork/ConversationForkService.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const Audit = Schema.Struct({
  pid: Schema.Int,
  type: Schema.Literals(["opened", "command", "closed"]),
  command: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  switchTarget: Schema.optional(Schema.String),
});
const decodeAudit = Schema.decodeEffect(Schema.Array(Schema.fromJsonString(Audit)));

const waitFor = Effect.fnUntraced(function* (
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
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("20 seconds"));
  if (Option.isNone(found)) return yield* Effect.die("Terminal cursor SQL did not converge");
  return found.value;
});

it.live(
  "persists a cursor first available at native completion, resumes it after SQL reopen, and refuses a stopped bound fork target",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* checkpointWorkspace("terminal-cursor");
        const privateRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-terminal-cursor-",
        });
        const home = path.join(privateRoot, "home");
        const executable = path.join(privateRoot, "terminal-cursor-peer.mjs");
        const auditPath = path.join(privateRoot, "audit.ndjson");
        const controlPath = path.join(privateRoot, "control");
        yield* fs.makeDirectory(home);
        yield* fs.writeFileString(auditPath, "");
        yield* fs.writeFileString(controlPath, "waiting");
        let peer = yield* fs.readFileString(
          NodeURL.fileURLToPath(
            new URL("../provider/testUtils/controlledOmpPeer.mjs", import.meta.url),
          ),
        );
        // This peer announces a path at startup but saves its transcript only at completion.
        // The adapter must not certify a readable resume cursor before that real file exists.
        const header =
          '  NodeFS.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\\n", {\n    mode: 0o600,\n  });';
        const userWrite =
          '      NodeFS.appendFileSync(\n        sessionFile,\n        JSON.stringify({ type: "message", role: "user", text: command.message }) + "\\n",\n      );';
        assert.equal(peer.split(header).length, 2);
        assert.equal(peer.split(userWrite).length, 2);
        peer = peer
          .replace(header, "  // The terminal write creates the transcript.")
          .replace("let active;", "let active;\nlet pendingUser;")
          .replace(userWrite, "      pendingUser = command.message;")
          .replace(
            "  const message = {",
            `  if (!NodeFS.existsSync(sessionFile)) {\n    NodeFS.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\\n", { mode: 0o600 });\n  }\n  NodeFS.appendFileSync(sessionFile, JSON.stringify({ type: "message", role: "user", text: pendingUser }) + "\\n");\n  const message = {`,
          );
        yield* fs.writeFileString(executable, `#!${process.execPath}\n${peer}`);
        yield* fs.chmod(executable, 0o700);
        const config = yield* makeReplayServerConfig("terminal-cursor");
        yield* Effect.addFinalizer(() =>
          fs.remove(config.stateDir, { recursive: true }).pipe(Effect.orDie),
        );
        const instanceId = ProviderInstanceId.make("terminal-cursor-omp");
        const targetId = ThreadId.make("terminal-cursor-target");
        const sourceId = ThreadId.make("terminal-cursor-source");
        const settings = yield* ServerSettings.ServerSettingsService;
        const makeProcess = yield* makeOmpCustomModelsClientFactory(
          ompTarget,
          settings,
          instanceId,
          config.stateDir,
        );
        const readAudit = Effect.fnUntraced(function* () {
          return yield* decodeAudit(
            (yield* fs.readFileString(auditPath)).split("\n").filter(Boolean),
          );
        });
        const yieldCrypto = yield* Crypto.Crypto;
        const yieldSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const yieldAllocator = yield* IdAllocatorV2;
        const makeRuntime = (recoverOnStartup: boolean) =>
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "terminal-cursor", runtimePolicyOverride: { cwd } },
            makeLayer([
              makeOmpAdapterV2({
                target: ompTarget,
                instanceId,
                settings: { binaryPath: executable, homePath: home },
                environment: {
                  HOME: home,
                  PATH: path.dirname(process.execPath),
                  SCIENT_CONTROLLED_OMP_AUDIT: auditPath,
                  SCIENT_CONTROLLED_OMP_CONTROL: controlPath,
                },
                fileSystem: fs,
                path,
                crypto: yieldCrypto,
                spawner: yieldSpawner,
                serverConfig: config,
                idAllocator: yieldAllocator,
                continuations: { offer: () => Effect.void },
                makeProcess,
              }),
            ]),
            {
              configureMcp: false,
              layerServerConfig: Layer.succeed(ServerConfig.ServerConfig, config),
              layerDatabase: makeSqlitePersistenceLive(
                path.join(privateRoot, "statev2.sqlite"),
              ).pipe(Layer.provide(NodeServices.layer)),
              recoverOnStartup,
            },
          );
        const create = Effect.fnUntraced(function* (threadId: ThreadId) {
          yield* (yield* OrchestratorV2).dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId: ProjectId.make("terminal-cursor-project"),
            title: "Terminal cursor preservation",
            modelSelection: { instanceId, model: "controlled/model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        });
        const send = Effect.fnUntraced(function* (threadId: ThreadId, text: string) {
          yield* (yield* OrchestratorV2).dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:${text}`),
            threadId,
            messageId: MessageId.make(`${threadId}:${text}`),
            text,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
        });
        const saved = yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const sessions = yield* ProviderSessionManagerV2;
            yield* create(targetId);
            yield* send(targetId, "CONTROLLED_HOLD");
            const live = yield* waitFor(targetId, (p) =>
              p.providerTurns.some((turn) => turn.nativeAcceptance === "accepted"),
            );
            assert.equal(live.runs[0]?.status, "running");
            const binding = live.providerThreads[0]!;
            assert.isUndefined(binding.nativeMetadata?.resumeCursor);
            assert.ok(binding.nativeThreadRef?.nativeId);
            assert.isFalse(yield* fs.exists(binding.nativeThreadRef.nativeId));
            assert.equal(
              (yield* readAudit()).filter((row) => row.command === "switch_session").length,
              0,
            );
            yield* fs.writeFileString(controlPath, "finish");
            const completed = yield* waitFor(targetId, (p) => p.runs[0]?.status === "completed");
            const thread = completed.providerThreads[0]!;
            assert.ok(thread.nativeMetadata?.resumeCursor);
            assert.equal(thread.nativeThreadRef?.nativeId, binding.nativeThreadRef.nativeId);
            assert.equal(
              completed.providerTurns.filter((turn) => turn.status === "completed").length,
              1,
            );
            const transcriptPath = thread.nativeThreadRef?.nativeId;
            assert.ok(transcriptPath);
            const transcript = yield* fs.readFileString(transcriptPath);
            assert.include(transcript, "CONTROLLED_HOLD");
            assert.include(transcript, "CONTROLLED_DONE");
            yield* sessions.closeInstance(instanceId);
            assert.isTrue((yield* readAudit()).some((row) => row.type === "closed"));
            const stopped = yield* orchestrator.getThreadProjection(targetId);
            assert.deepEqual(
              stopped.providerThreads[0]?.nativeMetadata?.resumeCursor,
              thread.nativeMetadata.resumeCursor,
            );
            assert.equal(stopped.runs[0]?.status, "completed");
            return {
              thread,
              transcript,
              transcriptPath,
              manager: sessions,
              firstPid: (yield* readAudit()).find((row) => row.type === "opened")!.pid,
            };
          }).pipe(Effect.provide(makeRuntime(false))),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const sessions = yield* ProviderSessionManagerV2;
            assert.notStrictEqual(sessions, saved.manager);
            const reopened = yield* orchestrator.getThreadProjection(targetId);
            assert.deepEqual(
              reopened.providerThreads[0]?.nativeMetadata?.resumeCursor,
              saved.thread.nativeMetadata?.resumeCursor,
            );
            assert.deepEqual(
              reopened.providerThreads[0]?.nativeThreadRef,
              saved.thread.nativeThreadRef,
            );
            yield* send(targetId, "after-reopen");
            const resumed = yield* waitFor(
              targetId,
              (p) => p.runs.length === 2 && p.runs[1]?.status === "completed",
            );
            assert.equal(resumed.providerThreads[0]?.id, saved.thread.id);
            assert.deepEqual(
              resumed.providerThreads[0]?.nativeThreadRef,
              saved.thread.nativeThreadRef,
            );
            assert.deepEqual(
              resumed.providerThreads[0]?.nativeMetadata?.resumeCursor,
              saved.thread.nativeMetadata?.resumeCursor,
            );
            const switches = (yield* readAudit()).filter((row) => row.command === "switch_session");
            assert.equal(switches.length, 1);
            assert.equal(switches[0]?.switchTarget, saved.thread.nativeThreadRef!.nativeId);
            assert.notEqual(switches[0]?.pid, saved.firstPid);
            assert.isTrue(
              (yield* fs.readFileString(saved.transcriptPath)).startsWith(saved.transcript),
            );
            yield* sessions.closeInstance(instanceId);
            yield* create(sourceId);
            yield* send(sourceId, "real-source");
            yield* waitFor(sourceId, (p) => p.runs[0]?.status === "completed");
            yield* (yield* OrchestrationEffectWorkerV2).drain();
            const source = yield* orchestrator.getThreadProjection(sourceId);
            const target = yield* orchestrator.getThreadProjection(targetId);
            assert.ok(target.providerThreads[0]?.nativeThreadRef);
            assert.equal(
              target.providerThreads[0]?.nativeThreadRef?.nativeId,
              saved.thread.nativeThreadRef!.nativeId,
            );
            const sink = yield* EventSinkV2;
            const sequence = yield* sink.latestSequence({});
            const nativeBefore = yield* readAudit();
            const bytesBefore = yield* fs.readFileString(saved.transcriptPath);
            const sourceFile = source.providerThreads[0]?.nativeThreadRef?.nativeId;
            assert.ok(sourceFile);
            const sourceBytesBefore = yield* fs.readFileString(sourceFile);
            const answer = source.messages.find((message) => message.text === "CONTROLLED_DONE");
            assert.ok(answer);
            const commandId = CommandId.make("terminal-cursor-bound-target-fork");
            const rejected = yield* (yield* ConversationForkService)
              .dispatch({
                type: "thread.fork",
                commandId,
                originThreadId: sourceId,
                newThreadId: targetId,
                sourceAssistantMessageId: answer.id,
                workspaceMode: "local",
              })
              .pipe(Effect.result);
            assert.equal(rejected._tag, "Failure");
            if (rejected._tag === "Failure")
              assert.include(String(rejected.failure), "destination already exists");
            assert.equal(yield* sink.latestSequence({}), sequence);
            assert.isTrue(
              Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(commandId)),
            );
            assert.deepEqual(yield* orchestrator.getThreadProjection(targetId), target);
            assert.deepEqual(yield* orchestrator.getThreadProjection(sourceId), source);
            assert.deepEqual(yield* readAudit(), nativeBefore);
            assert.equal(yield* fs.readFileString(saved.transcriptPath), bytesBefore);
            assert.equal(yield* fs.readFileString(sourceFile), sourceBytesBefore);
            yield* sessions.closeInstance(instanceId);
            const audit = yield* readAudit();
            const opened = audit.filter((row) => row.type === "opened");
            assert.equal(opened.length, 3);
            assert.deepEqual(
              audit
                .filter((row) => row.type === "closed")
                .map((row) => row.pid)
                .toSorted(),
              opened.map((row) => row.pid).toSorted(),
            );
            yield* Effect.logInfo("Terminal cursor preservation evidence", {
              firstPid: saved.firstPid,
              terminalCursor: saved.thread.nativeMetadata?.resumeCursor,
              nativeThread: saved.thread.nativeThreadRef,
              resumedSwitches: switches,
              deniedTarget: targetId,
              unchangedSequence: sequence,
              audit,
            });
          }).pipe(Effect.provide(makeRuntime(true))),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            idAllocatorLayer,
            gateLayer,
            ServerSettings.layerTest(),
          ),
        ),
      ),
    ),
);
