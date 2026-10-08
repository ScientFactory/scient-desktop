// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { OmpRpcProtocolError } from "effect-omp-rpc/errors";
import { ompTarget } from "../../provider/omp/OmpTarget.ts";
import { nativeOmpSession } from "../../provider/testUtils/nativeOmpSession.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import type { ProviderAdapterV2Event } from "../ProviderAdapter.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const peer = (configuration: Partial<Parameters<typeof scriptedOmpRpc>[0]> = {}) =>
  scriptedOmpRpc({ models: [], initial: { provider: "test", id: "selected" }, ...configuration });

/** Each replacement uses the same native conversation directory and a new process scope. */
const fixture = Effect.fnUntraced(function* () {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-lifecycle-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );
  const threadId = ThreadId.make("native-lifecycle-thread");
  const instanceId = ProviderInstanceId.make("native-lifecycle-instance");
  let sessionRoot = "";
  let launchPrivateFiles: string[] = [];
  const open = (
    makeProcess: Parameters<typeof nativeOmpSession>[0]["makeProcess"],
    id = threadId,
    continuations?: Parameters<typeof nativeOmpSession>[0]["continuations"],
  ) =>
    nativeOmpSession({
      root,
      stateDir: NodePath.join(root, "state"),
      attachmentsDir: NodePath.join(root, "attachments"),
      target: ompTarget,
      instanceId,
      threadId: id,
      binaryPath: "synthetic-omp",
      environment: { HOME: root },
      modelSelection: { instanceId, model: "test/selected" },
      ...(continuations ? { continuations } : {}),
      makeProcess: (options) => {
        sessionRoot = options.sessionDir ?? "";
        launchPrivateFiles = NodeFS.readdirSync(sessionRoot)
          .filter((name) => name.startsWith("scient-extension-"))
          .map((name) => NodePath.join(sessionRoot, name));
        return makeProcess(options);
      },
    });
  const lock = () => NodePath.join(sessionRoot, ".session.lock");
  const released = Effect.gen(function* () {
    while (NodeFS.existsSync(lock())) yield* Effect.sleep("5 millis");
  }).pipe(Effect.timeout("2 seconds"));
  const privateFiles = () => [...launchPrivateFiles];
  return { root, open, lock, released, privateFiles };
});

