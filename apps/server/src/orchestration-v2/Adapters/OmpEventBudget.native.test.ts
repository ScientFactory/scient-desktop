// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import { nativeOmpSession } from "../../provider/testUtils/nativeOmpSession.ts";
import { nativeOmpOrchestration } from "../../provider/testUtils/nativeOmpOrchestration.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import { ompTarget } from "../../provider/omp/OmpTarget.ts";
import { layer as allocatorLayer } from "../IdAllocator.ts";
import type { ProviderAdapterV2Event } from "../ProviderAdapter.ts";

const fixture = Effect.fnUntraced(function* (limit = 64 * 1024, itemLimit = 8192) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-event-budget-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );
  const instanceId = ProviderInstanceId.make("native-budget-instance");
  const waiting: {
    readonly peer: ReturnType<typeof scriptedOmpRpc>;
    readonly exited: Deferred.Deferred<void>;
  }[] = [];
  let adapter: Effect.Success<ReturnType<typeof nativeOmpSession>>["adapter"] | undefined;
  let ordinal = 0;
  const open = Effect.fnUntraced(function* (
    nativeEventLogger?: Parameters<typeof nativeOmpSession>[0]["nativeEventLogger"],
  ) {
    const peer = scriptedOmpRpc({ models: [], initial: { provider: "test", id: "selected" } });
    const exited = yield* Deferred.make<void>();
    waiting.push({ peer, exited });
    const requests: unknown[] = [];
    const session = yield* nativeOmpSession({
      root,
      stateDir: NodePath.join(root, "state"),
      attachmentsDir: NodePath.join(root, "attachments"),
      target: ompTarget,
      instanceId,
      threadId: ThreadId.make(`budget-thread-${++ordinal}`),
      binaryPath: "synthetic-omp",
      ...(nativeEventLogger ? { nativeEventLogger } : {}),
      environment: { HOME: root },
      modelSelection: { instanceId, model: "test/selected" },
      ...(adapter ? { adapter } : {}),
      eventQueueByteLimit: limit,
      eventQueueItemLimit: itemLimit,
      continuations: {
        offer: (request) =>
          Effect.sync(() => {
            requests.push(request);
          }),
      },
      makeProcess: (options) => {
        const next = waiting.shift();
        if (!next) return Effect.die("No owned native budget peer");
        return next.peer.makeProcess(options).pipe(
          Effect.map((client) => ({
            ...client,
            shutdown: client.shutdown.pipe(
              Effect.tap(() => Deferred.succeed(next.exited, undefined)),
            ),
          })),
        );
      },
    });
    adapter = session.adapter;
    return {
      ...session,
      peer,
      requests,
      exited: Deferred.await(exited).pipe(Effect.timeout("3 seconds")),
    };
  });
  const locks = () =>
    NodeFS.readdirSync(root, { recursive: true }).filter((file) =>
      String(file).endsWith(".session.lock"),
    );
  return { open, locks };
});

const observe = Effect.fnUntraced(function* (
  session: Effect.Success<ReturnType<typeof nativeOmpSession>>,
) {
  const events: ProviderAdapterV2Event[] = [];
  const queue = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const ended = yield* Deferred.make<void>();
  yield* session.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(Effect.andThen(Queue.offer(queue, event))),
    ),
    Effect.ensuring(Deferred.succeed(ended, undefined)),
    Effect.forkScoped,
  );
  const take = Effect.fnUntraced(function* (predicate: (event: ProviderAdapterV2Event) => boolean) {
    for (;;) {
      const event = yield* Queue.take(queue);
      if (predicate(event)) return event;
    }
  });
  return {
    events,
    take: (predicate: Parameters<typeof take>[0]) =>
      take(predicate).pipe(Effect.timeout("3 seconds")),
    ended: Deferred.await(ended).pipe(Effect.timeout("3 seconds")),
  };
});

const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const start = Effect.fnUntraced(function* (
  session: Effect.Success<ReturnType<Effect.Success<ReturnType<typeof fixture>>["open"]>>,
) {
  yield* session
    .start({ text: "Work without a desktop event reader" })
    .pipe(Effect.timeout("2 seconds"));
  yield* session.peer.promptDelivered().pipe(Effect.timeout("2 seconds"));
  session.peer.state.streaming = true;
  yield* session.peer.emit([{ type: "agent_start" }]);
  yield* settle;
});

const finish = Effect.fnUntraced(function* (
  session: Effect.Success<ReturnType<Effect.Success<ReturnType<typeof fixture>>["open"]>>,
) {
  session.peer.state.streaming = false;
  session.peer.state.pendingAsyncWork = false;
  yield* session.peer.finish();
});

