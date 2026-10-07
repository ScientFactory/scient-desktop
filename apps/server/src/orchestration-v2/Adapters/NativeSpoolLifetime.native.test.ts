// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerConfig from "../../config.ts";
import { nativeOmpOrchestration } from "../../provider/testUtils/nativeOmpOrchestration.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import { IdAllocatorV2, layer as allocatorLayer } from "../IdAllocator.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";

const TestLayer = Layer.mergeAll(
  allocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-spool-manager-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestLayer));
const files = (root: string, suffix: string) =>
  NodeFS.readdirSync(root, { recursive: true })
    .filter((file) => String(file).endsWith(suffix))
    .map((file) => NodePath.join(root, String(file)));
const delta = (text: string) => ({
  type: "message_update",
  message: { role: "assistant", content: "" },
  assistantMessageEvent: { type: "text_delta", delta: text },
});
const finish = (peer: ReturnType<typeof scriptedOmpRpc>) => {
  peer.state.streaming = false;
  peer.state.pendingAsyncWork = false;
  return peer.emit([
    { type: "agent_end", messages: [], isTerminal: true },
    {
      type: "prompt_result",
      agentInvoked: true,
      id: peer.state.prompts.at(-1)?.frame.id,
      status: "completed",
      sessionSettled: true,
    },
  ]);
};

it.live(
  "the actual manager abandons a blocked native pump and closes its spool before healthy replacement",
  () =>
    run(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const gates = yield* Effect.forEach(Array.from({ length: 3 }), () =>
          Effect.gen(function* () {
            return {
              entered: yield* Deferred.make<void>(),
              stopped: yield* Deferred.make<void>(),
              exited: yield* Deferred.make<void>(),
            };
          }),
        );
        const peers = Array.from({ length: 4 }, () =>
          scriptedOmpRpc({ models: [], initial: { provider: "test", id: "selected" } }),
        );
        let launches = 0;
        let generation = 0;
        const f = yield* nativeOmpOrchestration({
          eventQueueByteLimit: 128 * 1024,
          makeProcess: (options) => {
            const position = launches++;
            return peers[position]!.makeProcess(options).pipe(
              Effect.map((client) => ({
                ...client,
                shutdown: client.shutdown.pipe(
                  Effect.tap(() =>
                    gates[position]
                      ? Deferred.succeed(gates[position]!.exited, undefined)
                      : Effect.void,
                  ),
                ),
              })),
            );
          },
          decorateEventSink: (sink) => ({
            ...sink,
            write: (input) => {
              const gate = gates[generation];
              const block =
                gate &&
                input.events.length === 1 &&
                input.events.some(
                  (event) =>
                    event.type === "provider-session.updated" && event.payload.status === "running",
                );
              return (
                block
                  ? Deferred.succeed(gate.entered, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(Deferred.succeed(gate.stopped, undefined)),
                    )
                  : Effect.void
              ).pipe(Effect.andThen(sink.write(input)));
            },
          }),
        });
        yield* f.run(({ send, waitFor, orchestrator }) =>
          Effect.gen(function* () {
            const manager = yield* ProviderSessionManagerV2;
            for (; generation < gates.length; generation++) {
              const gate = gates[generation]!;
              const peer = peers[generation]!;
              yield* send(`Hold actual session pump ${generation}`);
              yield* peer.promptDelivered().pipe(Effect.timeout("3 seconds"));
              yield* Deferred.await(gate.entered).pipe(Effect.timeout("3 seconds"));
              peer.state.streaming = true;
              yield* peer.emit([
                { type: "agent_start" },
                delta(`accepted-before-abandon-${generation}`),
                delta("x".repeat(256 * 1024)),
              ]);
              yield* Deferred.await(gate.exited).pipe(Effect.timeout("3 seconds"));
              const before = yield* orchestrator.getThreadProjection(f.threadId);
              const id = before.providerSessions.at(-1)!.id;
              expect(
                files(config.stateDir, "events.bin").some((file) => NodeFS.statSync(file).size > 0),
              ).toBe(true);
              yield* manager
                .release({ providerSessionId: id, reason: "manual_shutdown" })
                .pipe(Effect.timeout("3 seconds"));
              yield* Deferred.await(gate.stopped).pipe(Effect.timeout("3 seconds"));
              expect(Option.isNone(yield* manager.get(id))).toBe(true);
              expect(files(config.stateDir, "events.bin")).toEqual([]);
              expect(files(config.stateDir, ".session.lock")).toEqual([]);
              expect(peer.state.shutdowns).toBe(1);
              const retired = yield* waitFor(
                (p) =>
                  p.runs.filter((row) => row.status === "failed" || row.status === "interrupted")
                    .length ===
                  generation + 1,
              );
              expect(retired.runs.some((row) => row.status === "completed")).toBe(false);
            }
            const retired = yield* orchestrator.getThreadProjection(f.threadId);
            yield* send("Healthy replacement");
            const healthy = peers[3]!;
            yield* healthy.promptDelivered().pipe(Effect.timeout("3 seconds"));
            yield* waitFor((p) =>
              p.providerTurns.some(
                (turn) =>
                  !retired.providerTurns.some((previous) => previous.id === turn.id) &&
                  turn.nativeAcceptance === "accepted",
              ),
            );
            healthy.state.streaming = true;
            yield* healthy.emit([
              { type: "agent_start" },
              delta("Healthy after abandoned native pumps"),
            ]);
            yield* finish(healthy);
            const recovered = yield* waitFor((p) =>
              p.runs.some((row) => row.status === "completed"),
            );
            expect(recovered.runs.filter((row) => row.status === "completed")).toHaveLength(1);
            expect(
              recovered.runs.filter(
                (row) => row.status === "failed" || row.status === "interrupted",
              ),
            ).toHaveLength(3);
            expect(healthy.state.shutdowns).toBe(0);
            yield* manager.shutdown;
            expect(healthy.state.shutdowns).toBe(1);
            expect(files(config.stateDir, "events.bin")).toEqual([]);
            expect(files(config.stateDir, ".session.lock")).toEqual([]);
          }),
        );
      }),
    ),
);