const observe = Effect.fnUntraced(function* (
  session: Effect.Success<ReturnType<typeof nativeOmpSession>>,
) {
  const events: ProviderAdapterV2Event[] = [];
  const queue = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const ended = yield* Deferred.make<void>();
  yield* session.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => events.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
    ),
    Effect.ensuring(Deferred.succeed(ended, undefined)),
    Effect.forkScoped,
  );
  const take = (predicate: (event: ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(queue);
        if (predicate(event)) return event;
      }
    }).pipe(Effect.timeout("2 seconds"));
  const terminal = () => take((event) => event.type === "turn.terminal");
  return { events, take, terminal, ended: Deferred.await(ended).pipe(Effect.timeout("2 seconds")) };
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("native OMP lifecycle", () => {
  it.live("Stops an accepted native OMP prompt before agent_start exactly once", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const p = peer();
        let continuations = 0;
        const s = yield* f.open(p.makeProcess, undefined, {
          offer: () =>
            Effect.sync(() => {
              continuations++;
            }),
        });
        const privateFiles = f.privateFiles();
        expect(privateFiles).toHaveLength(2);
        const seen = yield* observe(s);
        yield* s.start({ text: "Stop before the agent starts" });
        yield* p.promptDelivered();
        yield* seen.take(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeAcceptance === "accepted",
        );
        yield* s.interrupt.pipe(Effect.timeout("2 seconds"));
        const terminal = yield* seen.terminal();
        expect(terminal).toMatchObject({ status: "interrupted" });
        expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(p.state.shutdowns).toBe(1);
        expect(p.state.frames.some((frame) => frame.type === "abort")).toBe(false);
        expect(NodeFS.existsSync(f.lock())).toBe(false);
        for (const path of privateFiles) expect(NodeFS.existsSync(path)).toBe(false);
        const accepted = seen.events.filter(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeAcceptance === "accepted",
        ).length;
        const replacementPeer = peer();
        const replacement = yield* f.open(replacementPeer.makeProcess);
        const replacementSeen = yield* observe(replacement);
        expect(NodeFS.existsSync(f.lock())).toBe(true);
        yield* replacement.start({ text: "Immediate same-owner replacement" });
        yield* replacementPeer.promptDelivered();
        expect(
          yield* p.tryEmit([
            { type: "agent_start" },
            {
              type: "subagent_lifecycle",
              payload: { id: "late-child", status: "completed" },
            },
            { type: "agent_end", messages: [], isTerminal: true },
          ]),
        ).toEqual([false, false, false]);
        yield* replacementPeer.emit([
          { type: "agent_start" },
          {
            type: "tool_execution_start",
            toolCallId: "replacement-barrier",
            toolName: "read",
            args: { path: "replacement.txt" },
          },
        ]);
        yield* replacementSeen.take(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
        );
        expect(replacement.runtime.providerSession.status).toBe("running");
        expect(replacementSeen.events.some((event) => event.type === "turn.terminal")).toBe(false);
        expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(
          seen.events.filter(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeAcceptance === "accepted",
          ),
        ).toHaveLength(accepted);
        expect(continuations).toBe(0);
        expect(p.state.shutdowns).toBe(1);
        yield* replacementPeer.finish();
        expect(yield* replacementSeen.terminal()).toMatchObject({ status: "completed" });
        yield* replacement.close;
        yield* replacementSeen.ended;
        expect(
          replacementSeen.events.filter((event) => event.type === "turn.terminal"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.live("keeps a racing native agent start and late end interrupted while Stop closes", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const p = peer();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const s = yield* f.open((options) =>
          p.makeProcess(options).pipe(
            Effect.map((client) => ({
              ...client,
              shutdown: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(client.shutdown),
              ),
            })),
          ),
        );
        const seen = yield* observe(s);
        yield* s.start({ text: "Race Stop" });
        yield* p.promptDelivered();
        yield* seen.take((event) => event.type === "provider_turn.updated");
        const stop = yield* s.interrupt.pipe(Effect.forkScoped);
        yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"));
        yield* p.emit([
          { type: "agent_start" },
          { type: "agent_end", messages: [], isTerminal: true },
        ]);
        expect(
          seen.events.some(
            (event) => event.type === "turn.terminal" && event.status === "completed",
          ),
        ).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stop).pipe(Effect.timeout("2 seconds"));
        expect(yield* seen.terminal()).toMatchObject({ status: "interrupted" });
        expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(p.state.shutdowns).toBe(1);
        expect(NodeFS.existsSync(f.lock())).toBe(false);
      }),
    ),
  );

  it.live("closes a settled native OMP owner without inventing another turn outcome", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const p = peer();
        const s = yield* f.open(p.makeProcess);
        const seen = yield* observe(s);
        yield* s.start({ text: "Finish first" });
        yield* p.promptDelivered();
        yield* p.finish();
        expect(yield* seen.terminal()).toMatchObject({ status: "completed" });
        yield* s.close;
        yield* seen.ended;
        expect(p.state.shutdowns).toBe(1);
        expect(NodeFS.existsSync(f.lock())).toBe(false);
        expect(s.runtime.providerSession.status).toBe("stopped");
        expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
      }),
    ),
  );

  it.live("fences old native OMP frames from a replacement conversation process", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const oldPeer = peer();
        const old = yield* f.open(oldPeer.makeProcess);
        const oldSeen = yield* observe(old);
        yield* old.start({ text: "First" });
        yield* oldPeer.promptDelivered();
        yield* oldSeen.take((event) => event.type === "provider_turn.updated");
        yield* old.interrupt;
        expect(yield* oldSeen.terminal()).toMatchObject({ status: "interrupted" });
        const nextPeer = peer();
        const next = yield* f.open(nextPeer.makeProcess);
        const nextSeen = yield* observe(next);
        yield* next.start({ text: "Second" });
        yield* nextPeer.promptDelivered();
        yield* nextSeen.take((event) => event.type === "provider_turn.updated");
        yield* oldPeer.emit([
          { type: "agent_start" },
          { type: "agent_end", messages: [], isTerminal: true },
        ]);
        yield* nextPeer.emit([
          { type: "agent_start" },
          {
            type: "tool_execution_start",
            toolCallId: "new-owner",
            toolName: "read",
            args: { path: "next.txt" },
          },
        ]);
        yield* nextSeen.take(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "read",
        );
        expect(nextSeen.events.some((event) => event.type === "turn.terminal")).toBe(false);
        expect(next.runtime.providerSession.status).toBe("running");
        yield* nextPeer.finish();
        expect(yield* nextSeen.terminal()).toMatchObject({ status: "completed" });
        expect(oldSeen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(nextSeen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
      }),
    ),
  );

  it.live(
    "reports one broken native OMP session on malformed bytes and releases it for retry",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          const p = peer();
          const s = yield* f.open(p.makeProcess);
          const seen = yield* observe(s);
          yield* p.raw("{not json\n");
          yield* seen.take(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "error",
          );
          yield* f.released;
          expect(s.runtime.providerSession.status).toBe("error");
          expect(p.state.shutdowns).toBe(1);
          expect(
            seen.events.filter(
              (event) =>
                event.type === "provider_session.updated" &&
                event.providerSession.status === "error",
            ),
          ).toHaveLength(1);
          const healthy = peer();
          const replacement = yield* f.open(healthy.makeProcess);
          const nextSeen = yield* observe(replacement);
          yield* replacement.start({ text: "Recovered" });
          yield* healthy.promptDelivered();
          yield* healthy.finish();
          expect(yield* nextSeen.terminal()).toMatchObject({ status: "completed" });
          expect(healthy.state.shutdowns).toBe(0);
        }),
      ),
  );

  it.live("closes every native OMP stream and process when their owner closes", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const owner = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
        const sessions = [];
        for (let index = 0; index < 3; index++) {
          const p = peer();
          const s = yield* f
            .open(p.makeProcess, ThreadId.make(`native-close-${index}`))
            .pipe(Effect.provideService(Scope.Scope, owner));
          const seen = yield* observe(s);
          yield* s.start({ text: "Open work" });
          yield* p.promptDelivered();
          yield* seen.take((event) => event.type === "provider_turn.updated");
          sessions.push({ p, s, seen, lock: f.lock() });
        }
        yield* Scope.close(owner, Exit.void);
        for (const { p, s, seen, lock } of sessions) {
          yield* seen.ended;
          expect(p.state.shutdowns).toBe(1);
          expect(NodeFS.existsSync(lock)).toBe(false);
          expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
          expect(s.runtime.providerSession.status).toBe("stopped");
        }
      }),
    ),
  );

  it.live("bounds native OMP Stop while the runtime is waiting for model state", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        let blocked = false;
        const stateRequested = yield* Deferred.make<void>();
        const p = peer({ silentReply: (frame) => blocked && frame.type === "get_state" });
        const s = yield* f.open((options) =>
          p.makeProcess(options).pipe(
            Effect.map((client) => ({
              ...client,
              getState: () =>
                blocked
                  ? Deferred.succeed(stateRequested, undefined).pipe(
                      Effect.andThen(client.getState()),
                    )
                  : client.getState(),
            })),
          ),
        );
        const seen = yield* observe(s);
        yield* s.start({ text: "Block state refresh" });
        yield* p.promptDelivered();
        yield* seen.take((event) => event.type === "provider_turn.updated");
        blocked = true;
        yield* p.emit([{ type: "agent_start" }, { type: "model_changed" }]);
        yield* Deferred.await(stateRequested).pipe(Effect.timeout("2 seconds"));
        yield* s.interrupt.pipe(Effect.timeout("2 seconds"));
        expect(yield* seen.terminal()).toMatchObject({ status: "interrupted" });
        expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(p.state.shutdowns).toBe(1);
        expect(NodeFS.existsSync(f.lock())).toBe(false);
      }),
    ),
  );

  it.live("joins native OMP crash cleanup when the owner closes during shutdown", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const p = peer();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const s = yield* f.open((options) =>
          p.makeProcess(options).pipe(
            Effect.map((client) => ({
              ...client,
              shutdown: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(client.shutdown),
              ),
            })),
          ),
        );
        const seen = yield* observe(s);
        yield* s.start({ text: "Crash before close" });
        yield* p.promptDelivered();
        yield* p.close();
        yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"));
        const closing = yield* s.close.pipe(Effect.forkScoped);
        expect(NodeFS.existsSync(f.lock())).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(closing).pipe(Effect.timeout("2 seconds"));
        yield* seen.ended;
        expect(p.state.shutdowns).toBe(1);
        expect(NodeFS.existsSync(f.lock())).toBe(false);
        expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(seen.events.find((event) => event.type === "turn.terminal")).toMatchObject({
          status: "failed",
        });
      }),
    ),
  );

  it.live("refuses cancelled native OMP resume and permits a fresh healthy thread", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const seeded = yield* f.open(peer().makeProcess);
        const prior = seeded.providerThread;
        if (!prior.appThreadId) return yield* Effect.die("Missing native thread owner");
        yield* seeded.close;
        const cancelled = peer({ switchCancelled: true });
        const order: string[] = [];
        const current = yield* f.open((options) =>
          cancelled.makeProcess(options).pipe(
            Effect.map((client) => ({
              ...client,
              shutdown: Effect.sync(() =>
                order.push(NodeFS.existsSync(f.lock()) ? "shutdown:locked" : "shutdown:unlocked"),
              ).pipe(Effect.andThen(client.shutdown)),
            })),
          ),
        );
        const refused = yield* current.runtime
          .resumeThread({ providerThread: prior })
          .pipe(Effect.result);
        expect(refused._tag).toBe("Failure");
        if (refused._tag === "Failure") expect(encodeJson(refused.failure)).toContain("cancelled");
        expect(
          cancelled.state.frames.filter((frame) => frame.type === "switch_session"),
        ).toHaveLength(1);
        expect(cancelled.state.prompts).toHaveLength(0);
        const fresh = yield* current.runtime.ensureThread({
          threadId: prior.appThreadId,
          modelSelection: { instanceId: prior.providerInstanceId, model: "test/selected" },
          runtimePolicy: { cwd: f.root, runtimeMode: "full-access", interactionMode: "default" },
        });
        expect(fresh.nativeThreadRef).toBeDefined();
        expect(current.runtime.providerSession.status).toBe("ready");
        yield* current.close;
        expect(cancelled.state.shutdowns).toBe(1);
        expect(order).toEqual(["shutdown:locked"]);
        expect(NodeFS.existsSync(f.lock())).toBe(false);
      }),
    ),
  );

  it.live("keeps two native OMP homes and processes isolated through Stop", () =>
    run(
      Effect.gen(function* () {
        const left = yield* fixture();
        const right = yield* fixture();
        const a = peer();
        const b = peer();
        const first = yield* left.open(a.makeProcess);
        const second = yield* right.open(b.makeProcess);
        const firstSeen = yield* observe(first);
        const secondSeen = yield* observe(second);
        expect(first.providerThread.nativeMetadata?.resumeCursor).not.toEqual(
          second.providerThread.nativeMetadata?.resumeCursor,
        );
        expect(left.lock()).not.toBe(right.lock());
        yield* first.start({ text: "First home" });
        yield* second.start({ text: "Second home" });
        yield* a.promptDelivered();
        yield* b.promptDelivered();
        yield* firstSeen.take((event) => event.type === "provider_turn.updated");
        yield* secondSeen.take((event) => event.type === "provider_turn.updated");
        yield* first.interrupt;
        expect(yield* firstSeen.terminal()).toMatchObject({ status: "interrupted" });
        expect(a.state.shutdowns).toBe(1);
        expect(b.state.shutdowns).toBe(0);
        expect(NodeFS.existsSync(left.lock())).toBe(false);
        expect(NodeFS.existsSync(right.lock())).toBe(true);
        yield* b.finish();
        expect(yield* secondSeen.terminal()).toMatchObject({ status: "completed" });
        expect(secondSeen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        yield* second.close;
        expect(b.state.shutdowns).toBe(1);
        expect(NodeFS.existsSync(right.lock())).toBe(false);
      }),
    ),
  );

  it.live.each(
    (["makeProcess", "ready", "protocol", "get_state"] as const).map((step) => ({
      caseTitle: `cleans native OMP ${step} failure in shutdown-before-unlock order`,
      step,
    })),
  )("$caseTitle", ({ step }) =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const p = peer(
          step === "protocol"
            ? { supportedProtocolVersions: [1] }
            : step === "get_state"
              ? {
                  commandError: (frame) =>
                    frame.type === "get_state" ? "State refused" : undefined,
                }
              : {},
        );
        const order: string[] = [];
        const failed = yield* f
          .open((options) =>
            step === "makeProcess"
              ? Effect.fail(new OmpRpcProtocolError({ detail: "Synthetic launch failure" }))
              : p.makeProcess(options).pipe(
                  Effect.map((client) => ({
                    ...client,
                    ...(step === "ready"
                      ? {
                          ready: Effect.fail(
                            new OmpRpcProtocolError({ detail: "Synthetic readiness failure" }),
                          ),
                        }
                      : {}),
                    shutdown: Effect.sync(() =>
                      order.push(
                        NodeFS.existsSync(f.lock()) ? "shutdown:locked" : "shutdown:unlocked",
                      ),
                    ).pipe(Effect.andThen(client.shutdown)),
                  })),
                ),
          )
          .pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        expect(order).toEqual(step === "makeProcess" ? [] : ["shutdown:locked"]);
        expect(NodeFS.existsSync(f.lock())).toBe(false);
        const healthy = peer();
        yield* f.open(healthy.makeProcess);
        expect(NodeFS.existsSync(f.lock())).toBe(true);
        expect(healthy.state.shutdowns).toBe(0);
      }),
    ),
  );
  it.live.each(
    (["interrupt", "owner-close", "process-loss"] as const).map((ending) => ({
      caseTitle: `settles the native OMP child before its parent outcome on ${ending}`,
      ending,
    })),
  )("$caseTitle", ({ ending }) =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const p = peer();
        const s = yield* f.open(p.makeProcess);
        const seen = yield* observe(s);
        yield* s.start({ text: "Delegate a retained child" });
        yield* p.promptDelivered();
        yield* p.emit([
          { type: "agent_start" },
          {
            type: "subagent_lifecycle",
            payload: {
              id: "owned-child",
              agent: "task",
              detached: true,
              status: "started",
              description: "Review the parent",
            },
          },
        ]);
        const started = yield* seen.take(
          (event) => event.type === "subagent.updated" && event.subagent.status === "running",
        );
        if (started.type !== "subagent.updated") return yield* Effect.die("Missing native child");
        if (ending === "interrupt") yield* s.interrupt;
        else if (ending === "owner-close") yield* s.close;
        else yield* p.close();
        const terminal = yield* seen.terminal();
        expect(terminal).toMatchObject({
          status:
            ending === "interrupt"
              ? "interrupted"
              : ending === "owner-close"
                ? "cancelled"
                : "failed",
        });
        yield* f.released;
        yield* s.close;
        yield* seen.ended;
        const children = seen.events.filter(
          (event) => event.type === "subagent.updated" && event.subagent.status !== "running",
        );
        expect(children).toHaveLength(1);
        expect(children[0]).toMatchObject({
          subagent: {
            id: started.subagent.id,
            runId: started.subagent.runId,
            status:
              ending === "interrupt"
                ? "interrupted"
                : ending === "owner-close"
                  ? "cancelled"
                  : "failed",
          },
        });
        expect(seen.events.indexOf(children[0]!)).toBeLessThan(seen.events.indexOf(terminal));
        expect(seen.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        const pending = s.runtime.hasPendingBackgroundWork;
        if (!pending) return yield* Effect.die("Missing native background-work getter");
        expect(yield* pending).toBe(false);
        expect(p.state.shutdowns).toBe(1);
        expect(p.state.frames.some((frame) => frame.type === "abort")).toBe(false);
        expect(NodeFS.existsSync(f.lock())).toBe(false);
      }),
    ),
  );
});
