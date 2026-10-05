/** Actual Droid ACP writes through V2 command, restart and queue ownership. */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DroidSettings,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Config from "../config.ts";
import { makeDroidAcpRuntime } from "../provider/acp/DroidAcpSupport.ts";
import { scriptedDroid } from "../provider/testUtils/scriptedDroid.ts";
import { makeDroidAdapterV2 } from "./Adapters/DroidAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2, type OrchestratorV2Error } from "./Orchestrator.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const decodeDroidSettings = Schema.decodeEffect(DroidSettings);
const instanceId = ProviderInstanceId.make("droid-native-scheduling");
const threadId = ThreadId.make("thread:droid-native-scheduling");
const selection = { instanceId, model: "droid-native" };
const outer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  Config.layerTest(process.cwd(), { prefix: "droid-native-scheduling-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const withDroid = <A, E, R>(
  body: string,
  run: (h: {
    orchestrator: OrchestratorV2["Service"];
    worker: OrchestrationEffectWorkerV2["Service"];
    send: (
      text: string,
      mode?: "start_immediately" | "queue_after_active" | "steer_active",
      model?: string,
    ) => ReturnType<OrchestratorV2["Service"]["dispatch"]>;
    stop: () => Effect.Effect<void, OrchestratorV2Error>;
    waitFor: (
      p: (projection: OrchestrationV2ThreadProjection) => boolean,
    ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
    preparationEntered: Effect.Effect<void>;
    admissionGuard: () => Effect.Effect<boolean>;
    releasePreparation: Effect.Effect<boolean>;
    log: Effect.Effect<ReadonlyArray<{ method?: string; params?: Record<string, unknown> }>>;
    injectEvent: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
  }) => Effect.Effect<A, E, R>,
  options: { manualWorker?: boolean; holdModel?: boolean; injectEvents?: boolean } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("droid-native-scheduling");
      const injected = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const peer = yield* scriptedDroid(body);
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const allocator = yield* IdAllocatorV2;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const entered = yield* Deferred.make<void>(),
        released = yield* Deferred.make<void>();
      let admissionGuard = () => Effect.succeed(false);
      const nativeAdapter = makeDroidAdapterV2({
        instanceId,
        settings: yield* decodeDroidSettings({
          enabled: true,
          binaryPath: peer.binaryPath,
        }),
        environment: { PATH: process.env.PATH },
        sensitiveEnvironmentValues: [],
        makeRuntime: (input) =>
          makeDroidAcpRuntime(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              setModel: (model) =>
                options.holdModel && model === "droid-other"
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(released)),
                      Effect.andThen(runtime.setModel(model)),
                    )
                  : runtime.setModel(model),
            })),
          ),
        childProcessSpawner: spawner,
        fileSystem: fs,
        crypto,
        serverConfig: config,
        idAllocator: allocator,
        selfInvocation: yield* resolveSelfInvocation(),
        onAuthenticationRejected: () => Effect.die("No authentication in scheduling peer"),
      });
      const adapter = {
        ...nativeAdapter,
        openSession: (input: Parameters<typeof nativeAdapter.openSession>[0]) =>
          nativeAdapter.openSession(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              ...(options.injectEvents
                ? {
                    events: runtime.events.pipe(
                      Stream.merge(Stream.fromQueue(injected), { haltStrategy: "left" }),
                    ),
                  }
                : {}),
              startTurn: (turn: Parameters<typeof runtime.startTurn>[0]) => {
                admissionGuard = turn.shouldStartProviderTurn ?? (() => Effect.succeed(false));
                return runtime.startTurn(turn);
              },
            })),
          ),
      };
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "droid-native-scheduling", runtimePolicyOverride: { cwd } },
        makeLayer([adapter]),
        {
          configureMcp: false,
          runEffectWorker: !options.manualWorker,
          serverConfigLayer: Layer.succeed(Config.ServerConfig, config),
          responseStreamingMode: options.injectEvents ? "paragraph" : "turn",
        },
      );
      return yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2,
          worker = yield* OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("droid-create"),
          threadId,
          projectId: ProjectId.make("droid-project"),
          title: "Droid scheduling",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const waitFor = (predicate: (p: OrchestrationV2ThreadProjection) => boolean) =>
          Effect.scoped(
            Effect.gen(function* () {
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
              ).pipe(
                Stream.filter(predicate),
                Stream.runHead,
                Effect.timeout("15 seconds"),
                Effect.catchTag("TimeoutError", () =>
                  Effect.die("Missing native Droid scheduling receipt"),
                ),
              );
              assert.ok(Option.isSome(found));
              return found.value;
            }),
          );
        return yield* run({
          orchestrator,
          worker,
          waitFor,
          send: (text, mode = "start_immediately", model = selection.model) =>
            Effect.gen(function* () {
              const projection = yield* orchestrator.getThreadProjection(threadId);
              return yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`send:${text}`),
                threadId,
                messageId: MessageId.make(`message:${text}`),
                text,
                attachments: [],
                dispatchMode:
                  mode === "steer_active"
                    ? {
                        type: "steer_active",
                        targetRunId: projection.runs.find((r) =>
                          ["starting", "running", "waiting"].includes(r.status),
                        )!.id,
                      }
                    : { type: mode },
                modelSelection: { instanceId, model },
                createdBy: "user",
                creationSource: "web",
              });
            }),
          stop: () =>
            Effect.gen(function* () {
              const p = yield* orchestrator.getThreadProjection(threadId);
              yield* orchestrator.dispatch({
                type: "run.interrupt",
                commandId: CommandId.make(
                  `droid-stop:${p.runs.find((r) => ["starting", "running", "waiting"].includes(r.status))!.id}`,
                ),
                threadId,
                runId: p.runs.find((r) => ["starting", "running", "waiting"].includes(r.status))!
                  .id,
              });
            }),
          preparationEntered: Deferred.await(entered),
          admissionGuard: () => admissionGuard(),
          releasePreparation: Deferred.succeed(released, undefined),
          log: peer.readLog(),
          injectEvent: (event) => Queue.offer(injected, event).pipe(Effect.asVoid),
        });
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(outer));