const delta = (text: string) => ({
  type: "message_update",
  message: { role: "assistant", content: "" },
  assistantMessageEvent: { type: "text_delta", delta: text },
});

describe("native OMP event ingress budgets", () => {
  it.live(
    "contains an oversized native update, retains failure and admits quiet and replacement sessions",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          const noisy = yield* f.open();
          const quiet = yield* f.open();
          const n = yield* observe(noisy);
          const q = yield* observe(quiet);
          yield* start(noisy);
          yield* start(quiet);
          yield* noisy.peer.emit([delta("x".repeat(256 * 1024))]);
          const terminal = yield* n.take((event) => event.type === "turn.terminal");
          expect(terminal).toMatchObject({
            status: "failed",
            threadDisposition: "broken",
            failure: { class: "provider_error" },
          });
          yield* noisy.exited;
          expect(n.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
          expect(n.events.some((event) => event.type === "message.updated")).toBe(false);
          expect(noisy.runtime.providerSession.status).toBe("error");
          expect(noisy.peer.state.shutdowns).toBe(1);
          yield* noisy.close;
          yield* n.ended;
          expect(f.locks()).toHaveLength(1);
          expect(quiet.runtime.providerSession.status).toBe("running");
          yield* finish(quiet);
          expect(yield* q.take((event) => event.type === "turn.terminal")).toMatchObject({
            status: "completed",
          });
          expect(quiet.peer.state.shutdowns).toBe(0);
          const replacement = yield* f.open();
          const r = yield* observe(replacement);
          yield* start(replacement);
          yield* replacement.peer.emit([delta("Replacement answer")]);
          yield* finish(replacement);
          expect(yield* r.take((event) => event.type === "turn.terminal")).toMatchObject({
            status: "completed",
          });
          expect(
            r.events.some(
              (event) =>
                event.type === "message.updated" && event.message.text === "Replacement answer",
            ),
          ).toBe(true);
          yield* noisy.close;
          expect(noisy.peer.state.shutdowns).toBe(1);
        }),
      ),
  );

  it.live(
    "bounds buffered native wake results and retains the settled parent's only terminal",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          const session = yield* f.open();
          const seen = yield* observe(session);
          yield* start(session);
          session.peer.state.pendingAsyncWork = true;
          session.peer.state.streaming = false;
          yield* session.peer.emit([
            { type: "agent_end", messages: [], yielded: true },
            {
              type: "prompt_result",
              agentInvoked: true,
              id: session.peer.state.prompts.at(-1)?.frame.id,
              status: "completed",
              sessionSettled: false,
            },
          ]);
          expect(yield* seen.take((event) => event.type === "turn.terminal")).toMatchObject({
            status: "completed",
          });
          yield* seen.take(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.pendingBackgroundTasks?.some(
                (task) => task.kind === "monitor",
              ) === true,
          );
          session.peer.state.streaming = true;
          const result = (job: string) => ({
            type: "message_end",
            message: {
              role: "custom",
              customType: "async-result",
              content: `${job}: ${"z".repeat(40 * 1024)}`,
            },
          });
          yield* session.peer.emit([{ type: "agent_start" }, result("job-one"), result("job-two")]);
          yield* seen.take(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "error",
          );
          yield* session.exited;
          expect(session.runtime.providerSession.status).toBe("error");
          expect(session.peer.state.shutdowns).toBe(1);
          expect(session.requests).toHaveLength(1);
          expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
          expect(
            seen.events.some(
              (event) =>
                event.type === "turn_item.updated" && event.turnItem.title === "Background result",
            ),
          ).toBe(false);
          expect(
            seen.events.findLast((event) => event.type === "provider_thread.updated"),
          ).toMatchObject({ providerThread: { pendingBackgroundTasks: [], status: "error" } });
          yield* session.close;
          yield* seen.ended;
          expect(f.locks()).toHaveLength(0);
        }),
      ),
  );

  it.live("sheds only the largest native backlog when all eight readers are stalled", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture(128 * 1024);
        const sessions = yield* Effect.forEach(Array.from({ length: 8 }), () =>
          f.open().pipe(Effect.tap(start)),
        );
        const largest = sessions[0]!;
        yield* largest.peer.emit([delta("L".repeat(40_000))]);
        yield* settle;
        expect(largest.runtime.providerSession.status).toBe("running");
        let shed = false;
        for (const session of sessions.slice(1)) {
          yield* session.peer.emit([delta("q".repeat(30_000))]);
          yield* settle;
          if (largest.runtime.providerSession.status === "error") {
            shed = true;
            break;
          }
          expect(
            sessions.every((owner) => owner.runtime.providerSession.status === "running"),
          ).toBe(true);
        }
        expect(shed).toBe(true);
        expect(
          sessions
            .slice(1)
            .every((session) => session.runtime.providerSession.status === "running"),
        ).toBe(true);
        const observers = yield* Effect.forEach(sessions, observe);
        expect(yield* observers[0]!.take((event) => event.type === "turn.terminal")).toMatchObject({
          status: "failed",
          threadDisposition: "broken",
        });
        yield* largest.exited;
        yield* largest.close;
        yield* observers[0]!.ended;
        expect(observers[0]!.events.filter((event) => event.type === "turn.terminal")).toHaveLength(
          1,
        );
        expect(
          observers[0]!.events.findLast((event) => event.type === "message.updated"),
        ).toMatchObject({
          message: { text: "L".repeat(40_000), streaming: false },
        });
        expect(largest.peer.state.shutdowns).toBe(1);
        expect(f.locks()).toHaveLength(7);
        for (let index = 1; index < sessions.length; index++) {
          yield* finish(sessions[index]!);
          expect(
            yield* observers[index]!.take((event) => event.type === "turn.terminal"),
          ).toMatchObject({ status: "completed" });
          expect(sessions[index]!.peer.state.shutdowns).toBe(0);
        }
      }),
    ),
  );

  it.live(
    "does not block native turn admission behind 5000 idle updates and a stalled reader",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          const decoded = yield* Deferred.make<void>();
          const lastIdle = Schema.is(
            Schema.Struct({
              event: Schema.Struct({
                kind: Schema.Literal("notification"),
                payload: Schema.Struct({
                  _tag: Schema.Literal("Event"),
                  event: Schema.Struct({
                    type: Schema.Literal("tool_execution_update"),
                    toolCallId: Schema.Literal("idle-4999"),
                  }),
                }),
              }),
            }),
          );
          const session = yield* f.open({
            filePath: "synthetic-native-observer",
            write: (event) =>
              lastIdle(event)
                ? Deferred.succeed(decoded, undefined).pipe(Effect.asVoid)
                : Effect.void,
            close: () => Effect.void,
          });
          yield* session.peer.emit(
            Array.from({ length: 5000 }, (_, index) => ({
              type: "tool_execution_update",
              toolCallId: `idle-${index}`,
              toolName: "read",
              partialResult: { output: "idle" },
            })),
          );
          yield* Deferred.await(decoded).pipe(Effect.timeout("2 seconds"));
          yield* start(session);
          expect(session.peer.state.prompts).toHaveLength(1);
          const seen = yield* observe(session);
          yield* finish(session);
          expect(yield* seen.take((event) => event.type === "turn.terminal")).toMatchObject({
            status: "completed",
          });
          expect(
            seen.events.some(
              (event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
            ),
          ).toBe(false);
          yield* session.close;
          expect(session.peer.state.shutdowns).toBe(1);
        }),
      ),
  );
});