it.live.each(
  (["cancelled-publication", "failed-open"] as const).map((mode) => ({
    caseTitle: `the actual manager disposes ${mode} native resources without a started consumer`,
    mode,
  })),
)("$caseTitle", ({ mode }) =>
  run(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const entered = yield* Deferred.make<void>();
      const peer = scriptedOmpRpc({
        models: [],
        initial: { provider: "test", id: "selected" },
        ...(mode === "failed-open"
          ? {
              commandError: (frame: { readonly type: string }) =>
                frame.type === "get_state" ? "Refused synthetic native state" : undefined,
            }
          : {}),
      });
      const f = yield* nativeOmpOrchestration({
        makeProcess: peer.makeProcess,
        decorateEventSink: (sink) => ({
          ...sink,
          write: (input) =>
            (mode === "cancelled-publication" &&
            input.events.some((event) => event.type === "provider-session.attached")
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void
            ).pipe(Effect.andThen(sink.write(input))),
        }),
      });
      yield* f.run(() =>
        Effect.gen(function* () {
          const manager = yield* ProviderSessionManagerV2;
          const allocator = yield* IdAllocatorV2;
          const instanceId = ProviderInstanceId.make("omp-native-background-instance");
          const id = yield* allocator.allocate.providerSession({
            providerInstanceId: instanceId,
            threadId: f.threadId,
          });
          const opening = manager.open({
            threadId: f.threadId,
            providerSessionId: id,
            modelSelection: { instanceId, model: "test/selected" },
            runtimePolicy: {
              cwd: config.cwd,
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          });
          if (mode === "cancelled-publication") {
            const fiber = yield* opening.pipe(Effect.forkChild);
            yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"));
            expect(files(config.stateDir, "events.bin")).toHaveLength(1);
            yield* Fiber.interrupt(fiber).pipe(Effect.timeout("3 seconds"));
          } else expect(Exit.isFailure(yield* opening.pipe(Effect.exit))).toBe(true);
          expect(Option.isNone(yield* manager.get(id))).toBe(true);
          expect(peer.state.shutdowns).toBe(1);
          expect(files(config.stateDir, "events.bin")).toEqual([]);
          expect(files(config.stateDir, ".session.lock")).toEqual([]);
        }),
      );
    }),
  ),
);
