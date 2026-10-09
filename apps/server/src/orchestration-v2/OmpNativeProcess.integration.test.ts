/** Controlled native subprocess → actual RPC → V2 SQL. No vendor model or account. */
import { assert, describe, it } from "@effect/vitest";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
import { makeOmpCustomModelsClientFactory } from "../provider/omp/OmpCustomModels.ts";
import { layer as gateLayer } from "../provider/omp/OmpExecutableGate.ts";
import { ompTarget } from "../provider/omp/OmpTarget.ts";
import { makeOmpAdapterV2 } from "./Adapters/OmpAdapterV2.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const Audit = Schema.Struct({
  pid: Schema.Int,
  type: Schema.Literals(["opened", "command", "closed"]),
  command: Schema.optional(Schema.String),
  executable: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  root: Schema.optional(Schema.String),
  extensionCount: Schema.optional(Schema.Int),
  mode: Schema.optional(Schema.String),
  approvalMode: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  switchTarget: Schema.optional(Schema.String),
  held: Schema.optional(Schema.Boolean),
  promptLabel: Schema.optional(Schema.Literals(["foreground", "queued-first", "queued-second"])),
});
const decodeAudit = Schema.decodeEffect(Schema.Array(Schema.fromJsonString(Audit)));
const TranscriptEntry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("message"),
    role: Schema.Literal("user"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("message"),
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    stopReason: Schema.Literal("stop"),
  }),
]);
const decodeTranscript = Schema.decodeEffect(Schema.Array(Schema.fromJsonString(TranscriptEntry)));
const dependencies = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  gateLayer,
  ServerSettings.layerTest(),
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-native-process-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "controlled OMP POSIX subprocess",
  () => {
    it.live.each(
      [false, true].map((interrupted) => ({
        caseTitle: interrupted
          ? "stops the actual OMP child and resumes held SQL work through its owned transcript"
          : "completes and automatically drains unheld work through the default OMP subprocess",
        interrupted,
      })),
    )(
      "$caseTitle",
      ({ interrupted }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const config = yield* ServerConfig.ServerConfig;
            const settings = yield* ServerSettings.ServerSettingsService;
            const cwd = yield* checkpointWorkspace("omp-native-process");
            const privateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "scient-omp-peer-" });
            const home = path.join(privateRoot, "home");
            const auditPath = path.join(privateRoot, "audit.ndjson");
            const controlPath = path.join(privateRoot, "control");
            const executable = path.join(privateRoot, "controlled-omp.mjs");
            yield* fs.makeDirectory(home);
            yield* fs.writeFileString(auditPath, "");
            yield* fs.writeFileString(controlPath, "waiting");
            const source = yield* fs.readFileString(
              NodeURL.fileURLToPath(
                new URL("../provider/testUtils/controlledOmpPeer.mjs", import.meta.url),
              ),
            );
            yield* fs.writeFileString(executable, `#!${process.execPath}\n${source}`);
            yield* fs.chmod(executable, 0o700);
            const readAudit = Effect.fnUntraced(function* () {
              return yield* decodeAudit(
                (yield* fs.readFileString(auditPath)).split("\n").filter(Boolean),
              );
            });
            const readTranscript = Effect.fnUntraced(function* (file: string) {
              return yield* decodeTranscript(
                (yield* fs.readFileString(file)).split("\n").filter(Boolean),
              );
            });
            const instanceId = ProviderInstanceId.make("omp-controlled-process-instance");
            const threadId = ThreadId.make(`omp-controlled-process-${interrupted}`);
            // No injected process factory: this is the production gate/version/spawn/client path.
            const makeProcess = yield* makeOmpCustomModelsClientFactory(
              ompTarget,
              settings,
              instanceId,
              config.stateDir,
            );
            const adapter = makeOmpAdapterV2({
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
              crypto: yield* Crypto.Crypto,
              spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              serverConfig: config,
              idAllocator: yield* IdAllocatorV2,
              continuations: { offer: () => Effect.void },
              makeProcess,
            });
            let fixtureOrchestrator: OrchestratorV2["Service"] | undefined;
            const delegatedStops: Array<{
              readonly threadId: ThreadId;
              readonly commandId: CommandId;
            }> = [];
            const runtimeLayer = makeOrchestratorV2ReplayLayerWithRegistry(
              { name: `omp-default-process-${interrupted}`, runtimePolicyOverride: { cwd } },
              makeLayer([adapter]),
              {
                configureMcp: false,
                threads: {
                  stopDelegatedTasks: (input) =>
                    Effect.gen(function* () {
                      assert.ok(fixtureOrchestrator);
                      const { subagents } = yield* fixtureOrchestrator.getThreadRecords(
                        input.threadId,
                        ["subagents"],
                      );
                      assert.isEmpty(
                        subagents.filter(
                          (task) => task.origin === "app_owned" && task.childThreadId !== null,
                        ),
                      );
                      assert.deepEqual(input, {
                        threadId,
                        commandId: CommandId.make(`${threadId}:stop`),
                        reason: undefined,
                      });
                      delegatedStops.push({ threadId: input.threadId, commandId: input.commandId });
                    }),
                },
                layerServerConfig: Layer.succeed(ServerConfig.ServerConfig, config),
              },
            );
            yield* Effect.gen(function* () {
              const orchestrator = yield* OrchestratorV2;
              fixtureOrchestrator = orchestrator;
              const sessions = yield* ProviderSessionManagerV2;
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`${threadId}:create`),
                threadId,
                projectId: ProjectId.make("omp-default-process-project"),
                title: "Controlled native OMP",
                modelSelection: { instanceId, model: "controlled/model" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
              });
              const waitFor = Effect.fnUntraced(function* (
                predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
              ) {
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
                if (Option.isNone(found)) return yield* Effect.die("Native SQL did not converge");
                return found.value;
              });
              const send = (text: string, queued = false) =>
                orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make(`${threadId}:${text}`),
                  threadId,
                  messageId: MessageId.make(`${threadId}:${text}`),
                  text,
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                  dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
                });
              yield* send("CONTROLLED_HOLD");
              const initial = yield* waitFor((projection) =>
                projection.providerTurns.some((turn) => turn.acceptedAt !== undefined),
              );
              const foreground = initial.runs[0];
              assert.ok(foreground);
              let stoppedPrefix: ReadonlyArray<typeof TranscriptEntry.Type> | undefined;
              yield* send("queued-first", true);
              yield* send("queued-second", true);
              const queued = yield* waitFor(
                (projection) =>
                  projection.runs.filter((run) => run.status === "queued").length === 2,
              );
              assert.isTrue(
                queued.runs
                  .filter((run) => run.status === "queued")
                  .every((run) => run.queueHeld !== true),
              );
              if (interrupted) {
                yield* orchestrator.dispatch({
                  type: "run.interrupt",
                  commandId: CommandId.make(`${threadId}:stop`),
                  threadId,
                  runId: foreground.id,
                  holdQueue: true,
                });
                const held = yield* waitFor(
                  (projection) =>
                    projection.runs.some(
                      (run) => run.id === foreground.id && run.status === "interrupted",
                    ) &&
                    projection.runs.filter((run) => run.status === "queued").length === 2 &&
                    projection.runs
                      .filter((run) => run.status === "queued")
                      .every((run) => run.queueHeld === true),
                );
                assert.equal(
                  held.providerTurns.filter((turn) => turn.status === "interrupted").length,
                  1,
                );
                const stoppedAudit = yield* readAudit();
                assert.equal(stoppedAudit.filter((row) => row.command === "prompt").length, 1);
                assert.equal(stoppedAudit.filter((row) => row.type === "closed").length, 1);
                const file = stoppedTranscript(stoppedAudit);
                assert.ok(file);
                stoppedPrefix = yield* readTranscript(file);
                assert.deepEqual(
                  stoppedPrefix.filter(
                    (entry) => entry.type === "message" && entry.role === "user",
                  ),
                  [{ type: "message", role: "user", text: "CONTROLLED_HOLD" }],
                );
                yield* orchestrator.dispatch({
                  type: "queue.resume",
                  commandId: CommandId.make(`${threadId}:resume`),
                  threadId,
                });
              } else {
                yield* fs.writeFileString(controlPath, "finish");
              }
              const final = yield* waitFor(
                (projection) =>
                  projection.runs.length === 3 &&
                  projection.runs.every(
                    (run) =>
                      run.status === "completed" ||
                      (interrupted && run.id === foreground.id && run.status === "interrupted"),
                  ),
              );
              assert.deepEqual(
                delegatedStops,
                interrupted ? [{ threadId, commandId: CommandId.make(`${threadId}:stop`) }] : [],
              );
              assert.equal(
                final.runs.filter((run) => run.status === "completed").length,
                interrupted ? 2 : 3,
              );
              assert.equal(
                final.messages.filter(
                  (message) => message.role === "assistant" && message.text === "CONTROLLED_DONE",
                ).length,
                interrupted ? 2 : 3,
              );
              assert.isTrue(final.providerTurns.every((turn) => turn.acceptedAt !== undefined));
              yield* sessions.closeInstance(instanceId);
              const audit = yield* readAudit();
              const opened = audit.filter((row) => row.type === "opened");
              const closed = audit.filter((row) => row.type === "closed");
              assert.equal(opened.length, interrupted ? 2 : 1);
              assert.deepEqual(
                closed.map((row) => row.pid).sort(),
                opened.map((row) => row.pid).sort(),
              );
              for (const row of opened) {
                assert.equal(row.cwd, yield* fs.realPath(cwd));
                assert.equal(row.executable, yield* fs.realPath(executable));
                assert.equal(row.mode, "rpc");
                assert.equal(row.approvalMode, "yolo");
                assert.equal(row.extensionCount, 2);
                assert.ok(row.root?.startsWith(yield* fs.realPath(config.stateDir)));
                yield* Effect.sync(() => assert.throws(() => process.kill(row.pid, 0), /ESRCH/));
              }
              assert.equal(audit.filter((row) => row.command === "prompt").length, 3);
              assert.deepEqual(
                audit.filter((row) => row.command === "prompt").map((row) => row.promptLabel),
                ["foreground", "queued-first", "queued-second"],
              );
              const file = stoppedTranscript(audit);
              assert.ok(file);
              const transcript = yield* readTranscript(file);
              assert.deepEqual(
                transcript
                  .filter((entry) => entry.type === "message" && entry.role === "user")
                  .map((entry) => entry.text),
                ["CONTROLLED_HOLD", "queued-first", "queued-second"],
              );
              assert.equal(
                transcript.filter((entry) => entry.type === "message" && entry.role === "assistant")
                  .length,
                interrupted ? 2 : 3,
              );
              if (interrupted) {
                const switchReceipt = audit.find((row) => row.command === "switch_session");
                assert.ok(switchReceipt);
                const ownedTranscript = stoppedTranscript(audit);
                assert.equal(switchReceipt.switchTarget, ownedTranscript);
                assert.ok(stoppedPrefix);
                assert.deepEqual(transcript.slice(0, stoppedPrefix.length), stoppedPrefix);
              }
            }).pipe(Effect.provide(runtimeLayer));
          }).pipe(Effect.provide(dependencies)),
        ),
      { timeout: 60_000 },
    );
  },
);

function stoppedTranscript(audit: ReadonlyArray<typeof Audit.Type>) {
  return audit.find((row) => row.command === "prompt" && row.held === true)?.sessionFile;
}