const workers = Layer.mergeAll(
  NodeServices.layer,
  allocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-budget-worker-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
it.live(
  "contains native background monitor overflow through real workers and SQL without inventing a child or wake",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* nativeOmpOrchestration({ eventQueueByteLimit: 1 });
        yield* f.run(({ send, waitFor }) =>
          Effect.gen(function* () {
            yield* send("Start native background work");
            yield* waitFor((p) =>
              p.providerTurns.some((turn) => turn.nativeAcceptance === "accepted"),
            );
            yield* f.emit([{ type: "agent_start" }]);
            yield* f.finish(false);
            const failed = yield* waitFor(
              (p) =>
                p.providerSessions.some((session) => session.status === "error") &&
                p.providerThreads.some((thread) => thread.status === "error") &&
                p.runs[0]?.status === "completed",
            );
            expect(failed.runs).toHaveLength(1);
            expect(failed.runs[0]?.status).toBe("completed");
            expect(failed.providerTurns).toHaveLength(1);
            expect(failed.providerTurns[0]?.status).toBe("completed");
            expect(failed.subagents).toEqual([]);
            expect(failed.providerThreads[0]?.pendingBackgroundTasks).toEqual([]);
            expect(f.peer.state.prompts).toHaveLength(1);
            yield* waitFor((p) => p.providerSessions.some((session) => session.status === "error"));
          }),
        );
        expect(f.peer.state.shutdowns).toBe(1);
      }),
    ).pipe(Effect.provide(workers)),
);