const promptTexts = (log: ReadonlyArray<{ method?: string; params?: Record<string, unknown> }>) =>
  log
    .filter((row) => row.method === "session/prompt")
    .map((row) => (row.params?.prompt as ReadonlyArray<{ text?: string }> | undefined)?.[0]?.text)
    .map((text) => text?.match(/<user_request>\n([\s\S]*)\n<\/user_request>$/u)?.[1] ?? text);
const waiting = `const pending = [];
function onPrompt(message) { if ((message.params.prompt[0].text === "first" || message.params.prompt[0].text.endsWith("\\nfirst\\n</user_request>"))) { pending.push(message); update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "owned-first" } }); } else reply(message, { stopReason: "end_turn" }); }
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" }); };`;

it.live(
  "native Droid steering retains one Scient run with a replacement attempt and a single completed owner",
  () =>
    withDroid(waiting, (h) =>
      Effect.gen(function* () {
        yield* h.send("first");
        const first = yield* h.waitFor((p) =>
          p.providerTurns.some((turn) => turn.status === "running"),
        );
        yield* h.send("follow-up", "steer_active");
        const settled = yield* h.waitFor((p) => p.runs[0]?.status === "completed");
        assert.lengthOf(settled.runs, 1);
        assert.equal(settled.runs[0]?.id, first.runs[0]?.id);
        assert.lengthOf(settled.attempts, 2);
        assert.equal(settled.attempts[0]?.status, "superseded");
        assert.equal(settled.attempts[1]?.status, "completed");
        assert.deepEqual(promptTexts(yield* h.log), ["first", "follow-up"]);
        assert.lengthOf(
          (yield* h.log).filter((r) => r.method === "session/cancel"),
          1,
        );
      }),
    ),
);

