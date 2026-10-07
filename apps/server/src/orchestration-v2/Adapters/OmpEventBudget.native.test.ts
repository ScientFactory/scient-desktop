// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

const encodeEventJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.fnUntraced(function* (limit = 64 * 1024, itemLimit = 8192) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-event-budget-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );
  const instanceId = ProviderInstanceId.make("native-budget-instance");
  const fs = yield* FileSystem.FileSystem;
  let reads = 0;
  let handles = 0;
  const openFile: FileSystem.FileSystem["open"] = (name, options) =>
    fs.open(name, options).pipe(
      Effect.flatMap((file) =>
        Effect.gen(function* () {
          if (!name.endsWith("events.bin")) return file;
          handles++;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              handles--;
            }),
          );
          const read: FileSystem.File["read"] = (bytes) =>
            Effect.sync(() => {
              reads++;
            }).pipe(Effect.andThen(file.read(bytes)));
          return new Proxy(file, {
            get: (target, key, receiver) =>
              key === "read" ? read : Reflect.get(target, key, receiver),
          });
        }),
      ),
    );
  const fileSystem = new Proxy(fs, {
    get: (target, key, receiver) =>
      key === "open" ? openFile : Reflect.get(target, key, receiver),
  });
  const waiting: {
    readonly peer: ReturnType<typeof scriptedOmpRpc>;
    readonly exited: Deferred.Deferred<void>;
  }[] = [];
  let adapter: Effect.Success<ReturnType<typeof nativeOmpSession>>["adapter"] | undefined;
  let ordinal = 0;
  const barriers = new Map<string, Deferred.Deferred<void>>();
  const isBarrier = Schema.is(
    Schema.Struct({
      event: Schema.Struct({
        kind: Schema.Literal("notification"),
        threadId: Schema.String,
        payload: Schema.Struct({
          _tag: Schema.Literal("Event"),
          event: Schema.Struct({ type: Schema.Literal("model_changed") }),
        }),
      }),
    }),
  );
  const open = Effect.fnUntraced(function* (
    nativeEventLogger?: Parameters<typeof nativeOmpSession>[0]["nativeEventLogger"],
  ) {
    const peer = scriptedOmpRpc({ models: [], initial: { provider: "test", id: "selected" } });
    const exited = yield* Deferred.make<void>();
    waiting.push({ peer, exited });
    const requests: unknown[] = [];
    const threadId = ThreadId.make(`budget-thread-${++ordinal}`);
    const session = yield* nativeOmpSession({
      root,
      stateDir: NodePath.join(root, "state"),
      attachmentsDir: NodePath.join(root, "attachments"),
      target: ompTarget,
      instanceId,
      threadId,
      binaryPath: "synthetic-omp",
      nativeEventLogger: {
        filePath: "synthetic-native-budget-barrier",
        write: (event, owner) =>
          (nativeEventLogger?.write(event, owner) ?? Effect.void).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const barrier = isBarrier(event) ? barriers.get(event.event.threadId) : undefined;
                return barrier
                  ? Deferred.succeed(barrier, undefined).pipe(Effect.asVoid)
                  : Effect.void;
              }),
            ),
          ),
        close: () => Effect.void,
      },
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
    }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
    adapter = session.adapter;
    return {
      ...session,
      peer,
      requests,
      drain: Effect.gen(function* () {
        const barrier = yield* Deferred.make<void>();
        barriers.set(threadId, barrier);
        yield* peer.emit([{ type: "model_changed" }]);
        yield* Deferred.await(barrier).pipe(Effect.timeout("3 seconds"));
        barriers.delete(threadId);
      }),
      exited: Deferred.await(exited).pipe(Effect.timeout("3 seconds")),
    };
  });
  const locks = () =>
    NodeFS.readdirSync(root, { recursive: true }).filter((file) =>
      String(file).endsWith(".session.lock"),
    );
  const backlogs = () =>
    NodeFS.readdirSync(root, { recursive: true })
      .filter((entry) => String(entry).endsWith("events.bin"))
      .map((entry) => NodePath.join(root, String(entry)));
  return { open, locks, backlogs, reads: () => reads, handles: () => handles };
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
        for (const [position, session] of sessions.entries()) {
          for (let index = 0; index < (position === 0 ? 3 : 2); index++) {
            yield* session.peer.emit([
              {
                type: "tool_execution_update",
                toolCallId: `tool-${index}`,
                toolName: "read",
                partialResult: { output: "z".repeat(15_000) },
              },
            ]);
          }
          if (session.runtime.providerSession.status === "running") yield* session.drain;
        }
        // The native tool preview is capped at 1024 characters, unlike V1. Keep the
        // complete original 3/2 tool matrix, then drive meaningful answer data
        // through every owner's real canonical queue at the existing 128KiB cap.
        for (const [position, session] of sessions.entries()) {
          yield* session.peer.emit([
            delta((position === 0 ? "L" : "q").repeat(position === 0 ? 40_000 : 20_000)),
          ]);
          if (session.runtime.providerSession.status === "running") yield* session.drain;
        }
        yield* largest.exited;
        expect(largest.peer.state.shutdowns).toBe(1);
        for (const session of sessions.slice(1)) {
          expect(session.runtime.providerSession.status).toBe("running");
          expect(session.peer.state.shutdowns).toBe(0);
          yield* session.peer.emit([
            {
              type: "tool_execution_update",
              toolCallId: "tool-0",
              toolName: "read",
              partialResult: { output: "Healthy update" },
            },
          ]);
          if (session.runtime.providerSession.status === "running") yield* session.drain;
        }
        expect(
          sessions
            .slice(1)
            .every((session) => session.runtime.providerSession.status === "running"),
        ).toBe(true);
        const spilled = f.backlogs().filter((file) => NodeFS.statSync(file).size > 0);
        expect(spilled).toHaveLength(1);
        expect(NodeFS.statSync(spilled[0]!).mode & 0o777).toBe(0o600);
        expect(NodeFS.statSync(NodePath.dirname(spilled[0]!)).mode & 0o777).toBe(0o700);
        expect(NodeFS.readFileSync(spilled[0]!, "utf8")).toContain("L".repeat(40_000));
        // All survivor traffic above happened before releasing or reading A.
        // Producer seal retains the consumer-owned disk cursor without reading it.
        yield* largest.close;
        expect(NodeFS.existsSync(spilled[0]!)).toBe(true);
        expect(f.reads()).toBe(0);
        const survivorObservers = yield* Effect.forEach(sessions.slice(1), observe);
        const retired = [];
        for (let generation = 0; generation < 3; generation++) {
          const replacement = yield* f.open();
          yield* start(replacement);
          yield* replacement.peer.emit([delta("R".repeat(4000)), delta("x".repeat(256 * 1024))]);
          yield* replacement.exited;
          yield* replacement.close;
          retired.push(replacement);
          expect(replacement.peer.state.shutdowns).toBe(1);
          expect(f.reads()).toBe(0);
          expect(f.backlogs().filter((file) => NodeFS.statSync(file).size > 0)).toHaveLength(
            generation + 2,
          );
          for (const survivor of sessions.slice(1)) {
            yield* survivor.peer.emit([
              {
                type: "tool_execution_update",
                toolCallId: "tool-1",
                toolName: "read",
                partialResult: { output: `After sealed generation ${generation}` },
              },
            ]);
            yield* survivor.drain;
            expect(survivor.runtime.providerSession.status).toBe("running");
            expect(survivor.peer.state.shutdowns).toBe(0);
          }
        }
        for (const replacement of retired) {
          const reader = yield* observe(replacement);
          expect(yield* reader.take((event) => event.type === "turn.terminal")).toMatchObject({
            status: "failed",
            threadDisposition: "broken",
          });
          yield* reader.ended;
          expect(reader.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
          expect(reader.events.findLast((event) => event.type === "message.updated")).toMatchObject(
            { message: { text: "R".repeat(4000), streaming: false } },
          );
        }
        const observers = [yield* observe(largest), ...survivorObservers];
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
        ).toMatchObject({ message: { text: "L".repeat(40_000), streaming: false } });
        const retained = observers[0]!.events.filter(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
        );
        expect(
          new Set(
            retained.map((event) =>
              event.type === "turn_item.updated" ? event.turnItem.id : null,
            ),
          ).size,
        ).toBe(3);
        expect(
          retained.every(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.output === `${"z".repeat(1024)}…`,
          ),
        ).toBe(true);
        expect(largest.peer.state.shutdowns).toBe(1);
        expect(f.locks()).toHaveLength(7);
        for (let index = 1; index < sessions.length; index++) {
          yield* sessions[index]!.peer.emit([delta("Healthy answer")]);
          yield* finish(sessions[index]!);
          expect(
            yield* observers[index]!.take((event) => event.type === "turn.terminal"),
          ).toMatchObject({ status: "completed" });
          expect(sessions[index]!.peer.state.shutdowns).toBe(0);
          expect(
            observers[index]!.events.findLast((event) => event.type === "message.updated"),
          ).toMatchObject({
            message: { text: "q".repeat(20_000) + "Healthy answer", streaming: false },
          });
          yield* sessions[index]!.close;
        }
        expect(f.locks()).toHaveLength(0);
        expect(f.handles()).toBe(0);
        expect(f.backlogs()).toEqual([]);
      }),
    ),
  );

  it.live(
    "global item pressure reclaims the item-heavy owner instead of byte-heavy survivors",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture(1024 * 1024, 70);
          const sessions = yield* Effect.forEach(Array.from({ length: 8 }), () =>
            f.open().pipe(Effect.tap(start)),
          );
          const tool = (owner: number, index: number, output: string) => ({
            type: "tool_execution_update",
            toolCallId: owner === 0 ? `tiny-${index}` : `${"byte-heavy-".repeat(64)}${index}`,
            toolName: "read",
            partialResult: { output },
          });
          for (const [owner, session] of sessions.entries()) {
            for (let index = 0; index < (owner === 0 ? 21 : 11); index++)
              yield* session.peer.emit([
                tool(owner, index, owner === 0 ? "tiny" : "q".repeat(4096)),
              ]);
            yield* session.drain;
          }
          for (const [index, session] of sessions.slice(1).entries()) {
            yield* session.peer.emit([tool(index + 1, 0, "updated"), delta("Healthy items")]);
            yield* session.drain;
          }
          const largest = sessions[0]!;
          yield* largest.exited;
          for (const [index, session] of sessions.slice(1).entries()) {
            expect(session.peer.state.shutdowns).toBe(0);
            expect(session.runtime.providerSession.status).toBe("running");
            yield* session.peer.emit([tool(index + 1, 1, "still healthy")]);
            yield* session.drain;
          }
          expect(
            sessions
              .slice(1)
              .every((session) => session.runtime.providerSession.status === "running"),
          ).toBe(true);
          expect(f.backlogs().filter((file) => NodeFS.statSync(file).size > 0)).toHaveLength(1);
          const observers = yield* Effect.forEach(sessions, observe);
          expect(
            yield* observers[0]!.take((event) => event.type === "turn.terminal"),
          ).toMatchObject({ status: "failed", threadDisposition: "broken" });
          const runningBytes = (events: readonly ProviderAdapterV2Event[]) =>
            events
              .filter(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "dynamic_tool" &&
                  event.turnItem.status === "running",
              )
              .reduce((sum, event) => sum + Buffer.byteLength(encodeEventJson(event)), 0);
          for (let index = 1; index < sessions.length; index++) {
            yield* finish(sessions[index]!);
            expect(
              yield* observers[index]!.take((event) => event.type === "turn.terminal"),
            ).toMatchObject({ status: "completed" });
            expect(runningBytes(observers[index]!.events)).toBeGreaterThan(
              runningBytes(observers[0]!.events),
            );
            expect(sessions[index]!.peer.state.shutdowns).toBe(0);
            yield* sessions[index]!.close;
          }
          expect(
            observers[0]!.events.filter((event) => event.type === "turn.terminal"),
          ).toHaveLength(1);
          yield* largest.close;
          yield* observers[0]!.ended;
          expect(largest.peer.state.shutdowns).toBe(1);
          expect(f.locks()).toHaveLength(0);
          expect(f.backlogs()).toEqual([]);
        }),
      ),
  );

  it.live("contains repeated native item overflows without cancelling a reading quiet owner", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture(1024 * 1024, 24);
        const quiet = yield* f.open();
        const q = yield* observe(quiet);
        yield* start(quiet);
        for (let generation = 0; generation < 2; generation++) {
          const noisy = yield* f.open();
          yield* start(noisy);
          // These tiny frames cannot exhaust the 1MiB byte allowance.
          yield* noisy.peer.emit(
            Array.from({ length: 24 }, (_, index) => ({
              type: "tool_execution_update",
              toolCallId: `tiny-${index}`,
              toolName: "read",
              partialResult: { output: "tiny" },
            })),
          );
          yield* noisy.exited;
          expect(noisy.peer.state.shutdowns).toBe(1);
          expect(quiet.runtime.providerSession.status).toBe("running");
          yield* noisy.close;
          const seen = yield* observe(noisy);
          expect(yield* seen.take((event) => event.type === "turn.terminal")).toMatchObject({
            status: "failed",
            threadDisposition: "broken",
          });
          yield* seen.ended;
          expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
          expect(f.locks()).toHaveLength(1);
        }
        yield* quiet.peer.emit([delta("Quiet item recovery")]);
        yield* finish(quiet);
        expect(yield* q.take((event) => event.type === "turn.terminal")).toMatchObject({
          status: "completed",
        });
        yield* quiet.close;
        expect(f.locks()).toHaveLength(0);
        expect(f.backlogs()).toEqual([]);
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