it.live("Stop before native Droid start offer cancels the pending attempt without a prompt", () =>
  withDroid(
    waiting,
    (h) =>
      Effect.gen(function* () {
        yield* h.send("first");
        yield* h.stop();
        yield* h.worker.drain(12);
        const stopped = yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
        assert.lengthOf(stopped.attempts, 1);
        assert.equal(stopped.attempts[0]?.status, "interrupted");
        assert.lengthOf(stopped.providerTurns, 0);
        assert.isFalse(stopped.turnItems.some((item) => item.type === "error"));
        assert.deepEqual(promptTexts(yield* h.log), []);
        yield* h.send("again");
        yield* h.worker.drain(12);
        yield* h.waitFor(
          (p) =>
            p.runs[1]?.status === "waiting" &&
            p.providerTurns.some(
              (turn) =>
                turn.status === "completed" && turn.runAttemptId === p.runs[1]?.activeAttemptId,
            ),
        );
        yield* h.worker.drain(12);
        const recovered = yield* h.waitFor((p) => p.runs[1]?.status === "completed");
        assert.equal(recovered.runs[0]?.status, "interrupted");
        assert.lengthOf(promptTexts(yield* h.log), 1);
        assert.isTrue(promptTexts(yield* h.log)[0]?.endsWith("again"));
        // Capture another pending start on the reused owner, then physically
        // close that session before Stop can deliver any native turn.
        yield* h.send("session disappeared before acceptance");
        const pending = yield* h.orchestrator.getThreadProjection(threadId);
        const third = pending.runs.at(-1)!;
        assert.equal(third.status, "starting");
        assert.isFalse(
          pending.providerTurns.some((turn) => turn.runAttemptId === third.activeAttemptId),
        );
        const owner = pending.providerThreads.find(
          (thread) => thread.id === pending.thread.activeProviderThreadId,
        )!;
        assert.ok(owner.providerSessionId);
        yield* (yield* ProviderSessionManagerV2).close(owner.providerSessionId);
        yield* h.stop();
        yield* h.worker.drain(12);
        const absent = yield* h.waitFor(
          (p) => p.runs.find((run) => run.id === third.id)?.status === "interrupted",
        );
        assert.isFalse(
          absent.turnItems.some((item) => item.runId === third.id && item.type === "error"),
        );
        assert.isFalse(
          absent.providerTurns.some((turn) => turn.runAttemptId === third.activeAttemptId),
        );
        assert.lengthOf(promptTexts(yield* h.log), 1);
      }),
    { manualWorker: true },
  ),
);

it.live(
  "native Droid queued follow-ups wait for an active tool and Stop preserves their unsent payloads",
  () =>
    withDroid(
      `${waiting}
const original = onPrompt; onPrompt = message => { original(message); if ((message.params.prompt[0].text === "first" || message.params.prompt[0].text.endsWith("\\nfirst\\n</user_request>"))) update({ sessionUpdate: "tool_call", toolCallId: "running-tool", title: "Run tests", kind: "execute", status: "pending" }); };`,
      (h) =>
        Effect.gen(function* () {
          yield* h.send("first");
          yield* h.waitFor((p) => p.turnItems.some((i) => i.type === "command_execution"));
          yield* h.send("held-one", "queue_after_active");
          yield* h.send("held-two", "queue_after_active");
          assert.deepEqual(promptTexts(yield* h.log), ["first"]);
          assert.lengthOf(
            (yield* h.log).filter((r) => r.method === "session/cancel"),
            0,
          );
          yield* h.stop();
          yield* h.worker.drain(12);
          const held = yield* h.waitFor((p) =>
            p.runs.filter((r) => r.status === "queued").every((r) => r.queueHeld === true),
          );
          assert.deepEqual(promptTexts(yield* h.log), ["first"]);
          assert.lengthOf(
            held.runs.filter((r) => r.status === "queued" && r.queueHeld),
            2,
          );
        }),
    ),
);

it.live(
  "unconfirmed native Droid replacement settings fail the owned run without offering the follow-up",
  () =>
    withDroid(
      `${waiting}\nunreported = message => message.params.configId === "model" && message.params.value === "droid-other";`,
      (h) =>
        Effect.gen(function* () {
          yield* h.send("first");
          yield* h.waitFor((p) => p.providerTurns.some((turn) => turn.status === "running"));
          yield* h.send("follow-up", "steer_active", "droid-other");
          const failed = yield* h.waitFor((p) => p.runs[0]?.status === "failed");
          assert.lengthOf(failed.runs, 1);
          assert.equal(failed.attempts.at(-1)?.status, "failed");
          assert.deepEqual(promptTexts(yield* h.log), ["first"]);
          assert.isTrue(failed.turnItems.some((item) => item.type === "error"));
        }),
    ),
);

it.live("supplies native Droid preparation with an authoritative guard invalidated by Stop", () =>
  withDroid(
    waiting,
    (h) =>
      Effect.gen(function* () {
        yield* h.send("first");
        yield* h.waitFor((p) => p.providerTurns.some((turn) => turn.status === "running"));
        yield* h.send("follow-up", "steer_active", "droid-other");
        yield* h.preparationEntered.pipe(Effect.timeout("10 seconds"));
        assert.isTrue(yield* h.admissionGuard());
        yield* h.stop();
        assert.isFalse(yield* h.admissionGuard());
        yield* h.releasePreparation;
        yield* h.worker.drain(12);
        yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
      }),
    { holdModel: true },
  ),
);

for (const terminal of ["completed", "interrupted"] as const) {
  it.live(
    `explicit native Steer retains the old answer when its late ${terminal} receipt arrives after adoption`,
    () =>
      withDroid(
        `const pending = [];
function onPrompt(message) { pending.push(message); update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: pending.length === 1 && state.prompts === 1 ? "old received answer\\n\\n" : "new owned answer\\n\\n" } }); }
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" }); };`,
        (h) =>
          Effect.gen(function* () {
            yield* h.send("first");
            const before = yield* h.waitFor((p) =>
              p.messages.some(
                (message) =>
                  message.role === "assistant" && message.text === "old received answer\n\n",
              ),
            );
            const oldTurn = before.providerTurns.find((turn) => turn.status === "running")!;
            const oldMessage = before.messages.find(
              (message) => message.text === "old received answer\n\n",
            )!;
            assert.isTrue(oldMessage.streaming);
            yield* h.send("follow-up", "steer_active");
            const adopted = yield* h.waitFor(
              (p) =>
                p.attempts.length === 2 &&
                p.providerTurns.some(
                  (turn) =>
                    turn.runAttemptId === p.runs[0]?.activeAttemptId && turn.status === "running",
                ) &&
                p.messages.some((message) => message.text === "new owned answer\n\n"),
            );
            assert.notEqual(adopted.runs[0]?.activeAttemptId, oldTurn.runAttemptId);
            assert.deepEqual(promptTexts(yield* h.log), ["first", "follow-up"]);
            // Feed exact normalized old receipt identity at the engine seam. The
            // real ACP replacement above owns the new prompt; producer compatibility
            // and safe-Steer deferral remain the provider lane's complementary proof.
            yield* h.injectEvent({
              type: "turn.terminal",
              driver: ProviderDriverKind.make("droid"),
              providerThreadId: oldTurn.providerThreadId,
              providerTurnId: oldTurn.id,
              runOrdinal: adopted.runs[0]!.ordinal,
              status: terminal,
              failure: null,
              threadDisposition: "reusable",
            });
            yield* h.injectEvent({
              type: "provider_turn.updated",
              driver: ProviderDriverKind.make("droid"),
              providerTurn: { ...oldTurn, status: terminal, completedAt: yield* DateTime.now },
            });
            const owner = adopted.providerThreads.find(
              (thread) => thread.id === adopted.thread.activeProviderThreadId,
            )!;
            const marker = `old-${terminal}-observed`;
            yield* h.injectEvent({
              type: "provider_thread.updated",
              driver: ProviderDriverKind.make("droid"),
              providerThread: {
                ...owner,
                nativeMetadata: { ...owner.nativeMetadata, title: marker },
              },
            });
            const after = yield* h.waitFor((p) =>
              p.providerThreads.some((thread) => thread.nativeMetadata?.title === marker),
            );
            assert.equal(after.runs[0]?.status, "running");
            assert.equal(after.runs[0]?.activeAttemptId, adopted.runs[0]?.activeAttemptId);
            assert.equal(
              after.providerTurns.find(
                (turn) => turn.runAttemptId === adopted.runs[0]?.activeAttemptId,
              )?.status,
              "running",
            );
            const retained = after.messages.find((message) => message.id === oldMessage.id)!;
            assert.equal(retained.text, oldMessage.text);
            assert.isFalse(retained.streaming);
            yield* h.stop();
            yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
          }),
        { injectEvents: true },
      ),
  );
}
